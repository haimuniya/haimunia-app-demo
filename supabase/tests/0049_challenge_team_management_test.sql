-- COMM-308 advanced challenge team management, behavioural coverage for
-- 202609010005_challenge_team_management.sql.
--
-- The load-bearing scenario is section D: a reassignment moves
-- challenge_participants.team_id and leaves every already-stamped
-- challenge_progress.team_id exactly where it was, so a member's earlier
-- contributions keep counting for the team they were made for. That rule was
-- designed into challenge_progress_stamp_team (202608290003) and asserted by
-- chal_progress's team_totals; this file is the first test that actually
-- moves a member and then proves it.
--
-- Sections B and C also carry regression weight: B proves the four
-- challenge_teams policies (COMM-006/COMM-204) still behave exactly as they
-- did before the two new triggers, and C pins the member-side boundary that
-- COMM-308 assumed already existed and did not.
--
-- CI is the first shared run of this file; it was run locally against a
-- fresh `supabase db reset` first.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures, as the bootstrap superuser (RLS and the new triggers'
-- authenticated-only scoping both out of the way).
--
--   C1  the team challenge everything interesting happens on
--         Alpha  e308...01     Bravo  e308...02
--         m1 (Alpha), m2 (no team), m3 (no team)
--   C2  an individual_target challenge, for "not a team challenge" and for
--         Golf e308...09, a team belonging to the wrong challenge
--   C3  a team challenge used as a sandbox for plain team CRUD and for the
--         withdrawn-member cases
--         Charlie e308...03    Delta e308...04     m3 (Delta)
--   C4  a team challenge deleted whole at the end, to prove the ON DELETE
--         CASCADE escape hatch in challenge_teams_block_delete
--         Echo e308...0a       m2 (Echo)
-- =====================================================================
insert into public.challenges (id, title, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
values
  ('c3080000-0000-4000-8000-000000000001', 'Team challenge',    'team',              'reps',          null, now() - interval '1 day', now() + interval '20 days', 'active', tests.uid('coach')),
  ('c3080000-0000-4000-8000-000000000002', 'Solo challenge',    'individual_target', 'session_count', 100,  now() - interval '1 day', now() + interval '20 days', 'active', tests.uid('coach')),
  ('c3080000-0000-4000-8000-000000000003', 'Team sandbox',      'team',              'reps',          null, now() - interval '1 day', now() + interval '20 days', 'active', tests.uid('coach')),
  ('c3080000-0000-4000-8000-000000000004', 'Team to be nuked',  'team',              'reps',          null, now() - interval '1 day', now() + interval '20 days', 'active', tests.uid('coach'));

insert into public.challenge_teams (id, challenge_id, name) values
  ('e3080000-0000-4000-8000-000000000001', 'c3080000-0000-4000-8000-000000000001', 'Alpha'),
  ('e3080000-0000-4000-8000-000000000002', 'c3080000-0000-4000-8000-000000000001', 'Bravo'),
  ('e3080000-0000-4000-8000-000000000004', 'c3080000-0000-4000-8000-000000000003', 'Delta'),
  ('e3080000-0000-4000-8000-000000000009', 'c3080000-0000-4000-8000-000000000002', 'Golf'),
  ('e3080000-0000-4000-8000-00000000000a', 'c3080000-0000-4000-8000-000000000004', 'Echo');

insert into public.challenge_participants (challenge_id, user_id, team_id, status) values
  ('c3080000-0000-4000-8000-000000000001', tests.uid('m1'), 'e3080000-0000-4000-8000-000000000001', 'active'),
  ('c3080000-0000-4000-8000-000000000001', tests.uid('m2'), null,                                   'active'),
  ('c3080000-0000-4000-8000-000000000001', tests.uid('m3'), null,                                   'active'),
  ('c3080000-0000-4000-8000-000000000002', tests.uid('m1'), null,                                   'active'),
  ('c3080000-0000-4000-8000-000000000003', tests.uid('m3'), 'e3080000-0000-4000-8000-000000000004', 'active'),
  ('c3080000-0000-4000-8000-000000000004', tests.uid('m2'), 'e3080000-0000-4000-8000-00000000000a', 'active');

-- =====================================================================
-- A. The column
-- =====================================================================
select has_column('public', 'challenge_teams', 'captain_id',
  'challenge_teams gains captain_id (COMM-308 migration outline)');
select col_type_is('public', 'challenge_teams', 'captain_id', 'uuid',
  'captain_id is a uuid');
select col_is_null('public', 'challenge_teams', 'captain_id',
  'captain_id is nullable - most teams never name a captain, and null is the normal state');
select results_eq(
  $$ select count(*)::int from public.challenge_teams where captain_id is not null $$,
  $$ values (0) $$,
  'every existing team starts with no captain - the column is added, not backfilled');
select results_eq(
  $$ select confdeltype::text from pg_constraint
     where conrelid = 'public.challenge_teams'::regclass and contype = 'f'
       and conkey = array[(select attnum from pg_attribute
                           where attrelid = 'public.challenge_teams'::regclass and attname = 'captain_id')] $$,
  $$ values ('n'::text) $$,
  'captain_id references profiles ON DELETE SET NULL - losing the account must not delete the team');

-- =====================================================================
-- B. Regression: challenge_teams create / rename / delete under the
--    existing RLS policies (COMM-006/COMM-204), unchanged by this ticket
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.challenge_teams (id, challenge_id, name)
     values ('e3080000-0000-4000-8000-000000000003', 'c3080000-0000-4000-8000-000000000003', 'Charlie') $$,
  '42501',
  null,
  'a plain member still cannot create a team - challenge_teams_insert_perm requires community.challenge.create');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.challenge_teams (id, challenge_id, name)
     values ('e3080000-0000-4000-8000-000000000003', 'c3080000-0000-4000-8000-000000000003', 'Charlie') $$,
  'a community.challenge.create holder still creates a team by direct RLS insert, no function needed');
