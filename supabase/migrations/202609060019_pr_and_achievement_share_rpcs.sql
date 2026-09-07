begin;

-- Five-persona UX audit, defect 1 (LAUNCH BLOCKER): pr_share() and
-- ach_share() are the only two of the client's 63 RPC names with no
-- definition in any migration. Both are fully wired in cloud.js -
-- sharePrPrompt() (cloud.js:9917) and shareAchievementUnlock()
-- (cloud.js:10105) - and both have answered PGRST202 "Could not find the
-- function" since the day they shipped. Sharing a PR and sharing an
-- achievement are the two moments the whole community layer is built around
-- and neither has ever worked once.
--
-- This is the same class of defect 202609060007 closed for
-- post_edit_caption / post_set_visibility: contracts.md documents both, the
-- UI renders both, the function was never written. Built rather than
-- deleted for the same reason.
--
-- ------------------------------------------------------------------
-- ARGUMENT NAMES AND TYPES ARE THE SHIPPED CLIENT'S, NOT contracts.md's
-- ------------------------------------------------------------------
-- PostgREST resolves an RPC by the exact set of named arguments in the
-- request body, so the names below are copied from the live call sites and
-- are deliberately not p_-prefixed, exactly as post_delete, post_create,
-- post_edit_caption and community_profile already are:
--
--   rpc("pr_share",  { record_id, note, media })
--   rpc("ach_share", { member_achievement_id, caption, media })
--
-- ONE PUBLISHED TYPE IS WRONG AND IS NOT FOLLOWED. contracts.md line 991
-- says `pr_share(record_id uuid, ...)`. record_id is NOT a uuid and never
-- was: it is `entry.id` from the offline log, produced by uid("set") in
-- src/shared/safe-helpers.js, which returns the literal string
-- "set-" || crypto.randomUUID(). Shipping the documented uuid parameter
-- would make every call fail to cast in PostgREST before the body ever ran
-- - a second, identical outage on top of the one this migration closes. The
-- parameter is TEXT here, which is also the type private_records.record_id
-- and workout_posts.source_record_id already are. contracts.md needs that
-- one line corrected; ach_share's published signature is correct as-is.
--
-- ------------------------------------------------------------------
-- GATES: post_create's, in post_create's order
-- ------------------------------------------------------------------
-- Both functions are SECURITY DEFINER for post_create's reason - they write
-- public.workout_posts and public.post_media directly, past
-- posts_insert_self and post_media_insert_author - so every gate those
-- policies carry is re-checked by hand:
--   1. a real caller
--   2. is_community_member()            -> redeemed invite AND recovery_verified_at
--   3. has_perm('community.post.create')
--   4. not is_posting_restricted()      -> COMM-153 speech sanction
--   5. check_rate_limit('post_create', 20, 10)
-- The rate limit uses post_create's OWN key, not a per-function key: a
-- member's posting budget is one budget, and a separate key would hand a
-- scripted client 20 posts plus 20 shares plus 20 more per ten minutes.
-- app.allow_unrated_post_insert is pinned around the insert for the same
-- reason post_create pins it (202609060012, SEC-003), so one share consumes
-- exactly one token rather than two.
--
-- THE POST-TYPE PRIVILEGE GUARD (202609060004) needs nothing added here and
-- is deliberately not weakened. POST_PR and POST_ACHIEVEMENT are outside its
-- four staff-only labels, so workout_posts_guard_privileged_type() lets both
-- inserts through on their own merits; neither function can be coaxed into
-- writing a privileged label because neither takes a post_type from the
-- caller at all - both are constants below.
--
-- IDEMPOTENCY, both mechanisms:
--   * The optional p_idempotency_key of 202609060014, same shape as
--     post_create's, so the cloud.js owner can route either call through
--     communityRpc()/OUTBOX_ACTIONS later without a signature change.
--   * A NATURAL key that holds even with no client key at all: the shipped
--     unique constraint workout_posts(author_id, source_type,
--     source_record_id). Both functions look for their own prior post first
--     and return its id instead of inserting, so a double tap on "שיתוף",
--     or a retry after a dropped response, converges on one post rather
--     than raising a unique violation the client would render as a failure.
--
-- OWNERSHIP IS RESOLVED SERVER-SIDE IN BOTH, WITH NO CLIENT TRUST:
-- ach_share reads member_achievements and refuses any row whose user_id is
-- not the caller. pr_share is the harder half and is documented at its own
-- header below.

-- ---------------------------------------------------------------------------
-- Helper: read a number out of a client-written payload without ever
-- raising on one that is not a number.
-- ---------------------------------------------------------------------------
-- private_records.payload is whatever the offline app wrote, so a plain
-- (payload ->> 'weight')::numeric on a row holding "" or "heavy" aborts the
-- whole share with a 22P02 the member cannot act on. A CASE guard is the
-- documented way to make a cast conditional per row; wrapping it in one
-- IMMUTABLE function keeps the four call sites below from drifting apart.
create or replace function public.private_record_number(p_payload jsonb, p_key text)
returns numeric
language sql immutable set search_path = '' as $$
  select case
    when p_payload is null or p_key is null then null
    when jsonb_typeof(p_payload -> p_key) = 'number' then (p_payload ->> p_key)::numeric
    when p_payload ->> p_key ~ '^-?[0-9]+(\.[0-9]+)?$' then (p_payload ->> p_key)::numeric
    else null
  end;
