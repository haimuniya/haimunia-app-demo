begin;

-- Security hunt, round 4 (2026-09-11), client-side data tampering agent.
--
-- THE FINDING. workout_posts_guard_privileged_type() (202609060004, widened
-- 202609080002) blocks a member from self-awarding the four/five STAFF-only
-- labels (POST_COACH, POST_ANNOUNCEMENT, POST_SYSTEM, POST_NEW_MEMBER,
-- POST_CLUB_WOD) by checking whether the row's author is actually staff.
-- POST_PR and POST_ACHIEVEMENT were never added to that list, because they
-- are not staff-only - any member can legitimately earn a real PR or a real
-- achievement. But nothing else stood in the gap either:
-- workout_posts_guard_moderated_fields() (202609060011) only pins seven
-- specific columns (status, deleted_at, score_value, score_direction,
-- comparison_key, published_at, is_pinned) and only on UPDATE; post_type,
-- metadata, occurred_on, title and result_text - the columns pr_share()/
-- ach_share() derive FROM REAL DATA (a private_records row, a
-- member_achievements row) - were left fully writable, including on a raw
-- INSERT, to any authenticated author of their own row.
--
-- Confirmed live against real local Postgres: a plain member, as
-- themselves, with no elevated role -
--   insert into workout_posts (author_id, post_type, visibility, body, metadata)
--   values (auth.uid(), 'POST_ACHIEVEMENT', 'club', 'text',
--           '{"achievement_name":"1000 attendances (FAKE)"}'::jsonb);
-- - succeeded, with zero backing member_achievements row, zero backing
-- private_records row, and the forged post read back club-wide through the
-- real feed RLS exactly like a genuine share. feed_page's ranking function
-- gives POST_PR/POST_ACHIEVEMENT the achievement ranking boost and
-- community_profile()'s Progress tab renders metadata's movement/result/
-- achieved_on straight onto the member's public profile - both with zero
-- validation that pr_share()/ach_share() ever ran.
--
-- THE FIX. Same shape as every other guarded column in this file's own
-- lineage: a transaction-local pin, set only by the one or two SECURITY
-- DEFINER functions allowed to produce the value, checked by a BEFORE
-- INSERT OR UPDATE OF post_type trigger that already exists. POST_PR and
-- POST_ACHIEVEMENT join the guard's label list, gated by a NEW pin
-- (app.allow_pr_achievement_write) rather than the staff-membership check
-- the other five labels use, since the legitimacy test here is "did this
-- come from pr_share()/ach_share(), which already read the caller's own
-- private_records/member_achievements row" - not "is the author staff".
-- pr_share() and ach_share() are recreated with that pin set around their
-- own INSERT/UPDATE, nested inside the app.allow_moderation_write /
-- app.allow_unrated_post_insert pins they already carry - unrelated
-- concerns, so unrelated pins, exactly as this schema already does for
-- every other multi-guard write path (e.g. pr_share's own upgrade branch
-- already nests inside app.allow_moderation_write for a different reason).
-- Function bodies are otherwise byte-identical to 202609060025 (pr_share)
-- and 202609060019 (ach_share) - recreated in full because that is the
-- only way Postgres offers to add two lines to a plpgsql body.

