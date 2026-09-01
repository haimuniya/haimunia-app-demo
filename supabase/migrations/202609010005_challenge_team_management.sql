begin;

-- COMM-308 Advanced challenge team management.
--
-- What lands here:
--   * two admin_actions.target_type labels: 'challenge_participant' and
--     'challenge_team'
--   * challenge_teams.captain_id
--   * public.chal_reassign_team(uuid, uuid, uuid)  - the coach moves a member
--   * public.chal_set_captain(uuid, uuid)          - the coach names a captain
--   * public.challenge_teams_guard_captain()   trigger: captain_id is pinned to
--     chal_set_captain, and a captain must be on the team they captain
--   * public.challenge_teams_block_delete()    trigger: 'team not empty'
--   * public.challenge_participants_guard_team() trigger: a member picks a team
--     once, at join; every later move is the coach's
--   * public.challenge_teams_release_captain() trigger: a captain who leaves the
--     team stops being its captain
--
-- What deliberately does NOT land here:
--   * any change to challenge_teams' four RLS policies (COMM-006/COMM-204).
--     The ticket says "existing policy ... no change" and means it: a
--     community.challenge.create holder still inserts, renames and deletes
--     teams by direct RLS write. The two triggers above constrain what those
--     writes may contain; they do not move the permission boundary.
--   * any widening of challenge_participants_update_self. See section 4.
--   * ANY write to challenge_progress. This is the load-bearing rule of the
--     ticket and it is honoured by omission: reassigning a member changes
--     challenge_participants.team_id and nothing else, so every team_id
--     already snapshotted onto a challenge_progress row by
--     challenge_progress_stamp_team (202608290003) keeps pointing at the team
--     the contribution was actually made for. "A departed member's earlier
--     contributions keep counting for their old team" is the same rule
--     chal_progress's team_totals already sums by, and a reassignment is
--     simply another way to depart a team.

-- =====================================================================
-- 0. admin_actions gains two target_type labels
-- =====================================================================
-- 202608280002 pinned target_type to ten values; 202609010002 (COMM-309)
-- added an eleventh. This adds the twelfth and thirteenth.
--
-- 'challenge_participant' is named by COMM-308 in as many words for
-- chal_reassign_team. None of the existing values fits: the subject of the
-- action is one member's membership of one challenge, which is neither the
-- 'challenge' (the challenge row is untouched) nor the 'member' (nothing
-- about the profile changes, and a 'member' row in this log has always meant
-- a moderation action against a person - see mod_restrict_member).
--
-- 'challenge_team' is this migration's own choice, for chal_set_captain: its
-- target really is one challenge_teams row, and reusing
-- 'challenge_participant' there would make the log say the coach edited the
-- member when they edited the team column.
--
-- action_type is NOT widened. Unlike 202609010001 and 202609010002, which
-- each described a genuinely new kind of staff act, both functions here are
-- an edit to a challenge's setup by a community.challenge.create holder,
-- which is exactly what the existing 'challenge_edit' label already means.
-- A new label would split one concept across two filters in
-- admin_actions_page for no reader's benefit.
alter table public.admin_actions drop constraint if exists admin_actions_target_type_check;
alter table public.admin_actions add constraint admin_actions_target_type_check check (target_type in (
  'post', 'comment', 'member', 'role', 'challenge', 'achievement',
  'event', 'announcement', 'report', 'club',
  -- COMM-309.
  'monthly_club_recap',
  -- COMM-308.
  'challenge_participant', 'challenge_team'
));

-- =====================================================================
-- 1. challenge_teams.captain_id
-- =====================================================================
-- Nullable, and null is the normal state: most teams never name a captain.
-- `on delete set null` matches every other soft pointer at profiles in this
-- schema (challenges.created_by, challenge_progress.entered_by): losing the
-- account must not delete the team.
--
-- No FK can express "and that member is on this team", so the invariant is a
-- trigger (section 2), not a constraint.
alter table public.challenge_teams
  add column if not exists captain_id uuid references public.profiles(id) on delete set null;