$$;
revoke all on function public.private_record_number(jsonb, text) from public, anon, authenticated;

comment on function public.private_record_number(jsonb, text) is
  'Internal. Reads one numeric key out of a private_records.payload, returning NULL rather than raising when the value is absent, empty or not a number - payload is client-written JSON with no schema, and an unguarded cast would abort pr_share() on a single malformed row. No client grant: only pr_share() calls it.';

-- The cross-owner ownership probe in pr_share() looks up private_records by
-- record_id ALONE, which the (user_id, record_type, record_id) primary key
-- cannot serve. Without this index that probe is a sequential scan of every
-- member's entire training history on every share. Partial, because that
-- probe is the only lookup of this shape and the two session types are the
-- only ones a PR can come from.
create index if not exists private_records_record_id_idx
  on public.private_records(record_id)
  where record_type in ('strength_entry', 'wod_entry');

-- ---------------------------------------------------------------------------
-- pr_share(record_id text, note text, media jsonb, p_idempotency_key uuid)
-- ---------------------------------------------------------------------------
-- OWNERSHIP, and why it is not a flat "the record must be yours".
--
-- The client sends an id and nothing else - no movement, no weight, no
-- improvement - so every number this post publishes has to be read out of
-- the caller's OWN private_records rows or not published at all. That is
-- what makes the id untrusted in the way that matters: there is no path by
-- which a caller-supplied figure reaches a card.
--
-- Three cases, and the middle one is the actual boundary:
--
--   a. The caller owns a live strength_entry / wod_entry row with this
--      record_id. Normal path. Movement, result, previous result,
--      improvement and date are all recomputed here from that row and the
--      caller's own history, exactly as contracts.md promises.
--
--   b. The record_id belongs to a DIFFERENT member. Refused, 'not
--      authorized'. This is the case the audit's "verify ownership
--      server-side" is about: without it a member could attach their post to
--      someone else's record id, and the feed card's "פתיחת האימון" deep
--      link (cloud.js, source_record_id) would then point a reader at a
--      record that is not the post's.
--
--   c. Nobody at all holds this record_id server-side. ALLOWED, and with no
--      performance claim of any kind - note and photo only. This is not a
--      hole, it is the honest answer for a real member: cloud backup is
--      opt-OUT (enableSyncIfAllowed / backupOptedOut, cloud.js), so a member
--      who turned sync off in Settings has a genuine PR on their device and
--      no server copy of it, forever. Refusing here would make "share my PR"
--      permanently, silently broken for them - a UX defect of exactly the
--      kind this audit is closing. It also covers the ordinary race where
--      the share is tapped in the second before flushOutbox() lands the row.
--      An unclaimed id buys the caller nothing they could not already get
--      from post_create with free text.
--
-- KNOWN LIMITATION, recorded rather than papered over: metadata.movement can
-- only be resolved for a CUSTOM movement, because only customMovements are
-- ever synced (app.js queueAllLocalRecordsForSync). A PR on a built-in
-- movement therefore publishes its numbers with no movement name, and
-- renderPrPostCard falls back to "שיא אישי". Closing that needs either the
-- movement name in the call (a signature change, and a client-supplied
-- display string) or a server-side catalogue of the built-in movements;
-- neither is smuggled in here.
--
-- THE METADATA KEYS ARE NOT INVENTED. movement / new_result /
-- previous_result / improvement / achieved_on are what renderPrPostCard
-- (cloud.js:6781) reads, and the first four are precisely the keys
-- feed_page already strips from metadata when the author has
-- show_workout_results off (202608310006). Writing any other key would
-- publish a number the privacy filter does not know to redact.
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

  -- Natural idempotency, ahead of the rate limit so a double tap costs no
  -- budget: workout_posts(author_id, source_type, source_record_id) is
  -- unique, so a second share of one record must converge on the first post
  -- rather than raise 23505. Deleted posts are included deliberately - the
  -- constraint does not exclude them, so re-inserting would fail.
  select p.id into v_post_id
  from public.workout_posts p
  where p.author_id = v_uid
    and p.source_type in ('strength_entry', 'wod_entry')
    and p.source_record_id = pr_share.record_id
  limit 1;
  if v_post_id is not null then
    perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_post_id));
    return v_post_id;
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
  -- and not others by design; see the header.
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
  -- it. This is contracts.md's "improvement is recomputed server-side from
  -- the record, not trusted from the client", and it is the only source of
  -- previous_result / improvement anywhere in this function.
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
  -- caption and no photo says nothing at all. Reachable only in case (c),
  -- and the client's own prompt offers both a note and a photo.
  if v_result is null and v_body = '' and v_media_count = 0 then
    raise exception 'a post needs text or at least one photo';
  end if;

  perform set_config('app.allow_unrated_post_insert', 'on', true);
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

  perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;
