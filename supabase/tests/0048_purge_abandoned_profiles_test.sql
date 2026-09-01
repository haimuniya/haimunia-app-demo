-- COMM-314: behavioural coverage for 202609010004
-- (public.purge_abandoned_profiles(p_retention_days)).
--
-- Five boundaries, each proved by a SCENARIO rather than by a structural
-- check, the style 0039 to 0047 established:
--
--   1. ALL FOUR CRITERIA MUST HOLD, NOT MERELY MOST. Five fixture
--      accounts, each failing exactly one of is_anonymous / no
--      invite_redemptions / no recovery_verified_at / old enough, and
--      only the one failing NONE of them is ever touched. The
--      recovery_verified_at fixture is deliberately given an OLD
--      timestamp (40 days back) to prove "genuinely absent, not merely
--      old" - a broken predicate that compared the timestamp's age
--      instead of its presence would still exclude a merely-recent one,
--      so an old-but-set stamp is the only fixture that can catch it.
--   2. MISSING PROFILE ROW READS THE SAME AS recovery_verified_at IS
--      NULL. The eligible fixture also gets a real profiles row (with the
--      column null) so the same run proves the cascade delete removes it,
--      but a second never-had-a-profile account earlier in this file
--      would be equally eligible - the predicate itself is a NOT EXISTS,
--      so a missing row and a null column are the same case by
--      construction, not by a second code path.
--   3. REAL DELETION, CASCADING. The eligible account's auth.users row,
--      profiles row and (absence of) invite_redemptions row are each
--      checked gone, not soft-deleted - no deleted_at column exists on
--      auth.users to have set in the first place.
--   4. IDEMPOTENT. A second call over the exact same fixtures finds
--      nothing: {checked: 0, success: 0, failure: 0}, and the four
--      still-ineligible accounts are untouched.
--   5. THE RETENTION WINDOW IS A REAL PARAMETER, NOT A HARDCODED 30. The
--      "too new" fixture (5 days old) is untouched at the default window
--      and then eligible under a 3-day window passed explicitly - proving
--      changing the window changes ONLY the age comparison, not the other
--      three checks (the redeemed and verified fixtures stay untouched
--      under the same narrower call).
--
-- Plus the grant boundary (service_role and nothing else) and the
-- SECURITY DEFINER structural check, the same shape 0044's coverage of
-- coach_detect_engagement_decline() established for the nearest sibling
-- job in this repo.
--
-- FIXTURE MECHANIC: every fixture auth.users row is inserted directly
-- (bootstrap superuser, RLS and protect_* triggers out of the way, same as
-- rls_helpers.sql's own fixtures), with created_at expressed as an offset
-- from now() so the file means the same thing whatever day it runs on.

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
create or replace function tests.pap_uid(p_nick text) returns uuid
language sql immutable as $fn$
  select case p_nick
    when 'eligible' then '11110000-0000-4000-8000-000000000001'::uuid  -- anonymous, unredeemed, unverified, 40 days old
    when 'too_new'  then '11110000-0000-4000-8000-000000000002'::uuid  -- anonymous, unredeemed, unverified, 5 days old
    when 'redeemed' then '11110000-0000-4000-8000-000000000003'::uuid  -- anonymous, REDEEMED, unverified, 40 days old
    when 'verified' then '11110000-0000-4000-8000-000000000004'::uuid  -- anonymous, unredeemed, VERIFIED (itself 40 days old), 40 days old
    when 'real'     then '11110000-0000-4000-8000-000000000005'::uuid  -- NOT anonymous, unredeemed, unverified, 40 days old
  end
$fn$;
grant execute on function tests.pap_uid(text) to anon, authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', tests.pap_uid('eligible'), 'authenticated', 'authenticated', null, null, null, now() - interval '40 days', now() - interval '40 days', true),
  ('00000000-0000-0000-0000-000000000000', tests.pap_uid('too_new'),  'authenticated', 'authenticated', null, null, null, now() - interval '5 days',  now() - interval '5 days',  true),
  ('00000000-0000-0000-0000-000000000000', tests.pap_uid('redeemed'), 'authenticated', 'authenticated', null, null, null, now() - interval '40 days', now() - interval '40 days', true),
  ('00000000-0000-0000-0000-000000000000', tests.pap_uid('verified'), 'authenticated', 'authenticated', null, null, null, now() - interval '40 days', now() - interval '40 days', true),
  ('00000000-0000-0000-0000-000000000000', tests.pap_uid('real'),     'authenticated', 'authenticated', 'pap-real@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now() - interval '40 days', now() - interval '40 days', now() - interval '40 days', false);

-- 'eligible' also gets a real profiles row, deliberately, so the run below
-- proves the cascade delete removes it too - boundary 3. Its own
-- recovery_verified_at is null.
insert into public.profiles (id, handle, display_name, recovery_verified_at)
values (tests.pap_uid('eligible'), 'pap_eligible', 'PAP Eligible', null);

-- 'verified' gets a profiles row with recovery_verified_at set, and set to
-- an OLD timestamp on purpose - boundary 1's proof that "genuinely
-- absent" is checked, not "recently set".
insert into public.profiles (id, handle, display_name, recovery_verified_at)
values (tests.pap_uid('verified'), 'pap_verified', 'PAP Verified', now() - interval '40 days');

-- 'redeemed' has an invite_redemptions row, reusing rls_helpers.sql's own
-- invite code fixture.
insert into public.invite_redemptions (user_id, invite_id, role)
values (tests.pap_uid('redeemed'), '11111111-2222-4333-8444-555555555555', 'member');

-- 'too_new' and 'real' get neither a profiles row nor an invite_redemptions
-- row - each is ineligible for exactly one of the other three reasons
-- (age, and is_anonymous, respectively).

-- =====================================================================
-- 1-3. A real run: only 'eligible' is touched, real deletion, cascading.
-- =====================================================================
select is(
  public.purge_abandoned_profiles(),
  jsonb_build_object('checked', 1, 'success', 1, 'failure', 0),
  'exactly one candidate found and purged at the default 30-day window - the other four each fail exactly one of the four criteria and are never even counted as checked');

select is(
  (select count(*)::integer from auth.users where id = tests.pap_uid('eligible')),
  0,
  'the auth.users row is really gone - not soft-deleted, there is no deleted_at column on auth.users to have set');

select is(
  (select count(*)::integer from public.profiles where id = tests.pap_uid('eligible')),
  0,
  'and the cascade took the profiles row with it, the same on delete cascade shape purge_due_accounts() already relies on');

select is(
  (select count(*)::integer from auth.users where id in (tests.pap_uid('too_new'), tests.pap_uid('redeemed'), tests.pap_uid('verified'), tests.pap_uid('real'))),
  4,
  'and every fixture that fails exactly one of the four criteria survives the run untouched');

-- =====================================================================
-- 4. IDEMPOTENT: a second call over the same fixtures does nothing.
-- =====================================================================
select is(
  public.purge_abandoned_profiles(),
  jsonb_build_object('checked', 0, 'success', 0, 'failure', 0),
  'a rerun finds nothing left to purge for an account already removed, and does not touch anything still ineligible - the same idempotent shape purge_due_accounts() already has');

-- =====================================================================
-- 5. THE RETENTION WINDOW IS A REAL PARAMETER.
-- =====================================================================
select is(
  (select count(*)::integer from auth.users where id = tests.pap_uid('too_new')),
  1,
  'still present at the default window - 5 days old is not older than 30');

select is(
  public.purge_abandoned_profiles(3),
  jsonb_build_object('checked', 1, 'success', 1, 'failure', 0),
  'a narrower, explicitly-passed 3-day window makes the 5-day-old account eligible - the window is a real parameter this run responds to, not a hardcoded 30');

select is(
  (select count(*)::integer from auth.users where id = tests.pap_uid('too_new')),
  0,
  'and it really was purged under the narrower window');

select is(
  (select count(*)::integer from auth.users where id in (tests.pap_uid('redeemed'), tests.pap_uid('verified'))),
  2,
  'the narrower window changed only the age comparison - the redeemed and verified accounts, both 40 days old, are still excluded by their OWN criteria, not merely spared by the window');

-- =====================================================================
-- Reachability: service_role and nobody else, same shape
-- coach_detect_engagement_decline() (0044) established for the nearest
-- sibling scheduled job in this repo.
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'purge_abandoned_profiles'),
  true,
  'purge_abandoned_profiles is SECURITY DEFINER - auth.users has no grant to authenticated or anon at all, so being definer (owned by a role that can see it) is what makes it reachable, not an RLS bypass on a public table');

select ok(
  pg_catalog.has_function_privilege('service_role', 'public.purge_abandoned_profiles(integer)', 'execute'),
  'service_role can execute it - the grant supabase/functions/purge_abandoned_profiles/index.ts calls over RPC, the same auth shape recap_weekly_classmates() has');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.purge_abandoned_profiles(integer)', 'execute'),
  'authenticated cannot');

select ok(
  not pg_catalog.has_function_privilege('anon', 'public.purge_abandoned_profiles(integer)', 'execute'),
  'anon cannot');

select ok(
  not pg_catalog.has_function_privilege('public', 'public.purge_abandoned_profiles(integer)', 'execute'),
  'and PUBLIC cannot - asserted separately, because a new function starts with execute granted to PUBLIC and forgetting that one revoke is how a service-role-only purge job quietly becomes an RPC any logged-in member can fire against the whole club');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.purge_abandoned_profiles() $$,
  '42501',
  null,
  'a real authenticated caller gets 42501 calling it directly, from the grant rather than from a check inside the body');
select tests.clear_auth();

select * from finish();
rollback;
