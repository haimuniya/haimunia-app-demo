-- Coach signal honesty (202609060020).
--
-- The defect these assertions pin down: coach_inactive_members() reported
-- every member of a seeded, visibly active club as never-active - because
-- its HAVING clause merged "we have no data" with "they stopped" and the
-- client rendered the null branch as "never" - while coach_new_members()
-- INNER JOINed the same empty table and so could not see a single new
-- member, including the ones who had registered and never opened the app,
-- who are precisely the people day-0 retention outreach exists for.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures
-- =====================================================================
-- The helper file joins every fixture member today, which is the one shape
-- that cannot exercise any of this: nobody can have lapsed, and everybody
-- is new. Tenure is backdated per member instead.
select tests.clear_auth();

update public.invite_redemptions set redeemed_at = now() - interval '100 days'
 where user_id in (tests.uid('m1'), tests.uid('m2'));
update public.profiles set created_at = now() - interval '100 days'
 where id in (tests.uid('m1'), tests.uid('m2'));

update public.invite_redemptions set redeemed_at = now() - interval '200 days'
 where user_id = tests.uid('m3');
update public.profiles set created_at = now() - interval '200 days'
 where id = tests.uid('m3');

-- norec keeps the helper's "joined today" and gets nothing else: they are
-- the member who registered and has never once opened the app.

-- m1: opened the app, then stopped 30 days ago. Genuinely lapsed.
insert into public.activity_pings (user_id, activity_date)
values (tests.uid('m1'), current_date - 30),
       (tests.uid('m1'), current_date - 31)
on conflict do nothing;

-- m2: joined 100 days ago and we have never recorded one thing about them.
-- No pings at all. This is the 'no_data' member.

-- m3: joined 200 days ago but has exactly ONE ping, today. This member is
-- the sharpest regression case in the file - see the assertion below.
insert into public.activity_pings (user_id, activity_date)
values (tests.uid('m3'), current_date)
on conflict do nothing;

-- Two logged training days for m1, so sessions_logged has something to
-- count and the aggregate-vs-raw privacy boundary can be tested.
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('m1'), current_date - 30),
       (tests.uid('m1'), current_date - 33)
on conflict do nothing;

-- =====================================================================
-- 1. coach_inactive_members: 'lapsed' and 'no_data' are different answers
-- =====================================================================
select tests.set_auth(tests.uid('coach'));

select is(
  (select state from public.coach_inactive_members() where user_id = tests.uid('m1')),
  'lapsed',
  'a member who opened the app and stopped 30 days ago is lapsed');

select is(
  (select last_activity_on from public.coach_inactive_members() where user_id = tests.uid('m1')),
  current_date - 30,
  'a lapsed member carries the real date their activity stopped');

select is(
  (select days_since_activity from public.coach_inactive_members() where user_id = tests.uid('m1')),
  30,
  'and the gap in days, so the client never has to do date arithmetic itself');

-- THE CORE FIX. Before 202609060020 this member was returned in the same
-- undifferentiated list as m1 and rendered "מעולם לא" - an assertion about a
-- person manufactured out of an absence of data.
select is(
  (select state from public.coach_inactive_members() where user_id = tests.uid('m2')),
  'no_data',
  'THE FIX: a member we have never recorded anything about is no_data, NOT lapsed - the two must never render identically');

select is(
  (select last_activity_on from public.coach_inactive_members() where user_id = tests.uid('m2')),
  null::date,
  'a no_data member has a null date rather than a fabricated one');

select is(
  (select days_since_activity from public.coach_inactive_members() where user_id = tests.uid('m2')),
  null::integer,
  'and a null gap: there is no "days since" a thing that never happened, and 0 or a large number would be something the client could render by accident');

-- Scoped to the fixture members rather than counting the whole club: this
-- file runs against whatever club the stack was started with, and a bare
-- count would pass on CI's empty stack and fail on a locally seeded one.
select is(
  (select count(*)::int from public.coach_inactive_members()
    where state = 'lapsed'
      and user_id in (tests.uid('m1'), tests.uid('m2'), tests.uid('m3'), tests.uid('norec'))),
  1,
  'of the four fixture members exactly one is genuinely lapsed - this is the number the Manage tab attention row must count, NOT the whole result set, which also carries the no_data members');

-- The new-member exclusion. norec joined today with no activity at all;
-- without this rule every new member appears in the alarming red list on
-- the day they join, before anyone could reasonably have welcomed them.
select is_empty(
  $$ select 1 from public.coach_inactive_members() where user_id = tests.uid('norec') $$,
  'a member who joined today is never "inactive" - they are new, and they belong in coach_new_members() where the actions for them are');

-- m3 pinged today, so they are not in the list at all.
select is_empty(
  $$ select 1 from public.coach_inactive_members() where user_id = tests.uid('m3') $$,
  'a member who opened the app today is not in the inactive list');

-- =====================================================================
-- 2. coach_new_members: the join date, and the member who never came back
-- =====================================================================
select is(
  (select joined_on from public.coach_new_members() where user_id = tests.uid('norec')),
  current_date,
  'a member who joined today appears with today as their join date');

