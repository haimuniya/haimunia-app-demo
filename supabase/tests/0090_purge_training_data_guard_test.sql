-- Data-loss regression coverage for 202609070001:
-- public.purge_abandoned_profiles() must never delete an account that holds
-- a training log, and public.purge_due_accounts() must still delete one when
-- the member asked for it.
--
-- WHY THIS FILE EXISTS AT ALL. 0048 proved every boundary the ticket named -
-- all four conditions, cascade, idempotence, the window as a real parameter -
-- and it proved the cascade WORKING as a feature ("the cascade took the
-- profiles row with it"). What no test anywhere asserted is what ELSE that
-- same cascade takes: `private_records.user_id references auth.users(id) on
-- delete cascade` (202608260001:21), and cloud backup opens an anonymous
-- account on the member's FIRST SAVED SET. Every one of the old predicate's
-- four conditions is true for a member who has been quietly logging workouts
-- for a month and never joined the community, so on day 31 the job deleted
-- their entire history. 0048's fixtures were all EMPTY accounts, so the
-- whole file passed against a function that destroyed real logs.
--
-- The rule this file encodes: only a fixture that HOLDS DATA can catch this,
-- so every scenario below gives an account real rows and then asserts the
-- rows are still there afterwards. Counting the surviving auth.users row is
-- not enough on its own - the point is the content underneath it.
--
--   1. account_holds_training_data() DIRECTLY, including its grants: a
--      yes/no answer about a stranger's training history is not a question
--      any client role may ask. Asserted first, before anything is deleted,
--      so the fixtures it reads still exist.
--   2. THE REGRESSION. A month of strength_entry rows under an anonymous,
--      unredeemed, unverified, 40-day-old account. Survives; all 30 rows
--      survive; retained_with_data reports it.
--   3. PRESENCE, NOT LIVENESS. An account whose every private_records row
--      is soft-deleted is still protected. deleted_at is client-set, so
--      believing it would make a buggy client's mistake permanent.
--   4. attendance_log ALONE PROTECTS. Defensive today (attendance_log
--      references profiles, profiles requires a redemption, a redemption
--      already disqualifies) - asserted anyway because attendance_log is
--      append-only and never retracted, so it is the one place a training
--      history can outlive the private_records rows it came from.
--   5. THE JOB STILL WORKS. A genuinely empty anonymous shell is still
--      purged. A guard that spared everything would pass 2-4 too.
--   6. THE CLOCK IS LAST ACTIVITY, NOT BIRTHDAY - AND NOT `updated_at`.
--      An empty shell opened 40 days ago but signed into yesterday is not
--      abandoned and is not purged (the old `created_at <= cutoff`
--      comparison collected accounts that were in daily use). An empty
--      shell with a fresh `auth.users.updated_at` and no sign-in for 40
--      days IS purged: updated_at tracks any write to the row rather than
--      the member, so a clock built on it can be wound forward by a GoTrue
--      upgrade or a backfill and quietly disable the job.
--   7. THE GUARD IS AN EXCLUSION, NOT A LONGER WINDOW. At p_retention_days
--      => 0 the age test is vacuous: the account from 6 is now collected
--      (proving 6 was the clock and nothing else), and the data-holding
--      accounts still are not.
--   8. purge_due_accounts() DOES NOT SHARE THE HOLE, and must not be
--      "fixed" into sparing data - a member who asks for deletion wants the
--      log gone. Asserted in both directions in one scenario.
--
-- FIXTURE MECHANIC: as 0048 - auth.users rows inserted directly under the
-- bootstrap superuser, ages expressed as offsets from now() so the file
-- means the same thing whatever day it runs.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- ---------------------------------------------------------------------
-- Fixture ids, local to this file.
-- ---------------------------------------------------------------------
create or replace function tests.dlg_uid(p_nick text) returns uuid
language sql immutable as $fn$
  select case p_nick
    -- anonymous, unredeemed, unverified, 40 days old, 30 logged workouts
    when 'logger'    then '22220000-0000-4000-8000-000000000001'::uuid
    -- same, but every record soft-deleted
    when 'tombstone' then '22220000-0000-4000-8000-000000000002'::uuid
    -- same, no private_records at all, but attendance_log rows
    when 'attended'  then '22220000-0000-4000-8000-000000000003'::uuid
    -- anonymous, unredeemed, unverified, 40 days old, holds nothing
    when 'empty'     then '22220000-0000-4000-8000-000000000004'::uuid
    -- empty shell, opened 40 days ago, signed in yesterday
    when 'active'    then '22220000-0000-4000-8000-000000000005'::uuid
    -- empty shell, opened 40 days ago, never signed in again, but with a
    -- fresh auth.users.updated_at
    when 'churned'   then '22220000-0000-4000-8000-000000000007'::uuid
    -- a real member who asked for deletion 31 days ago
    when 'departing' then '22220000-0000-4000-8000-000000000006'::uuid
  end
$fn$;
grant execute on function tests.dlg_uid(text) to anon, authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, last_sign_in_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', tests.dlg_uid('logger'),    'authenticated', 'authenticated', null, null, null, now() - interval '40 days', now() - interval '40 days', null, true),
  ('00000000-0000-0000-0000-000000000000', tests.dlg_uid('tombstone'), 'authenticated', 'authenticated', null, null, null, now() - interval '40 days', now() - interval '40 days', null, true),
  ('00000000-0000-0000-0000-000000000000', tests.dlg_uid('attended'),  'authenticated', 'authenticated', null, null, null, now() - interval '40 days', now() - interval '40 days', null, true),
  ('00000000-0000-0000-0000-000000000000', tests.dlg_uid('empty'),     'authenticated', 'authenticated', null, null, null, now() - interval '40 days', now() - interval '40 days', null, true),
  -- 'active': opened 40 days ago, so the OLD created_at comparison collects
  -- it, but signed into yesterday.
  ('00000000-0000-0000-0000-000000000000', tests.dlg_uid('active'),    'authenticated', 'authenticated', null, null, null, now() - interval '40 days', now() - interval '40 days', now() - interval '1 day', true),
  -- 'churned': abandoned 40 days ago and never signed into again, but with
  -- auth.users.updated_at freshly stamped - the exact shape 0086's own ghost
  -- fixtures carry. updated_at tracks any write to the row, not the member,
  -- so it must NOT keep an empty account alive.
  ('00000000-0000-0000-0000-000000000000', tests.dlg_uid('churned'),   'authenticated', 'authenticated', null, null, null, now() - interval '40 days', now(), null, true),
  ('00000000-0000-0000-0000-000000000000', tests.dlg_uid('departing'), 'authenticated', 'authenticated', 'dlg-departing@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now() - interval '90 days', now() - interval '90 days', now() - interval '90 days', now() - interval '31 days', false);

-- A month of logged sets for 'logger', in the exact shape cloud.js's
-- flushOutbox() upserts (payload is app.js's whole sanitised record).
insert into public.private_records (user_id, record_type, record_id, payload, updated_at)
select tests.dlg_uid('logger'), 'strength_entry', 'dlg-entry-' || g,
       jsonb_build_object('id', 'dlg-entry-' || g, 'exerciseId', 'back-squat',
                          'date', to_char((now() - (g || ' days')::interval)::date, 'YYYY-MM-DD'),
                          'weight', 80 + g, 'reps', 5, 'sets', 3),
       now() - (g || ' days')::interval
from generate_series(1, 30) g;

-- 'tombstone': the member deleted every entry from the log. flushOutbox()
-- upserts payload {} with deleted_at set, so these rows carry no training
-- content - but they are still proof that a real person used this account,
-- and deleted_at got there from a client-side flag.
insert into public.private_records (user_id, record_type, record_id, payload, deleted_at, updated_at)
select tests.dlg_uid('tombstone'), 'strength_entry', 'dlg-tomb-' || g,
       '{}'::jsonb, now() - interval '10 days', now() - interval '10 days'
from generate_series(1, 3) g;

-- 'attended': a profiles row and attendance days with NO private_records
-- behind them - the append-only shape 202608310001 leaves when the source
-- entries are later soft-deleted. Deliberately given no invite_redemptions
-- row so it reaches the purge predicate at all; that combination is not
-- reachable through the app today (profiles_insert_self requires a
-- redemption), which is exactly why this clause needs a test rather than an
-- argument.
insert into public.profiles (id, handle, display_name, recovery_verified_at)
values (tests.dlg_uid('attended'), 'dlg_attended', 'DLG Attended', null);
insert into public.attendance_log (user_id, occurred_on, source_record_type, source_record_id)
select tests.dlg_uid('attended'), (now() - (g || ' days')::interval)::date, 'wod_entry', 'dlg-gone-' || g
from generate_series(1, 5) g;

-- 'departing': a real member, mid-deletion-request, with a real log. This is
-- purge_due_accounts()' population, not this job's.
insert into public.profiles (id, handle, display_name, recovery_verified_at, deleted_at)
values (tests.dlg_uid('departing'), 'dlg_departing', 'DLG Departing', now() - interval '80 days', now() - interval '31 days');
insert into public.private_records (user_id, record_type, record_id, payload, updated_at)
select tests.dlg_uid('departing'), 'wod_entry', 'dlg-dep-' || g,
       jsonb_build_object('id', 'dlg-dep-' || g, 'wodId', 'fran',
                          'date', to_char((now() - (g || ' days')::interval)::date, 'YYYY-MM-DD')),
       now() - (g || ' days')::interval
from generate_series(1, 4) g;
insert into public.account_deletion_requests (user_id, requested_at, purge_after)
values (tests.dlg_uid('departing'), now() - interval '31 days', now() - interval '1 day');

-- =====================================================================
-- 1. account_holds_training_data() DIRECTLY - before anything is deleted.
-- =====================================================================
select ok(public.account_holds_training_data(tests.dlg_uid('logger')),
  'account_holds_training_data is true for live private_records rows');
select ok(public.account_holds_training_data(tests.dlg_uid('tombstone')),
  'true for soft-deleted private_records rows - presence, not liveness');
select ok(public.account_holds_training_data(tests.dlg_uid('attended')),
  'true for attendance_log rows with no private_records behind them');
select ok(not public.account_holds_training_data(tests.dlg_uid('active')),
  'false for an account that has never backed anything up');
select ok(not public.account_holds_training_data(null),
  'false, not null, for a null uuid - a null here must never read as "no data, safe to delete"');

select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'account_holds_training_data'),
  false,
  'account_holds_training_data is SECURITY INVOKER on purpose: inside purge_abandoned_profiles it already runs as that definer function''s owner and sees everything, and anywhere else it stays subject to RLS instead of becoming an oracle');

select ok(
  pg_catalog.has_function_privilege('service_role', 'public.account_holds_training_data(uuid)', 'execute'),
  'service_role can execute it');
select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.account_holds_training_data(uuid)', 'execute'),
  'authenticated cannot - "does this stranger have a training history" is not a question a member gets to ask');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.account_holds_training_data(uuid)', 'execute'),
  'anon cannot');
