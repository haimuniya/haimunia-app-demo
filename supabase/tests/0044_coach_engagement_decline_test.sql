-- COMM-304, schema half: behavioural coverage for 202608310008
-- (coach_detect_engagement_decline(), the first producer
-- `coach_engagement_flags` has had since it shipped empty in Phase 0).
--
-- The ticket names four boundaries and each one is proved by a SCENARIO
-- rather than by a structural check, the style 0039/0040/0041 established:
--
--   1. A genuine decline crosses the RIGHT bucket. Every fixture member
--      below shares the same 3.0-sessions-per-week baseline and differs
--      only in how much they trained in the last fortnight, so the bucket
--      each one lands in is produced by the drop and by nothing else. The
--      healthy member is in the same set, on the same baseline, and is
--      never flagged.
--   2. No baseline, no flag - proved on a member whose numbers would
--      otherwise flag them `inactive` (a real baseline rate, well above
--      the floor, and nothing at all recently), moved across the boundary
--      one day at a time: first attendance day one day INSIDE the baseline
--      window is not enough, exactly ON its first day is. That is the only
--      form of the assertion that can tell "too new" apart from "too
--      little", which is a separate constant with its own two-sided proof
--      on the coach.
--   3. An already-flagged member never gets a second open row - proved by
--      running the job repeatedly (nine times across this file), including
--      against a flag PLANTED before the job ever ran, so "already open" is
--      answered from `coach_engagement_flags` itself and not from a second
--      piece of state. The re-run refreshes the row in place: same id, same
--      `flagged_at`, new level, and the coach's own `status` untouched.
--   4. The flagged member still cannot read their own row - re-asserted
--      here against rows THIS FUNCTION WROTE, for a coach and an admin who
--      were both flagged by it, rather than against the planted rows 0011
--      has been using since Phase 0. That is the whole point of re-running
--      the assertion: the table now has real producer-written rows in it
--      for the first time.
--
-- Plus the claim COMM-304 makes about the client half's write path -
-- "the existing staff update policy already covers it, no migration
-- required" - executed rather than trusted: a coach performs the real
-- three-column review update, and the last run of the job then declines to
-- re-raise that member, which is what makes "reviewed" mean something.
--
-- FIXTURE MECHANIC WORTH READING FIRST
-- Every date is expressed as an offset from `current_date`, so the file
-- means the same thing whatever day it runs on. With the shipped constants
-- (8 baseline weeks, 2 recent weeks) the three window edges are:
--
--   recent window   [current_date - 13, ...)     - open-ended at the top
--   baseline window [current_date - 69, current_date - 14]
--
-- `tests.seed_baseline()` lays down 24 days two days apart running from
-- offset 69 down to offset 23: exactly 3.0 sessions per week, oldest day
-- exactly ON the baseline window's first day, and nothing inside the recent
-- window. Every member who uses it therefore differs only in what the test
-- adds afterwards.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- The job, called the way a scheduler would: as service_role, which is the
-- only role holding execute on it. Same set_config shape 0035 uses for
-- chal_notify_ending_soon.
create or replace function tests.run_detect() returns integer
language plpgsql as $fn$
declare v_n integer;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v_n := public.coach_detect_engagement_decline();
  perform pg_catalog.set_config('role', 'postgres', true);
  return v_n;
end $fn$;
grant execute on function tests.run_detect() to anon, authenticated, service_role;

-- 24 training days, two days apart, oldest exactly on the baseline window's
-- first day and newest well clear of the recent window: 3.0 sessions/week.
create or replace function tests.seed_baseline(p_user uuid) returns void
language sql as $fn$
  insert into public.attendance_log (user_id, occurred_on)
  select p_user, current_date - (69 - g * 2) from generate_series(0, 23) g
$fn$;
grant execute on function tests.seed_baseline(uuid) to anon, authenticated, service_role;

create or replace function tests.open_flags(p_user uuid) returns integer
language sql stable as $fn$
  select count(*)::integer from public.coach_engagement_flags
  where user_id = p_user and status = 'open'
$fn$;
grant execute on function tests.open_flags(uuid) to anon, authenticated, service_role;