-- THE OTHER CORE FIX. The old function INNER JOINed activity_pings, so a
-- member with no pings could not appear at all - and a member who
-- registered and never opened the app again is exactly who day-0 outreach
-- is for. The feature could not see the churn it existed to prevent.
select is(
  (select has_opened_app from public.coach_new_members() where user_id = tests.uid('norec')),
  false,
  'THE FIX: a member who registered and has NEVER opened the app is present in the new-member list and flagged as never having opened it - the old INNER JOIN on activity_pings dropped exactly this member');

-- The mirror of the same bug. m3 joined 200 days ago and opened the app for
-- the first time today; the old function read min(activity_date) as a join
-- date and would call them a brand-new member.
select is_empty(
  $$ select 1 from public.coach_new_members() where user_id = tests.uid('m3') $$,
  'THE FIX: a 200-day member who happens to have opened the app for the first time today is NOT new - the old min(activity_date) form reported the first-app-open date as a join date, which for every member predating the feature was the feature''s own deploy date');

select is(
  (select count(*)::int from public.coach_new_members(365) where user_id = tests.uid('m3')),
  1,
  '...and a wide enough window still finds them, so the exclusion above is the window doing its job rather than the member being dropped');

select is(
  (select sessions_logged from public.coach_new_members(365) where user_id = tests.uid('m1')),
  2,
  'sessions_logged counts real attendance_log training days');

select is(
  (select sessions_logged from public.coach_new_members() where user_id = tests.uid('norec')),
  0,
  'a member who has logged nothing reports zero sessions, not null');

select is(
  (select contacted from public.coach_new_members() where user_id = tests.uid('norec')),
  false,
  'contact status defaults to false so the list reads as a work queue');

insert into public.member_contact_log (user_id, contacted_by, note)
values (tests.uid('norec'), tests.uid('coach'), 'called, left a message');

select is(
  (select contacted from public.coach_new_members() where user_id = tests.uid('norec')),
  true,
  'and flips once any coach logs an outreach, which is what stops two coaches welcoming the same member');

-- =====================================================================
-- 3. The privacy boundary 202609060013 drew is still intact
-- =====================================================================
-- This is the constraint that made "just point these at attendance_log" the
-- wrong fix. The coach may have the aggregate count above; they still may
-- not have the rows behind it.
select is_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m1') $$,
  'a plain coach still reads ZERO raw attendance rows (202609060013 / PRIVACY.md "not a detailed log") - sessions_logged is delivered as an aggregate by a definer function precisely so this stays true');

select ok(
  not public.has_perm('community.analytics.view'),
  '...and that is because a coach does not hold community.analytics.view, while still being staff');

-- =====================================================================
-- 4. Authorization: all three are staff-only
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select throws_ok(
  $$ select * from public.coach_inactive_members() $$,
  'not authorized',
  'coach_inactive_members refuses a plain member');

select throws_ok(
  $$ select * from public.coach_new_members() $$,
  'not authorized',
  'coach_new_members refuses a plain member');

select throws_ok(
  $$ select * from public.coach_activity_signal_status() $$,
  'not authorized',
  'coach_activity_signal_status refuses a plain member');

-- =====================================================================
-- 5. coach_activity_signal_status: telling "all clear" from "no data"
-- =====================================================================
-- The reason this exists: an empty inactive list means either "everyone is
-- active" or "this section has never received a single data point", and the
-- client cannot tell those apart from the list. The old client asserted the
-- first ("כולם פעילים") in both cases.
select tests.set_auth(tests.uid('admin'));

select ok(
  (select members_with_app_activity from public.coach_activity_signal_status()) >= 2,
  'the status row counts members who have ever opened the app');

select ok(
  (select members_total from public.coach_activity_signal_status())
    > (select members_with_app_activity from public.coach_activity_signal_status()),
  'and reports it against the club total, which is what lets the client say "we have data on 2 of 7" instead of guessing');

-- The two counts are DIFFERENT SIGNALS, and that is the whole reason the
-- status row carries both. Asserted differentially rather than as absolute
-- numbers: this file runs against whatever club the stack was started with,
-- so a bare count would pass on CI's empty stack and fail on a seeded one.
create temporary table signal_before as
  select * from public.coach_activity_signal_status();

select tests.clear_auth();
-- m2 has no activity_pings and now gains a training day.
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('m2'), current_date - 5)
on conflict do nothing;
select tests.set_auth(tests.uid('admin'));

select is(
  (select members_with_logged_sessions from public.coach_activity_signal_status())
    - (select members_with_logged_sessions from signal_before),
  1,
  'a member gaining a logged training day increments the logged-sessions count');

select is(
  (select members_with_app_activity from public.coach_activity_signal_status())
    - (select members_with_app_activity from signal_before),
  0,
  '...and does NOT touch the app-activity count: logging a workout and opening the app are different signals, and only one of them is about training');

-- =====================================================================
-- 6. Grants
-- =====================================================================
select tests.clear_auth();

select ok(
  not pg_catalog.has_function_privilege('anon', 'public.coach_inactive_members(date)', 'execute'),
  'coach_inactive_members is locked away from anon');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.coach_new_members(integer)', 'execute'),
  'coach_new_members is locked away from anon');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.coach_activity_signal_status()', 'execute'),
  'coach_activity_signal_status is locked away from anon');
select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.coach_activity_signal_status()', 'execute'),
  'and granted to authenticated, where the inline is_staff() gate takes over');

select * from finish();
rollback;
