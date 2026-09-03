-- COMM-374. admin_member_roster (202609030005_member_roster.sql).
--
-- Two boundaries matter here and both are asserted in both directions:
--   1. is_staff(), not is_admin() - a COACH can browse the roster, which
--      admin_search_members deliberately does not allow. A plain member
--      cannot.
--   2. Browsing grants nothing. The roster is read-only; the role-change
--      RPCs keep their own inline is_admin() check, so the coach who can
--      now see every member still cannot promote one. That is asserted
--      here rather than left to the client disabling a button.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Who may browse
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.admin_member_roster(null, 25) $$,
  'P0001', 'not authorized',
  'a plain member cannot browse the roster');
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select * from public.admin_member_roster(null, 25) $$,
  'P0001', 'not authorized',
  'nor a member with no verified recovery method');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select * from public.admin_member_roster(null, 25) $$,
  'a COACH can - gated on is_staff(), deliberately looser than admin_search_members'' is_admin(), so a coach no longer needs an admin to look up a member');
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select * from public.admin_member_roster(null, 25) $$,
  'and an admin can');
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select * from public.admin_member_roster(null, 25) $$,
  'and an owner can');

-- The same coach really is refused by the search function, so the looser
-- gate is a deliberate difference and not an accident of the fixture.
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select * from public.admin_search_members('member') $$,
  'P0001', 'not authorized',
  'while the SAME coach is still refused by admin_search_members, which checks a literal is_admin - the two gates really do differ, and COMM-374 chose the looser one on purpose');

-- =====================================================================
-- Browsing grants nothing: the role-change path is untouched
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.admin_grant_coach(tests.uid('m1')) $$,
  'P0001', 'not authorized',
  'the coach who can see every roster row still cannot promote anyone - admin_grant_coach keeps its own inline is_admin() check, untouched by this ticket. The client disabling the button is a courtesy; this is the boundary');

-- =====================================================================
-- The shape is admin_search_members' shape, exactly
-- =====================================================================
select tests.clear_auth();
select results_eq(
  $$ select pg_catalog.pg_get_function_result(p.oid) =
            (select pg_catalog.pg_get_function_result(q.oid) from pg_catalog.pg_proc q
             join pg_catalog.pg_namespace m on m.oid = q.pronamespace
             where m.nspname = 'public' and q.proname = 'admin_search_members')
     from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_member_roster' $$,
  $$ values (true) $$,
  'and the two result types are byte-identical, names, types and order - checkable by the type system rather than by convention, which is why this returns `table(...)` and not the setof jsonb contracts.md proposed');

-- =====================================================================
-- Every member appears
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select count(*)::int from public.admin_member_roster(null, 100) $$,
  $$ values (7) $$,
  'all seven fixture profiles appear');
select set_eq(
  $$ select handle from public.admin_member_roster(null, 100) $$,
  $$ values ('member_a'), ('member_b'), ('member_c'), ('member_norec'),
            ('coach_x'), ('admin_x'), ('owner_x') $$,
  'and they are exactly the seven, including the coach, the admin and the owner - the roster is the whole club, not only plain members');
select results_eq(
  $$ select role from public.admin_member_roster(null, 100) where handle = 'coach_x' $$,
  $$ values ('coach'::text) $$,
  'the role comes from invite_redemptions');
select results_eq(
  $$ select is_admin from public.admin_member_roster(null, 100) where handle = 'admin_x' $$,
  $$ values (true) $$,
  'and the legacy is_admin flag is passed through, the same as admin_search_members does');

-- =====================================================================
-- A profile with no invite_redemptions row still appears
-- =====================================================================
-- COMM-374's last acceptance criterion. This is the mid-signup window and
-- the pre-invite-gate legacy account, and a plain inner join would drop
-- both silently.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000e1',
        'authenticated', 'authenticated', 'noredeem@members.haimuniya.invalid', now(), now());
insert into public.profiles (id, handle, display_name, recovery_verified_at, created_at)
values ('00000000-0000-4000-8000-0000000000e1', 'no_redemption', 'No Redemption', now(),
        now() - interval '400 days');

select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select count(*)::int from public.admin_member_roster(null, 100) $$,
  $$ values (8) $$,
  'a profile with NO invite_redemptions row still appears in the roster');
select results_eq(
  $$ select role is null, redeemed_at is null
     from public.admin_member_roster(null, 100) where handle = 'no_redemption' $$,
  $$ values (true, true) $$,
  'with role and redeemed_at null rather than being dropped - the left join plus the created_at fallback in the ORDER BY is what keeps them, since a null sort key would otherwise sort them out of every page');