create or replace function tests.flag_level(p_user uuid) returns text
language sql stable as $fn$
  select level from public.coach_engagement_flags
  where user_id = p_user and status = 'open'
$fn$;
grant execute on function tests.flag_level(uuid) to anon, authenticated, service_role;

-- Snapshots of a row's identity, so "the same row was updated" is a claim
-- about the id and not about the contents.
create table tests.snap (k text primary key, id uuid, ts timestamptz);

-- =====================================================================
-- Reachability: service_role and nobody else
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'coach_detect_engagement_decline'),
  true,
  'coach_detect_engagement_decline is SECURITY DEFINER - it crosses two RLS boundaries on purpose (attendance_log is own-row plus staff, and coach_engagement_flags excludes the flagged member from every policy)');

select ok(
  pg_catalog.has_function_privilege('service_role', 'public.coach_detect_engagement_decline()', 'execute'),
  'service_role can execute it - the grant a pg_cron entry or a scheduled Edge Function will use, the same auth shape chal_notify_ending_soon has');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.coach_detect_engagement_decline()', 'execute'),
  'authenticated cannot');

select ok(
  not pg_catalog.has_function_privilege('anon', 'public.coach_detect_engagement_decline()', 'execute'),
  'anon cannot');

select ok(
  not pg_catalog.has_function_privilege('public', 'public.coach_detect_engagement_decline()', 'execute'),
  'and PUBLIC cannot - asserted separately, because a new function starts with execute granted to PUBLIC and forgetting that one revoke is how a service-role job quietly becomes an RPC every logged-in member can fire');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.coach_detect_engagement_decline() $$,
  '42501',
  null,
  'a real authenticated caller - a staff one, at that - gets 42501 calling it directly, from the grant rather than from a check inside the body');
select tests.clear_auth();

-- =====================================================================
-- The tuning constants are named constants, not literals in a query
-- =====================================================================
-- COMM-304: "a later tuning pass is a one-line change". Asserted by name
-- only; the VALUES are asserted behaviourally by the scenarios below, so
-- re-tuning does not mean editing the same numbers in two files.
select is(
  (select p.prosrc ~ 'c_baseline_weeks\s+constant'
      and p.prosrc ~ 'c_recent_weeks\s+constant'
      and p.prosrc ~ 'c_mild_ratio\s+constant'
      and p.prosrc ~ 'c_significant_ratio\s+constant'
      and p.prosrc ~ 'c_min_baseline_sessions_per_week\s+constant'
      and p.prosrc ~ 'c_reflag_cooldown_days\s+constant'
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'coach_detect_engagement_decline'),
  true,
  'all six tuning numbers are declared CONSTANTs at the top of the function body - the two window lengths, the two drop ratios, the minimum baseline floor and the re-flag cooldown');

-- =====================================================================
-- Run 0: an empty club
-- =====================================================================
select results_eq(
  $$ select count(*)::int from public.attendance_log $$,
  $$ values (0) $$,
  'attendance_log starts empty on a fresh reset, so every number in this file comes from the fixtures below and not from 202608310001''s backfill');

select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags $$,
  $$ values (0) $$,
  'and coach_engagement_flags starts empty - still, at this point, exactly as it has shipped since Phase 0');

select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (0) $$,
  'the job on a club that has never trained writes nothing and reports zero: a member with no attendance rows at all is not a member with a baseline of zero, they are not a candidate, and the loop never sees them');

select is_empty(
  $$ select 1 from public.coach_engagement_flags $$,
  'and wrote no rows at all');

-- =====================================================================
-- Fixtures: one shared baseline, seven different recent fortnights
-- =====================================================================
select tests.seed_baseline(tests.uid('m1'));     -- recent: nothing      -> inactive
select tests.seed_baseline(tests.uid('m2'));     -- recent: nothing      -> inactive (pre-flagged)
select tests.seed_baseline(tests.uid('m3'));     -- recent: 3 days       -> mild (cooled down)
select tests.seed_baseline(tests.uid('admin'));  -- recent: 1 day        -> significant
select tests.seed_baseline(tests.uid('owner'));  -- recent: 5 days       -> healthy

