-- COMM-300. attendance_log, its trigger on private_records, and the
-- no-client-write boundary (202608310001_attendance_log.sql).
--
-- The ticket names one testable boundary explicitly, and it is the first
-- three blocks below: two different session types on the same calendar day
-- produce one row, two different days produce two, and a `bodyweight` or
-- `measurement` record_type produces none. Everything after that is the
-- boundary this table exists to hold - nobody can write it by hand - plus
-- the two rules that only bite on data a hand-crafted request can send (an
-- unreadable date, a future date).
--
-- Written alongside the migration, not as a follow-up, per the convention
-- 0030-0034 set.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- The migration's own backfill runs against whatever private_records rows
-- exist at migration time (none, on a fresh reset). Assert the starting
-- point rather than assuming it, so every count below is about this file.
select is_empty(
  $$ select 1 from public.attendance_log $$,
  'attendance_log starts empty on a fresh database - every row below was written by the trigger during this test');

-- =====================================================================
-- The named boundary: one day, two session types -> exactly one row
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'strength_entry', 'e-day1-a',
             '{"id":"e-day1-a","exerciseId":"back-squat","date":"2026-08-10","type":"reps","weight":100,"reps":5,"sets":3,"ts":1}'::jsonb) $$,
  'm1 syncs a strength_entry logged on 2026-08-10');
select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'the first session-bearing record produces exactly one attendance day');
select results_eq(
  $$ select occurred_on, source_record_type, source_record_id from public.attendance_log where user_id = tests.uid('m1') $$,
  $$ values ('2026-08-10'::date, 'strength_entry'::text, 'e-day1-a'::text) $$,
  'occurred_on is read from payload->>''date'', not from now(), and the source record is stamped for provenance');

select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'strength_entry', 'e-day1-b',
             '{"id":"e-day1-b","exerciseId":"deadlift","date":"2026-08-10","type":"reps","weight":140,"reps":3,"sets":3,"ts":2}'::jsonb) $$,
  'm1 syncs a second lift on the same calendar day');
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'wod_entry', 'w-day1',
             '{"id":"w-day1","wodId":"fran","date":"2026-08-10","scoreType":"time","timeSeconds":240,"rx":true,"isPR":false,"ts":3}'::jsonb) $$,
  'm1 syncs a wod_entry on the same calendar day - a different session type');
select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'COMM-300 named boundary: two different session types on the same calendar day are still exactly one attendance day');
select results_eq(
  $$ select source_record_id from public.attendance_log where user_id = tests.uid('m1') and occurred_on = '2026-08-10' $$,
  $$ values ('e-day1-a'::text) $$,
  'on conflict do nothing keeps the first record that claimed the day - the later ones do not overwrite the provenance');

-- =====================================================================
-- The named boundary: two different days -> two rows
-- =====================================================================
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'wod_entry', 'w-day2',
             '{"id":"w-day2","wodId":"cindy","date":"2026-08-11","scoreType":"amrap","rounds":20,"reps":5,"rx":true,"isPR":false,"ts":4}'::jsonb) $$,
  'm1 trains again the next calendar day');
select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m1') $$,
  $$ values (2) $$,
  'COMM-300 named boundary: logging on two different days produces two attendance days');
select results_eq(
  $$ select occurred_on from public.attendance_log where user_id = tests.uid('m1') order by occurred_on $$,
  $$ values ('2026-08-10'::date), ('2026-08-11'::date) $$,
  'and they are the two days the member actually logged');

-- =====================================================================
-- The named boundary: bodyweight and measurement produce nothing
-- =====================================================================
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'bodyweight', 'bw-1',
             '{"id":"bw-1","date":"2026-08-12","weight":78.4,"ts":5}'::jsonb) $$,
  'm1 syncs a bodyweight reading dated 2026-08-12 - a well-formed date on a non-session record');
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'measurement', 'ms-1',
             '{"id":"ms-1","typeId":"waist","date":"2026-08-13","value":81,"ts":6}'::jsonb) $$,
  'm1 syncs a body measurement dated 2026-08-13');
select is_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m1') and occurred_on in ('2026-08-12', '2026-08-13') $$,
  'COMM-300 named boundary: bodyweight and measurement produce no attendance day, even though both carry a date of exactly the same shape - the filter is on record_type, not on having a date');
select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m1') $$,
  $$ values (2) $$,
  'still exactly the two real training days');