select ok(
  not pg_catalog.has_function_privilege('public', 'public.account_holds_training_data(uuid)', 'execute'),
  'and PUBLIC cannot - asserted separately because a new function starts with execute granted to PUBLIC');

-- =====================================================================
-- 2. THE REGRESSION. The whole point of the file.
-- =====================================================================
select is(
  (select count(*)::integer from public.private_records where user_id = tests.dlg_uid('logger')),
  30,
  'fixture check: the backup-only member starts with a month of logged sets in private_records');

select is(
  public.purge_abandoned_profiles(),
  jsonb_build_object('checked', 2, 'success', 2, 'failure', 0, 'retained_with_data', 3),
  'a default 30-day run purges the TWO empty shells and spares three data-holding accounts that meet all four of the ORIGINAL conditions, reporting them as retained_with_data so the guard is visible in run history rather than indistinguishable from an empty population');

select is(
  (select count(*)::integer from auth.users where id = tests.dlg_uid('logger')),
  1,
  'REGRESSION: the backup-only member''s account survives the purge - under the old predicate it was deleted on day 31, with no prompt, no warning and no recovery method');

select is(
  (select count(*)::integer from public.private_records where user_id = tests.dlg_uid('logger')),
  30,
  'and every one of the 30 logged workouts is still there - this is the assertion the cascade would have failed, and the one no test in the repo made');

