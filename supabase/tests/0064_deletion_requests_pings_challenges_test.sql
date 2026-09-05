-- Three tables that shipped with real RLS and, until this file, zero pgTAP
-- coverage:
--
--   account_deletion_requests  202608260001 - self-select only, NO write
--                              grant at all for `authenticated`;
--                              request_account_deletion() and
--                              admin_remove_member() are the only writers,
--                              purge_due_accounts() the only reaper.
--   activity_pings             202608270001 - self-select + self-insert.
--                              The raw per-day rows stay private; the
--                              aggregate leaks out only through the definer
--                              view community_streaks and the staff-gated
--                              coach_inactive_members().
--   weekly_challenges          202608270001 - `using (true)` on SELECT,
--                              staff-only INSERT (202608270005 /
--                              202608270006 rebound the WITH CHECK onto the
--                              current no-arg is_staff()).
--
-- On weekly_challenges' `using (true)`: it is deliberate, not an oversight,
-- and this file locks the intent in rather than narrowing it. The table
-- holds club-wide programming written BY staff FOR the whole box - a title,
-- a comparison_key and a date window, no member data of any kind - and it
-- is the fallback the home mark renders when public.challenges is empty
-- (202608280019_feed_ranking.sql). Its peers agree: announcements_read,
-- challenges_read and events_read are all club-wide-to-any-authenticated
-- too, differing only by the status/expiry/feature-flag axes that
-- weekly_challenges (single club, no draft state, no feature flag) does not
-- have. The privacy boundary here is the WRITE side, and that is what the
-- insert assertions below pin down.
--
-- Two behaviours worth naming up front, both asserted below because they
-- are easy to misremember:
--   * A missing INSERT policy is an ERROR (42501). A missing UPDATE/DELETE
--     policy is a SILENT NO-OP - the USING filter matches no rows, so the
--     statement succeeds having changed nothing. activity_pings and
--     weekly_challenges both still carry Supabase's default UPDATE/DELETE
--     grants for `authenticated` (they were created in 202608270001, one
--     migration before 202608270002 tightened the default privileges), so
--     RLS is the only thing standing there. It holds.
--   * account_deletion_requests is the opposite shape: the GRANT is the
--     wall (select only), so every client write dies at 42501 before RLS is
--     ever consulted.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. account_deletion_requests - the read boundary
-- =====================================================================
-- Seeded as the bootstrap superuser: there is no INSERT grant for any
-- client role, so this is the only way to get two members' rows side by
-- side without going through request_account_deletion() first.
select tests.clear_auth();
insert into public.account_deletion_requests (user_id)
values (tests.uid('m1')), (tests.uid('m2'));

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id from public.account_deletion_requests $$,
  $$ select tests.uid('m1') $$,
  'a member selecting the whole table gets exactly their own pending-deletion row');
select is_empty(
  $$ select user_id from public.account_deletion_requests where user_id = tests.uid('m2') $$,
  'and naming another member''s id explicitly returns nothing - the row is filtered away, not refused with an error that would confirm it exists');

-- Whether a member is scheduled for deletion is exactly the kind of thing
-- an admin panel might want, and deliberately does not have: the table has
-- ONE policy and it is self-select. Nothing widens it for staff.
select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select user_id from public.account_deletion_requests $$,
  'an admin has NO special read access - is_admin buys nothing on this table');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select user_id from public.account_deletion_requests $$,
  'and neither does a coach - there is no is_staff() branch here either');

-- =====================================================================
-- 2. account_deletion_requests - the write boundary is the GRANT
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.account_deletion_requests (user_id) values (tests.uid('m1')) $$,
  '42501',
  null,
  'a member cannot insert their own deletion row directly - request_account_deletion() is the only self-service write path');
select throws_ok(
  $$ insert into public.account_deletion_requests (user_id) values (tests.uid('m3')) $$,
  '42501',
  null,
  'and certainly cannot schedule somebody else for deletion');
select throws_ok(
  $$ update public.account_deletion_requests set purge_after = now() + interval '100 years' where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'a member cannot push their own purge_after out to dodge the reaper');
