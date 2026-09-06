begin;

-- Production-readiness audit, 2026-09-06, part 4. RELIABILITY: write
-- idempotency for the four community writes a retry can duplicate.
--
-- THE PROBLEM (RELIABILITY_AUDIT.md). None of post_create, add_post_comment,
-- chal_record_progress or toggle_reaction carried any idempotency key, so a
-- request that succeeded server-side but whose response the client never saw
-- - a mobile connection dropping mid-flight, a timeout, a backgrounded PWA -
-- produced a duplicate on retry. chal_record_progress is the worst of the
-- four because it is an append-only DELTA log: a retried +100 silently
-- becomes +200 on the member's challenge total, and nothing downstream can
-- tell that apart from two legitimate contributions. toggle_reaction is the
-- second worst in a different way: it INVERTS rather than converges, so a
-- retry of "add my cheer" removes it again.
--
-- THE MECHANISM. One shared claim table keyed (user_id, action, key), and
-- two helpers around it. A caller passes a client-generated uuid; the first
-- request claims the key and stores its result, and any later request with
-- the same key returns that stored result WITHOUT re-executing. The key is
-- optional everywhere (default null = today's behaviour exactly), so this
-- migration changes no existing call's semantics until the client starts
-- sending keys.
--
-- CONCURRENCY, which is the part a naive "select then insert" gets wrong:
-- idem_begin() claims with `on conflict ... do update`, not `do nothing`.
-- DO UPDATE takes a row lock, so a second concurrent request with the same
-- key BLOCKS until the first transaction commits and then reads its
-- committed result, instead of racing past a not-yet-visible row and doing
-- the work twice. `xmax = 0` is what distinguishes a fresh insert from a
-- conflict, and is the standard way to ask "did I win the claim".
--
-- A ROLLED-BACK first attempt leaves no claim behind: the claim row is
-- written inside the caller's own transaction, so it dies with it. That is
-- deliberate - a failed request must be genuinely retryable, not
-- permanently poisoned by its own claim.

create table public.request_idempotency (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (char_length(action) between 1 and 60),
  idempotency_key uuid not null,
  -- jsonb rather than a uuid column so one table serves callers that return
  -- a uuid (post_create, add_post_comment, chal_record_progress) and callers
  -- that return something else (toggle_reaction returns boolean).
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, action, idempotency_key)
);
create index request_idempotency_created_idx on public.request_idempotency(created_at);

alter table public.request_idempotency enable row level security;
-- No client grant and no policy of any kind: this table is written and read
-- exclusively by the SECURITY DEFINER helpers below, the same shape
-- rate_limits (202608270010) uses. A member has no reason to read or forge
-- another member's claim rows.
revoke all on public.request_idempotency from public, anon, authenticated;

comment on table public.request_idempotency is
  'Launch-readiness audit, write idempotency. One row per (user, action, client-supplied key). Claimed by public.idem_begin() and completed by public.idem_complete(); a replay returns the stored result instead of re-running the write. No client grant and no RLS policy - only the definer helpers touch it. Purged after 7 days by public.idem_purge(), scheduled daily as the ''idempotency-purge'' cron job: a key older than that cannot still be an in-flight retry, and the table would otherwise grow without bound.';