-- =====================================================================
-- 3. PRESENCE, NOT LIVENESS.
-- =====================================================================
select is(
  (select count(*)::integer from auth.users where id = tests.dlg_uid('tombstone')),
  1,
  'an account whose every private_records row is SOFT-DELETED is still protected - deleted_at is written by the client from its own outbox flag, so a buggy build that marked a live log deleted would otherwise have its mistake made permanent by this job');

select is(
  (select count(*)::integer from public.private_records where user_id = tests.dlg_uid('tombstone')),
  3,
  'and the tombstones themselves are still there - the same "genuinely absent, never merely flagged" rule 202609010004 already applied to recovery_verified_at');

-- =====================================================================
-- 4. attendance_log ALONE PROTECTS.
-- =====================================================================
select is(
  (select count(*)::integer from auth.users where id = tests.dlg_uid('attended')),
  1,
  'attendance days with no private_records rows behind them protect the account on their own - attendance_log is append-only and is never retracted when its source entry is soft-deleted (202608310001), so it is the one place a training history can outlive the records it was derived from');

select is(
  (select count(*)::integer from public.attendance_log where user_id = tests.dlg_uid('attended')),
  5,
  'and the attendance days survive - they cascade from profiles, which cascades from auth.users, so deleting the account would have taken them silently');