-- m3: 1.5/wk against a 3.0/wk baseline. Exactly halved.
insert into public.attendance_log (user_id, occurred_on) values
  (tests.uid('m3'), current_date - 1),
  (tests.uid('m3'), current_date - 5),
  (tests.uid('m3'), current_date - 9);

-- admin: 0.5/wk against 3.0/wk. Three times a week down to once.
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('admin'), current_date - 3);

-- owner: 2.5/wk against 3.0/wk. A normal fortnight with one session missed.
insert into public.attendance_log (user_id, occurred_on) values
  (tests.uid('owner'), current_date),
  (tests.uid('owner'), current_date - 3),
  (tests.uid('owner'), current_date - 6),
  (tests.uid('owner'), current_date - 9),
  (tests.uid('owner'), current_date - 12);

-- norec: THE NO-BASELINE CASE. Nine training days, all of them inside the
-- baseline window, none in the recent fortnight - so their baseline rate
-- (1.13/wk) clears the floor comfortably and their recent rate is zero.
-- Every number this member has says `inactive`. The only thing that saves
-- them is that their first ever session is 34 days ago: they have not been
-- training long enough for "what they used to do" to be a thing that
-- exists. This is the member the whole rule is for.
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('norec'), current_date - (34 - g * 2) from generate_series(0, 8) g;

-- coach: THE TOO-LITTLE CASE, which is a different rule from the too-new
-- one. Training history going back 300 days, so the baseline window is
-- fully covered and the boundary above is passed with room to spare - but
-- only three sessions inside it. 0.38/wk, under the floor. Someone who has
-- never really been coming has not started coming less.
insert into public.attendance_log (user_id, occurred_on) values
  (tests.uid('coach'), current_date - 300),
  (tests.uid('coach'), current_date - 60),
  (tests.uid('coach'), current_date - 40),
  (tests.uid('coach'), current_date - 20);

-- A flag PLANTED before the job has ever run, with deliberately wrong
-- figures and the wrong level. If the re-flag guard were answered from
-- anything other than coach_engagement_flags itself, m2 would end this run
-- with two rows.
insert into public.coach_engagement_flags
  (user_id, level, baseline_sessions_per_week, recent_sessions_per_week, flagged_at)
values (tests.uid('m2'), 'mild', 9.9, 9.9, now() - interval '10 days');

-- A flag a coach has already DISMISSED, five days ago. m3 qualifies as
-- `mild` on the numbers; the dismissal is the only thing in their way.
insert into public.coach_engagement_flags
  (user_id, level, status, reviewed_by, reviewed_at, flagged_at)
values (tests.uid('m3'), 'mild', 'dismissed', tests.uid('coach'),
        now() - interval '5 days', now() - interval '20 days');

-- =====================================================================
-- Run 1: the buckets
-- =====================================================================
select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (3) $$,
  'the first real run writes three rows: two new flags and one refresh of the planted open one');

select results_eq(
  $$ select tests.flag_level(tests.uid('m1')) $$,
  $$ values ('inactive'::text) $$,
  'BUCKET inactive: a 3.0/wk member who has trained on not one day in the last fortnight');

select results_eq(
  $$ select tests.flag_level(tests.uid('admin')) $$,
  $$ values ('significant'::text) $$,
  'BUCKET significant: the same 3.0/wk baseline, down to 0.5/wk - three times a week to once. 17 per cent of baseline, under the 0.35 ratio');

select results_eq(
  $$ select tests.flag_level(tests.uid('m2')) $$,
  $$ values ('inactive'::text) $$,
  'the planted flag was RE-LEVELLED from mild to inactive rather than left stale: the level is a live judgement about a member, and a coach reading a week-old label with fresh urgency behind it is worse than no label');

select is_empty(
  $$ select 1 from public.coach_engagement_flags where user_id = tests.uid('owner') $$,
  'BUCKET none: 2.5/wk against a 3.0/wk baseline is 83 per cent and is not a decline. Missing one session in a fortnight is the normal texture of a training week, and it must never reach a coach - this is the member the 0.60 ratio exists to keep off the list');

select is_empty(
  $$ select 1 from public.coach_engagement_flags where user_id = tests.uid('norec') $$,
  'NO BASELINE, NO FLAG: a member whose every number says inactive - 1.13/wk baseline, nothing recently - is not flagged, because their first ever session was 34 days ago and the baseline window starts 69 days ago. There is no such thing as a decline with no prior baseline to decline from');