comment on column public.challenge_teams.captain_id is
  'COMM-308. The team''s captain, or null. A label the team column displays - it delegates NO permission, so nothing anywhere reads this column to decide whether a write is allowed. Written only by public.chal_set_captain(): challenge_teams_guard_captain() rejects a direct client UPDATE of this column even from a community.challenge.create holder, so every change to it carries an admin_actions row. Always either null or an active (not withdrawn) participant of this team - the same trigger enforces that on every write path, the function included.';

-- =====================================================================
-- 2. challenge_teams_guard_captain: the pin and the invariant
-- =====================================================================
-- Two jobs, one BEFORE trigger, because both answer "is this captain_id
-- value allowed to be written right now".
--
-- (a) THE PIN. challenge_teams_update_perm (202608280009) grants a
--     community.challenge.create holder a whole-row UPDATE, so without this
--     a coach could set captain_id straight from the client and the
--     admin_actions row COMM-308 asks for would never be written. The
--     permission half of the ticket's rule ("settable only by a
--     community.challenge.create holder") is already true by that policy;
--     what a policy cannot say is "through this one function, so it gets
--     audited". Same transaction-local GUC escape hatch protect_is_admin()
--     uses for recovery_verified_at and assigned_coach_id, for the same
--     reason: auth.role() still reads 'authenticated' inside a SECURITY
--     DEFINER function, so definer rights alone would not survive this
--     trigger. `app.` is a namespace PostgREST never populates from a
--     request (it only ever fills `request.*`).
--
--     This RAISES rather than silently reverting the way protect_is_admin()
--     does. protect_is_admin() guards a column on a row the member is
--     otherwise allowed to update every day (their own profile), where a
--     hard error on an unrelated save would be hostile. Here the only
--     sessions that ever touch captain_id are staff ones doing it on
--     purpose, and a silent no-op would leave a coach staring at a captain
--     badge that never appears.
--
-- (b) THE INVARIANT, which is checked on every write path including
--     chal_set_captain and the service role: a non-null captain_id must
--     belong to a participant of this challenge whose team_id is this team
--     and whose status is not 'withdrawn'. chal_set_captain checks the same
--     thing itself, first, so the client gets the function's message rather
--     than the trigger's - both stand, exactly as recap_monthly_publish and
--     monthly_club_recaps_freeze both refuse a double publish.
--
--     "Active participant" here means status <> 'withdrawn', not
--     status = 'active'. A participant who has COMPLETED the challenge has
--     finished it, not left it: they still occupy a slot in the team column
--     and are still a legitimate captain. The same predicate is used by the
--     delete guard and by chal_reassign_team, so the three rules cannot
--     disagree - in particular a member who blocks a team's deletion is
--     always a member who can be reassigned out of it.
--
-- On INSERT the pin nulls nothing and the invariant always refuses a
-- non-null captain_id, because no participant can be on a team that did not
-- exist a moment ago. Creating a team and naming its captain is therefore
-- two steps, which is the only order that can ever be true.
create or replace function public.challenge_teams_guard_captain() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old uuid;
begin
  -- OLD is unassigned in an INSERT trigger and reading it there would be a
  -- runtime error, so this is a statement, not an inline CASE.
  if tg_op = 'UPDATE' then v_old := old.captain_id; end if;

  if new.captain_id is not distinct from v_old then
    return new;
  end if;

  if coalesce(auth.role(), '') = 'authenticated'
     and coalesce(current_setting('app.allow_captain_set', true), '') <> 'on' then
    raise exception 'captain is set through chal_set_captain';
  end if;

  if new.captain_id is not null and not exists (
    select 1 from public.challenge_participants cp
    where cp.challenge_id = new.challenge_id
      and cp.user_id = new.captain_id
      and cp.team_id = new.id
      and cp.status <> 'withdrawn'
  ) then
    raise exception 'captain must be an active participant on this team';
  end if;

  return new;
end $$;
revoke all on function public.challenge_teams_guard_captain() from public, anon, authenticated;

drop trigger if exists challenge_teams_guard_captain_trigger on public.challenge_teams;
create trigger challenge_teams_guard_captain_trigger
  before insert or update of captain_id on public.challenge_teams
  for each row execute function public.challenge_teams_guard_captain();