-- The remaining non-session types, for completeness: none of them is a
-- training session either.
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'movement',     'mv-1', '{"id":"mv-1","name":"Bulgarian split squat","date":"2026-08-14"}'::jsonb),
            (tests.uid('m1'), 'custom_wod',   'cw-1', '{"id":"cw-1","name":"Sunday grinder","date":"2026-08-15"}'::jsonb),
            (tests.uid('m1'), 'measure_type', 'mt-1', '{"id":"mt-1","name":"Waist","date":"2026-08-16"}'::jsonb),
            (tests.uid('m1'), 'session_note', 'sn-1', '{"id":"sn-1","date":"2026-08-17","note":"felt strong"}'::jsonb) $$,
  'm1 syncs one of each remaining record_type, every one carrying a date');
select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m1') $$,
  $$ values (2) $$,
  'movement, custom_wod, measure_type and session_note produce no attendance day either - the session-bearing set is exactly the two attendance_session_record_types() names');
select results_eq(
  $$ select public.attendance_session_record_types() $$,
  $$ values (array['strength_entry', 'wod_entry']::text[]) $$,
  'and that set is exactly what the helper the trigger''s WHEN clause reads returns, so the two cannot drift');

-- =====================================================================
-- Append-only: a soft-delete does not retract a day
-- =====================================================================
select lives_ok(
  $$ update public.private_records set deleted_at = now(), updated_at = now()
     where user_id = tests.uid('m1') and record_type = 'strength_entry' and record_id = 'e-day1-a' $$,
  'm1 soft-deletes the record that first claimed 2026-08-10');
select isnt_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m1') and occurred_on = '2026-08-10' $$,
  'the attendance day survives the soft-delete of its source record - append-only, "correct forward, not backward"');
select lives_ok(
  $$ update public.private_records set deleted_at = now(), updated_at = now()
     where user_id = tests.uid('m1') and record_type in ('strength_entry', 'wod_entry') $$,
  'm1 soft-deletes every session record they have');
select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m1') $$,
  $$ values (2) $$,
  'deleting every source record still leaves both attendance days - the trigger never deletes, and a soft-delete UPDATE is a no-op rather than a re-log');

-- =====================================================================
-- A soft-deleted record cannot create a day either
-- =====================================================================
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload, deleted_at)
     values (tests.uid('m1'), 'strength_entry', 'e-born-dead',
             '{"id":"e-born-dead","exerciseId":"press","date":"2026-08-20","type":"reps","weight":50,"reps":5,"sets":3,"ts":7}'::jsonb,
             now()) $$,
  'a record that arrives already soft-deleted syncs fine');
select is_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m1') and occurred_on = '2026-08-20' $$,
  'and produces no attendance day - the WHEN clause requires deleted_at is null');

-- =====================================================================
-- The upsert path: flushOutbox() re-sends as an UPDATE, which must count
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload, deleted_at)
     values (tests.uid('m2'), 'strength_entry', 'm2-e1',
             '{"id":"m2-e1","exerciseId":"snatch","date":"2026-08-05","type":"reps","weight":60,"reps":1,"sets":5,"ts":1}'::jsonb,
             now()) $$,
  'm2 has a session record that reached the server soft-deleted');
select is_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m2') $$,
  'no attendance day yet');
select lives_ok(
  $$ update public.private_records set deleted_at = null, payload = payload, updated_at = now()
     where user_id = tests.uid('m2') and record_id = 'm2-e1' $$,
  'the record is un-deleted by a later sync - the same UPDATE half of flushOutbox()''s upsert');
select results_eq(
  $$ select occurred_on from public.attendance_log where user_id = tests.uid('m2') $$,
  $$ values ('2026-08-05'::date) $$,
  'the trigger is AFTER INSERT OR UPDATE, so a record that arrives as an UPDATE (an edit, or a re-sync from a second device) still produces its day');

-- =====================================================================
-- Unreadable and impossible dates produce no row, and never raise
-- =====================================================================
select results_eq(
  $$ select public.attendance_parse_day('2026-08-10') $$,
  $$ values ('2026-08-10'::date) $$,
  'attendance_parse_day accepts the exact shape cleanISODate() produces');
select results_eq(
  $$ select public.attendance_parse_day('2026-13-45') is null $$,
  $$ values (true) $$,
  'a well-shaped but impossible date returns null instead of raising 22008 - the case a hand-crafted request can send and the JS sanitizer cannot');