select lives_ok(
  $$ update public.challenge_teams set name = 'Charlie renamed' where id = 'e3080000-0000-4000-8000-000000000003' $$,
  'the holder still renames a team by direct RLS update - the new BEFORE trigger is scoped to captain_id and does not fire here');
select results_eq(
  $$ select name from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000003' $$,
  $$ values ('Charlie renamed'::text) $$,
  'the rename actually landed');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.challenge_teams set name = 'Member rename' where id = 'e3080000-0000-4000-8000-000000000003' $$,
  'a plain member''s rename raises nothing - challenge_teams_update_perm simply matches no row');
select results_eq(
  $$ select name from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000003' $$,
  $$ values ('Charlie renamed'::text) $$,
  '...and changes nothing: the name is still the coach''s');
select lives_ok(
  $$ delete from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000003' $$,
  'a plain member''s delete raises nothing either');
select isnt_empty(
  $$ select 1 from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000003' $$,
  '...and the team is still there - challenge_teams_delete_perm matched no row');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ delete from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000003' $$,
  'the holder deletes an EMPTY team by direct RLS delete, exactly as before this ticket');
select is_empty(
  $$ select 1 from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000003' $$,
  'the empty team is gone');

-- =====================================================================
-- C. The member-side boundary: a member picks a team once, at join
-- =====================================================================
-- COMM-308 states this was already true of challenge_participants_update_self.
-- It was not: that policy is `user_id = auth.uid()` with no column
-- restriction. challenge_participants_guard_team is what makes it true.
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ update public.challenge_participants set team_id = 'e3080000-0000-4000-8000-000000000001'
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m2') $$,
  'a member with no team still picks one directly - the COMM-204 "הצטרפות לקבוצה" button is untouched');
select results_eq(
  $$ select team_id from public.challenge_participants
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m2') $$,
  $$ values ('e3080000-0000-4000-8000-000000000001'::uuid) $$,
  'the one-time pick landed');

select throws_ok(
  $$ update public.challenge_participants set team_id = 'e3080000-0000-4000-8000-000000000002'
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m2') $$,
  'P0001',
  'team already chosen',
  'the same member cannot then move themselves to another team - no self-service hopping onto whoever is winning');
select throws_ok(
  $$ update public.challenge_participants set team_id = null
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m2') $$,
  'P0001',
  'team already chosen',
  'nor can they clear their team and re-pick, which would be the same move in two steps');