comment on function public.challenge_teams_guard_captain() is
  'COMM-308 BEFORE INSERT OR UPDATE OF captain_id on challenge_teams. Refuses ''captain is set through chal_set_captain'' for any authenticated session without the transaction-local app.allow_captain_set pin, which only chal_set_captain() ever sets - so captain_id cannot be written by a direct client UPDATE even by a community.challenge.create holder, and every change to it is audited. Then refuses ''captain must be an active participant on this team'' for a non-null captain_id with no challenge_participants row on this team whose status is not ''withdrawn'' - on every write path, service role and definer function included. A write that leaves captain_id unchanged is never touched, so renaming a team is unaffected.';

-- =====================================================================
-- 3. challenge_teams_block_delete: 'team not empty'
-- =====================================================================
-- COMM-308 leaves the choice open ("is refused (or the client blocks the
-- action)"). This takes the database side, for the reason the ticket itself
-- gives: challenge_participants.team_id is `on delete set null`, so a
-- client-only rule means one missed check silently empties a team column and
-- the members in it just quietly stop having a team. A BEFORE DELETE trigger
-- is the same server-enforced-invariant choice COMM-315 and COMM-309 made,
-- and it holds for the SQL editor and the service role too.
--
-- THE CASCADE ESCAPE HATCH IS LOAD-BEARING. challenge_teams.challenge_id is
-- `on delete cascade`, so deleting a challenge deletes its teams - and
-- without the first check below, this trigger would refuse that cascade and
-- make any team challenge with members undeletable, breaking
-- challenges_delete_perm (202608280009). By the time an RI cascade fires,
-- the parent challenges row is already gone from the deleting statement's
-- own snapshot, so "the challenge no longer exists" is a reliable read of
-- "this delete is a cascade, not a coach deleting one team".
--
-- A withdrawn participant does not block the delete: they are not in the
-- team column any more, and their team_id going null is the same
-- already-shipped `on delete set null` behaviour. Their historical
-- challenge_progress rows are a separate matter - challenge_progress.team_id
-- is also `on delete set null` (202608290003), so deleting a team does erase
-- the snapshot on contributions made for it. That is pre-existing and out of
-- this ticket's scope; it is also why "empty the column by reassignment
-- first" is the workflow rather than "delete and let it sort itself out".
create or replace function public.challenge_teams_block_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.challenges c where c.id = old.challenge_id) then
    return old;
  end if;

  if exists (
    select 1 from public.challenge_participants cp
    where cp.team_id = old.id and cp.status <> 'withdrawn'
  ) then
    raise exception 'team not empty';
  end if;

  return old;
end $$;
revoke all on function public.challenge_teams_block_delete() from public, anon, authenticated;

drop trigger if exists challenge_teams_block_delete_trigger on public.challenge_teams;
create trigger challenge_teams_block_delete_trigger
  before delete on public.challenge_teams
  for each row execute function public.challenge_teams_block_delete();

comment on function public.challenge_teams_block_delete() is
  'COMM-308 BEFORE DELETE on challenge_teams. Raises ''team not empty'' when any challenge_participants row still points at the team with status <> ''withdrawn''; the column must be emptied by chal_reassign_team first. Returns early, allowing the delete, when the parent challenges row is already gone - that is an ON DELETE CASCADE from challenges, not a coach deleting one team, and refusing it would make a team challenge with members undeletable.';

