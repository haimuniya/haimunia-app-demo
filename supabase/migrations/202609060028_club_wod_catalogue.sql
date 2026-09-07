begin;

-- The last structural gap in the weekly-challenge feature: a coach cannot
-- run a club challenge on their OWN programming.
--
-- =====================================================================
-- THE GAP, precisely
-- =====================================================================
-- A weekly challenge is a comparison_key. app.js:2263 builds the WOD form
-- of that key as
--
--     `wod:${entry.wodId}:${entry.scoreType}:${entry.rx ? "rx" : "scaled"}`
--
-- so a challenge is joinable only when EVERY member's client can resolve
-- the same wodId. For a built-in WOD that is free: WOD_LIBRARY ships inside
-- src/constants.js, so `wod:fran:time:rx` means the same thing on every
-- device in the club.
--
-- A CUSTOM WOD IS LOCAL DATA. addCustomWod() mints `customwod-<uuid>`
-- (uid("customwod"), src/shared/safe-helpers.js), stores it in IndexedDB,
-- and allWods() is `WOD_LIBRARY.concat(customWods)`. Custom WODs DO reach
-- this database - as private_records rows of record_type 'custom_wod' - but
-- private_records is per-member by design (202608260001) and nobody but the
-- author can read one. So a challenge keyed to a coach's own WOD is dead on
-- arrival for everyone else: challengeKeyExists() (cloud.js) cannot resolve
-- the id, the row is marked invalid, and no member can even LOG the workout
-- to score against it. The picker fbf5a43 shipped makes that visible by
-- skipping `category === "Custom"` outright - a coach literally cannot
-- select their own programming.
--
-- 202609060026 named this and deliberately did not fix it:
--   "refused by nobody   a well-shaped key naming something real that only
--    ONE member's device knows about (a custom WOD is local data;
--    challengeKeyExists is therefore device-relative)."
-- This migration is the fix it pointed at: a club-level catalogue, so that a
-- WOD id can mean the same thing on every device.
--
-- =====================================================================
-- DECISION 1: WHO PUBLISHES - community.challenge.create, and NOTHING
-- AUTO-PUBLISHES
-- =====================================================================
-- The permission is not invented here. It is the one that already gates
-- creating the thing this exists to serve: weekly_challenges_insert_admin /
-- _update_perm / _delete_perm (202609060005) and every write in the Phase-2
-- challenge model check `has_perm('community.challenge.create')`. Seeded to
-- coach, head_coach, admin and owner (202608280001). Deliberately NOT
-- is_staff(), which 202609060005 explicitly moved weekly_challenges AWAY
-- from - is_staff() also admits the `staff` role, which holds no challenge
-- permission at all, and re-introducing that split here would recreate the
-- exact latent hole that migration closed.
--
-- A MEMBER'S PRIVATE CUSTOM WODs NEVER AUTO-PUBLISH. There is no trigger
-- from private_records to this table and there will not be one. Publishing
-- is an explicit call, by a permission holder, with an audit row. Syncing
-- your training log must never be the same act as publishing it - the whole
-- privacy model of this product rests on that, and private_records carries
-- everything a member has ever logged.
--
-- =====================================================================
-- DECISION 2: THE ID - reuse `customwod-<uuid>`, do not mint a new one
-- =====================================================================
-- The alternative was a fresh id in a `clubwod-` namespace. Reusing the
-- coach's existing local id wins on three counts, and the first is decisive:
--
--   * THE PUBLISHING COACH'S OWN HISTORY ALREADY MATCHES. Their wod_entries
--     carry wodId = customwod-<uuid> and their published workout_posts carry
--     comparison_key wod:customwod-<uuid>:<type>:<rx|scaled>. Under a new id
--     every one of those rows would silently stop matching the challenge
--     they were programmed for, and the coach - the person most likely to
--     have already logged it - would be the one member the board excludes.
--   * NO CLIENT-SIDE ID REMAPPING. allWods() merges the club catalogue by
--     id; nothing has to rewrite existing entries, and no migration of
--     IndexedDB data is needed on any device.
--   * ONE NAMESPACE, ONE MEANING. `customwod-<uuid>` already means "a WOD
--     this app's builder produced". Publishing changes who can SEE it, not
--     what it is.
--
-- THE CHECK THIS DEPENDS ON WAS VERIFIED, NOT ASSUMED.
-- weekly_challenges_comparison_key_shape (202609060026) requires
-- `wod:[a-z0-9-]+:[a-z]+:(rx|scaled)`. uid() returns
-- prefix + "-" + crypto.randomUUID(), and randomUUID is lower-case hex with
-- hyphens; both fallback paths (lower-case hex from getRandomValues, or
-- Date.now().toString(36) + Math.random().toString(36)) are also lower-case
-- alphanumeric. So `customwod-<uuid>` matches [a-z0-9-]+ on every path.
-- 0088_weekly_challenge_key_shape_test.sql already asserts exactly this key
-- is accepted. Length also checked: 128 (cleanId's LIMITS.idLen cap) + the
-- 17 characters of "wod:" + ":" + "scaled" + a 5-char score type = 145, well
-- inside comparison_key's 1..160 CHECK.
--
-- WHAT THE wod_id CHECK BELOW THEREFORE REFUSES, and why it is not
-- decoration: cleanId() accepts [A-Za-z0-9._:-], so an IMPORTED backup file
-- can put a custom WOD on this device with id `customwod-ABC.x:y`. That id
-- is legal locally and produces a comparison_key the weekly_challenges CHECK
-- rejects - i.e. a WOD that could be published and then never used for the
-- one thing publishing is for. Refusing it here, at publish time, is the
-- only place the coach can still be told. It also pins the namespace, so a
-- published WOD can never shadow a WOD_LIBRARY id like `fran`.
--
-- =====================================================================
-- DECISION 3: A SNAPSHOT, NOT A LIVE REFERENCE
-- =====================================================================
-- Publishing COPIES the definition into this table. The coach's local copy
-- and the club copy are separate from that moment on, and editing the local
-- one changes nothing here.
--
-- The alternative - the club version tracking the author's private_records
-- row - would mean a live challenge silently changing what it asks of
-- people, mid-week, with scores already on the board. That is the same class
-- of defect as the ones this branch has been fixing, and it would also make
-- the club catalogue depend on a member keeping cloud backup switched on
-- (it is opt-OUT, so it can be switched off at any time, taking the club's
-- WOD with it).
--
-- The snapshot is made VISIBLE rather than silent: club_wod_publish() with
-- the same wod_id and IDENTICAL fields returns the existing row (so a double
-- tap is safe), and with the same wod_id and DIFFERENT fields RAISES
-- 'wod already published'. A coach who edited locally and re-published is
-- told their edit did not propagate, instead of quietly believing it did.
-- club_wod_edit() below is the narrow, audited, challenge-aware path for a
-- real correction.
--
-- =====================================================================
-- DECISION 4: RETIREMENT, NEVER DELETION
-- =====================================================================
-- There is NO delete grant and no delete policy on this table, for any
-- client role. A published WOD is referenced by three things that outlive
-- any decision to stop programming it: weekly_challenges rows, the
-- comparison_key on workout_posts (which is how the leaderboard joins), and
-- every member's local wod_entries. Deleting the row would strand all three
-- - wodById() would return undefined and a member's own logged history would
-- render as an unknown workout.
--
-- So retirement is a FLAG, and club_wods_list() keeps returning retired rows
-- with `retiredAt` set. The client must keep merging them into allWods() so
-- that history and challenge keys always resolve; what retirement changes is
-- that the WOD is hidden from the pickers for NEW logs and NEW challenges.
-- Retirement of a WOD referenced by a challenge that has not yet ended is
-- refused outright ('wod is used by a live challenge'), so a coach cannot
-- pull the workout out from under a challenge that is running.
--
-- =====================================================================
-- DECISION 5: THE FIELD SET IS sanitizeCustomWod's, EXACTLY
-- =====================================================================
-- src/sanitize.js sanitizeCustomWod() produces
--   { id, name, category:"Custom", scoreType, desc, timeCapSeconds }
-- plus, for scoreType 'emom' only,
--   { emomMovements[], emomTargetReps[], emomMinutes }
-- and that is the whole definition. Every column below is one of those; no
-- field is invented that the client has nothing to put in. `category` is the
-- one exception and is NOT stored: it is a render-time constant, returned as
-- the literal 'Club' by club_wod_json() so that
--   * cloud.js challengeKeyChoices() stops skipping it (it skips
--     `category === "Custom"`), and
--   * app.js deleteCustomWod() refuses it (it requires
--     `category === "Custom"`), so a member cannot delete club programming
--     off their own device by mistake.
-- Storing a per-row category would let those two behaviours diverge per row
-- for no gain.
--
-- EMOM IS PUBLISHABLE EVEN THOUGH IT CAN NEVER BE A CHALLENGE.
-- wodShareCandidate() returns comparisonKey null for scoreType 'emom' and
-- the picker skips it, so no EMOM key exists to compare. A shared catalogue
-- of the coach's programming is worth having on its own - members can log
-- the workout - so EMOM is allowed here and the emom_* columns carry the
-- rotation renderWodLogSection() needs. The challenge picker keeps excluding
-- it, unchanged.

-- =====================================================================
-- 1. THE TABLE
-- =====================================================================
create table if not exists public.club_wods (
  -- A surrogate uuid, because admin_actions.target_id is uuid and every
  -- staff action below has to be nameable in the audit log. The MEANINGFUL
  -- key is wod_id.
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),

  -- The client-side WOD id, unchanged from the coach's own device. UNIQUE:
  -- one club definition per id, forever - that uniqueness is what makes
  -- "every member resolves the same wodId" true.
  wod_id text not null unique
    check (wod_id ~ '^customwod-[a-z0-9-]+$' and char_length(wod_id) <= 128),

  -- LIMITS.nameLen / LIMITS.notesLen from src/constants.js.
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 300),

  -- WOD_SCORE_TYPES. This is the segment that lands in the comparison key,
  -- which is why it is a closed set here and immutable after publish: a
  -- score type change would silently repoint every future entry at a
  -- different key from the one the challenge was created with.
  score_type text not null check (score_type in ('time', 'amrap', 'load', 'emom')),

  -- EMOM structure. Empty arrays / null for every other score type, pinned
  -- by club_wods_emom_shape below rather than left to the writer.
  emom_movements text[] not null default '{}',
  emom_target_reps integer[] not null default '{}',
  emom_minutes integer check (emom_minutes is null or emom_minutes between 1 and 999),

  -- Reference-only, exactly as on the client: shown in the log form, never
  -- enforced and never scored against. LIMITS.minutes * 60 + 59.
  time_cap_seconds integer check (time_cap_seconds is null or time_cap_seconds between 1 and 59999),

  -- on delete set null, not cascade: the club's catalogue must not lose a
  -- workout because the coach who published it left, and every member's
  -- logged history depends on the row still being there.
  published_by uuid references public.profiles(id) on delete set null,
  published_at timestamptz not null default now(),

  retired_at timestamptz,
  retired_by uuid references public.profiles(id) on delete set null,
  retired_reason text check (retired_reason is null or char_length(retired_reason) <= 500),

  -- Every array_length is wrapped in coalesce: array_length of an empty
  -- array is NULL, not 0, and a CHECK that evaluates to NULL is SATISFIED.
  -- Written the obvious way, an EMOM row with no movements would slip
  -- straight through the constraint meant to forbid it.
  constraint club_wods_emom_shape check (
    (score_type = 'emom'
       and coalesce(array_length(emom_movements, 1), 0) between 1 and 20
       and coalesce(array_length(emom_target_reps, 1), 0) = coalesce(array_length(emom_movements, 1), 0)
       and emom_minutes is not null)
    or
    (score_type <> 'emom'
       and coalesce(array_length(emom_movements, 1), 0) = 0
       and coalesce(array_length(emom_target_reps, 1), 0) = 0
       and emom_minutes is null)
  ),
  constraint club_wods_retired_shape check (
    (retired_at is null and retired_by is null and retired_reason is null)
    or retired_at is not null
  )
);