select results_eq(
  $$ select team_id from public.challenge_participants
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m2') $$,
  $$ values ('e3080000-0000-4000-8000-000000000001'::uuid) $$,
  'after both refusals the member is still on the team they picked');

select lives_ok(
  $$ update public.challenge_participants set status = 'completed'
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m2') $$,
  'the rest of challenge_participants_update_self is untouched - a member still edits their own status (COMM-205''s consistency tap depends on it)');
select tests.clear_auth();
update public.challenge_participants set status = 'active'
  where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m2');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ update public.challenge_participants set team_id = 'e3080000-0000-4000-8000-000000000002'
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  'a member aiming at SOMEONE ELSE''S participant row raises nothing - RLS filters the row out before any trigger sees it');
select results_eq(
  $$ select team_id from public.challenge_participants
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  $$ values ('e3080000-0000-4000-8000-000000000001'::uuid) $$,
  '...and m1 is still on Alpha: challenge_participants_update_self matched no row for m3');

-- =====================================================================
-- D. THE LOAD-BEARING SCENARIO: reassignment never moves history
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c3080000-0000-4000-8000-000000000001', tests.uid('m1'), 10) $$,
  'm1 contributes 10 while on Alpha');
select results_eq(
  $$ select team_id from public.challenge_progress
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') and delta = 10 $$,
  $$ values ('e3080000-0000-4000-8000-000000000001'::uuid) $$,
  'challenge_progress_stamp_team snapshotted Alpha onto that contribution (202608290003)');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', tests.uid('m1'), 'e3080000-0000-4000-8000-000000000002') $$,
  'the coach moves m1 from Alpha to Bravo');
select results_eq(
  $$ select team_id from public.challenge_participants
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  $$ values ('e3080000-0000-4000-8000-000000000002'::uuid) $$,
  'the participant row now points at Bravo');
select results_eq(
  $$ select team_id from public.challenge_progress
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') and delta = 10 $$,
  $$ values ('e3080000-0000-4000-8000-000000000001'::uuid) $$,
  'COMM-308 CENTRAL RULE: the historical contribution still says Alpha - chal_reassign_team does not touch challenge_progress at all');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c3080000-0000-4000-8000-000000000001', tests.uid('m1'), 5) $$,
  'm1 contributes 5 more, now from Bravo');
select results_eq(
  $$ select team_id from public.challenge_progress
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') and delta = 5 $$,
  $$ values ('e3080000-0000-4000-8000-000000000002'::uuid) $$,
  'only contributions made AFTER the reassignment are stamped with the new team');
select results_eq(
  $$ select count(*)::int from public.challenge_progress
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and team_id = 'e3080000-0000-4000-8000-000000000001' $$,
  $$ values (1) $$,
  'Alpha still owns exactly one contribution row after the member left it');

select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select (e ->> 'name')::text, (e ->> 'total')::numeric
     from jsonb_array_elements(
       (public.chal_progress('c3080000-0000-4000-8000-000000000001')).team_totals) e
     order by 1 $$,
  $$ values ('Alpha'::text, 10::numeric), ('Bravo'::text, 5::numeric) $$,
  'end to end through chal_progress: Alpha keeps the 10 the departed member contributed, Bravo has only the 5 earned since - "a departed member''s earlier contributions keep counting for their old team"');

-- =====================================================================
-- E. chal_reassign_team: permission and validation boundaries
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', tests.uid('m3'), 'e3080000-0000-4000-8000-000000000002') $$,
  'P0001',
  'not authorized',
  'a plain member cannot call chal_reassign_team - community.challenge.create required, same shape as chal_record_progress');
select throws_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', tests.uid('m1'), 'e3080000-0000-4000-8000-000000000001') $$,
  'P0001',
  'not authorized',
  '...not even on their own row: the function is a staff path, not a member''s way around the guard in section C');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.chal_reassign_team(null, tests.uid('m3'), null) $$,
  'P0001',
  'challenge and target participant are required',
  'a null challenge is refused');
select throws_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', null, null) $$,
  'P0001',
  'challenge and target participant are required',
  'a null target member is refused');