select throws_ok(
  $$ delete from public.account_deletion_requests where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'nor delete the row to cancel - undo is a support action, not a client one');

select tests.clear_auth();
select ok(
  pg_catalog.has_table_privilege('authenticated', 'public.account_deletion_requests', 'select'),
  'the grant matrix says it out loud: authenticated may SELECT');
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.account_deletion_requests', 'insert')
  and not pg_catalog.has_table_privilege('authenticated', 'public.account_deletion_requests', 'update')
  and not pg_catalog.has_table_privilege('authenticated', 'public.account_deletion_requests', 'delete'),
  'and nothing else - the three writes above fail at the grant, before RLS is even consulted');
select ok(
  not pg_catalog.has_table_privilege('anon', 'public.account_deletion_requests', 'select'),
  'a signed-out session cannot read the table at all');

-- =====================================================================
-- 3. request_account_deletion() - the one member-facing writer
-- =====================================================================
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body)
values ('c0640000-0000-4000-8000-000000000001', tests.uid('m3'), 'club', 'a post by the member who is about to leave');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.request_account_deletion() $$,
  'a member can schedule their own deletion');
select results_eq(
  $$ select user_id from public.account_deletion_requests $$,
  $$ select tests.uid('m3') $$,
  'and can still read their own row back AFTER the call soft-deleted their profile - the 30-day undo window stays visible to the person in it');
select ok(
  (select purge_after between now() + interval '29 days' and now() + interval '31 days'
     from public.account_deletion_requests where user_id = tests.uid('m3')),
  'purge_after lands 30 days out, matching the grace period the UI promises');

select tests.clear_auth();
select ok(
  (select deleted_at is not null from public.profiles where id = tests.uid('m3')),
  'the profile is soft-deleted immediately, so the member disappears from the club the moment they ask');
select ok(
  (select deleted_at is not null from public.workout_posts where id = 'c0640000-0000-4000-8000-000000000001'),
  'and so is every post they authored');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.request_account_deletion() $$,
  'calling it a second time is safe - the on conflict clause re-arms the same row');
select tests.clear_auth();
select is(
  (select count(*)::int from public.account_deletion_requests where user_id = tests.uid('m3')),
  1,
  'still exactly one row, not a second pending request');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.request_account_deletion()', 'execute'),
  'and a signed-out session cannot call it - auth.uid() would be null and the insert would write a NULL user_id');

-- =====================================================================
-- 4. admin_remove_member() - the staff-facing writer
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_remove_member(tests.uid('m2')) $$,
  'P0001',
  'not authorized',
  'a plain member cannot remove another member');
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.admin_remove_member(tests.uid('m2')) $$,
  'P0001',
  'not authorized',
  'and neither can a coach - this one gates on the literal profiles.is_admin, not the coach-inclusive is_staff()');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.admin_remove_member(tests.uid('admin')) $$,
  'P0001',
  'use account deletion for your own account',
  'an admin cannot remove themselves through the member-management path');
select lives_ok(
  $$ select public.admin_remove_member(tests.uid('norec')) $$,
  'an admin can remove a member');
select is_empty(
  $$ select user_id from public.account_deletion_requests $$,
  'and then cannot read back the row they just caused - writing through a definer function does not buy the caller a read on the table');

select tests.clear_auth();
select ok(
  (select purge_after between now() + interval '29 days' and now() + interval '31 days'
     from public.account_deletion_requests where user_id = tests.uid('norec')),
  'the admin path arms the identical 30-day purge the self-service path does');
select ok(
  (select deleted_at is not null from public.profiles where id = tests.uid('norec')),
  'with the same immediate soft-delete of the profile');

select tests.set_auth(tests.uid('norec'));
select results_eq(
  $$ select user_id from public.account_deletion_requests $$,
  $$ select tests.uid('norec') $$,
  'and the removed member can see their own scheduled purge - being removed by staff is not hidden from them');

-- =====================================================================
-- 5. activity_pings - own-row read/write
-- =====================================================================
select tests.clear_auth();
insert into public.activity_pings (user_id, activity_date) values
  (tests.uid('m2'), current_date),
  (tests.uid('m2'), current_date - 1),
  (tests.uid('m2'), current_date - 2);

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.activity_pings (user_id, activity_date) values (tests.uid('m1'), current_date) $$,
  'a member can record their own daily ping');