create index if not exists club_wods_active_idx
  on public.club_wods(published_at desc) where retired_at is null;

-- DB-M3 (202609060015): every public foreign-key column outside club_id
-- leads an index, so `on delete set null` does not sequentially scan this
-- table when a coach's profile is removed. That rule is asserted as a
-- PROPERTY over the catalog in 0081_indexes_impersonation_and_dormant_jobs_test,
-- not as a name list, so a new FK without an index fails the suite - which is
-- exactly what these two answer. club_id is the documented exclusion (one
-- club row exists).
create index if not exists club_wods_published_by_idx
  on public.club_wods(published_by) where published_by is not null;
create index if not exists club_wods_retired_by_idx
  on public.club_wods(retired_by) where retired_by is not null;

comment on table public.club_wods is
  'The club WOD catalogue: staff-published workout definitions every community member can read, so that a weekly-challenge comparison_key of the form wod:<id>:<score_type>:<rx|scaled> resolves on EVERY device instead of only the author''s. Closes the gap 202609060026 named and left open - a custom WOD is local data (IndexedDB + a private_records row nobody else can read), so a challenge keyed to a coach''s own programming was invisible and unscoreable for the rest of the club. wod_id is the coach''s OWN customwod-<uuid>, reused rather than reminted, so their already-logged entries and already-published posts match the challenge from day one. Every row is a SNAPSHOT taken at publish time: editing the local copy afterwards changes nothing here, and re-publishing a changed definition raises rather than silently overwriting a live challenge''s meaning. WRITES: none by RLS - no insert/update/delete grant to any client role. Everything goes through club_wod_publish / club_wod_edit / club_wod_retire / club_wod_restore, all gated on community.challenge.create and all audited. READS: every is_community_member(). NOTHING AUTO-PUBLISHES: there is no trigger from private_records and there must never be one.';

