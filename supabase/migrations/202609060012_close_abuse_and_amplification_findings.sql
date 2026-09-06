begin;

-- Production-readiness audit, 2026-09-06, part 2. Closes SEC-003, SEC-006,
-- SEC-007, SEC-008 and the rate-limiting half of SEC-011, all P1/P2 abuse
-- and resource-amplification findings independent of the P0/P1 fixed in
-- 202609060011.
--
-- Not run against a live Postgres from this sandbox - no Supabase CLI, no
-- running Docker containers. Verify with a cold `supabase db reset` +
-- `supabase test db` before merge, per DATABASE_AUDIT.md.

-- =====================================================================
-- 1. SEC-003 - post_create()'s rate limit is bypassable via a direct
--    insert into workout_posts. cloud.js:3072/4211 still upsert directly
--    (PR-share / achievement-share posts), so the table's INSERT grant
--    cannot simply be revoked without moving those call sites first
--    (SECURITY_AUDIT.md's own caveat). Interim mitigation: a BEFORE INSERT
--    trigger enforcing the identical limit on every authenticated insert
--    that reaches the table directly, pinned off (skipped) only inside
--    post_create()'s own insert, which already checks the same limit by
--    hand - without the pin, a real post through the composer would
--    consume two rate-limit tokens per post instead of one.
-- =====================================================================

create or replace function public.workout_posts_guard_insert_rate_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_pinned boolean;
begin
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;

  v_pinned := coalesce(current_setting('app.allow_unrated_post_insert', true), '') = 'on';
  if v_pinned then return new; end if;

  if not public.check_rate_limit('post_create', 20, 10) then
    raise exception 'rate_limited';
  end if;
  return new;
end $$;
revoke all on function public.workout_posts_guard_insert_rate_limit() from public, anon, authenticated;

drop trigger if exists workout_posts_guard_insert_rate_limit_trigger on public.workout_posts;
create trigger workout_posts_guard_insert_rate_limit_trigger
  before insert on public.workout_posts
  for each row execute function public.workout_posts_guard_insert_rate_limit();

comment on function public.workout_posts_guard_insert_rate_limit() is
  'Launch-readiness audit, SEC-003. BEFORE INSERT on workout_posts. Enforces the identical check_rate_limit(''post_create'', 20, 10) that post_create() already applies, for any authenticated insert that reaches the table directly - covering cloud.js:3072/4211''s still-live upsert() calls, which post_create() cannot yet supersede. Skipped inside the transaction-local app.allow_unrated_post_insert pin, which only post_create() sets around its own insert, so a real composed post consumes exactly one rate-limit token, not two.';

create or replace function public.post_create(
  body text,
  visibility public.post_visibility,
  media jsonb,
  links jsonb
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
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  -- COMM-153 enforcement, before the rate limit so a restricted member burns
  -- no budget and gets the accurate reason.
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;
  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  -- Control characters stripped, trimmed, then capped - the same normalisation
  -- cleanPostBody() does on the client, repeated here because the client guard
  -- is not the boundary. The stripped class is 0x01-0x08 and 0x0B-0x1F: tab
  -- (0x09) and newline (0x0A) are kept, since the card renders the body
  -- white-space: pre-wrap, and a text value can never carry 0x00. The bracket
  -- expression is built with chr() rather than written as [[:cntrl:]] so it
  -- does not depend on the database LC_CTYPE, and not [[:print:]] so a
  -- C-locale build cannot strip every Hebrew character.
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

  -- links is optional { workout_id, achievement_id, event_id }. The present
  -- keys are merged into metadata as top-level ids, which is where feed_page
  -- (202608280019) already looks for event_id and challenge_id.
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

  -- Matches the client's optimistic rule: photo-only is POST_PHOTO, anything
  -- with text (with or without photos) is POST_TEXT. The workout_posts
  -- default_post_type trigger would otherwise pick this, but it is set
  -- explicitly so a caption-plus-photo post is not misfiled as POST_PHOTO.
  v_post_type := case
    when v_media_count > 0 and v_body = '' then 'POST_PHOTO'::public.post_type
    else 'POST_TEXT'::public.post_type
  end;

  -- Pinned around this one insert so the new
  -- workout_posts_guard_insert_rate_limit_trigger (SEC-003, this migration)
  -- does not consume a second rate-limit token for a post that already paid
  -- for one on the check_rate_limit() call above.
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

  return v_post_id;
end $$;
revoke all on function public.post_create(text, public.post_visibility, jsonb, jsonb) from public, anon;
grant execute on function public.post_create(text, public.post_visibility, jsonb, jsonb) to authenticated;

-- =====================================================================
-- 2. SEC-006 - avatar-photos had no per-member object cap and no orphan
--    sweep. Mirrors can_upload_post_photo's own count clause (20), using 3
--    rather than 1 so a mid-flight extension change (202609010010:65-68)
--    still has room to delete-then-recreate rather than needing to be
--    perfectly atomic.
-- =====================================================================

create or replace function public.can_write_own_avatar(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and split_part(p_name, '/', 1) = auth.uid()::text
    and exists (
      select 1 from public.profiles p join public.invite_redemptions ir on ir.user_id = p.id
      where p.id = auth.uid() and p.deleted_at is null
    )
    and (select count(*) from storage.objects o
      where o.bucket_id = 'avatar-photos' and split_part(o.name, '/', 1) = auth.uid()::text) < 3;
$$;
revoke all on function public.can_write_own_avatar(text) from public, anon;
grant execute on function public.can_write_own_avatar(text) to authenticated;

create or replace function public.list_orphaned_avatar_photos(p_older_than interval default interval '1 day')
returns table(object_name text)
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o where o.bucket_id = 'avatar-photos'
    and o.created_at < now() - p_older_than
    and not exists (
      select 1 from public.profiles p
      -- avatar_url stores the full public Storage URL, e.g.
      -- .../object/public/avatar-photos/{uid}/avatar.webp?t=<cache-bust>
      -- (202609060006) - the object name must be matched as a SUBSTRING,
      -- not a suffix, or the trailing ?t= query string would make every
      -- in-use avatar look orphaned.
      where p.avatar_url is not null and p.avatar_url like '%' || o.name || '%'
    );
$$;
revoke all on function public.list_orphaned_avatar_photos(interval) from public, anon, authenticated;
grant execute on function public.list_orphaned_avatar_photos(interval) to service_role;

-- =====================================================================
-- 3. SEC-007 - three unbounded client write paths with no rate limit and
--    no size ceiling: private_records, analytics_events, push_subscriptions.
--
--    private_records deliberately keeps NO membership gate (it is the
--    offline-sync channel and is documented to work pre-redemption,
--    COMMUNITY_SETUP.md SS Offline synchronization) and this migration does
--    NOT add one. It also deliberately gets a RATE limit rather than the
--    audit's literally-suggested "row cap": a real athlete's multi-year
--    training history is many thousands of legitimate rows, and a hard cap
--    would silently break a real first-sync for a longtime user. 1000
--    writes per 10 minutes is generous enough to let a large first sync's
--    outbox drain in one window while still bounding a scripted attacker to
--    a finite, logged cost instead of "unbounded by network throughput".
--    Worth a product-owner sanity check against real sync volumes before
--    launch.
-- =====================================================================

-- NOT VALID: this repo has no visibility into whatever payload sizes
-- already exist on the real project (the table has been uncapped since it
-- shipped), and a validating ALTER TABLE would abort this entire migration
-- if even one legacy row exceeds 64 KB. NOT VALID enforces the cap on every
-- new/updated row immediately while leaving existing rows unvalidated - a
-- safe, non-destructive default per this repo's migration-safety rule.
-- Follow-up for whoever owns the real project: run `alter table
-- public.private_records validate constraint private_records_payload_size;`
-- once real data is confirmed to fit, to get the same guarantee retroactively.
alter table public.private_records add constraint private_records_payload_size
  check (pg_column_size(payload) <= 65536) not valid;

create or replace function public.private_records_guard_rate_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.check_rate_limit('private_record_write', 1000, 10) then
    raise exception 'rate_limited';
  end if;
  return new;
end $$;
revoke all on function public.private_records_guard_rate_limit() from public, anon, authenticated;

drop trigger if exists private_records_guard_rate_limit_trigger on public.private_records;
create trigger private_records_guard_rate_limit_trigger
  before insert on public.private_records
  for each row execute function public.private_records_guard_rate_limit();

comment on function public.private_records_guard_rate_limit() is
  'Launch-readiness audit, SEC-007. BEFORE INSERT on private_records. A rate limit, not a row cap: this table is the offline-sync channel and a real multi-year training history is legitimately many thousands of rows, so capping row COUNT would break a real first sync. 1000 inserts / 10 minutes bounds write-amplification abuse while leaving room for a large legitimate outbox to drain. private_records keeps no membership gate here on purpose - it is documented to accept a pre-redemption anonymous session (COMMUNITY_SETUP.md SS Offline synchronization).';

create or replace function public.analytics_events_guard_rate_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.check_rate_limit('analytics_event', 500, 10) then
    raise exception 'rate_limited';
  end if;
  return new;
end $$;
revoke all on function public.analytics_events_guard_rate_limit() from public, anon, authenticated;

drop trigger if exists analytics_events_guard_rate_limit_trigger on public.analytics_events;
create trigger analytics_events_guard_rate_limit_trigger
  before insert on public.analytics_events
  for each row execute function public.analytics_events_guard_rate_limit();

create or replace function public.push_subscriptions_guard_count() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Counts ACTIVE subscriptions only (revoked_at is null), matching the
  -- table's own partial index (push_subscriptions_user_idx) - counting
  -- revoked history too would eventually lock a real long-time member out
  -- of ever registering a new device.
  if (select count(*) from public.push_subscriptions where user_id = new.user_id and revoked_at is null) >= 10 then
    raise exception 'too many push subscriptions for this account';
  end if;
  return new;
end $$;
revoke all on function public.push_subscriptions_guard_count() from public, anon, authenticated;

drop trigger if exists push_subscriptions_guard_count_trigger on public.push_subscriptions;
create trigger push_subscriptions_guard_count_trigger
  before insert on public.push_subscriptions
  for each row execute function public.push_subscriptions_guard_count();

-- =====================================================================
-- 4. SEC-008 - no tenant isolation exists anywhere, and nothing stops a
--    second `clubs` row from silently turning every unfiltered read policy
--    into a cross-tenant leak. The cheap, correct answer for launch per the
--    audit: make the single-club assumption fail loudly if it is ever
--    violated, rather than the currently-silent way it would fail.
-- =====================================================================

create or replace function public.clubs_guard_single_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- A BEFORE INSERT trigger fires BEFORE the RLS WITH CHECK policy, so an
  -- unconditional raise here would preempt clubs_insert_owner and hand a
  -- plain member a P0001 "single_club_invariant" message where RLS would
  -- (and should) have given them a plain 42501 permission-denied - both
  -- leaking this invariant's reasoning to someone not authorized to insert
  -- at all, and breaking 0001_clubs_and_rbac_test's "a plain member cannot
  -- insert a club" assertion, which is the RLS boundary and not this
  -- trigger's business. Caught on the first real pgTAP run. So: defer to RLS
  -- for anyone RLS will refuse anyway, and only speak up for a caller who
  -- WOULD otherwise succeed - the owner, and any non-authenticated session
  -- (service role, dashboard, a future backfill), which is exactly the
  -- SEC-008 case this guard exists for.
  if coalesce(auth.role(), '') = 'authenticated'
     and coalesce(public.my_role_code(), '') <> 'owner' then
    return new;
  end if;

  if (select count(*) from public.clubs) >= 1 then
    raise exception 'single_club_invariant: this schema has no multi-tenant filtering yet (202608280001), so a second clubs row would silently cross-tenant-leak every unfiltered read policy - see SECURITY_AUDIT.md SEC-008 before adding one';
  end if;
  return new;
end $$;
revoke all on function public.clubs_guard_single_row() from public, anon, authenticated;

drop trigger if exists clubs_guard_single_row_trigger on public.clubs;
create trigger clubs_guard_single_row_trigger
  before insert on public.clubs
  for each row execute function public.clubs_guard_single_row();

-- =====================================================================
-- 5. SEC-011 (rate-limiting half) - admin_reset_password had no rate
--    limit at all, unlike every SQL write path in this module. The Edge
--    Function cannot call check_rate_limit() directly (revoked from
--    authenticated), so it gets its own narrow wrapper, called with the
--    admin's own JWT before the password is ever changed.
-- =====================================================================

create or replace function public.admin_check_password_reset_rate_limit() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  if not public.check_rate_limit('admin_password_reset', 5, 60) then
    raise exception 'rate_limited';
  end if;
end $$;
revoke all on function public.admin_check_password_reset_rate_limit() from public, anon;
grant execute on function public.admin_check_password_reset_rate_limit() to authenticated;

comment on function public.admin_check_password_reset_rate_limit() is
  'Launch-readiness audit, SEC-011. Called by the admin_reset_password Edge Function, with the CALLING ADMIN''s own JWT, before it ever calls auth.admin.updateUserById(). Re-checks is_admin() server-side (defense in depth - the Edge Function already checked it) then enforces 5 resets per 60 minutes per admin, so a single compromised or hijacked admin session cannot loop a club-wide password-reset lockout. Raises before any password is changed, unlike the audit RPC (admin_log_password_reset) which only runs after.';

commit;