select throws_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-0000000000ff', tests.uid('m3'), null) $$,
  'P0001',
  'challenge not found',
  'an unknown challenge is refused');
select throws_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000002', tests.uid('m1'), null) $$,
  'P0001',
  'not a team challenge',
  'team_id is meaningless on an individual_target challenge, so the function refuses it outright');
select throws_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', tests.uid('owner'), 'e3080000-0000-4000-8000-000000000001') $$,
  'P0001',
  'not an active participant',
  'someone who never joined the challenge cannot be put on a team');
select throws_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', tests.uid('m3'), 'e3080000-0000-4000-8000-000000000009') $$,
  'P0001',
  'team does not belong to this challenge',
  'a team from another challenge is refused - this is the check that stops a cross-challenge team_id being written');

select lives_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', tests.uid('m3'), 'e3080000-0000-4000-8000-000000000001') $$,
  'the coach puts m3, who had no team, onto Alpha');
select results_eq(
  $$ select team_id from public.challenge_participants
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m3') $$,
  $$ values ('e3080000-0000-4000-8000-000000000001'::uuid) $$,
  'm3 is on Alpha');

select tests.clear_auth();
update public.challenge_participants set status = 'withdrawn'
  where challenge_id = 'c3080000-0000-4000-8000-000000000003' and user_id = tests.uid('m3');
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000003', tests.uid('m3'), null) $$,
  'P0001',
  'not an active participant',
  'a withdrawn participant cannot be reassigned - they are not in the team column any more');

-- =====================================================================
-- F. chal_set_captain, and the pin that makes it the only write path
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.chal_set_captain('e3080000-0000-4000-8000-000000000002', tests.uid('m1')) $$,
  'P0001',
  'not authorized',
  'a plain member cannot name a captain, not even themselves');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.chal_set_captain(null, tests.uid('m1')) $$,
  'P0001',
  'team is required',
  'a null team is refused');
select throws_ok(
  $$ select public.chal_set_captain('e3080000-0000-4000-8000-0000000000ff', tests.uid('m1')) $$,
  'P0001',
  'team not found',
  'an unknown team is refused');
select throws_ok(
  $$ select public.chal_set_captain('e3080000-0000-4000-8000-000000000002', tests.uid('m3')) $$,
  'P0001',
  'captain must be an active participant on this team',
  'm3 is on Alpha, so m3 cannot captain Bravo');
select throws_ok(
  $$ select public.chal_set_captain('e3080000-0000-4000-8000-000000000002', tests.uid('owner')) $$,
  'P0001',
  'captain must be an active participant on this team',
  'someone who is not in the challenge at all certainly cannot captain one of its teams');
select is_empty(
  $$ select 1 from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000002' and captain_id is not null $$,
  'after both refusals Bravo still has no captain - nothing was written before the check');

select lives_ok(
  $$ select public.chal_set_captain('e3080000-0000-4000-8000-000000000002', tests.uid('m1')) $$,
  'the coach names m1, who is on Bravo, as Bravo''s captain');
select results_eq(
  $$ select captain_id from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000002' $$,
  $$ values (tests.uid('m1')) $$,
  'captain_id is set');

select throws_ok(
  $$ update public.challenge_teams set captain_id = tests.uid('m3')
     where id = 'e3080000-0000-4000-8000-000000000001' $$,
  'P0001',
  'captain is set through chal_set_captain',
  'THE PIN: even a community.challenge.create holder cannot write captain_id by direct RLS update, so the column can never change without an admin_actions row');
select throws_ok(
  $$ insert into public.challenge_teams (challenge_id, name, captain_id)
     values ('c3080000-0000-4000-8000-000000000001', 'Hotel', tests.uid('m1')) $$,
  'P0001',
  'captain is set through chal_set_captain',
  'the pin covers INSERT too - a team is created first and captained second, which is the only order that can ever be true');
select lives_ok(
  $$ update public.challenge_teams set name = 'Bravo renamed' where id = 'e3080000-0000-4000-8000-000000000002' $$,
  'a rename of a team that HAS a captain is still a plain RLS update - the guard only fires on a real captain_id change');
select results_eq(
  $$ select name, captain_id from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000002' $$,
  $$ values ('Bravo renamed'::text, tests.uid('m1')) $$,
  '...and the captain survived the rename');