comment on column public.club_wods.wod_id is
  'The client-side WOD id, byte-identical to the id on the publishing coach''s device (uid("customwod") -> "customwod-" + crypto.randomUUID()). The CHECK pins the namespace for two reasons: a published WOD can never shadow a WOD_LIBRARY id like "fran", and the resulting comparison_key wod:<wod_id>:<score_type>:(rx|scaled) is guaranteed to satisfy weekly_challenges_comparison_key_shape (202609060026). That second half is not decoration - cleanId() accepts [A-Za-z0-9._:-], so an imported backup can create a locally-legal id such as customwod-ABC.x:y whose key the weekly_challenges CHECK would reject, and publish time is the only moment a coach can still be told.';
comment on column public.club_wods.score_type is
  'WOD_SCORE_TYPES from src/constants.js. Appears verbatim in the comparison key, which is why it is immutable after publish - club_wod_edit() cannot change it. emom is publishable (members can log the coach''s programming) but can never be a challenge: wodShareCandidate() returns a null comparisonKey for it and the picker skips it.';
comment on column public.club_wods.retired_at is
  'Retirement, which is the ONLY way a published WOD leaves circulation - there is no delete grant. A retired row is still returned by club_wods_list() and must still be merged into the client''s allWods(), because weekly_challenges rows, workout_posts.comparison_key values and every member''s local wod_entries all reference the id; dropping it would render a member''s own logged history as an unknown workout. What retirement changes is that the WOD is hidden from the pickers for new logs and new challenges. Retiring a WOD referenced by a challenge that has not ended is refused.';

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.club_wods enable row level security;
revoke all on public.club_wods from public, anon, authenticated;