select is_empty(
  $$ select 1 from public.coach_engagement_flags
     where user_id = tests.uid('coach') and status = 'open' $$,
  'TOO LITTLE HISTORY IS A DIFFERENT RULE: the coach has 300 days of history, so the window boundary is not what stops them - three sessions in eight weeks is 0.38/wk, under the floor. Someone who was never really coming has not started coming less');

select results_eq(
  $$ select tests.open_flags(tests.uid('m3')) $$,
  $$ values (0) $$,
  'and m3, who qualifies as mild on the numbers, is not re-raised five days after a coach dismissed them - otherwise "dismiss" is a button that does nothing and the section stops being read');

select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags $$,
  $$ values (4) $$,
  'four rows in total: the two planted ones plus two new flags');

-- The figures on the row are the figures the rule decided with.
select results_eq(
  $$ select baseline_sessions_per_week, recent_sessions_per_week
     from public.coach_engagement_flags
     where user_id = tests.uid('admin') and status = 'open' $$,
  $$ values (3.00::numeric, 0.50::numeric) $$,
  'the stored figures are sessions per WEEK over each window, rounded to two places - the same rounded numbers the bucket test used, so a coach reading the row can reproduce the decision');

select results_eq(
  $$ select club_id from public.coach_engagement_flags
     where user_id = tests.uid('admin') and status = 'open' $$,
  $$ select public.default_club_id() $$,
  'club_id is carried from the member''s own attendance rows rather than defaulted blindly - the same value today, since there is one club, and not a lie the day there is not');

insert into tests.snap (k, id, ts)
select 'm1', id, flagged_at from public.coach_engagement_flags
where user_id = tests.uid('m1') and status = 'open';

-- =====================================================================
-- Run 2: the same job, immediately again, with nothing changed
-- =====================================================================
select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (3) $$,
  'a second run touches the same three members - and touches, not inserts');

select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags $$,
  $$ values (4) $$,
  'still four rows. The job is safe to run on a schedule, which is the whole property the "already open" rule buys');

select is_empty(
  $$ select user_id from public.coach_engagement_flags
     where status = 'open' group by user_id having count(*) > 1 $$,
  'NO MEMBER ANYWHERE holds two open flags - said set-wide rather than per member, so a future producer that gets this wrong for a member this file never names still fails here');

select results_eq(
  $$ select id, flagged_at from public.coach_engagement_flags
     where user_id = tests.uid('m1') and status = 'open' $$,
  $$ select id, ts from tests.snap where k = 'm1' $$,
  'm1''s flag is the SAME ROW after the re-run - same id, same flagged_at. flagged_at is when this drift was first noticed and is the only record of how long it has been going on, so a re-run must never reset it');

select results_eq(
  $$ select flagged_at from public.coach_engagement_flags
     where user_id = tests.uid('m2') and status = 'open' $$,
  $$ select now() - interval '10 days' $$,
  'and the planted row still carries the flagged_at it was planted with, ten days back, across two refreshes');

-- =====================================================================
-- Run 3: the open row is refreshed in place, not frozen
-- =====================================================================
-- m1 starts training again, but only half as much as they used to.
insert into public.attendance_log (user_id, occurred_on) values
  (tests.uid('m1'), current_date - 1),
  (tests.uid('m1'), current_date - 5),
  (tests.uid('m1'), current_date - 9);

select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (3) $$,
  'third run, same three members');

select results_eq(
  $$ select tests.flag_level(tests.uid('m1')),
            (select recent_sessions_per_week from public.coach_engagement_flags
             where user_id = tests.uid('m1') and status = 'open') $$,
  $$ values ('mild'::text, 1.50::numeric) $$,
  'm1 moved inactive -> mild on their existing row: 1.5/wk against 3.0/wk is exactly halved, which is the 0.50 case sitting between the two ratios');

select results_eq(
  $$ select id, flagged_at from public.coach_engagement_flags
     where user_id = tests.uid('m1') and status = 'open' $$,
  $$ select id, ts from tests.snap where k = 'm1' $$,
  'still the same row and the same flagged_at - the level and the figures moved, the row''s identity and its age did not');