select results_eq(
  $$ select public.attendance_parse_day('10/08/2026') is null,
            public.attendance_parse_day('2026-08-10T06:00:00Z') is null,
            public.attendance_parse_day('') is null,
            public.attendance_parse_day(null) is null $$,
  $$ values (true, true, true, true) $$,
  'every other shape - locale format, a full timestamp, empty, null - returns null');

select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m2'), 'strength_entry', 'm2-nodate', '{"id":"m2-nodate","exerciseId":"row","type":"reps","ts":2}'::jsonb),
            (tests.uid('m2'), 'strength_entry', 'm2-baddate', '{"id":"m2-baddate","exerciseId":"row","date":"yesterday","ts":3}'::jsonb),
            (tests.uid('m2'), 'strength_entry', 'm2-impossible', '{"id":"m2-impossible","exerciseId":"row","date":"2026-02-31","ts":4}'::jsonb),
            (tests.uid('m2'), 'wod_entry', 'm2-nulldate', '{"id":"m2-nulldate","wodId":"fran","date":null,"ts":5}'::jsonb) $$,
  'a session record with a missing, malformed, impossible or null date still syncs - the trigger never raises, because a raise would wedge that row in the offline outbox forever');
select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m2') $$,
  $$ values (1) $$,
  'and none of the four produced an attendance day - still just the one real day m2 has');

-- =====================================================================
-- The future-date rule
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m3'), 'strength_entry', 'm3-future',
             ('{"id":"m3-future","exerciseId":"clean","type":"reps","ts":1,"date":"' || (current_date + 30)::text || '"}')::jsonb) $$,
  'm3 syncs an entry dated 30 days from now - a broken local clock, or a member banking attendance early');
select is_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m3') $$,
  'the attendance row is refused, not clamped to today: this table is append-only, so a wrong day could never be taken back, and clamping would invent a training day the member never claimed');

select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m3'), 'strength_entry', 'm3-tomorrow',
             ('{"id":"m3-tomorrow","exerciseId":"clean","type":"reps","ts":2,"date":"' || (current_date + 1)::text || '"}')::jsonb) $$,
  'm3 syncs an entry dated tomorrow-in-UTC');
select results_eq(
  $$ select occurred_on from public.attendance_log where user_id = tests.uid('m3') $$,
  $$ values ((current_date + 1)) $$,
  'one day of slack is allowed on purpose: current_date is the server''s UTC day and the client writes a local calendar day, so a member training at 01:00 in Asia/Jerusalem legitimately logs "tomorrow" in UTC every single night');

select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m3'), 'strength_entry', 'm3-today',
             ('{"id":"m3-today","exerciseId":"clean","type":"reps","ts":3,"date":"' || current_date::text || '"}')::jsonb) $$,
  'and today is of course accepted');
select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m3') $$,
  $$ values (2) $$,
  'm3 has the tomorrow-slack day and today, and nothing from the 30-days-out entry');

-- =====================================================================
-- No client write, admin included
-- =====================================================================
select results_eq(
  $$ select has_table_privilege('authenticated', 'public.attendance_log', 'select') $$,
  $$ values (true) $$,
  'authenticated can select attendance_log');
select results_eq(
  $$ select has_table_privilege('authenticated', 'public.attendance_log', 'insert'),
            has_table_privilege('authenticated', 'public.attendance_log', 'update'),
            has_table_privilege('authenticated', 'public.attendance_log', 'delete') $$,
  $$ values (false, false, false) $$,
  'authenticated has no insert, update or delete grant at all - the "function owns it" shape pins and notification_batches already use');
select results_eq(
  $$ select has_table_privilege('anon', 'public.attendance_log', 'select'),
            has_table_privilege('anon', 'public.attendance_log', 'insert') $$,
  $$ values (false, false) $$,
  'anon cannot reach the table at all');
select results_eq(
  $$ select count(*)::int from pg_catalog.pg_policies
     where schemaname = 'public' and tablename = 'attendance_log' and cmd <> 'SELECT' $$,
  $$ values (0) $$,
  'and there is no insert, update or delete policy either - not one, for any role');
select results_eq(
  $$ select relrowsecurity from pg_catalog.pg_class where oid = 'public.attendance_log'::regclass $$,
  $$ values (true) $$,
  'row level security is enabled');