-- SELECT only. No insert, update or delete grant at all - not merely no
-- policy. Every write is a definer RPC below, which is what lets publish
-- carry the ownership probe, the snapshot rule, the challenge-liveness
-- check and the audit row as one atomic thing a client cannot step around
-- with a direct PostgREST call.
grant select on public.club_wods to authenticated;

-- is_community_member(), not `true`: this is club content and an anonymous
-- sign-in session holds a real authenticated JWT and nothing else
-- (202609060001). Same predicate announcements_read and weekly_challenges_read
-- carry. Retired rows are deliberately INSIDE the policy - see the retired_at
-- comment; a client that cannot read them cannot resolve its own history.
create policy club_wods_read on public.club_wods
  for select to authenticated
  using (public.is_community_member());

-- =====================================================================
-- 2. THE CLIENT SHAPE, in one place
-- =====================================================================
-- Returned by both club_wods_list() and the three write RPCs, so there is
-- exactly one definition of "what a club WOD looks like to the client" and
-- the list and the publish response can never disagree.
--
-- The keys are the CLIENT's, not the column names: sanitizeCustomWod()
-- (src/sanitize.js) consumes { id, name, category, scoreType, desc,
-- emomMovements, emomTargetReps, emomMinutes, timeCapSeconds }, so cloud.js
-- can hand these straight to it with no remapping. Every key is present on
-- every row - a stable shape, with emom fields as [] / null off an EMOM -
-- so the client never has to test for absence.
--
-- 'category' is the literal 'Club'. See the header: it is what makes the
-- challenge picker stop skipping these (cloud.js skips "Custom") and what
-- makes app.js deleteCustomWod() refuse them (it requires "Custom").
create or replace function public.club_wod_json(w public.club_wods) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', w.wod_id,
    'name', w.name,
    'category', 'Club',
    'scoreType', w.score_type,
    'desc', w.description,
    'emomMovements', to_jsonb(w.emom_movements),
    'emomTargetReps', to_jsonb(w.emom_target_reps),
    'emomMinutes', w.emom_minutes,
    'timeCapSeconds', w.time_cap_seconds,
    'publishedBy', w.published_by,
    'publishedAt', w.published_at,
    'retiredAt', w.retired_at
  );
$$;
-- GRANTED to authenticated, unlike most internal helpers in this module,
-- and the reason is club_wods_list() being SECURITY INVOKER: an invoker
-- function executes with the CALLER's rights, so a formatter the caller
-- cannot execute would make the list raise "permission denied for function".
-- That is safe here in a way it is not for audit_identity_label() or
-- private_record_number(): this function reads no table and touches no
-- catalogue. It takes a whole club_wods row as its argument, so a caller can
-- only apply it to a row they already hold, and it returns nothing that row
-- did not already contain.
revoke all on function public.club_wod_json(public.club_wods) from public, anon;
grant execute on function public.club_wod_json(public.club_wods) to authenticated;

comment on function public.club_wod_json(public.club_wods) is
  'One club_wods row to the exact object shape src/sanitize.js sanitizeCustomWod() consumes - id (the wod_id), name, category (the literal ''Club''), scoreType, desc, emomMovements, emomTargetReps, emomMinutes, timeCapSeconds - plus publishedBy, publishedAt and retiredAt. Every key is always present so the client never tests for absence. It is the shared body of club_wods_list() and the three write RPCs, which is what stops the list and the publish response from disagreeing about the shape. Granted to authenticated only because club_wods_list() is SECURITY INVOKER and would otherwise be unable to call it; that is harmless here because the function reads nothing - it takes a whole row as its argument, so a caller can only apply it to a row they can already read.';

-- =====================================================================
-- 3. club_wods_list() - the read
-- =====================================================================
-- SECURITY INVOKER, so club_wods_read is the boundary and this function
-- cannot become a way around it; the two gates are stated anyway, in the
-- module's order, so the failure is an honest message rather than an empty
-- list. Same shape admin_actions_page() uses (202609060022).
--
-- RETURNS RETIRED ROWS TOO, always, with no filter parameter. That is not
-- an oversight: the client MUST hold every id it might have to resolve -
-- an old wod_entry of its own, a comparison_key on a post in the feed, a
-- challenge from three weeks ago - and a caller that could ask for "active
-- only" would eventually be wired into allWods() and reintroduce exactly
-- the unresolvable-id defect this migration exists to fix. Hiding retired
-- WODs is a PICKER decision and belongs in the picker.
create or replace function public.club_wods_list() returns setof jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  return query
    select public.club_wod_json(w)
    from public.club_wods w
    where w.club_id = public.default_club_id()
    order by w.published_at asc, w.wod_id asc;
end $$;
revoke all on function public.club_wods_list() from public, anon;
grant execute on function public.club_wods_list() to authenticated;

comment on function public.club_wods_list() is
  'The club WOD catalogue, oldest first, as client-shaped objects (see club_wod_json). AUTH: security invoker - auth.uid() first (''not authorized''), then is_community_member() (''recovery method required''), with club_wods_read underneath it, so this cannot become a way around the policy. Takes no arguments and ALWAYS INCLUDES RETIRED ROWS, deliberately: the client has to be able to resolve every id it might meet (its own old wod_entries, a comparison_key on a feed post, a challenge from weeks ago), and an "active only" option would sooner or later be wired into allWods() and recreate the unresolvable-id defect this catalogue exists to fix. Each row carries retiredAt; hiding retired WODs is a picker decision and belongs in the picker. Read-only.';

