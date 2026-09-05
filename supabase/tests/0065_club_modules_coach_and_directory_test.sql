-- Coverage for 202609050006: five more club_features rows (directory,
-- member_of_week, welcome_flow, monthly_recap, coach_tools). No new
-- function, no new RLS policy, no new admin_actions label - the generic
-- club_features mechanism (202609010012, already exhaustively covered by
-- 0055_club_features_test.sql) was already built to take more keys. This
-- file proves exactly that: the five seed rows exist, toggle through the
-- same admin_set_club_feature() path, and - the one thing worth locking in
-- so a future reader does not "fix" it - that none of the five gates any
-- table's RLS. Unlike the original six, they gate a UI section only; the
-- coach-only RPCs behind them keep their own independent permission check
-- with or without the flag.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. Seeded, enabled, readable by any member - same shape as the original
-- six.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select set_eq(
  $$ select module_key from public.club_features
     where module_key in ('directory', 'member_of_week', 'welcome_flow', 'monthly_recap', 'coach_tools') $$,
  $$ values ('directory'), ('member_of_week'), ('welcome_flow'), ('monthly_recap'), ('coach_tools') $$,
  'all five new module keys are seeded');
select results_eq(
  $$ select bool_and(enabled) from public.club_features
     where module_key in ('directory', 'member_of_week', 'welcome_flow', 'monthly_recap', 'coach_tools') $$,
  $$ values (true) $$,
  'and every one starts enabled - a migration must never silently turn something off for a live club');
select is( public.club_feature_enabled('coach_tools'), true, 'club_feature_enabled reads the new keys like any other' );
select tests.clear_auth();

-- =====================================================================
-- 2. Toggle through the existing generic path - no new write mechanism.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_set_club_feature('coach_tools', false) $$,
  'P0001', 'not authorized',
  'a plain member cannot toggle a new key either - same authorization check, not bypassed for these five');
select tests.clear_auth();

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('directory', false) $$,
  'owner can toggle a new key exactly like an original one');
select tests.clear_auth();
select results_eq(
  $$ select enabled from public.club_features where module_key = 'directory' $$,
  $$ values (false) $$,
  'the row was actually written');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'club_feature_toggle'
       and after_data ->> 'module_key' = 'directory' $$,
  $$ values (1) $$,
  'and audited under the same club_feature_toggle label as any other module - no new admin_actions value needed');
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('directory', true);
select tests.clear_auth();

-- =====================================================================
-- 3. THE THING WORTH LOCKING IN: none of the five gates profiles (or
-- anything else) via RLS. Off means "hide the section," not "hide the
-- data" - a real, deliberate difference from the original six this file
-- exists to keep visible to a future reader.
-- =====================================================================
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('directory', false);
select public.admin_set_club_feature('coach_tools', false);
select tests.clear_auth();

select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.profiles where id = tests.uid('m1') $$,
  'profiles stay exactly as readable as always with directory off - there is no RLS clause to extend, by design (202609010012''s own reasoning for never gating it)');
select tests.clear_auth();

select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('directory', true);
select public.admin_set_club_feature('coach_tools', true);
select tests.clear_auth();

select * from finish();
rollback;
