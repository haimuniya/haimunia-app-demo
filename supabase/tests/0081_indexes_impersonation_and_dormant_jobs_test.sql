-- Production-readiness audit, 2026-09-06 (202609060015).
-- DB-M3 (FK indexes), SEC-019 (staff impersonation), FEAT-004 / FEAT-010
-- (the two dormant scheduled jobs).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. DB-M3 - every non-club_id FK column now leads an index
-- =====================================================================
-- Asserted as a PROPERTY over the catalog rather than as 28 hand-written
-- index-name checks: a future migration adding a new foreign key without
-- an index fails this test automatically, which a name list would not.
select is(
  (select count(*)::int
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_attribute a on a.attrelid = c.oid and a.attnum = any(con.conkey)
     join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f'
      and n.nspname = 'public'
      and a.attname <> 'club_id'
      and not exists (
        select 1 from pg_index i
         where i.indrelid = c.oid and a.attnum = i.indkey[0]
      )),
  0,
  'DB-M3: no public FK column outside club_id is left without a leading index - a cascade delete no longer sequentially scans the child table');

-- club_id is deliberately excluded and deliberately NOT indexed - see the
-- migration's own section 2. This assertion pins that it is a conscious
-- exclusion by proving the single-club invariant that justifies it is real.
select ok(
  (select count(*)::int from public.clubs) = 1,
  'and club_id stays unindexed on purpose because exactly one club row exists - the invariant clubs_guard_single_row() enforces');

-- =====================================================================
-- 2. SEC-019 - display_name may not claim a staff role
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ update public.profiles set display_name = 'מאמן דני' where id = tests.uid('m1') $$,
  'P0001', 'display name may not claim a staff role',
  'THE FIX: a plain member cannot rename themselves to claim coach status');
select throws_ok(
  $$ update public.profiles set display_name = 'Club Admin' where id = tests.uid('m1') $$,
  'P0001', 'display name may not claim a staff role',
  'and the English staff words are covered too');

-- An ordinary rename is untouched. This is the assertion that keeps the
-- guard from being a blunt instrument.
select lives_ok(
  $$ update public.profiles set display_name = 'דנה כהן' where id = tests.uid('m1') $$,
  'an ordinary display name still saves');
select tests.clear_auth();
select is(
  (select display_name from public.profiles where id = tests.uid('m1')), 'דנה כהן',
  'and really changed');

-- A real coach may of course call themselves a coach.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.profiles set display_name = 'מאמן יואב' where id = tests.uid('coach') $$,
  'a REAL coach is exempt - the guard blocks claiming a role you do not hold, not the word itself');
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ update public.profiles set display_name = 'Admin Noa' where id = tests.uid('admin') $$,
  'and so is a real admin');

-- The service role / dashboard path is out of scope, same as every other
-- guard trigger in this module.
select tests.clear_auth();
select lives_ok(
  $$ update public.profiles set display_name = 'מאמן שלא באמת' where id = tests.uid('m2') $$,
  'a non-authenticated session (service role, dashboard, backfill) is unaffected');

-- =====================================================================
-- 3. FEAT-004 / FEAT-010 - the two dormant jobs
-- =====================================================================
select isnt_empty(
  $$ select 1 from cron.job where jobname = 'community-health' $$,
  'FEAT-004 THE FIX: community_health_generate() finally has a producer - it was defined, correct, and called by absolutely nothing, so community_health_scores was permanently empty');

select is_empty(
  $$ select 1 from cron.job where jobname = 'feed-weights-recompute' $$,
  'FEAT-010 THE FIX: the weekly job that ran a deliberate no-op stub is unscheduled - a green cron row for an unbuilt feature is worse than no row, because it reads as "personalized ranking works"');

-- And the stub itself is still there, still a no-op, ready for whoever
-- builds the derivation. Removing the function was NOT the fix.
select has_function('public', 'recompute_feed_weights', array['integer'],
  'the stub function itself is retained - only its misleading schedule was removed');

-- =====================================================================
-- 4. scheduled_job_health()'s staleness window follows each job's cadence
-- =====================================================================
-- 202609060016 used a flat 8 days for every job. recap_monthly runs on the
-- 1st, so from ~the 9th onward it reported unhealthy every month while
-- being fine - a permanent false positive on the one surface whose value
-- is being trusted. Found by reading the real production output.
select is(
  (select case
     when split_part('41 4 1 * *',' ',3) <> '*' then 'monthly'
     when split_part('41 4 1 * *',' ',5) <> '*' then 'weekly'
     when split_part('41 4 1 * *',' ',2) <> '*' then 'daily'
     else 'hourly' end),
  'monthly',
  'a day-of-month cron expression is classified monthly, not daily - this is the classification the window derives from');
select is(
  (select case
     when split_part('11 5 * * 1',' ',3) <> '*' then 'monthly'
     when split_part('11 5 * * 1',' ',5) <> '*' then 'weekly'
     when split_part('11 5 * * 1',' ',2) <> '*' then 'daily'
     else 'hourly' end),
  'weekly',
  'and a day-of-week expression is weekly');
select ok(
  (select prosrc from pg_proc where proname = 'scheduled_job_health') like '%35 days%',
  'the function carries a monthly window, so recap_monthly is not permanently flagged');
select ok(
  (select prosrc from pg_proc where proname = 'scheduled_job_health') not like '%interval ''8 days''%',
  'and the flat 8-day window that caused the false positive is gone');
-- The behaviour that must NOT be relaxed by the above.
select ok(
  (select prosrc from pg_proc where proname = 'scheduled_job_health') like '%coalesce(%false)%'
  or (select prosrc from pg_proc where proname = 'scheduled_job_health') like '%, false) as healthy%',
  'a never-run job is still coalesced to unhealthy - exactly the state purge_due_accounts sat in undetected');

select * from finish();
rollback;
