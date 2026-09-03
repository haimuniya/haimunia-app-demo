-- Standalone fix found while building COMM-374
-- (202609030007_fix_admin_search_members_ambiguity.sql).
--
-- admin_search_members raised 42702 "column reference id is ambiguous" for
-- EVERY caller, admins included, from 202608270011 until that migration:
-- its `returns table(id uuid, ..., is_admin boolean, ...)` OUT parameters
-- shadowed profiles.id, profiles.is_admin and profiles.deleted_at inside its
-- own authorization guard, and PL/pgSQL refuses an ambiguous reference
-- rather than guessing.
--
-- THE ASSERTION THAT WAS MISSING, and the whole reason this went unnoticed:
-- nobody ever checked that an ADMIN GETS ROWS BACK. Every existing test of
-- this function asserts only the refusal path, and a non-admin got an
-- exception either way - just with the wrong SQLSTATE. The happy path is
-- asserted first below, deliberately.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- The happy path: an admin gets rows
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select * from public.admin_search_members('member') $$,
  'an admin can call admin_search_members at all - this is the assertion that was missing for the whole life of the defect, and the one that fails loudly against the old body');
select results_eq(
  $$ select count(*)::int from public.admin_search_members('member') $$,
  $$ values (4) $$,
  'and really gets rows: the four fixture handles containing "member" (member_a, member_b, member_c, member_norec)');
select set_eq(
  $$ select handle from public.admin_search_members('member') $$,
  $$ values ('member_a'), ('member_b'), ('member_c'), ('member_norec') $$,
  'matched on handle');
select results_eq(
  $$ select display_name from public.admin_search_members('Coach X') $$,
  $$ values ('Coach X'::text) $$,
  'display_name matching still works');
select results_eq(
  $$ select handle from public.admin_search_members(tests.uid('owner')::text) $$,
  $$ values ('owner_x'::text) $$,
  'and so does an exact id lookup - all three arms of the WHERE clause are intact');

select results_eq(
  $$ select id, handle, role, is_admin from public.admin_search_members('admin_x') $$,
  $$ values (tests.uid('admin'), 'admin_x'::text, 'member'::text, true) $$,
  'the joined columns are the real ones: invite_redemptions.role read past that table''s own-row policy, which is why the function is security definer');

select is_empty(
  $$ select 1 from public.admin_search_members('nobody_by_that_name') $$,
  'a query matching nothing returns nothing, rather than raising');

-- =====================================================================
-- The refusal path still refuses, with the RIGHT error
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.admin_search_members('member') $$,
  'P0001', 'not authorized',
  'a plain member is refused with P0001 not authorized - and crucially NOT with 42702, which is what they used to get and what made the defect look like a permission denial');
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select * from public.admin_search_members('member') $$,
  'P0001', 'not authorized',
  'a coach is refused too: this function keeps its literal is_admin() guard, which is exactly why COMM-374 added admin_member_roster as the coach-readable browse path instead of loosening this one');

select tests.clear_auth();
update public.profiles set deleted_at = now() where id = tests.uid('admin');
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select * from public.admin_search_members('member') $$,
  'P0001', 'not authorized',
  'and a SOFT-DELETED admin is refused - the guard''s deleted_at clause is live, not merely present, which an ambiguity error would also have hidden');
select tests.clear_auth();
update public.profiles set deleted_at = null where id = tests.uid('admin');

-- =====================================================================
-- Soft-deleted members stay out of the results
-- =====================================================================
select tests.clear_auth();
update public.profiles set deleted_at = now() where id = tests.uid('m3');
select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select count(*)::int from public.admin_search_members('member') $$,
  $$ values (3) $$,
  'a soft-deleted member drops out of search results');
select tests.clear_auth();
update public.profiles set deleted_at = null where id = tests.uid('m3');

-- =====================================================================
-- The signature did not change
-- =====================================================================
select results_eq(
  $$ select pg_catalog.pg_get_function_result(p.oid) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_search_members' $$,
  $$ values ('TABLE(id uuid, handle text, display_name text, avatar_url text, is_admin boolean, role text, redeemed_at timestamp with time zone, last_activity_on date)'::text) $$,
  'the eight columns are unchanged in name, type and order - this was a fix to the guard, not a reshape, so no client reading these rows needs to change');
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.admin_search_members(text)', 'execute'),
            has_function_privilege('anon', 'public.admin_search_members(text)', 'execute') $$,
  $$ values (true, false) $$,
  'and the grants are unchanged');

-- =====================================================================
-- The sibling functions were never affected, and still are not
-- =====================================================================
-- They carry the byte-identical guard but return void, so they have no OUT
-- parameters to collide with - which is precisely why the defect survived a
-- copy-paste into three functions and only poisoned the one with a result
-- table.
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_grant_coach(tests.uid('m1')) $$,
  'admin_grant_coach works for an admin and always did - same guard, no OUT parameters');
select results_eq(
  $$ select role from public.admin_search_members('member_a') $$,
  $$ values ('coach'::text) $$,
  'and the promotion it just made is visible through the now-working search, which is the pair COMM-377 reuses');

select * from finish();
rollback;
