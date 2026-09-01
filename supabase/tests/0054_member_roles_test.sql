-- Standalone follow-up fix, post-Phase-3 (202609010011). Behavioural
-- coverage for public.member_roles(uuid[]), the fix for loadMemberRoles()'s
-- real bug: invite_redemptions has carried exactly one SELECT policy since
-- Phase 0 (own-row only), so a member's own RLS-enforced session could never
-- read another member's role. This proves both halves at runtime, not just
-- read off pg_catalog:
--   1. The base table's own policy is still own-row only - a real
--      cross-member read of invite_redemptions itself still returns nothing,
--      proving the bug this migration works around is real and still
--      structurally true of the table.
--   2. member_roles() answers for arbitrary members anyway, returns ONLY
--      {user_id, role} (never redeemed_at or code), silently drops an id
--      with no row rather than erroring, and is reachable by any
--      authenticated session with no staff/permission gate at all - matching
--      the migration's own "role is club-public by design" reasoning.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- =====================================================================
-- 1. The base table's own policy: still own-row only, proven at runtime
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select is_empty(
  $$ select 1 from public.invite_redemptions where user_id = tests.uid('coach') $$,
  'a real member session still cannot read another member''s invite_redemptions row directly - this is the exact bug member_roles() exists to work around, re-proven rather than assumed');

select results_eq(
  $$ select count(*)::int from public.invite_redemptions where user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'their own row is still readable - the own-row policy itself is untouched by this migration');

select tests.clear_auth();

-- =====================================================================
-- 2. member_roles() answers for arbitrary members
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select role from public.member_roles(array[tests.uid('coach')]) $$,
  $$ values ('coach'::text) $$,
  'a plain member reading ANOTHER member''s role through member_roles() gets the real value - the exact case the direct table read could never answer');

select results_eq(
  $$ select count(*)::int from public.member_roles(array[tests.uid('m1'), tests.uid('coach'), tests.uid('admin')]) $$,
  $$ values (3) $$,
  'batched: three ids in, three rows out, in one call - the shape loadMemberRoles() relies on');

-- =====================================================================
-- 3. Only {user_id, role} - never redeemed_at, never code
-- =====================================================================
-- A `returns table(...)` function's output columns are OUT-mode entries in
-- its own proargnames/proargmodes, not a pg_attribute row set reachable via
-- prorettype/typrelid - this reads the shape the way Postgres actually
-- records it for this function kind, not the way a plain composite-returning
-- function would expose it.
-- COLLATE "C" on both sides: proargnames is a `name[]`, and `name` has no
-- collation of its own, so comparing it (even cast to text) against a plain
-- text literal inside results_eq's own cursor comparison is ambiguous to
-- the planner without pinning one explicitly.
select results_eq(
  $$ select (u.name::text) collate "C"
     from pg_catalog.pg_proc p, unnest(p.proargnames, p.proargmodes) with ordinality as u(name, mode, ord)
     where p.proname = 'member_roles' and p.pronamespace = 'public'::regnamespace
       and u.mode = 't'
     order by u.ord $$,
  $$ values ('user_id'::text collate "C"), ('role'::text collate "C") $$,
  'the returned row shape is exactly {user_id, role}, in that order - no redeemed_at, no code, nothing else a caller could read about another member through this function');

-- =====================================================================
-- 4. An id with no row is silently absent, never an error
-- =====================================================================
select results_eq(
  $$ select count(*)::int from public.member_roles(array[gen_random_uuid()]) $$,
  $$ values (0) $$,
  'an id nobody redeemed an invite as returns zero rows, not an error - the same "silently absent" shape the real query already has, so a stale or malformed id in a batch never breaks the whole card set');

select results_eq(
  $$ select count(*)::int from public.member_roles(null) $$,
  $$ values (0) $$,
  'a null array is coalesced to empty, not a NULL-propagation error');

select tests.clear_auth();

-- =====================================================================
-- 5. Reachable by any authenticated session, no staff/permission gate -
-- role is club-public by design, matching the badge feature it backs.
-- =====================================================================
select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.member_roles(uuid[])', 'execute'),
  'authenticated can call it - a plain member, not just staff, since this is what makes the coach badge visible to everyone');

select ok(
  not pg_catalog.has_function_privilege('anon', 'public.member_roles(uuid[])', 'execute'),
  'anon cannot - a real session is still required');

select ok(
  not pg_catalog.has_function_privilege('public', 'public.member_roles(uuid[])', 'execute'),
  'and PUBLIC cannot, asserted separately so a future migration cannot silently reopen it to every role by forgetting this one revoke');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.member_roles(array[tests.uid('coach')]) $$,
  'a plain member with no staff rank and no special permission can call it successfully - this is deliberately not staff-gated');
select tests.clear_auth();

select * from finish();
rollback;