-- =====================================================================
-- 4. THE AUDIT LABELS
-- =====================================================================
-- Both constraints restated IN FULL by the migration that widens them last,
-- the module's convention since 202609010001. Four action types, because a
-- log that cannot tell publishing from retiring is the defect 202609060022
-- was written to fix (comment_moderate logged the same label for taking a
-- comment down and putting it back).
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review', 'member_of_week_publish',
  'monthly_recap_publish', 'club_feature_toggle', 'invite_created',
  'invite_revoked', 'shared_code_created', 'shared_code_status_changed',
  'onboarding_content_updated', 'member_password_reset', 'announcement_edit',
  'member_remove', 'invite_reclaimed',
  -- The club WOD catalogue.
  'club_wod_published', 'club_wod_edited', 'club_wod_retired', 'club_wod_restored'
));

alter table public.admin_actions drop constraint if exists admin_actions_target_type_check;
alter table public.admin_actions add constraint admin_actions_target_type_check check (target_type in (
  'post', 'comment', 'member', 'role', 'challenge', 'achievement',
  'event', 'announcement', 'report', 'club',
  'monthly_club_recap',
  'challenge_participant', 'challenge_team',
  'invite', 'invite_code',
  'onboarding_step',
  -- The club WOD catalogue. No member behind it, so log_admin_action()
  -- leaves target_user_id null, which is correct: publishing a workout is
  -- an action on club content, not on a person.
  'club_wod'
));

-- =====================================================================
-- 5. THE LIVE-CHALLENGE PROBE
-- =====================================================================
-- "Is this WOD spoken for?" asked once, by both club_wod_retire() and
-- club_wod_edit(), so the two can never drift apart on what counts.
--
-- split_part rather than LIKE: LIKE would need the id escaped for % and _.
-- The wod_id CHECK forbids both characters, so LIKE would in fact be safe
-- today - and that is exactly the kind of safety that stops being true when
-- someone later widens the CHECK. Positional equality cannot rot.
--
-- p_from is the boundary the two callers disagree on, deliberately:
--   retire  -> current_date, i.e. any challenge that has not ENDED. A
--              running or scheduled challenge must keep its workout.
--   edit    -> the challenge must not have STARTED. A finished challenge's
--              board is a record of what people actually did against a
--              stated workout, and rewriting the workout underneath it
--              falsifies that record after the fact.
create or replace function public.club_wod_challenge_conflict(p_wod_id text, p_include_started boolean)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.weekly_challenges wc
    where split_part(wc.comparison_key, ':', 1) = 'wod'
      and split_part(wc.comparison_key, ':', 2) = p_wod_id
      and (case when p_include_started then wc.starts_on <= current_date else false end
           or wc.ends_on >= current_date)
  );
$$;
revoke all on function public.club_wod_challenge_conflict(text, boolean) from public, anon, authenticated;

comment on function public.club_wod_challenge_conflict(text, boolean) is
  'Internal. True when a weekly_challenges row references this wod_id in a way that should freeze it. p_include_started false: only challenges that have not yet ENDED (what club_wod_retire refuses over - a running or scheduled challenge must keep its workout). p_include_started true: those PLUS every challenge that has already started, including finished ones (what club_wod_edit refuses over - a finished board records what people did against a stated workout, and rewriting the workout afterwards falsifies it). SECURITY DEFINER so it sees every challenge row regardless of the caller''s policy view; no client grant. Matches on comparison_key by position rather than LIKE so it cannot rot if the wod_id charset is ever widened.';