revoke all on function public.pr_share(text, text, jsonb, uuid) from public, anon;
grant execute on function public.pr_share(text, text, jsonb, uuid) to authenticated;

comment on function public.pr_share(text, text, jsonb, uuid) is
  'Five-persona UX audit, defect 1. Publishes a POST_PR for one of the caller''s own logged records. SECURITY DEFINER; auth.uid() checked first. ARGUMENT NAMES are the shipped client''s (record_id, note, media), not p_-prefixed, because PostgREST resolves by name; record_id is TEXT, not the uuid contracts.md line 991 documents - the id is uid("set") output ("set-<uuid>"), so a uuid parameter would fail to cast on every call. Gates, in post_create''s order: ''not authorized'' (null caller, or a record_id owned by another member), ''recovery method required'' (not is_community_member()), ''not authorized'' (no community.post.create), ''posting_restricted'' (COMM-153), ''rate_limited'' past 20 per 10 minutes on post_create''s OWN key so shares and posts share one budget, ''record is required'' (null, blank or over 160 chars), ''at most 4 photos per post'', ''each media item needs a storage_path'', ''a post needs text or at least one photo'' (only reachable when no server copy of the record exists AND there is no note and no photo). OWNERSHIP: the caller''s own private_records row is the only source of every figure published - movement (custom movements only; built-in movement names are never synced), new_result, previous_result and improvement are recomputed here from that row and the caller''s own prior records. A record_id held by a DIFFERENT member is refused. A record_id nobody holds is allowed and publishes note and photo only, because cloud backup is opt-out and a member who declined it still owns the PR. IDEMPOTENT twice over: the optional p_idempotency_key (202609060014) and, with no key at all, the unique (author_id, source_type, source_record_id) - a repeat share returns the first post''s id and writes nothing. SIDE EFFECTS: one workout_posts row (POST_PR, visibility club, metadata movement/new_result/previous_result/improvement/achieved_on - the exact keys renderPrPostCard reads and feed_page redacts under show_workout_results), up to 4 post_media rows, one post_create rate-limit token. RETURNS the post id.';

-- ---------------------------------------------------------------------------
-- ach_share(member_achievement_id uuid, caption text, media jsonb,
--           p_idempotency_key uuid)
-- ---------------------------------------------------------------------------
-- Simpler than pr_share in every way that matters: the row being shared is
-- a server-owned member_achievements row, so ownership is one predicate and
-- every word on the card comes from the achievement_definitions row that
-- unlock wrote. Nothing is read from the request but the caption and the
-- media.
--
-- only_me IS REFUSED, per contracts.md ("Rejects a private-visibility
-- achievement"). The client already refuses it (shareAchievementUnlock
-- checks a.visibility === "only_me" before calling), which is exactly why
-- the server has to as well - a client check is not a boundary. The post
-- otherwise inherits the achievement's own visibility rather than
-- defaulting to club, so a friends-only decoration does not become a
-- club-wide post by being shared.
--
-- shared_at is stamped only when it was null, so a re-share of an already
-- shared decoration does not rewrite the date it was first shared.
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
  'Five-persona UX audit, defect 1. Publishes a POST_ACHIEVEMENT for one of the caller''s own member_achievements rows and stamps shared_at. SECURITY DEFINER; auth.uid() checked first. ARGUMENT NAMES are the shipped client''s (member_achievement_id, caption, media), not p_-prefixed, because PostgREST resolves by name; matches contracts.md line 1124. Gates, in post_create''s order: ''not authorized'' (null caller, or a row owned by another member - NOT reported as missing), ''recovery method required'', ''not authorized'' (no community.post.create), ''posting_restricted'', ''rate_limited'' past 20 per 10 minutes on post_create''s own shared key, ''achievement is required'', ''achievement not found'' (unknown row or a definition that has since been deleted), ''a private achievement cannot be shared'' (visibility only_me - the client refuses this too, which is why the server must), ''at most 4 photos per post'', ''each media item needs a storage_path''. The post inherits the ACHIEVEMENT''s visibility (club or friends), never a hardcoded club. Title, result_text and metadata (achievement_id, code, title, badge_icon, explanation, earned_on - the keys renderAchievementPostCard reads) come from achievement_definitions, never from the request. IDEMPOTENT twice over: the optional p_idempotency_key (202609060014) and the unique (author_id, source_type, source_record_id); a repeat share returns the first post''s id, writes no second post, and does not rewrite an existing shared_at. SIDE EFFECTS: one workout_posts row, up to 4 post_media rows, member_achievements.shared_at set when it was null, one post_create rate-limit token. RETURNS the post id.';

commit;