select throws_ok(
  $$ insert into public.activity_pings (user_id, activity_date) values (tests.uid('m2'), current_date - 3) $$,
  '42501',
  null,
  'and cannot forge a ping for somebody else - streaks are not something you can hand out');
-- The client writes this exact shape (cloud.js: upsert with
-- ignoreDuplicates, which PostgREST sends as on conflict do nothing), once
-- per app open. It must not error on the second open of the same day.
select lives_ok(
  $$ insert into public.activity_pings (user_id, activity_date) values (tests.uid('m1'), current_date)
     on conflict (user_id, activity_date) do nothing $$,
  'the same day pinged twice is a no-op, not a primary-key error - this is the client''s literal upsert shape');
select is(
  (select count(*)::int from public.activity_pings where user_id = tests.uid('m1')),
  1,
  'and leaves exactly one row for the day');

select results_eq(
  $$ select activity_date from public.activity_pings order by activity_date $$,
  $$ select current_date $$,
  'a member reading the table sees only their own days');
select is_empty(
  $$ select activity_date from public.activity_pings where user_id = tests.uid('m2') $$,
  'another member''s raw per-day activity is invisible - which days somebody trained is more personal than how long their streak is');

select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select user_id from public.activity_pings $$,
  'a coach cannot read the raw rows either - coach_inactive_members() is the deliberate, self-gated way across that line');
select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select user_id from public.activity_pings $$,
  'and an admin has no direct read here either');

-- UPDATE/DELETE: the table still carries Supabase's default grants for
-- these (created one migration before the default privileges were
-- tightened), so RLS alone has to hold - and a missing policy is a silent
-- filter, not an error.
select ok(
  pg_catalog.has_table_privilege('authenticated', 'public.activity_pings', 'update')
  and pg_catalog.has_table_privilege('authenticated', 'public.activity_pings', 'delete'),
  'authenticated does hold UPDATE and DELETE grants on activity_pings - a leftover from the pre-202608270002 defaults');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.activity_pings set activity_date = current_date - 20 where user_id = tests.uid('m1') $$,
  'so an UPDATE is accepted rather than rejected...');
select lives_ok(
  $$ delete from public.activity_pings where user_id = tests.uid('m1') $$,
  '...and so is a DELETE');
select results_eq(
  $$ select activity_date from public.activity_pings $$,
  $$ select current_date $$,
  'but both changed ZERO rows: with no UPDATE or DELETE policy the USING filter matches nothing, so pings are append-only and a member cannot rewrite their own history');

-- =====================================================================
-- 6. activity_pings - the two deliberate ways across that boundary
-- =====================================================================
-- community_streaks is deliberately NOT security_invoker: it runs with the
-- migration owner's rights so it can aggregate every member's rows, and
-- re-applies the block/soft-delete checks by hand.
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select current_streak from public.community_streaks where user_id = tests.uid('m2') $$,
  $$ values (3) $$,
  'the aggregate DOES cross the boundary: a member sees another member''s streak length through community_streaks, though the three raw dates behind it stayed hidden two blocks up');

select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select user_id from public.community_streaks where user_id = tests.uid('m2') $$,
  'and the definer view still honours blocks, which it has to check explicitly because definer mode bypasses the RLS that would otherwise do it');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m1') and blocked_id = tests.uid('m2');

-- coach_inactive_members() is the staff path to the raw dates.
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.coach_inactive_members() $$,
  'P0001',
  'not authorized',
  'a plain member cannot run the inactivity report');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select user_id from public.coach_inactive_members() where user_id = tests.uid('m2') $$,
  'a coach can run it, and a member who pinged today is not on the list');
select is(
  (select count(*)::int from public.coach_inactive_members() where user_id = tests.uid('coach')),
  1,
  'while a member with no ping at all is - null last activity sorts first, which is the point of the report');