create or replace function public.workout_posts_guard_privileged_type() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_pinned boolean;
begin
  -- An UPDATE that names post_type in its SET list fires this trigger even
  -- when the value does not move. Editing the caption of a real post must
  -- not be refused.
  if tg_op = 'UPDATE' and new.post_type is not distinct from old.post_type then
    return new;
  end if;

  if new.post_type in ('POST_PR', 'POST_ACHIEVEMENT') then
    -- Unlike the staff-only labels below, this check is scoped to real
    -- authenticated callers only - matching workout_posts_guard_moderated_fields'
    -- own precedent ("skipped entirely when auth.role() is not
    -- authenticated - service role, dashboard, backfills unaffected").
    -- The threat model here is a real client bypassing pr_share()/
    -- ach_share() over PostgREST; a superuser/service-role/backfill
    -- context (fixture setup, a future admin tool) is not part of it, and
    -- several existing pgTAP fixtures across this suite seed a POST_PR row
    -- directly as bootstrap-superuser test data.
    if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;
    v_pinned := coalesce(current_setting('app.allow_pr_achievement_write', true), '') = 'on';
    if v_pinned then return new; end if;
    -- The one pre-existing, still-live exception: publishAchievement()
    -- (cloud.js) shares a LOCAL, client-only achievement badge (app.js's
    -- own offline achievement engine, distinct from and older than the
    -- server-tracked member_achievements/ach_share() system) via a direct
    -- upsert with no post_type column at all, relying on default_post_type()
    -- to derive POST_ACHIEVEMENT from source_type='achievement'. There is
    -- no server record to verify a LOCAL badge against - by original
    -- design, same as POST_WORKOUT (publishWorkout, never guarded here
    -- either): a member's own self-reported log entry, trusted exactly as
    -- much as it always has been, no more. Distinguished from a REAL
    -- ach_share() row (source_record_id = a genuine member_achievements.id,
    -- always uuid-shaped) by shape: a local badge slug ("sessions-50",
    -- "pr-squat-gold", "tenure-<id>", "streak-<tier>", ...) never is.
    -- A uuid-shaped source_record_id gets NO exemption and still requires
    -- the pin, so this cannot be used to smuggle a fake ach_share()-style
    -- row past the real check.
    if new.post_type = 'POST_ACHIEVEMENT'
       and new.source_type = 'achievement'
       and new.source_record_id is not null
       and new.source_record_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then
      return new;
    end if;
    raise exception 'post type requires server-verified evidence';
  end if;

  if new.post_type not in (
    'POST_COACH', 'POST_ANNOUNCEMENT', 'POST_SYSTEM', 'POST_NEW_MEMBER',
    'POST_CLUB_WOD'
  ) then
    return new;
  end if;

  -- Server-authored rows. Every real producer of these labels is here.
  if new.author_id is null then
    return new;
  end if;

  if exists (
        select 1 from public.invite_redemptions ir
        where ir.user_id = new.author_id and public.role_rank(ir.role) >= 20
      )
     or exists (
        select 1 from public.profiles pf
        where pf.id = new.author_id and pf.is_admin and pf.deleted_at is null
      )
  then
    return new;
  end if;

  raise exception 'post type is staff only';
end $$;
revoke all on function public.workout_posts_guard_privileged_type() from public, anon, authenticated;

comment on function public.workout_posts_guard_privileged_type() is
  'Security hunt round 4 (202609110004), widened. BEFORE INSERT OR UPDATE OF post_type on workout_posts. POST_PR/POST_ACHIEVEMENT: skipped entirely when auth.role() is not ''authenticated'' (service role, dashboard, backfills, and existing pgTAP fixtures that seed a POST_PR row directly, all unaffected - same precedent as workout_posts_guard_moderated_fields); for a real authenticated caller, raises ''post type requires server-verified evidence'' (P0001) unless the transaction-local app.allow_pr_achievement_write pin is on - set only by pr_share() and ach_share() around their own INSERT/UPDATE, which is what actually reads the caller''s private_records/member_achievements row before minting the label. ONE NAMED EXCEPTION: a POST_ACHIEVEMENT row with source_type=''achievement'' and a non-uuid-shaped source_record_id (a local app.js badge slug, never one this schema''s own member_achievements.id can equal) is also let through unpinned - this is publishAchievement()''s still-live direct upsert sharing a LOCAL, client-only achievement with no server record to verify against, trusted exactly as much as POST_WORKOUT''s own self-reported log entry always has been, no more; a uuid-shaped source_record_id gets no such exemption and still requires the real pin. POST_COACH/POST_ANNOUNCEMENT/POST_SYSTEM/POST_NEW_MEMBER/POST_CLUB_WOD: unchanged from 202609080002 - raises ''post type is staff only'' when the row''s author_id is a member who is neither redeemed at role_rank >= 20 nor profiles.is_admin, applied on EVERY write path including the service role (a fact about the row''s author, not the session - deliberately not exempted the way the PR/achievement check above is). author_id is null is exempt for the staff-only labels: every legitimate producer of an authorless label writes an authorless row. An UPDATE that leaves post_type unchanged returns early.';

-- ---------------------------------------------------------------------
-- pr_share(): the pin, nested inside the existing app.allow_moderation_write
-- (upgrade branch) / app.allow_unrated_post_insert (fresh-post branch) pins.
-- Everything else is byte-identical to 202609060025.
-- ---------------------------------------------------------------------
create or replace function public.pr_share(
  record_id text,
  note text default '',
  media jsonb default '[]'::jsonb,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_body text;
  v_media_count integer := 0;
  v_post_id uuid;
  v_item jsonb;
  v_idx integer := 0;
  v_replay boolean;
  v_prior jsonb;
  v_rec public.private_records;
  v_prior_post public.workout_posts;
  v_upgrade boolean := false;
  v_payload jsonb := '{}'::jsonb;
  v_source_type text := 'strength_entry';
  v_metadata jsonb := '{}'::jsonb;
  v_title text;
  v_result text;
  v_prev_result text;
  v_improvement text;
  v_occurred date;
  v_weight numeric;
  v_reps numeric;
  v_duration numeric;
  v_est numeric;
  v_prev numeric;
  v_score numeric;
  v_exercise text;
  v_ts numeric;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('pr_share', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;

  -- 160 is private_records.record_id's own CHECK: an id longer than that
  -- cannot name a record in this database, so it is rejected as malformed
  -- rather than silently treated as case (c).
  if record_id is null or btrim(record_id) = '' or char_length(record_id) > 160 then
    raise exception 'record is required';
  end if;

  -- Case (a): the caller's own row. deleted_at is honoured - a record the
  -- member has since deleted is not something to publish figures from.
  select * into v_rec
  from public.private_records r
  where r.user_id = v_uid
    and r.record_type in ('strength_entry', 'wod_entry')
    and r.record_id = pr_share.record_id
    and r.deleted_at is null;

  if found then
    v_payload := coalesce(v_rec.payload, '{}'::jsonb);
    v_source_type := v_rec.record_type;
  else
    -- Case (b). Checked only when the caller does not own the id, so the
    -- normal path never pays for it.
    if exists (
      select 1 from public.private_records r
      where r.record_id = pr_share.record_id
        and r.record_type in ('strength_entry', 'wod_entry')
        and r.user_id <> v_uid
    ) then
      raise exception 'not authorized';
    end if;
    -- Case (c) falls through with an empty payload and publishes no figures.
  end if;

  -- ---------------------------------------------------------------
  -- The prior-post probe. THIS is what 202609060019 got wrong: it
  -- returned whatever post held the record's unique slot without ever
  -- asking what KIND of post it was.
  -- ---------------------------------------------------------------
  select * into v_prior_post
  from public.workout_posts p
  where p.author_id = v_uid
    and p.source_type in ('strength_entry', 'wod_entry')
    and p.source_record_id = pr_share.record_id
  limit 1;

  if found then
    -- Already the PR post. True idempotency: a double tap on "שיתוף", or a
    -- retry after a dropped response, converges on the first post and writes
    -- nothing. Ahead of the rate limit, so it costs no budget.
    if v_prior_post.post_type = 'POST_PR' then
      perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_prior_post.id));
      return v_prior_post.id;
    end if;

    -- The legacy workout share for this same record. Upgrade it in place;
    -- see the header for every field this does and does not move.
    if v_prior_post.post_type = 'POST_WORKOUT' then
      if v_prior_post.status <> 'active' then
        raise exception 'post is not available';
      end if;
      v_upgrade := true;
    else
      -- Not reachable from any shipped writer - post_create never sets
      -- source_record_id, and publishWorkout/pr_share are the only producers
      -- of a strength_entry/wod_entry row - but refusing loudly beats
      -- silently rewriting a post whose shape this function does not know.
      raise exception 'this record already has a post';
    end if;
  end if;

  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  -- Body normalisation is post_create's, byte for byte.
  v_body := regexp_replace(
    coalesce(note, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if media is not null and jsonb_typeof(media) = 'array' then
    v_media_count := jsonb_array_length(media);
  end if;
  if v_media_count > 4 then raise exception 'at most 4 photos per post'; end if;

  -- ---------------------------------------------------------------
  -- Everything below is recomputed from the record. Nothing is read
  -- from the request.
  -- ---------------------------------------------------------------
  if v_payload ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    v_occurred := (v_payload ->> 'date')::date;
  end if;

  v_exercise := nullif(v_payload ->> 'exerciseId', '');
  v_weight   := public.private_record_number(v_payload, 'weight');
  v_reps     := public.private_record_number(v_payload, 'reps');
  v_duration := public.private_record_number(v_payload, 'durationSeconds');
  v_est      := public.private_record_number(v_payload, 'est1RM');
  v_ts       := public.private_record_number(v_payload, 'ts');

  -- Only a custom movement is ever synced, so this resolves for some PRs
  -- and not others by design; see 202609060019's header.
  if v_exercise is not null then
    select nullif(left(btrim(coalesce(m.payload ->> 'name', '')), 120), '')
      into v_title
    from public.private_records m
    where m.user_id = v_uid and m.record_type = 'movement'
      and m.record_id = v_exercise and m.deleted_at is null;
  end if;

  if coalesce(v_payload ->> 'type', '') = 'duration' and v_duration is not null and v_duration > 0 then
    v_result := trim(trailing '.' from to_char(v_duration, 'FM999999990.99')) || ' שנ׳';
    if v_weight is not null and v_weight > 0 then
      v_result := trim(trailing '.' from to_char(v_weight, 'FM999999990.99')) || ' ק"ג · ' || v_result;
    end if;
    v_score := v_duration;
  elsif v_weight is not null and v_reps is not null and v_reps > 0 then
    v_result := trim(trailing '.' from to_char(v_weight, 'FM999999990.99')) || ' ק"ג × '
             || trim(trailing '.' from to_char(v_reps, 'FM999999990'));
    v_score := coalesce(v_est, v_weight);
  end if;

  -- The previous best for the SAME movement at the SAME rep count, from the
  -- caller's own history, excluding this record and anything logged after
  -- it. The only source of previous_result / improvement anywhere here.
  if v_exercise is not null and v_weight is not null and v_reps is not null and v_reps > 0 then
    select max(public.private_record_number(r.payload, 'weight')) into v_prev
    from public.private_records r
    where r.user_id = v_uid
      and r.record_type = 'strength_entry'
      and r.deleted_at is null
      and r.record_id <> pr_share.record_id
      and r.payload ->> 'exerciseId' = v_exercise
      and public.private_record_number(r.payload, 'reps') = v_reps
      and (v_ts is null or coalesce(public.private_record_number(r.payload, 'ts'), 0) < v_ts);

    if v_prev is not null and v_prev > 0 and v_weight > v_prev then
      v_prev_result := trim(trailing '.' from to_char(v_prev, 'FM999999990.99')) || ' ק"ג × '
                    || trim(trailing '.' from to_char(v_reps, 'FM999999990'));
      v_improvement := '+' || trim(trailing '.' from to_char(v_weight - v_prev, 'FM999999990.99')) || ' ק"ג';
    end if;
  end if;

  if v_title is not null then
    v_metadata := v_metadata || jsonb_build_object('movement', v_title);
  end if;
  if v_result is not null then
    v_metadata := v_metadata || jsonb_build_object('new_result', v_result);
  end if;
  if v_prev_result is not null then
    v_metadata := v_metadata || jsonb_build_object('previous_result', v_prev_result, 'improvement', v_improvement);
  end if;
  if v_occurred is not null then
    v_metadata := v_metadata || jsonb_build_object('achieved_on', v_occurred);
  end if;

  -- post_create's rule, asked of this shape: a card with no figures, no
  -- caption and no photo says nothing at all. On the upgrade path the card
  -- already exists and already carries a title and a result, so the check
  -- applies only to what is actually on the row.
  if v_result is null and v_body = '' and v_media_count = 0
     and (not v_upgrade
          or coalesce(v_prior_post.result_text, v_prior_post.title, v_prior_post.body) is null)
  then
    raise exception 'a post needs text or at least one photo';
  end if;

  if v_upgrade then
    -- deleted_at, score_value and score_direction are guarded by
    -- workout_posts_guard_moderated_fields; post_type is guarded by
    -- workout_posts_guard_privileged_type (202609110004). Both pins are
    -- transaction-local and unrelated to each other, nested here because
    -- this one statement moves columns both of them own.
    perform set_config('app.allow_moderation_write', 'on', true);
    perform set_config('app.allow_pr_achievement_write', 'on', true);
    update public.workout_posts p
       set post_type       = 'POST_PR',
           source_type     = v_source_type,
           body            = coalesce(nullif(v_body, ''), p.body),
           title           = coalesce(v_title, p.title),
           result_text     = coalesce(v_result, p.result_text),
           occurred_on     = coalesce(v_occurred, p.occurred_on),
           score_value     = coalesce(v_score, p.score_value),
           score_direction = case when coalesce(v_score, p.score_value) is null
                                  then null else 'higher' end,
           metadata        = coalesce(p.metadata, '{}'::jsonb) || v_metadata,
           deleted_at      = null
     where p.id = v_prior_post.id
    returning p.id into v_post_id;
    perform set_config('app.allow_pr_achievement_write', 'off', true);
    perform set_config('app.allow_moderation_write', 'off', true);

    -- The PR prompt has its own photo picker, so the media it sends IS the
    -- card's media. Only ever runs when the caller actually supplied some:
    -- a PR share with no photo destroys nothing. publishWorkout's own photo
    -- lives in workout_posts.photo_path, a different column, and survives
    -- either way.
    if v_media_count > 0 then
      delete from public.post_media pm where pm.post_id = v_post_id;
    end if;
  else
    perform set_config('app.allow_unrated_post_insert', 'on', true);
    perform set_config('app.allow_pr_achievement_write', 'on', true);
    insert into public.workout_posts (
      author_id, post_type, visibility, body, title, result_text,
      source_type, source_record_id, occurred_on, score_value, score_direction,
      metadata, status, published_at)
    values (
      v_uid, 'POST_PR', 'club', nullif(v_body, ''), v_title, v_result,
      v_source_type, pr_share.record_id, coalesce(v_occurred, current_date), v_score,
      case when v_score is null then null else 'higher' end,
      v_metadata, 'active', now())
    returning id into v_post_id;
    perform set_config('app.allow_pr_achievement_write', 'off', true);
    perform set_config('app.allow_unrated_post_insert', 'off', true);
  end if;

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

  perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;
revoke all on function public.pr_share(text, text, jsonb, uuid) from public, anon;
grant execute on function public.pr_share(text, text, jsonb, uuid) to authenticated;

comment on function public.pr_share(text, text, jsonb, uuid) is
  'Security hunt round 4 (202609110004): adds the app.allow_pr_achievement_write pin around both write branches, nested inside the pins each branch already carried (app.allow_moderation_write on the upgrade path, app.allow_unrated_post_insert on the fresh-insert path) - closes a confirmed direct-insert bypass that let any member forge a POST_PR with fabricated metadata and zero backing private_records row. Otherwise byte-identical to 202609060025: publishes a POST_PR for one of the caller''s own logged records, upgrading a prior POST_WORKOUT in place when one exists for the same record rather than creating a second post. See 202609060025''s own comment for the full gate list and field-by-field upgrade semantics, unchanged here.';

-- ---------------------------------------------------------------------
-- ach_share(): same pin, nested inside app.allow_unrated_post_insert.
-- Everything else is byte-identical to 202609060019.
-- ---------------------------------------------------------------------
create or replace function public.ach_share(
  member_achievement_id uuid,
  caption text default '',
  media jsonb default '[]'::jsonb,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_body text;
  v_media_count integer := 0;
  v_post_id uuid;
  v_item jsonb;
  v_idx integer := 0;
  v_replay boolean;
  v_prior jsonb;
  v_ma public.member_achievements;
  v_def public.achievement_definitions;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('ach_share', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;

  if member_achievement_id is null then raise exception 'achievement is required'; end if;

  select * into v_ma from public.member_achievements ma where ma.id = member_achievement_id;
  if not found then raise exception 'achievement not found'; end if;
  -- The ownership boundary. Not 'achievement not found': the row does exist
  -- and refusing it as missing would be a lie to the one member whose
  -- achievement it is not.
  if v_ma.user_id is distinct from v_uid then raise exception 'not authorized'; end if;
  if v_ma.visibility = 'only_me' then raise exception 'a private achievement cannot be shared'; end if;

  select * into v_def from public.achievement_definitions d where d.id = v_ma.achievement_id;
  if not found then raise exception 'achievement not found'; end if;

  -- Natural idempotency, same reasoning as pr_share's.
  select p.id into v_post_id
  from public.workout_posts p
  where p.author_id = v_uid
    and p.source_type = 'achievement'
    and p.source_record_id = member_achievement_id::text
  limit 1;
  if v_post_id is not null then
    update public.member_achievements
       set shared_at = now()
     where id = member_achievement_id and shared_at is null;
    perform public.idem_complete('ach_share', p_idempotency_key, to_jsonb(v_post_id));
    return v_post_id;
  end if;

  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(
    coalesce(caption, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if media is not null and jsonb_typeof(media) = 'array' then
    v_media_count := jsonb_array_length(media);
  end if;
  if v_media_count > 4 then raise exception 'at most 4 photos per post'; end if;

  perform set_config('app.allow_unrated_post_insert', 'on', true);
  perform set_config('app.allow_pr_achievement_write', 'on', true);
  insert into public.workout_posts (
    author_id, post_type, visibility, body, title, result_text,
    source_type, source_record_id, source_id, occurred_on, metadata, status, published_at)
  values (
    v_uid, 'POST_ACHIEVEMENT', v_ma.visibility::public.post_visibility,
    nullif(v_body, ''), left(v_def.name, 120), nullif(left(v_def.description, 240), ''),
    'achievement', member_achievement_id::text, member_achievement_id,
    v_ma.unlocked_at::date,
    jsonb_strip_nulls(jsonb_build_object(
      'achievement_id', v_ma.id,
      'code', v_def.code,
      'title', v_def.name,
      'badge_icon', v_def.icon,
      'explanation', nullif(v_def.description, ''),
      'earned_on', v_ma.unlocked_at::date)),
    'active', now())
  returning id into v_post_id;
  perform set_config('app.allow_pr_achievement_write', 'off', true);
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

  update public.member_achievements
     set shared_at = now()
   where id = member_achievement_id and shared_at is null;

  perform public.idem_complete('ach_share', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;
revoke all on function public.ach_share(uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.ach_share(uuid, text, jsonb, uuid) to authenticated;

comment on function public.ach_share(uuid, text, jsonb, uuid) is
  'Security hunt round 4 (202609110004): adds the app.allow_pr_achievement_write pin around the INSERT, nested inside the existing app.allow_unrated_post_insert pin - closes a confirmed direct-insert bypass that let any member forge a POST_ACHIEVEMENT with a fabricated title/metadata and zero backing member_achievements row. Otherwise byte-identical to 202609060019: publishes a POST_ACHIEVEMENT for one of the caller''s own member_achievements rows and stamps shared_at. See 202609060019''s own comment for the full gate list, unchanged here.';

commit;