select results_eq(
  $$ select status, reviewed_by, reviewed_at from public.coach_engagement_flags
     where user_id = tests.uid('m1') $$,
  $$ values ('open'::text, null::uuid, null::timestamptz) $$,
  'and the three columns that belong to the reviewing coach are untouched by the refresh - the job may never reset a coach''s decision about a row');

select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags $$,
  $$ values (4) $$,
  'four rows after three runs');

-- =====================================================================
-- Run 4: the cooldown expires
-- =====================================================================
update public.coach_engagement_flags
set reviewed_at = now() - interval '60 days'
where user_id = tests.uid('m3') and status = 'dismissed';

select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (4) $$,
  'with the dismissal now sixty days old, the run writes a fourth row');

select results_eq(
  $$ select tests.flag_level(tests.uid('m3')), tests.open_flags(tests.uid('m3')) $$,
  $$ values ('mild'::text, 1) $$,
  'BUCKET mild, and the two-sided proof of the cooldown: the SAME member on the SAME unchanged attendance rows went from not-flagged to flagged purely because the coach''s dismissal aged out. A member still drifting a month later comes back; a member dismissed yesterday does not');

select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags where user_id = tests.uid('m3') $$,
  $$ values (2) $$,
  'and the dismissed row is still there beside the new open one - the history of what a coach decided is not rewritten, which is why "one row per flagged period" is a rule about OPEN rows and not about the table');

-- =====================================================================
-- The no-baseline boundary, one day at a time
-- =====================================================================
-- One day INSIDE the window's first day. Their history now stretches 68
-- days back. It is still one day short.
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('norec'), current_date - 68);

select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (4) $$,
  'run five: still four members touched');

select is_empty(
  $$ select 1 from public.coach_engagement_flags where user_id = tests.uid('norec') $$,
  'a first attendance day ONE DAY inside the baseline window is still not a baseline - the boundary is not approximate, and this member''s numbers have said inactive for three runs now');

-- One more day, exactly ON the window's first day.
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('norec'), current_date - 69);

select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (5) $$,
  'run six writes a fifth row');

select results_eq(
  $$ select tests.flag_level(tests.uid('norec')) $$,
  $$ values ('inactive'::text) $$,
  'ONE DAY of history, on the exact first day of the baseline window, flips this member from never-flagged to inactive. The boundary is inclusive - a member whose history reaches the start of the window has a window to measure - and the two runs either side of it differ by that single attendance row and nothing else');

-- =====================================================================
-- The too-little-history floor, likewise
-- =====================================================================
-- A fourth session inside the baseline window takes the coach from 0.38/wk
-- to exactly 0.50/wk, which is the floor itself.
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('coach'), current_date - 30);

select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (6) $$,
  'run seven writes a sixth row');

select results_eq(
  $$ select tests.flag_level(tests.uid('coach')),
            (select baseline_sessions_per_week from public.coach_engagement_flags
             where user_id = tests.uid('coach') and status = 'open') $$,
  $$ values ('inactive'::text, 0.50::numeric) $$,
  'a baseline of exactly 0.5 sessions per week is ON the floor and therefore inside it, and this member - unflagged across six runs on three sessions - is flagged on the fourth. The floor is a real number with a real edge, separate from the window boundary above');

-- =====================================================================
-- A soft-deleted profile is never flagged
-- =====================================================================
-- The owner stops training entirely: their recent fortnight is emptied,
-- leaving the same 3.0/wk baseline and a recent rate of zero.
delete from public.attendance_log
where user_id = tests.uid('owner') and occurred_on >= current_date - 13;

update public.profiles set deleted_at = now() where id = tests.uid('owner');

select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (6) $$,
  'run eight: the owner now has textbook inactive numbers and is still not counted, because their profile is soft-deleted');

select is_empty(
  $$ select 1 from public.coach_engagement_flags where user_id = tests.uid('owner') $$,
  'no flag for a member who has left. A decline flag exists to start a conversation, and there is nobody to have it with');

update public.profiles set deleted_at = null where id = tests.uid('owner');

select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (7) $$,
  'run nine, with the profile restored and not one attendance row changed, writes the seventh');