select lives_ok(
  $$ update public.challenge_teams set name = 'Bravo', captain_id = tests.uid('m1')
     where id = 'e3080000-0000-4000-8000-000000000002' $$,
  'a client update that re-sends the SAME captain_id is not a change and is allowed - the guard compares values, it does not just look at the SET list');

select lives_ok(
  $$ select public.chal_set_captain('e3080000-0000-4000-8000-000000000002', null) $$,
  'clearing a captain (p_user_id null) is always allowed, per COMM-308''s validation rules');
select is_empty(
  $$ select 1 from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000002' and captain_id is not null $$,
  'the captain is cleared');

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.chal_set_captain('e3080000-0000-4000-8000-000000000002', tests.uid('m1')) $$,
  'the owner holds every permission and can name a captain too - the gate is the permission, not the coach role');

-- The other half of the invariant: a captain who leaves the team stops
-- being its captain, on every path, not just through chal_set_captain.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', tests.uid('m1'), 'e3080000-0000-4000-8000-000000000001') $$,
  'the coach moves the captain m1 off Bravo and onto Alpha');
select is_empty(
  $$ select 1 from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000002' and captain_id is not null $$,
  'challenge_teams_release_captain cleared Bravo''s captain in the same transaction - a team never points at someone who is not on it');

select lives_ok(
  $$ select public.chal_set_captain('e3080000-0000-4000-8000-000000000001', tests.uid('m3')) $$,
  'm3, on Alpha, is made Alpha''s captain');
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ delete from public.challenge_participants
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m3') $$,
  'the captain leaves the challenge outright, through the plain challenge_participants_leave_self policy');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000001' and captain_id is not null $$,
  'a plain leave clears the captain too - the rule lives in a trigger on challenge_participants, not inside chal_reassign_team, so all three paths (reassign, withdraw, leave) are covered');

-- =====================================================================
-- G. admin_actions: every staff write here is audited
-- =====================================================================
-- Read as the bootstrap superuser: admin_actions' only select policy is
-- community.analytics.view, and what is under test is the rows, not that
-- policy.
select results_eq(
  $$ select action_type, target_id from public.admin_actions
     where target_type = 'challenge_participant'
       and (after_data ->> 'team_id') = 'e3080000-0000-4000-8000-000000000002'
       and target_id = tests.uid('m1') $$,
  $$ values ('challenge_edit'::text, tests.uid('m1')) $$,
  'the Alpha -> Bravo reassignment wrote one admin_actions row, action_type challenge_edit, target_type challenge_participant, target_id the member (challenge_participants has a composite key and so no single row id)');
select results_eq(
  $$ select (before_data ->> 'team_id')::uuid, (before_data ->> 'challenge_id')::uuid from public.admin_actions
     where target_type = 'challenge_participant'
       and target_id = tests.uid('m1')
       and (after_data ->> 'team_id') = 'e3080000-0000-4000-8000-000000000002' $$,
  $$ values ('e3080000-0000-4000-8000-000000000001'::uuid, 'c3080000-0000-4000-8000-000000000001'::uuid) $$,
  'before_data carries the team the member came from and the challenge, so the log answers "moved from where" without a join');
select results_eq(
  $$ select count(*)::int from public.admin_actions where target_type = 'challenge_participant' $$,
  $$ values (3) $$,
  'exactly one row per SUCCESSFUL chal_reassign_team call so far (m1 Alpha->Bravo, m3 ->Alpha, m1 Bravo->Alpha) and none for the seven calls that raised - the log records what happened, not what was attempted');

select results_eq(
  $$ select action_type, target_id, (after_data ->> 'captain_id')::uuid from public.admin_actions
     where target_type = 'challenge_team' and (after_data ->> 'captain_id') is null $$,
  $$ values ('challenge_edit'::text, 'e3080000-0000-4000-8000-000000000002'::uuid, null::uuid) $$,
  'clearing a captain is audited too, target_type challenge_team, target_id the team');
select results_eq(
  $$ select count(*)::int from public.admin_actions where target_type = 'challenge_team' $$,
  $$ values (4) $$,
  'one row per successful chal_set_captain call (set m1, clear, set m1 again as owner, set m3) - and none for the calls that raised');