-- =====================================================================
-- 4. challenge_participants_guard_team: a member picks once
-- =====================================================================
-- COMM-308 states as fact that "a plain member's own
-- challenge_participants_update_self policy (202608280009) still does not
-- permit setting team_id to a value the member did not pick at join time".
-- READ THAT POLICY: it is `using (user_id = auth.uid() or has_perm(...))`
-- with the same WITH CHECK and no column restriction whatsoever, so as
-- shipped a member could move themselves between teams as often as they
-- liked - including onto whichever team is winning, on the last day. The
-- ticket's premise was not true; this trigger is what makes it true, and it
-- is the reason chal_reassign_team has to exist at all.
--
-- An RLS policy cannot express this. A policy's USING sees the old row and
-- its WITH CHECK sees the new one, and neither can see both, so "team_id may
-- not change" has nowhere to live in a policy. It has to be a trigger.
--
-- The rule is deliberately "a member may set team_id once, from null", not
-- "a member may never set team_id" - the shipped COMM-204 client depends on
-- the first: joinChallenge inserts the participant row with no team, then
-- either autoAssignChallengeTeam (join_mode 'auto') or pickChallengeTeam
-- (the "הצטרפות לקבוצה" button) sets it. That button is already rendered
-- only when the member has no team (`canPick = myParticipant && !myTeamId`),
-- so the client has always treated the choice as one-time and this trigger
-- makes the server agree. Nothing in the shipped client is refused by it.
--
-- NOT widened, exactly as instructed: this only narrows. It also leaves the
-- rest of that policy alone - a member can still edit their own status and
-- progress_value directly, which is what COMM-205's consistency
-- "mark complete" tap does and is a separate, pre-existing question.
--
-- Scoped to a real client session (auth.role() = 'authenticated'), the same
-- scoping protect_is_admin() uses, so a dashboard fix, a migration backfill
-- and the service role are unaffected. A holder of
-- community.challenge.create passes it - which is how chal_reassign_team's
-- own UPDATE gets through, since auth.role() reads 'authenticated' inside a
-- definer function.
create or replace function public.challenge_participants_guard_team() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.team_id is not distinct from old.team_id then return new; end if;
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;
  if public.has_perm('community.challenge.create') then return new; end if;
  if old.team_id is null then return new; end if;
  raise exception 'team already chosen';
end $$;
revoke all on function public.challenge_participants_guard_team() from public, anon, authenticated;

drop trigger if exists challenge_participants_guard_team_trigger on public.challenge_participants;
create trigger challenge_participants_guard_team_trigger
  before update of team_id on public.challenge_participants
  for each row execute function public.challenge_participants_guard_team();

comment on function public.challenge_participants_guard_team() is
  'COMM-308 BEFORE UPDATE OF team_id on challenge_participants. Raises ''team already chosen'' when an authenticated session without community.challenge.create changes a team_id that is already set - the one-time pick from null at join stays allowed, which is the only team write the COMM-204 client makes. Closes the gap between what challenge_participants_update_self actually allowed (any self-row column, any number of times) and what COMM-204/COMM-308 always described. Skipped entirely when auth.role() is not ''authenticated'', so the service role, a dashboard fix and a future backfill are unaffected.';