select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m3'), '2026-01-01') $$,
  '42501',
  null,
  'a member cannot mint their own attendance day - the achievements, coach flags and consistency board Phase 3 hangs off this table would all be forgeable if they could');
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ insert into public.attendance_log (user_id, occurred_on) values (tests.uid('admin'), '2026-01-01') $$,
  '42501',
  null,
  'nor can an admin');
select throws_ok(
  $$ delete from public.attendance_log where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'and nobody can delete a day, admin included - the append-only rule is a grant, not a convention');

-- =====================================================================
-- Who can read
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.attendance_log $$,
  $$ values (2) $$,
  'a plain member reading the whole table sees only their own two days');
select is_empty(
  $$ select 1 from public.attendance_log where user_id <> tests.uid('m1') $$,
  'a plain member cannot read another member''s attendance at all');

-- REVISED by 202609060013 (SEC-009 / PRIV-001), a deliberate product
-- decision. This previously asserted that a plain coach could read any
-- member's raw attendance rows, justified as "what COMM-304's decline
-- detection needs". That justification was checked and is not true:
-- coach_detect_engagement_decline(), the recaps, classmates, consistency
-- streaks and the health score are all SECURITY DEFINER and therefore
-- bypass this policy entirely - narrowing it cannot blind any of them
-- (0079 asserts that property directly). Meanwhile PRIVACY.md tells
-- members coaches see "your baseline rate and your recent rate, NOT a
-- detailed log", and show_attendance defaults OFF. The schema now enforces
-- what the policy document already promised.
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m1') $$,
  'a plain coach can no longer read another member''s raw attendance rows - the aggregate signal they actually use comes from SECURITY DEFINER functions, not from this table');
select tests.set_auth(tests.uid('admin'));
select isnt_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m1') $$,
  'an admin, who holds community.analytics.view, can read any member''s rows - what COMM-306''s cross-member consistency board needs');
select results_eq(
  $$ select count(distinct user_id)::int from public.attendance_log $$,
  $$ values (3) $$,
  'and the analytics read really is table-wide: m1, m2 and m3 all visible');

-- =====================================================================
-- The trigger function is unreachable as a function
-- =====================================================================
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.attendance_log_from_record()', 'execute'),
            has_function_privilege('anon', 'public.attendance_log_from_record()', 'execute') $$,
  $$ values (false, false) $$,
  'the only writer is revoked from every client role - it is reachable as a trigger and nowhere else');
select results_eq(
  $$ select prosecdef from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'attendance_log_from_record' $$,
  $$ values (true) $$,
  'and it is security definer - the deliberate crossing of the no-client-write boundary, and the only reason it needs elevation');

-- =====================================================================
-- COMM-317 (Phase 3 QA sweep): the "only path" boundary, at RUNTIME, not
-- only read off pg_catalog. Two layers, both actually executed rather than
-- merely inspected:
--   1. as authenticated (a member or an admin, since the revoke names no
--      exceptions), a direct call is refused by the grant itself;
--   2. even as the bootstrap superuser - a role no revoke touches, and the
--      role every other statement in this file uses to build fixtures with
--      RLS out of the way - the call is still refused, because the
--      function is declared `returns trigger` and Postgres itself will not
--      run a trigger function outside trigger context. So the boundary
--      holds twice over: nobody is granted execute, and even a grant would
--      not be enough. The whole rest of this file already demonstrates the
--      other half of "only path" at runtime, over and over: every row that
--      ever lands in attendance_log above got there because a
--      private_records insert or update fired the trigger, never because
--      this function was called directly.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.attendance_log_from_record() $$,
  '42501',
  null,
  'a member calling the trigger function directly, not merely inserting into attendance_log, is refused at runtime - permission denied, before Postgres even gets to ask whether this is a trigger context');
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.attendance_log_from_record() $$,
  '42501',
  null,
  'and an admin gets the identical runtime refusal - the revoke names no exception for staff or admin either');

select tests.clear_auth();
select throws_ok(
  $$ select public.attendance_log_from_record() $$,
  '0A000',
  'trigger functions can only be called as triggers',
  'and even the bootstrap superuser, who bypasses every grant check in this file, cannot call it directly: it is declared `returns trigger`, so Postgres itself refuses to run it outside trigger context. The private_records trigger is not just the only path a row is granted to appear through, it is the only path the engine will let this function run at all');

select * from finish();
rollback;