select results_eq(
  $$ select last_activity_on from public.coach_inactive_members(current_date + 1) where user_id = tests.uid('m2') $$,
  $$ select current_date $$,
  'and widening the window hands the coach the RAW last-activity date that the same coach could not select from activity_pings directly - the definer function is the whole boundary crossing');

-- =====================================================================
-- 7. weekly_challenges - `using (true)` is the intent, documented
-- =====================================================================
select tests.clear_auth();
insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by) values
  ('c0640000-0000-4000-8000-000000000011', 'movement:back-squat:est1rm', 'Back squat week', current_date - 1, current_date + 5, tests.uid('admin')),
  ('c0640000-0000-4000-8000-000000000012', 'movement:deadlift:est1rm',  'Deadlift week (over)', current_date - 30, current_date - 24, tests.uid('coach'));

select tests.set_auth(tests.uid('m1'));
select set_eq(
  $$ select id from public.weekly_challenges $$,
  $$ values ('c0640000-0000-4000-8000-000000000011'::uuid), ('c0640000-0000-4000-8000-000000000012'::uuid) $$,
  'every member reads every challenge row: this is club-wide programming written by staff for the whole box, and the read policy is intentionally unconditional');
select results_eq(
  $$ select title from public.weekly_challenges where ends_on < current_date $$,
  $$ values ('Deadlift week (over)') $$,
  'including one whose window has closed - RLS does no date filtering, the leaderboard view decides what is CURRENT');

-- A session with no effective role at all still reads it. `norec` was
-- removed in section 4, so my_role_code() is null for them. That is the
-- honest reading of `using (true)`: the gate is being signed in, nothing
-- more. Nothing member-specific lives in this table for it to leak.
select tests.set_auth(tests.uid('norec'));
select ok(
  public.my_role_code() is null and not public.is_staff(),
  'a session with no role code and no staff rank...');
select is(
  (select count(*)::int from public.weekly_challenges),
  2,
  '...still reads the challenge board, because the board is public-to-the-club by design');
select tests.clear_auth();
select ok(
  not pg_catalog.has_table_privilege('anon', 'public.weekly_challenges', 'select'),
  'the one hard edge: a signed-out session gets nothing - 202608270002 revoked anon');

-- =====================================================================
-- 8. weekly_challenges - the boundary that IS real, the write side
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('movement:snatch:est1rm', 'Member-declared week', current_date, current_date + 3, tests.uid('m1')) $$,
  '42501',
  null,
  'a plain member cannot set the club challenge');
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('movement:snatch:est1rm', 'Member-declared week', current_date, current_date + 3, tests.uid('admin')) $$,
  '42501',
  null,
  'and cannot get there by putting an admin''s id in created_by - the WITH CHECK requires BOTH created_by = auth.uid() AND is_staff()');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
     values ('c0640000-0000-4000-8000-000000000013', 'movement:clean:est1rm', 'Coach week', current_date, current_date + 3, tests.uid('coach')) $$,
  'a coach can - is_staff() is coach rank or above, which is what 202608270005 and 202608270006 rebound this policy onto');
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('movement:jerk:est1rm', 'Ghost-written week', current_date, current_date + 3, tests.uid('admin')) $$,
  '42501',
  null,
  'but not under somebody else''s name, even another staff member''s - created_by is always the author');
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
     values ('c0640000-0000-4000-8000-000000000014', 'movement:press:est1rm', 'Admin week', current_date, current_date + 3, tests.uid('admin')) $$,
  'and an admin can too');

-- Same silent-no-op shape as activity_pings: the grants are there, the
-- policies are not. Worth pinning because it is a real product constraint -
-- a coach cannot fix a typo in a challenge from the app, only add a new row.
select ok(
  pg_catalog.has_table_privilege('authenticated', 'public.weekly_challenges', 'update')
  and pg_catalog.has_table_privilege('authenticated', 'public.weekly_challenges', 'delete'),
  'authenticated holds UPDATE and DELETE grants on weekly_challenges as well');
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.weekly_challenges set title = 'Renamed by its own author'
     where id = 'c0640000-0000-4000-8000-000000000013' $$,
  'so a coach editing the challenge they themselves created is accepted...');