-- =====================================================================
-- Soft-deleted profiles are excluded
-- =====================================================================
select tests.clear_auth();
update public.profiles set deleted_at = now() where id = tests.uid('m3');
select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select count(*)::int from public.admin_member_roster(null, 100) $$,
  $$ values (7) $$,
  'a soft-deleted profile drops out of the roster');
select is_empty(
  $$ select 1 from public.admin_member_roster(null, 100) where handle = 'member_c' $$,
  'and it really is the deleted one that went');
select tests.clear_auth();
update public.profiles set deleted_at = null where id = tests.uid('m3');

-- =====================================================================
-- The limit clamp
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select count(*)::int from public.admin_member_roster(null, 3) $$,
  $$ values (3) $$,
  'p_limit is honoured');
select results_eq(
  $$ select count(*)::int from public.admin_member_roster(null, 0) $$,
  $$ values (1) $$,
  'p_limit 0 clamps up to 1');
select results_eq(
  $$ select count(*)::int from public.admin_member_roster(null, -10) $$,
  $$ values (1) $$,
  'a negative limit clamps up to 1 too, rather than returning nothing or raising');
select results_eq(
  $$ select count(*)::int from public.admin_member_roster(null, null) $$,
  $$ values (8) $$,
  'a null limit falls back to the default 25, which is more than the eight rows here');

-- =====================================================================
-- Ordering and the cursor
-- =====================================================================
-- The fixture rows were all created inside this transaction and share a
-- byte-identical created_at, so the join dates are spread explicitly first
-- - otherwise "newest joined first" would pass on a single distinct value
-- and prove nothing.
select tests.clear_auth();
update public.invite_redemptions set redeemed_at = case user_id
  when tests.uid('coach') then now() - interval '1 day'
  when tests.uid('admin') then now() - interval '2 days'
  when tests.uid('owner') then now() - interval '3 days'
  when tests.uid('m1')    then now() - interval '4 days'
  when tests.uid('m2')    then now() - interval '5 days'
  when tests.uid('m3')    then now() - interval '6 days'
  else now() - interval '7 days' end;

select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select bool_and(a >= b) from (
       select coalesce(redeemed_at, '-infinity'::timestamptz) as a,
              lead(coalesce(redeemed_at, '-infinity'::timestamptz)) over () as b
       from public.admin_member_roster(null, 100)) w
     where b is not null $$,
  $$ values (true) $$,
  'the roster is ordered newest-joined first');
-- The expectation is the literal handle, NOT a subquery over
-- invite_redemptions: that table is own-row under RLS, so a subquery
-- evaluated as the coach would resolve to the coach's own row and the
-- assertion would compare the function against itself.
select results_eq(
  $$ select handle from public.admin_member_roster(null, 1) $$,
  $$ values ('coach_x'::text) $$,
  'and the first page really is the most recently joined member - coach_x, redeemed one day ago by the spread above');
select results_eq(
  $$ select count(*)::int from public.admin_member_roster(
       (select redeemed_at from public.admin_member_roster(null, 1)), 100) $$,
  $$ values (7) $$,
  'passing the first row''s join date as p_cursor returns the remaining seven - the cursor is exclusive, so paging cannot repeat a row');

-- The no-redemption member sorts by their profiles.created_at, which was
-- set to 400 days ago, so they come last rather than first or nowhere.
select results_eq(
  $$ select handle from public.admin_member_roster(null, 100) offset 7 limit 1 $$,
  $$ values ('no_redemption'::text) $$,
  'the member with no redemption sorts on their profiles.created_at (400 days ago) and lands last - the tenure-fallback convention, not a special case');

-- =====================================================================
-- Function shape
-- =====================================================================
select tests.clear_auth();
select results_eq(
  $$ select prosecdef, provolatile = 's' from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_member_roster' $$,
  $$ values (true, true) $$,
  'security definer and stable - definer because profiles is viewer-relative and invite_redemptions is own-row only, so an invoker-rights version would return the caller their own slice');
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.admin_member_roster(timestamptz, integer)', 'execute'),
            has_function_privilege('anon', 'public.admin_member_roster(timestamptz, integer)', 'execute') $$,
  $$ values (true, false) $$,
  'granted to authenticated, revoked from anon');

select * from finish();
rollback;