-- =====================================================================
-- 6. club_wod_publish()
-- =====================================================================
-- GATES, in the module's standing order: a real caller, then
-- is_community_member(), then the permission. Rate limiting is deliberately
-- NOT applied - unlike post_create this is not a member-facing write path,
-- the callers are four seeded staff roles, and every call is already
-- audited and constrained by the unique wod_id.
--
-- THE DEFINITION COMES FROM THE CALL, NOT FROM private_records, and that is
-- the point of a snapshot: the coach may have just built the WOD seconds ago
-- (the outbox has not flushed), or may have cloud backup switched off
-- entirely - it is opt-OUT (enableSyncIfAllowed / backupOptedOut), so there
-- is no guarantee a server copy exists at all. Reading the definition from
-- private_records would make publishing fail for exactly the coach who most
-- wants to publish. Nothing in the payload is trusted for anything but the
-- definition itself: it grants no access, names no member, and is normalised
-- here byte-for-byte the way cleanStr()/cleanNum() normalise it on the
-- client.
--
-- OWNERSHIP IS STILL PROBED, in pr_share()'s three-case shape
-- (202609060019), and the middle case is a real defect and not a
-- formality:
--   a. no server copy of this record_id anywhere -> ALLOWED (sync off, or
--      not yet flushed; see above).
--   b. the caller's own private_records row              -> ALLOWED.
--   c. the record_id is SOMEBODY ELSE'S private custom WOD -> REFUSED,
--      'not authorized'. Without this a coach could publish under a
--      member's private id; that member's client would then merge a club
--      WOD whose id collides with a different local workout of their own,
--      and their history would silently start rendering as someone else's
--      programming. It is also, plainly, publishing another member's
--      private record.
create or replace function public.club_wod_publish(
  p_wod_id text,
  p_name text,
  p_score_type text,
  p_description text default '',
  p_emom_movements jsonb default null,
  p_emom_target_reps jsonb default null,
  p_emom_minutes integer default null,
  p_time_cap_seconds integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_ctrl text;
  v_wod_id text;
  v_name text;
  v_desc text;
  v_score text;
  v_moves text[] := '{}';
  v_reps integer[] := '{}';
  v_minutes integer;
  v_cap integer;
  v_existing public.club_wods;
  v_row public.club_wods;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;

  -- cleanStr()'s class exactly: 0x01-0x1F and 0x7F. Built with chr() rather
  -- than [[:cntrl:]] for post_create's reason (202608280023) - a character
  -- class must not depend on the database LC_CTYPE when the text is Hebrew.
  v_ctrl := '[' || chr(1) || '-' || chr(31) || chr(127) || ']';

  v_wod_id := btrim(coalesce(p_wod_id, ''));
  if v_wod_id !~ '^customwod-[a-z0-9-]+$' or char_length(v_wod_id) > 128 then
    raise exception 'wod id must be a custom WOD id';
  end if;

  v_name := left(btrim(regexp_replace(coalesce(p_name, ''), v_ctrl, '', 'g')), 80);
  if v_name = '' then raise exception 'a wod needs a name'; end if;
  v_desc := left(btrim(regexp_replace(coalesce(p_description, ''), v_ctrl, '', 'g')), 300);

  v_score := coalesce(p_score_type, '');
  if v_score not in ('time', 'amrap', 'load', 'emom') then
    raise exception 'unknown score type';
  end if;

  if v_score = 'emom' then
    if p_emom_movements is null or jsonb_typeof(p_emom_movements) <> 'array'
       or jsonb_array_length(p_emom_movements) = 0 then
      raise exception 'an emom needs at least one movement';
    end if;
    -- LIMITS.emomMovements.
    if jsonb_array_length(p_emom_movements) > 20 then
      raise exception 'at most 20 emom movements';
    end if;
    select array_agg(left(btrim(regexp_replace(coalesce(t.x #>> '{}', ''), v_ctrl, '', 'g')), 80) order by t.ord)
      into v_moves
      from jsonb_array_elements(p_emom_movements) with ordinality t(x, ord);
    if exists (select 1 from unnest(v_moves) m where m = '') then
      raise exception 'an emom movement needs a name';
    end if;
    -- Positional, so they must line up exactly. sanitizeCustomWod() pads a
    -- short target list with zeroes; refusing instead is the honest choice
    -- on a boundary - a rotation whose rep counts do not match its movements
    -- is a client bug, and silently inventing zeroes would publish it.
    if p_emom_target_reps is null or jsonb_typeof(p_emom_target_reps) <> 'array'
       or jsonb_array_length(p_emom_target_reps) <> array_length(v_moves, 1) then
      raise exception 'emom target reps must match the movements';
    end if;
    select array_agg(
             least(1000, greatest(0, round(coalesce(
               public.private_record_number(jsonb_build_object('v', t.x), 'v'), 0))))::integer
             order by t.ord)
      into v_reps
      from jsonb_array_elements(p_emom_target_reps) with ordinality t(x, ord);
    -- LIMITS.minutes, and sanitizeCustomWod()'s own default of 10.
    v_minutes := least(999, greatest(1, coalesce(p_emom_minutes, 10)));
  end if;

  if p_time_cap_seconds is not null and p_time_cap_seconds > 0 then
    v_cap := least(59999, p_time_cap_seconds);
  end if;

  -- Case (c): somebody else's private custom WOD. See the header.
  if exists (
    select 1 from public.private_records pr
    where pr.record_type = 'custom_wod'
      and pr.record_id = v_wod_id
      and pr.user_id <> v_uid
  ) then
    raise exception 'not authorized';
  end if;

  select * into v_existing from public.club_wods w where w.wod_id = v_wod_id;
  if found then
    -- Idempotent for a double tap or a retried request: the identical
    -- definition returns the row that is already there and writes nothing,
    -- not even an audit row.
    if v_existing.name = v_name
       and v_existing.score_type = v_score
       and v_existing.description = v_desc
       and v_existing.emom_movements is not distinct from v_moves
       and v_existing.emom_target_reps is not distinct from v_reps
       and v_existing.emom_minutes is not distinct from v_minutes
       and v_existing.time_cap_seconds is not distinct from v_cap then
      return public.club_wod_json(v_existing);
    end if;
    -- The snapshot rule, made audible. Silently overwriting would change
    -- what a running challenge asks of people, mid-week, with scores already
    -- on the board.
    raise exception 'wod already published';
  end if;

  insert into public.club_wods
    (wod_id, name, description, score_type, emom_movements, emom_target_reps,
     emom_minutes, time_cap_seconds, published_by)
  values
    (v_wod_id, v_name, v_desc, v_score, v_moves, v_reps,
     v_minutes, v_cap, v_uid)
  returning * into v_row;

  perform public.log_admin_action(
    'club_wod_published', 'club_wod', v_row.id,
    null,
    jsonb_build_object('wod_id', v_row.wod_id, 'name', v_row.name,
                       'score_type', v_row.score_type),
    v_row.score_type);

  return public.club_wod_json(v_row);
end $$;
revoke all on function public.club_wod_publish(text, text, text, text, jsonb, jsonb, integer, integer)
  from public, anon;
grant execute on function public.club_wod_publish(text, text, text, text, jsonb, jsonb, integer, integer)
  to authenticated;

comment on function public.club_wod_publish(text, text, text, text, jsonb, jsonb, integer, integer) is
  'Publishes one custom WOD to the club catalogue as a SNAPSHOT. AUTH: security definer; auth.uid() (''not authorized''), then is_community_member() (''recovery method required''), then has_perm(''community.challenge.create'') (''not authorized'') - the same permission that gates creating the weekly challenge this exists to serve, NOT is_staff(), which 202609060005 moved weekly_challenges away from. p_wod_id is the coach''s OWN customwod-<uuid>, reused rather than reminted so their already-logged entries and posts match the challenge immediately; it must match ^customwod-[a-z0-9-]+$ and be at most 128 characters (''wod id must be a custom WOD id''), which also guarantees the resulting wod:<id>:<score_type>:(rx|scaled) satisfies weekly_challenges_comparison_key_shape. The definition is taken from the CALL, not from private_records, because cloud backup is opt-out and the WOD may never have synced; name and description are normalised exactly as cleanStr() does (control characters stripped, trimmed, capped at 80 / 300). EMOM requires 1..20 named movements and a positionally matching target-reps array (''an emom needs at least one movement'', ''at most 20 emom movements'', ''an emom movement needs a name'', ''emom target reps must match the movements''). Ownership is probed in pr_share''s three-case shape: no server copy anywhere is ALLOWED (sync off or not yet flushed), the caller''s own row is allowed, and another member''s private custom_wod record_id raises ''not authorized''. Re-publishing the SAME wod_id with an identical definition returns the existing row and writes nothing (idempotent under a double tap); with a CHANGED definition it raises ''wod already published'' rather than overwriting - the snapshot rule made audible, so a coach who edited locally is told the edit did not propagate. Returns the club_wod_json shape. Audits ''club_wod_published'' on target_type ''club_wod''.';

-- =====================================================================
-- 7. club_wod_edit()
-- =====================================================================
-- The narrow correction path, and the reason the snapshot rule is livable.
-- Without it a typo in a club-wide catalogue that has no delete grant would
-- be permanent.
--
-- WHAT IT CANNOT TOUCH, and why: wod_id, score_type, the EMOM rotation and
-- the time cap. score_type is in the comparison key, so changing it
-- repoints every future entry at a different key than the challenge was
-- created with. The EMOM rotation is what renderWodLogSection() draws the
-- per-movement rep fields from, so changing it after members have logged
-- the workout makes their stored reps line up with different movements.
-- Those are corrections by retire-and-republish, which produces a new id
-- and therefore an honestly new workout.
--
-- WHEN IT REFUSES: as soon as any challenge referencing this WOD has
-- STARTED, finished ones included. A board is a record of what people did
-- against a stated workout.
create or replace function public.club_wod_edit(
  p_wod_id text,
  p_name text,
  p_description text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_ctrl text;
  v_name text;
  v_desc text;
  v_existing public.club_wods;
  v_row public.club_wods;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;

  select * into v_existing from public.club_wods w where w.wod_id = btrim(coalesce(p_wod_id, ''));
  if not found then raise exception 'wod not found'; end if;

  v_ctrl := '[' || chr(1) || '-' || chr(31) || chr(127) || ']';
  v_name := left(btrim(regexp_replace(coalesce(p_name, ''), v_ctrl, '', 'g')), 80);
  if v_name = '' then raise exception 'a wod needs a name'; end if;
  v_desc := left(btrim(regexp_replace(coalesce(p_description, ''), v_ctrl, '', 'g')), 300);

  if v_existing.name = v_name and v_existing.description = v_desc then
    return public.club_wod_json(v_existing);
  end if;

  if public.club_wod_challenge_conflict(v_existing.wod_id, true) then
    raise exception 'wod is locked by a challenge';
  end if;

  update public.club_wods
     set name = v_name, description = v_desc
   where id = v_existing.id
  returning * into v_row;

  perform public.log_admin_action(
    'club_wod_edited', 'club_wod', v_row.id,
    jsonb_build_object('wod_id', v_existing.wod_id, 'name', v_existing.name,
                       'description', v_existing.description),
    jsonb_build_object('wod_id', v_row.wod_id, 'name', v_row.name,
                       'description', v_row.description));

  return public.club_wod_json(v_row);
end $$;
revoke all on function public.club_wod_edit(text, text, text) from public, anon;
grant execute on function public.club_wod_edit(text, text, text) to authenticated;

comment on function public.club_wod_edit(text, text, text) is
  'Corrects the DISPLAY half of a published club WOD - name and description, nothing else. Exists because the catalogue has no delete grant and publish refuses to overwrite, so without it a typo would be permanent. AUTH: security definer; auth.uid(), is_community_member(), has_perm(''community.challenge.create''), same order and messages as club_wod_publish. CANNOT change wod_id, score_type, the EMOM rotation or the time cap: score_type is in the comparison key (changing it repoints future entries at a key the challenge was not created with) and the rotation is what the log form draws its per-movement rep fields from (changing it makes already-logged reps line up with different movements). Those are retire-and-republish, which mints an honestly new id. Raises ''wod not found''; ''a wod needs a name''; and ''wod is locked by a challenge'' as soon as ANY weekly challenge referencing this WOD has started, finished ones included - a leaderboard is a record of what people did against a stated workout. A no-op edit returns the row unchanged and writes no audit row. Audits ''club_wod_edited'' with before and after.';

-- =====================================================================
-- 8. club_wod_retire() / club_wod_restore()
-- =====================================================================
-- Retirement is the only exit. See the retired_at column comment for why
-- deletion is not offered to anyone: three separate things reference the id
-- and all of them outlive the decision to stop programming it.
create or replace function public.club_wod_retire(
  p_wod_id text,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_existing public.club_wods;
  v_row public.club_wods;
  v_reason text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;

  select * into v_existing from public.club_wods w where w.wod_id = btrim(coalesce(p_wod_id, ''));
  if not found then raise exception 'wod not found'; end if;
  -- Already retired: idempotent, no second audit row. Retiring twice is a
  -- retry, not a new decision.
  if v_existing.retired_at is not null then return public.club_wod_json(v_existing); end if;

  if public.club_wod_challenge_conflict(v_existing.wod_id, false) then
    raise exception 'wod is used by a live challenge';
  end if;

  v_reason := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''),
                 '[' || chr(1) || '-' || chr(31) || chr(127) || ']', '', 'g')), 500), '');

  update public.club_wods
     set retired_at = now(), retired_by = v_uid, retired_reason = v_reason
   where id = v_existing.id
  returning * into v_row;

  perform public.log_admin_action(
    'club_wod_retired', 'club_wod', v_row.id,
    jsonb_build_object('wod_id', v_row.wod_id, 'retired_at', null),
    jsonb_build_object('wod_id', v_row.wod_id, 'retired_at', v_row.retired_at),
    null, v_reason);

  return public.club_wod_json(v_row);
end $$;
revoke all on function public.club_wod_retire(text, text) from public, anon;
grant execute on function public.club_wod_retire(text, text) to authenticated;

comment on function public.club_wod_retire(text, text) is
  'Retires a published club WOD. The ONLY exit - there is no delete grant for any client role, because weekly_challenges rows, workout_posts.comparison_key values and every member''s local wod_entries all reference the id, and dropping the row would render a member''s own logged history as an unknown workout. A retired row is STILL returned by club_wods_list() and must still be merged into the client''s allWods(); what retirement changes is that the WOD leaves the pickers for new logs and new challenges. AUTH: security definer; auth.uid(), is_community_member(), has_perm(''community.challenge.create''). Raises ''wod not found'', and ''wod is used by a live challenge'' when a weekly challenge referencing this WOD has not yet ended - a coach cannot pull the workout out from under a challenge that is running or scheduled. Retiring an already-retired WOD returns it unchanged and writes no second audit row (a retry is not a new decision). p_reason is optional, control-stripped and capped at 500, and lands in admin_actions.note. Audits ''club_wod_retired''.';

create or replace function public.club_wod_restore(p_wod_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_existing public.club_wods;
  v_row public.club_wods;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;

  select * into v_existing from public.club_wods w where w.wod_id = btrim(coalesce(p_wod_id, ''));
  if not found then raise exception 'wod not found'; end if;
  if v_existing.retired_at is null then return public.club_wod_json(v_existing); end if;

  update public.club_wods
     set retired_at = null, retired_by = null, retired_reason = null
   where id = v_existing.id
  returning * into v_row;

  perform public.log_admin_action(
    'club_wod_restored', 'club_wod', v_row.id,
    jsonb_build_object('wod_id', v_existing.wod_id, 'retired_at', v_existing.retired_at,
                       'retired_reason', v_existing.retired_reason),
    jsonb_build_object('wod_id', v_row.wod_id, 'retired_at', null));

  return public.club_wod_json(v_row);
end $$;
revoke all on function public.club_wod_restore(text) from public, anon;
grant execute on function public.club_wod_restore(text) to authenticated;

comment on function public.club_wod_restore(text) is
  'Un-retires a club WOD, clearing retired_at/retired_by/retired_reason. The counterpart to club_wod_retire, and the reason retirement can be a routine tidy-up rather than an irreversible one. AUTH: security definer; auth.uid(), is_community_member(), has_perm(''community.challenge.create''). Raises ''wod not found''. Restoring a WOD that is not retired returns it unchanged and writes no audit row. Audits ''club_wod_restored'' with the retirement it undid in before_data, so the log keeps both halves of the decision.';

-- =====================================================================
-- 9. THE OWNERSHIP PROBE'S INDEX
-- =====================================================================
-- club_wod_publish() looks private_records up by record_id ALONE, which the
-- (user_id, record_type, record_id) primary key cannot serve. The partial
-- index 202609060019 added covers only strength_entry and wod_entry, so
-- without this one the probe is a sequential scan of every member's entire
-- training history on every publish.
create index if not exists private_records_custom_wod_record_id_idx
  on public.private_records(record_id)
  where record_type = 'custom_wod';

commit;