select lives_ok(
  $$ delete from public.weekly_challenges where id = 'c0640000-0000-4000-8000-000000000013' $$,
  '...as is deleting it');
select tests.clear_auth();
select results_eq(
  $$ select title from public.weekly_challenges where id = 'c0640000-0000-4000-8000-000000000013' $$,
  $$ values ('Coach week') $$,
  'and both changed nothing: with no UPDATE or DELETE policy the board is insert-only for every client, author included');

-- =====================================================================
-- 9. weekly_challenge_leaderboard - the read path built on the table
-- =====================================================================
-- security_invoker on purpose, so it reuses posts_feed_select rather than
-- re-deriving post visibility.
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, title, result_text, comparison_key, score_value, score_direction, occurred_on)
values
  ('c0640000-0000-4000-8000-000000000021', tests.uid('m2'), 'club', 'Back squat', '100 kg', 'movement:back-squat:est1rm', 100, 'higher', current_date),
  ('c0640000-0000-4000-8000-000000000022', tests.uid('m2'), 'club', 'Back squat old', '90 kg', 'movement:back-squat:est1rm', 90, 'higher', current_date - 10),
  ('c0640000-0000-4000-8000-000000000023', tests.uid('m2'), 'club', 'Deadlift', '150 kg', 'movement:deadlift:est1rm', 150, 'higher', current_date - 27);

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select post_id from public.weekly_challenge_leaderboard $$,
  $$ values ('c0640000-0000-4000-8000-000000000021'::uuid) $$,
  'the leaderboard picks up an already-shared post whose comparison_key and date fall inside the running challenge - there is no separate submission step');
select is_empty(
  $$ select post_id from public.weekly_challenge_leaderboard where challenge_id = 'c0640000-0000-4000-8000-000000000012' $$,
  'the finished challenge shows nothing even though a matching post exists - current_date must sit inside the window');

select tests.clear_auth();
update public.workout_posts set visibility = 'followers' where id = 'c0640000-0000-4000-8000-000000000021';
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select post_id from public.weekly_challenge_leaderboard $$,
  'and a post the viewer could not see in the feed does not surface here either - security_invoker means posts_feed_select still applies');
select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select post_id from public.weekly_challenge_leaderboard $$,
  $$ values ('c0640000-0000-4000-8000-000000000021'::uuid) $$,
  'while its own author still sees it');
select tests.clear_auth();
update public.workout_posts set visibility = 'club' where id = 'c0640000-0000-4000-8000-000000000021';

-- =====================================================================
-- 10. purge_due_accounts() - service-role only, and it really deletes
-- =====================================================================
-- Destructive, so it runs last: it removes the auth.users row for the
-- member admin_remove_member() scheduled in section 4.
select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.purge_due_accounts()', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.purge_due_accounts()', 'execute'),
  'no browser session can run the reaper, whatever role it holds');
select ok(
  pg_catalog.has_function_privilege('service_role', 'public.purge_due_accounts()', 'execute'),
  'only the service role the scheduler uses can');
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.purge_due_accounts() $$,
  '42501',
  null,
  'and an admin calling it from the app gets permission denied, not a purge');

select tests.clear_auth();
update public.account_deletion_requests set purge_after = now() - interval '1 day' where user_id = tests.uid('norec');
select is(
  public.purge_due_accounts(),
  1,
  'once the 30 days are up the reaper takes exactly the one row that is due');
select is(
  (select count(*)::int from auth.users where id = tests.uid('norec')),
  0,
  'the auth.users row is really gone - a hard delete, not another soft one');
select is(
  (select count(*)::int from public.profiles where id = tests.uid('norec')),
  0,
  'and on delete cascade took the profile with it');
select is(
  (select count(*)::int from public.account_deletion_requests where user_id = tests.uid('norec')),
  0,
  'along with the request row itself, so the queue drains');
select is(
  public.purge_due_accounts(),
  0,
  'a second run finds nothing - the reaper is idempotent');
select is(
  (select count(*)::int from public.account_deletion_requests),
  3,
  'and the three requests still inside their 30-day window are untouched, which is the whole point of the grace period');

select * from finish();
rollback;
