-- Launch-readiness audit, finding 7 (202609060006). profiles.avatar_url gets
-- the scheme + length CHECK events.map_link already has.
--
-- THE VECTOR THIS FILE REPRODUCES. profiles_update_self is
-- `using (id = auth.uid()) with check (id = auth.uid())` - unrestricted by
-- column - and avatar_url was `text` with no constraint whatsoever. So every
-- member could store `javascript:...` in a column that ~30 call sites hand
-- straight to an <img src>, and that admin_search_members(), member_roster(),
-- people_suggestions() and community_search() republish onto OTHER members'
-- screens. Unlike map_link, which only a community.event.manage holder can
-- write, this column is writable by everyone in the club.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. Exactly one constraint, doing both jobs
-- =====================================================================
-- Drop-and-re-add, not a second constraint added beside a survivor: two
-- CHECKs on one column is how a later widening silently contradicts an
-- earlier one.
select is(
  (select count(*)::int from pg_catalog.pg_constraint
   where conrelid = 'public.profiles'::regclass
     and contype = 'c'
     and pg_catalog.pg_get_constraintdef(oid) ilike '%avatar_url%'), 1,
  'exactly one CHECK mentions avatar_url - the scheme rule and the length rule are one constraint, not two');

-- =====================================================================
-- 2. THE VECTOR, refused
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ update public.profiles set avatar_url = 'javascript:alert(1)' where id = tests.uid('m1') $$,
  '23514',
  null,
  'THE FIX: javascript: is refused - this is a column every member can write and roughly thirty call sites render as an <img src>');
select throws_ok(
  $$ update public.profiles set avatar_url = 'data:text/html,<script>alert(1)</script>' where id = tests.uid('m1') $$,
  '23514',
  null,
  'and so is data:');
select throws_ok(
  $$ update public.profiles set avatar_url = 'javascript:void(0)//https://example.test/a.png' where id = tests.uid('m1') $$,
  '23514',
  null,
  'and the oldest bypass in the list is refused too, because the pattern is anchored with ^ - the scheme has to be at the START');
select throws_ok(
  $$ update public.profiles set avatar_url = ' https://example.test/a.png' where id = tests.uid('m1') $$,
  '23514',
  null,
  'a leading space does not buy a way in either');
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://example.test/' || repeat('a', 500) where id = tests.uid('m1') $$,
  '23514',
  null,
  'and the length half still holds independently: 500 characters is the cap, exactly as on events.map_link');

-- =====================================================================
-- 3. What still passes
-- =====================================================================
select lives_ok(
  $$ update public.profiles set avatar_url = 'https://example.test/storage/v1/object/public/avatar-photos/x/avatar.webp?t=1' where id = tests.uid('m1') $$,
  'the shape uploadAvatarPhoto() actually writes - the Storage object URL plus a ?t= cache-bust - passes, which is the whole live corpus');
select lives_ok(
  $$ update public.profiles set avatar_url = 'HTTPS://EXAMPLE.TEST/a.png' where id = tests.uid('m1') $$,
  'the match is case-insensitive, so an uppercase scheme is a legitimate link and not a rejection');
select lives_ok(
  $$ update public.profiles set avatar_url = 'http://example.test/a.png' where id = tests.uid('m1') $$,
  'plain http is allowed - this forbids the schemes that EXECUTE, it is not a transport-security policy');
select lives_ok(
  $$ update public.profiles set avatar_url = null where id = tests.uid('m1') $$,
  'and null is always fine, which is what removeAvatarPhoto() writes');

-- =====================================================================
-- 4. The constraint is the boundary, not the policy
-- =====================================================================
-- A CHECK holds for every writer, including the ones RLS never sees. Asserted
-- because the temptation with a rule like this is to put it in the client.
select tests.clear_auth();
select throws_ok(
  $$ update public.profiles set avatar_url = 'javascript:alert(1)' where id = tests.uid('m1') $$,
  '23514',
  null,
  'even the bootstrap superuser cannot write one - a CHECK is not a policy, and the service role and a dashboard edit are equally bound by it');

select * from finish();
rollback;