-- ---------------------------------------------------------------------
-- The two helpers
-- ---------------------------------------------------------------------
create or replace function public.idem_begin(p_action text, p_key uuid)
returns table(is_replay boolean, prior_result jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_inserted boolean;
  v_result jsonb;
begin
  -- No key supplied: caller opted out, behave exactly as before.
  if p_key is null then
    return query select false, null::jsonb;
    return;
  end if;
  if v_uid is null then raise exception 'not authorized'; end if;

  insert into public.request_idempotency (user_id, action, idempotency_key)
  values (v_uid, p_action, p_key)
  on conflict (user_id, action, idempotency_key)
    -- A no-op assignment, present only so this is DO UPDATE and therefore
    -- takes a row lock a concurrent duplicate will wait on.
    do update set user_id = public.request_idempotency.user_id
  returning (xmax = 0), public.request_idempotency.result into v_inserted, v_result;

  return query select (not v_inserted), v_result;
end $$;
revoke all on function public.idem_begin(text, uuid) from public, anon, authenticated;

create or replace function public.idem_complete(p_action text, p_key uuid, p_result jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_key is null then return; end if;
  update public.request_idempotency
     set result = p_result
   where user_id = auth.uid() and action = p_action and idempotency_key = p_key;
end $$;
revoke all on function public.idem_complete(text, uuid, jsonb) from public, anon, authenticated;

create or replace function public.idem_purge(p_older_than interval default interval '7 days')
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  with gone as (
    delete from public.request_idempotency where created_at < now() - p_older_than returning 1
  ) select count(*) into v_n from gone;
  return v_n;
end $$;
revoke all on function public.idem_purge(interval) from public, anon, authenticated;
grant execute on function public.idem_purge(interval) to service_role;

-- ---------------------------------------------------------------------
-- post_create: + p_idempotency_key
-- ---------------------------------------------------------------------
-- Body is byte-identical to 202609060012's (itself byte-identical to
-- 202608280023's apart from the SEC-003 pin) except for the two idempotency
-- blocks. Recreated in full because that is the only way Postgres offers.
create or replace function public.post_create(
  body text,
  visibility public.post_visibility,
  media jsonb,
  links jsonb,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_body text;
  v_media_count integer := 0;
  v_post_type public.post_type;
  v_metadata jsonb := '{}'::jsonb;
  v_post_id uuid;
  v_item jsonb;
  v_idx integer := 0;
  v_replay boolean;
  v_prior jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('post_create', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  -- COMM-153 enforcement, before the rate limit so a restricted member burns
  -- no budget and gets the accurate reason.
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;
  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(
    coalesce(body, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if media is not null and jsonb_typeof(media) = 'array' then
    v_media_count := jsonb_array_length(media);
  end if;
  if v_media_count > 4 then raise exception 'at most 4 photos per post'; end if;
  if v_body = '' and v_media_count = 0 then
    raise exception 'a post needs text or at least one photo';
  end if;

  if links is not null and jsonb_typeof(links) = 'object' then
    if coalesce(links ->> 'workout_id', '') <> '' then
      v_metadata := v_metadata || jsonb_build_object('workout_id', links ->> 'workout_id');
    end if;
    if coalesce(links ->> 'achievement_id', '') <> '' then
      v_metadata := v_metadata || jsonb_build_object('achievement_id', links ->> 'achievement_id');
    end if;
    if coalesce(links ->> 'event_id', '') <> '' then
      v_metadata := v_metadata || jsonb_build_object('event_id', links ->> 'event_id');
    end if;
  end if;

  v_post_type := case
    when v_media_count > 0 and v_body = '' then 'POST_PHOTO'::public.post_type
    else 'POST_TEXT'::public.post_type
  end;

  perform set_config('app.allow_unrated_post_insert', 'on', true);
  insert into public.workout_posts (author_id, post_type, visibility, body, metadata, status, published_at)
  values (v_uid, v_post_type, coalesce(visibility, 'club'),
          nullif(v_body, ''), v_metadata, 'active', now())
  returning id into v_post_id;
  perform set_config('app.allow_unrated_post_insert', 'off', true);

  if v_media_count > 0 then
    for v_item in select value from jsonb_array_elements(media)
    loop
      if coalesce(v_item ->> 'storage_path', '') = '' then
        raise exception 'each media item needs a storage_path';
      end if;
      insert into public.post_media (post_id, storage_path, alt_text, decorative, "position", width, height)
      values (
        v_post_id,
        v_item ->> 'storage_path',
        nullif(v_item ->> 'alt_text', ''),
        coalesce((v_item ->> 'decorative')::boolean, false),
        coalesce((v_item ->> 'position')::smallint, v_idx::smallint),
        nullif(v_item ->> 'width', '')::integer,
        nullif(v_item ->> 'height', '')::integer
      );
      v_idx := v_idx + 1;
    end loop;
  end if;

  perform public.idem_complete('post_create', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;
revoke all on function public.post_create(text, public.post_visibility, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.post_create(text, public.post_visibility, jsonb, jsonb, uuid) to authenticated;

-- The old 4-arg signature is dropped so there is exactly ONE post_create.
-- A 4-named-argument call from the existing client resolves to the new
-- function with p_idempotency_key defaulted, so nothing has to change at
-- once; leaving both would have kept an un-guarded path alive forever.
drop function if exists public.post_create(text, public.post_visibility, jsonb, jsonb);

-- ---------------------------------------------------------------------
-- add_post_comment: + p_idempotency_key on the 4-arg (mentions) overload
-- ---------------------------------------------------------------------
-- Body copied from pg_get_functiondef() of the live 4-arg function, not
-- re-typed. The 2- and 3-arg overloads are deliberately left alone: this
-- one is the client's real entry point (cloud.js:3672) and the inner
-- delegation on line "v_id := public.add_post_comment(...)" still calls the
-- 3-arg one, which is where the rate limit and the actual insert live.
create or replace function public.add_post_comment(
  p_post_id uuid,
  p_body text,
  p_parent_comment_id uuid,
  p_mentions uuid[],
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_uid uuid;
  v_targets uuid[];
  v_replay boolean;
  v_prior jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('add_post_comment', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if p_mentions is not null and array_length(p_mentions, 1) > 10 then
    raise exception 'at most 10 mentions per comment';
  end if;

  v_id := public.add_post_comment(p_post_id, p_body, p_parent_comment_id);
  if p_mentions is null or array_length(p_mentions, 1) is null then
    perform public.idem_complete('add_post_comment', p_idempotency_key, to_jsonb(v_id));
    return v_id;
  end if;

  select array_agg(distinct t.target) into v_targets
  from unnest(p_mentions) as t(target)
  where t.target is not null and t.target <> v_uid;
  if v_targets is null then
    perform public.idem_complete('add_post_comment', p_idempotency_key, to_jsonb(v_id));
    return v_id;
  end if;

  insert into public.comment_mentions (comment_id, mentioned_user_id)
  select v_id, t.target
  from unnest(v_targets) as t(target)
  where exists (select 1 from public.profiles p where p.id = t.target and p.deleted_at is null)
    and public.can_view_profile_field(t.target, 'allow_mentions')
  on conflict do nothing;

  perform public.idem_complete('add_post_comment', p_idempotency_key, to_jsonb(v_id));
  return v_id;
end $$;
revoke all on function public.add_post_comment(uuid, text, uuid, uuid[], uuid) from public, anon;
grant execute on function public.add_post_comment(uuid, text, uuid, uuid[], uuid) to authenticated;
drop function if exists public.add_post_comment(uuid, text, uuid, uuid[]);

-- ---------------------------------------------------------------------
-- chal_record_progress: + p_idempotency_key. The highest-value one.
-- ---------------------------------------------------------------------
create or replace function public.chal_record_progress(
  p_challenge_id uuid,
  p_user_id uuid,
  p_delta numeric,
  p_note text,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_note text;
  v_id uuid;
  v_replay boolean;
  v_prior jsonb;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('chal_record_progress', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;
  if p_challenge_id is null or p_user_id is null then raise exception 'challenge and target participant are required'; end if;
  if p_delta is null then raise exception 'delta is required'; end if;

  if not exists (
    select 1 from public.challenge_participants
    where challenge_id = p_challenge_id and user_id = p_user_id and status = 'active'
  ) then
    raise exception 'not an active participant';
  end if;

  v_note := nullif(left(btrim(coalesce(p_note, '')), 500), '');

  insert into public.challenge_progress
    (challenge_id, user_id, delta, source_type, note, entered_by)
  values (p_challenge_id, p_user_id, p_delta, 'coach_entry', v_note, v_uid)
  returning id into v_id;

  perform public.idem_complete('chal_record_progress', p_idempotency_key, to_jsonb(v_id));
  return v_id;
end $$;
revoke all on function public.chal_record_progress(uuid, uuid, numeric, text, uuid) from public, anon;
grant execute on function public.chal_record_progress(uuid, uuid, numeric, text, uuid) to authenticated;
drop function if exists public.chal_record_progress(uuid, uuid, numeric, text);

-- ---------------------------------------------------------------------
-- toggle_reaction: + p_idempotency_key. Converges instead of inverting.
-- ---------------------------------------------------------------------
create or replace function public.toggle_reaction(p_post_id uuid, p_idempotency_key uuid default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_existing boolean;
  v_replay boolean;
  v_prior jsonb;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;

  -- The retry case this closes: without a key, replaying "I cheered this
  -- post" flips the reaction back OFF, so a dropped response leaves the UI
  -- and the database disagreeing about a state the member set once.
  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('toggle_reaction', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::boolean; end if;

  select exists(select 1 from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer') into v_existing;
  if v_existing then
    delete from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer';
    perform public.idem_complete('toggle_reaction', p_idempotency_key, to_jsonb(false));
    return false;
  end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.check_rate_limit('reaction', 60, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;
  insert into public.reactions(post_id, user_id, kind) values (p_post_id, auth.uid(), 'cheer');
  perform public.idem_complete('toggle_reaction', p_idempotency_key, to_jsonb(true));
  return true;
end $$;
revoke all on function public.toggle_reaction(uuid, uuid) from public, anon;
grant execute on function public.toggle_reaction(uuid, uuid) to authenticated;
drop function if exists public.toggle_reaction(uuid);

-- ---------------------------------------------------------------------
-- Scheduled cleanup
-- ---------------------------------------------------------------------
select cron.schedule('idempotency-purge', '19 3 * * *',
  $$select public.idem_purge()$$);

commit;