-- =====================================================================
-- 5. THE JOB STILL DOES ITS JOB.
-- =====================================================================
select is(
  (select count(*)::integer from auth.users where id = tests.dlg_uid('empty')),
  0,
  'the genuinely empty anonymous shell - nothing ever backed up to it - was still purged: the fix narrows this job''s population, it does not disable it, and a guard that spared everything would pass every assertion above');

-- =====================================================================
-- 6. THE CLOCK IS LAST ACTIVITY, NOT BIRTHDAY.
-- =====================================================================
select is(
  (select count(*)::integer from auth.users where id = tests.dlg_uid('active')),
  1,
  'an EMPTY shell opened 40 days ago but signed into yesterday is not abandoned and is not purged - the old comparison was against created_at alone, which collected accounts that were in daily use for the crime of being old');

select is(
  (select count(*)::integer from auth.users where id = tests.dlg_uid('churned')),
  0,
  'but a fresh auth.users.updated_at does NOT save an empty shell nobody has signed into for 40 days: updated_at tracks any write to the row, not the member, and a first draft that included it in the clock made 0086''s twenty-day-old ghosts look active. A clock that anything server-side can wind forward is a job that quietly stops running');

select is(
  public.purge_abandoned_profiles(),
  jsonb_build_object('checked', 0, 'success', 0, 'failure', 0, 'retained_with_data', 3),
  'and a rerun at the default window is a clean no-op - the same idempotence 0048 established, now with the guard''s own count steady at three');

-- =====================================================================
-- 7. THE GUARD IS AN EXCLUSION, NOT A LONGER WINDOW.
-- =====================================================================
-- p_retention_days => 0 makes the age comparison vacuous (cutoff = now()),
-- so nothing but the training-data guard can be holding anything back.
select is(
  public.purge_abandoned_profiles(0),
  jsonb_build_object('checked', 1, 'success', 1, 'failure', 0, 'retained_with_data', 3),
  'at a zero-day window the yesterday-signed-in shell finally IS collected - which proves scenario 6 spared it on the CLOCK and not on some other accident - while the three data-holding accounts still are not touched at all');

select is(
  (select count(*)::integer from public.private_records where user_id = tests.dlg_uid('logger')),
  30,
  'the log survives a zero-day window: no retention setting, and no operator running this job by hand with an aggressive parameter, can reach an account that holds training data');

select is(
  (select count(*)::integer from public.attendance_log where user_id = tests.dlg_uid('attended')),
  5,
  'and so do the attendance days');

-- =====================================================================
-- 8. purge_due_accounts() DOES NOT SHARE THE HOLE.
-- =====================================================================
-- Checked rather than assumed. Its population is
-- account_deletion_requests.purge_after <= now(), and every writer of that
-- table is an explicit request: request_account_deletion() (the member's own
-- auth.uid()) and admin_remove_member() (202609060022, admin only, refuses
-- self). Cascading the training log away there is the 30-day erasure promise
-- being KEPT. So this scenario asserts the opposite of every assertion
-- above: the data must go.
select is(
  (select count(*)::integer from public.private_records where user_id = tests.dlg_uid('departing')),
  4,
  'fixture check: the departing member has a real log and a deletion request whose purge_after passed yesterday');

select is(
  (select count(*)::integer from auth.users where id = tests.dlg_uid('departing')),
  1,
  'and purge_abandoned_profiles() never touched them across three runs - they are not anonymous and this is not that job''s population at all');

select is(
  public.purge_due_accounts(),
  1,
  'purge_due_accounts() collects exactly the one due account');

select is(
  (select count(*)::integer from auth.users where id = tests.dlg_uid('departing')),
  0,
  'the account is really gone');

select is(
  (select count(*)::integer from public.private_records where user_id = tests.dlg_uid('departing')),
  0,
  'and so is the training log - DELIBERATELY. purge_due_accounts() must NOT be given the guard added above: a member who asks for deletion is asking for exactly this, and sparing their log would break the erasure promise in PRIVACY.md instead of keeping it');

select is(
  (select count(*)::integer from public.private_records where user_id = tests.dlg_uid('logger')),
  30,
  'and the backup-only member, who asked for nothing, still has all 30 workouts - the two jobs stay complementary, which is the property 202609060023''s header warned would be lost if either grew to cover the other''s population');

select * from finish();
rollback;