select is_empty(
  $$ select 1 from public.admin_actions where target_type = 'challenge_team'
       and (after_data ->> 'captain_id')::uuid = tests.uid('m3')
       and admin_id <> tests.uid('coach') $$,
  'the audit row records the staff member who actually called the function');

-- =====================================================================
-- H. Deleting a team with members is refused
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ delete from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000001' $$,
  'P0001',
  'team not empty',
  'Alpha still has m1 and m2 on it, so the delete is refused at the database rather than left to the client');
select isnt_empty(
  $$ select 1 from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000001' $$,
  'the team is still there after the refusal');

select lives_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', tests.uid('m2'), null) $$,
  'p_team_id null takes a member out of every team - how a column is emptied when the member should not land anywhere else');
select results_eq(
  $$ select team_id from public.challenge_participants
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m2') $$,
  $$ values (null::uuid) $$,
  'm2 has no team now');
select throws_ok(
  $$ delete from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000001' $$,
  'P0001',
  'team not empty',
  'one remaining member (m1) is enough to keep refusing');

select lives_ok(
  $$ select public.chal_reassign_team('c3080000-0000-4000-8000-000000000001', tests.uid('m1'), 'e3080000-0000-4000-8000-000000000002') $$,
  'the last member is reassigned off Alpha');
select lives_ok(
  $$ delete from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000001' $$,
  'the now-empty team deletes normally - "empty the column by reassignment first" is the whole workflow');
select results_eq(
  $$ select team_id from public.challenge_progress
     where challenge_id = 'c3080000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') and delta = 10 $$,
  $$ values (null::uuid) $$,
  'DELETING a team does null the historical snapshots that pointed at it (challenge_progress.team_id is ON DELETE SET NULL, 202608290003) - which is precisely why deleting a non-empty team is refused; REASSIGNING never does this');

-- A withdrawn member does not keep a team alive.
select lives_ok(
  $$ delete from public.challenge_teams where id = 'e3080000-0000-4000-8000-000000000004' $$,
  'Delta''s only member (m3) is withdrawn, so Delta is empty for this purpose and deletes - a withdrawn row''s team_id going null is the same ON DELETE SET NULL behaviour COMM-006 already shipped');

-- The cascade escape hatch: deleting the whole challenge must still work
-- even though its team is not empty.
select isnt_empty(
  $$ select 1 from public.challenge_participants
     where team_id = 'e3080000-0000-4000-8000-00000000000a' and status <> 'withdrawn' $$,
  'Echo has an active member on it, so a plain team delete would be refused');
select lives_ok(
  $$ delete from public.challenges where id = 'c3080000-0000-4000-8000-000000000004' $$,
  'deleting the whole challenge still cascades to its non-empty teams - challenge_teams_block_delete returns early when the parent challenge is already gone, so challenges_delete_perm is not broken by this ticket');
select is_empty(
  $$ select 1 from public.challenge_teams where id = 'e3080000-0000-4000-8000-00000000000a' $$,
  'the cascaded team is gone');

-- =====================================================================
-- I. Grants
-- =====================================================================
select tests.clear_auth();
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.chal_reassign_team(uuid, uuid, uuid)', 'execute') $$,
  $$ values (true) $$,
  'chal_reassign_team is callable by authenticated (the permission check inside is the boundary)');
select results_eq(
  $$ select has_function_privilege('anon', 'public.chal_reassign_team(uuid, uuid, uuid)', 'execute') $$,
  $$ values (false) $$,
  'anon cannot call chal_reassign_team');
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.chal_set_captain(uuid, uuid)', 'execute') $$,
  $$ values (true) $$,
  'chal_set_captain is callable by authenticated');
select results_eq(
  $$ select has_function_privilege('anon', 'public.chal_set_captain(uuid, uuid)', 'execute') $$,
  $$ values (false) $$,
  'anon cannot call chal_set_captain');
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.challenge_teams_guard_captain()', 'execute') $$,
  $$ values (false) $$,
  'the guard trigger function is not callable by a client - it is reachable only as a trigger');

select * from finish();
rollback;