select results_eq(
  $$ select tests.flag_level(tests.uid('owner')) $$,
  $$ values ('inactive'::text) $$,
  'and the same data that produced nothing a moment ago now produces an inactive flag - the soft-delete was doing that, not the numbers');

-- =====================================================================
-- attendance_log is a source and never a target
-- =====================================================================
select results_eq(
  $$ select count(*)::int from public.attendance_log $$,
  $$ values (143) $$,
  'nine runs of the job left attendance_log at exactly the row count the fixtures put there: it reads the training record and never writes to it, so no flag can ever change what a member is recorded as having done');

-- =====================================================================
-- THE PHASE 0 GUARANTEE, now against rows a producer actually wrote
-- =====================================================================
-- 0011 has asserted this since Phase 0 against planted rows. Every row in
-- the table now came out of coach_detect_engagement_decline(), which is the
-- reason to ask again: the table has real producer-written content for the
-- first time, and both a coach and an admin are in it.
select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags $$,
  $$ values (8) $$,
  'eight rows: seven open flags - six the job inserted and one it adopted and re-levelled - plus the dismissed one the fixture planted');

select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.coach_engagement_flags where user_id = tests.uid('coach') $$,
  'THE ONE THAT MATTERS: the coach was flagged `inactive` by the job two runs ago and cannot see it. Not through the staff branch, not at all - `user_id <> auth.uid()` is on every policy precisely because a staff member is also a member');
select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags $$,
  $$ values (7) $$,
  'they read the other seven rows normally, so the exclusion is one row and not a broken read');

select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select 1 from public.coach_engagement_flags where user_id = tests.uid('admin') $$,
  'and an admin - who reaches almost everything else in this schema through is_admin() - cannot see the flag the job wrote about them either');
select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags $$,
  $$ values (7) $$,
  'while reading the other seven');

select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.coach_engagement_flags $$,
  'a plain member reads NOTHING from the table - not their own flag, which they have, and not anybody else''s. No decline label and no session figure reaches a member view by any path');

-- =====================================================================
-- The client half's review write path, executed rather than trusted
-- =====================================================================
-- COMM-304: "the existing staff update policy already covers it, no
-- migration required for the grant itself". This is that claim, run.
select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ with u as (
       update public.coach_engagement_flags
       set status = 'reviewed', reviewed_by = tests.uid('coach'), reviewed_at = now()
       where user_id = tests.uid('admin') and status = 'open'
       returning id
     ) select count(*)::int from u $$,
  $$ values (1) $$,
  'a coach marks another member''s flag reviewed, writing all three columns in one statement, under the Phase 0 policy with NO migration in this ticket - the table grant carries no column list and coach_engagement_flags_staff_update carries no column predicate, so the client half needs nothing added');

select is_empty(
  $$ with u as (
       update public.coach_engagement_flags set status = 'dismissed'
       where user_id = tests.uid('coach') returning id
     ) select id from u $$,
  'and the same coach still cannot dismiss the flag about themselves, now that they really have one - the self-exclusion is in USING as well as WITH CHECK, so the row is not even visible to update');
select tests.clear_auth();

select results_eq(
  $$ select status, reviewed_by is not null, reviewed_at is not null
     from public.coach_engagement_flags where user_id = tests.uid('admin') $$,
  $$ values ('reviewed'::text, true, true) $$,
  'the review landed on the row');

-- =====================================================================
-- Run 10: a reviewed flag stays reviewed
-- =====================================================================
select results_eq(
  $$ select tests.run_detect() $$,
  $$ values (6) $$,
  'the next scheduled run touches six members, not seven: the member a coach just reviewed is left alone');

select results_eq(
  $$ select (select tests.open_flags(tests.uid('admin'))),
            (select count(*)::int from public.coach_engagement_flags
             where user_id = tests.uid('admin')) $$,
  $$ values (0, 1) $$,
  'admin still has exactly one row and it is still not open. Reviewing a flag has to survive the next run of the job or the control is decorative - this is the same cooldown rule the dismissal case proved, on the other status');

select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags $$,
  $$ values (8) $$,
  'and the table is still eight rows after ten runs of a job that has now seen every branch it has');

select * from finish();
rollback;