-- =====================================================================
-- 5. challenge_teams_release_captain: a captain who leaves stops captaining
-- =====================================================================
-- The section 2 invariant is checked when captain_id is written. The other
-- half of keeping it true is the participant side: a captain who is
-- reassigned to another team, withdraws, or leaves the challenge entirely
-- (challenge_participants_leave_self deletes the row) would otherwise leave
-- their old team pointing at someone who is not on it.
--
-- Doing this here rather than inside chal_reassign_team is the point: leave
-- and withdraw are plain client writes that never go near that function, and
-- a rule enforced in one of the three paths is not enforced.
--
-- The pin from section 2 applies to this trigger too: it runs inside the
-- LEAVING MEMBER's session, where auth.role() is 'authenticated' and no
-- chal_set_captain call is in progress, so without the escape hatch below
-- challenge_teams_guard_captain would refuse the clearing UPDATE and a
-- member would be unable to leave a challenge they captained at all. Set
-- transaction-locally and cleared immediately after the one UPDATE, exactly
-- as chal_set_captain does. Widening the pin instead ("clearing to null is
-- always allowed") was the alternative and is worse: it would let a coach
-- null a captain by direct client UPDATE with no admin_actions row, which is
-- the hole the pin exists to close.
create or replace function public.challenge_teams_release_captain() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('app.allow_captain_set', 'on', true);

  update public.challenge_teams t
  set captain_id = null
  where t.captain_id = old.user_id
    and t.challenge_id = old.challenge_id
    and not exists (
      select 1 from public.challenge_participants cp
      where cp.challenge_id = t.challenge_id
        and cp.user_id = t.captain_id
        and cp.team_id = t.id
        and cp.status <> 'withdrawn'
    );

  perform set_config('app.allow_captain_set', 'off', true);
  return null;
end $$;
revoke all on function public.challenge_teams_release_captain() from public, anon, authenticated;

drop trigger if exists challenge_teams_release_captain_trigger on public.challenge_participants;
create trigger challenge_teams_release_captain_trigger
  after delete or update of team_id, status on public.challenge_participants
  for each row execute function public.challenge_teams_release_captain();

comment on function public.challenge_teams_release_captain() is
  'COMM-308 AFTER DELETE OR UPDATE OF team_id, status on challenge_participants. Clears challenge_teams.captain_id when the member named there is no longer an active (not withdrawn) participant on that team - covering a reassignment, a withdrawal, and a plain leave, none of which go through chal_set_captain. Sets the transaction-local app.allow_captain_set pin around its one UPDATE (the only other place that pin is used) because it runs inside the leaving member''s own authenticated session, where challenge_teams_guard_captain() would otherwise refuse the write. Writes no admin_actions row: this is a consequence of a member''s own action, not a staff decision, and the staff action that caused it (chal_reassign_team) is already logged.';

-- =====================================================================
-- 6. chal_reassign_team - the coach moves a member between teams
-- =====================================================================
-- Same auth shape as chal_record_progress (202608290005), and for the same
-- reason: the member-facing policy covers the member's own row only (and
-- after section 4, only their first pick), so a staff write to someone
-- else's participant row has to be a SECURITY DEFINER function.
--
-- p_team_id null is allowed and means "take them out of every team", which
-- is what emptying a column before deleting it looks like when the member
-- should not land anywhere else.
--
-- IT DOES NOT TOUCH challenge_progress. One UPDATE, one column, one row.
-- Every already-stamped challenge_progress.team_id keeps its value, so the
-- deltas the member contributed while on their old team keep counting for
-- that team in chal_progress's team_totals, and only deltas logged after
-- this call are stamped with the new team. This is COMM-308's central
-- acceptance criterion and it is satisfied by the function's shape, not by a
-- rule someone has to remember.
--
-- A reassignment to the team the member is already on is not special-cased:
-- it writes the same value and still logs, so the audit answers "the coach
-- did this" rather than silently swallowing it. before_data and after_data
-- are then identical, which is an honest record of what happened.
create or replace function public.chal_reassign_team(
  p_challenge_id uuid,
  p_user_id uuid,
  p_team_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_challenge public.challenges;
  v_old_team uuid;
  v_status text;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;
  if p_challenge_id is null or p_user_id is null then
    raise exception 'challenge and target participant are required';
  end if;

  select * into v_challenge from public.challenges where id = p_challenge_id;
  if not found then raise exception 'challenge not found'; end if;
  -- team_id is meaningless on any other challenge_type: nothing reads it and
  -- chal_progress only builds team_totals for a 'team' challenge.
  if v_challenge.challenge_type <> 'team' then raise exception 'not a team challenge'; end if;

  select cp.team_id, cp.status into v_old_team, v_status
  from public.challenge_participants cp
  where cp.challenge_id = p_challenge_id and cp.user_id = p_user_id
  for update;
  if not found or v_status = 'withdrawn' then raise exception 'not an active participant'; end if;

  if p_team_id is not null and not exists (
    select 1 from public.challenge_teams t
    where t.id = p_team_id and t.challenge_id = p_challenge_id
  ) then
    raise exception 'team does not belong to this challenge';
  end if;

  update public.challenge_participants
  set team_id = p_team_id
  where challenge_id = p_challenge_id and user_id = p_user_id;

  -- target_id is the member. challenge_participants has a composite primary
  -- key and so no single id to point at; the challenge lives in the payload.
  perform public.log_admin_action(
    'challenge_edit', 'challenge_participant', p_user_id,
    pg_catalog.jsonb_build_object('challenge_id', p_challenge_id, 'team_id', v_old_team),
    pg_catalog.jsonb_build_object('challenge_id', p_challenge_id, 'team_id', p_team_id)
  );
end $$;
revoke all on function public.chal_reassign_team(uuid, uuid, uuid) from public, anon;
grant execute on function public.chal_reassign_team(uuid, uuid, uuid) to authenticated;

comment on function public.chal_reassign_team(uuid, uuid, uuid) is
  'COMM-308 move a participant between teams. security definer; auth.uid() checked first, then has_perm(''community.challenge.create''), the same auth shape as chal_record_progress. Refuses (all P0001): ''not authorized'', ''challenge and target participant are required'', ''challenge not found'', ''not a team challenge'' for any challenge_type other than ''team'', ''not an active participant'' when the target has no challenge_participants row or is withdrawn (checked FOR UPDATE), and ''team does not belong to this challenge''. p_team_id null removes the member from every team. Side effects, one transaction: sets challenge_participants.team_id and writes one admin_actions row of action_type ''challenge_edit'' and target_type ''challenge_participant'' whose target_id is the member and whose before/after data carry the challenge and the old and new team. It NEVER touches challenge_progress: every team_id already snapshotted there by challenge_progress_stamp_team keeps its value, so the member''s earlier contributions keep counting for their old team and only later ones count for the new one. If the member captained the team they left, challenge_teams_release_captain clears that captain_id in the same transaction. Returns void.';

-- =====================================================================
-- 7. chal_set_captain - the only write path for captain_id
-- =====================================================================
-- p_user_id null clears the captain and is always allowed, per COMM-308's
-- validation rules - the same "null means unassign, no second function"
-- shape coach_assign_coach already uses.
create or replace function public.chal_set_captain(
  p_team_id uuid,
  p_user_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_team public.challenge_teams;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;
  if p_team_id is null then raise exception 'team is required'; end if;

  select * into v_team from public.challenge_teams where id = p_team_id for update;
  if not found then raise exception 'team not found'; end if;

  -- The same predicate challenge_teams_guard_captain() enforces underneath.
  -- Checked here too so the client gets this message rather than the
  -- trigger's, and so the refusal happens before anything is written.
  if p_user_id is not null and not exists (
    select 1 from public.challenge_participants cp
    where cp.challenge_id = v_team.challenge_id
      and cp.user_id = p_user_id
      and cp.team_id = p_team_id
      and cp.status <> 'withdrawn'
  ) then
    raise exception 'captain must be an active participant on this team';
  end if;

  -- Transaction-local, cleared immediately after the one UPDATE it exists
  -- for. See the note on challenge_teams_guard_captain() above.
  perform set_config('app.allow_captain_set', 'on', true);
  update public.challenge_teams set captain_id = p_user_id where id = p_team_id;
  perform set_config('app.allow_captain_set', 'off', true);

  perform public.log_admin_action(
    'challenge_edit', 'challenge_team', p_team_id,
    pg_catalog.jsonb_build_object('challenge_id', v_team.challenge_id, 'captain_id', v_team.captain_id),
    pg_catalog.jsonb_build_object('challenge_id', v_team.challenge_id, 'captain_id', p_user_id)
  );
end $$;
revoke all on function public.chal_set_captain(uuid, uuid) from public, anon;
grant execute on function public.chal_set_captain(uuid, uuid) to authenticated;

comment on function public.chal_set_captain(uuid, uuid) is
  'COMM-308 name or clear a team''s captain. security definer; auth.uid() checked first, then has_perm(''community.challenge.create''). Refuses (all P0001): ''not authorized'', ''team is required'', ''team not found'' (looked up FOR UPDATE), and ''captain must be an active participant on this team'' when p_user_id has no challenge_participants row on this challenge whose team_id is this team and whose status is not ''withdrawn''. p_user_id null clears the captain and is always allowed. Side effects, one transaction: sets challenge_teams.captain_id behind the transaction-local app.allow_captain_set pin (this is the only place that pin is ever set, and challenge_teams_guard_captain() refuses the column to every other client session), and writes one admin_actions row of action_type ''challenge_edit'' and target_type ''challenge_team'' carrying the old and new captain. The captain is a display label only - it grants no permission anywhere in the schema. Returns void.';

commit;
