-- Launch-readiness audit, finding 1, part 2 (202609060009). The SECURITY
-- DEFINER read functions.
--
-- WHY THERE IS A SECOND FILE FOR ONE FINDING. 0067 covers the three read
-- POLICIES. A definer function never evaluates a policy - that is what
-- definer is for - so the gate has to be re-stated inside each function, and
-- an RLS test cannot reach it. Re-probing a ghost session against the stack
-- with 202609060001 already applied showed feed_page() still handing over
-- the entire club feed. This file is that probe, kept.
--
-- It also pins the CONTROL half: every other client-callable definer read
-- was checked in the same pass and already refuses, because it resolves
-- my_role_code() (null for a caller with no profile row) rather than only
-- asking whether a token arrived. Those assertions are here so the reason
-- this migration touched five functions and not seventy is a test rather
-- than a claim in a comment.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0075-4000-8000-000000000001',
        'authenticated', 'authenticated', 'ghost75@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

insert into public.workout_posts (id, author_id, post_type, visibility, title, result_text, occurred_on, status, published_at)
values ('40750000-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_TEXT', 'club', 'Back squat', '100 kg', current_date, 'active', now());

-- =====================================================================
-- 1. THE VECTOR, refused on all five
-- =====================================================================
select tests.set_auth('aaaaaaaa-0075-4000-8000-000000000001'::uuid);

select throws_ok(
  $$ select * from public.feed_page(null, 20, 'for_you') $$,
  'P0001',
  'recovery method required',
  'THE FIX: feed_page refuses a ghost session. This is the club feed with every author''s handle, display name and avatar attached, and it handed all of it over on the strength of auth.uid() being non-null - which an anonymous sign-in session satisfies');
select throws_ok(
  $$ select public.community_search('member', 10) $$,
  'P0001',
  'recovery method required',
  'and so does community_search, which answered a two-letter query with the club directory plus posts and events');
select throws_ok(
  $$ select public.community_profile(tests.uid('m1')) $$,
  'P0001',
  'recovery method required',
  'and community_profile, which returned a whole member - tenure, follower counts, recent posts, achievements');
-- community_profile is the one of the five with a SELF branch, placed the
-- same way profiles_read_authenticated's is: your own row is outside the
-- gate. It costs a ghost nothing, because a ghost has no profile row to read.
select throws_ok(
  $$ select public.community_profile('aaaaaaaa-0075-4000-8000-000000000001'::uuid) $$,
  'P0001',
  'profile not found',
  'and asking for its OWN profile gets ''profile not found'' rather than a row - the self branch is not a way in for a session that has no profile');
select throws_ok(
  $$ select public.club_summary() $$,
  'P0001',
  'recovery method required',
  'and club_summary, which published the club name and its member_count');
select is_empty(
  $$ select user_id from public.member_roles(array[tests.uid('coach')]) $$,
  'while member_roles returns an EMPTY SET rather than raising - it is a best-effort badge cache (202609010011) that has always tolerated a missing row, so it must not start throwing at a client that never checked');

-- =====================================================================
-- 2. The same five, for a real member: unchanged
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select id from public.feed_page(null, 20, 'for_you') $$,
  'a redeemed, recovery-verified member still reads the feed');
select ok(
  (public.community_search('member', 10) -> 'members') <> '[]'::jsonb,
  'and still searches');
select is(
  (public.community_profile(tests.uid('m1')) ->> 'handle'), 'member_a',
  'and still opens a profile');
select is(
  (public.club_summary() ->> 'name'), 'Haimunia',
  'and still gets the club summary');
select results_eq(
  $$ select role from public.member_roles(array[tests.uid('coach')]) $$,
  $$ values ('coach'::text) $$,
  'and still resolves a coach badge');

-- =====================================================================
-- 3. Mid-onboarding: refused, and why that is correct
-- =====================================================================
-- norec is redeemed with a profile and recovery_verified_at null. None of
-- these five is reachable from the shipped client at that moment:
-- renderCommunityApp() returns the COMM-016 recovery card and nothing else,
-- and ensureCommunityDataLoaded() - the only caller of loadFeed(),
-- loadClubSummary() and the role cache - refuses to run until the column is
-- stamped.
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select * from public.feed_page(null, 20, 'for_you') $$,
  'P0001',
  'recovery method required',
  'a member with no verified recovery method is refused too, with the same message every write path in the module already uses for this predicate');
select throws_ok(
  $$ select public.community_profile(tests.uid('m1')) $$,
  'P0001',
  'recovery method required',
  'and cannot read another member''s profile...');
select is(
  (public.community_profile(tests.uid('norec')) ->> 'handle'), 'member_norec',
  '...but still reads their OWN, which is the self-exemption the whole module keeps and which 0040 already depends on for the show_attendance case');
select is(
  (public.community_profile(null) ->> 'handle'), 'member_norec',
  'and a null argument still means "my own profile", which is where the self branch has to be tested from - after the coalesce, not before it');

-- =====================================================================
-- 4. THE CONTROL: everything else already refused, and still does
-- =====================================================================
-- These resolve my_role_code() first, which is null for a caller with no
-- profile row, so they raise before they read anything. That is why the
-- migration touched five functions and not every definer read in the schema.
select tests.set_auth('aaaaaaaa-0075-4000-8000-000000000001'::uuid);
select throws_ok(
  $$ select * from public.people_suggestions(10) $$, 'P0001', 'not authorized',
  'people_suggestions already refused a ghost, through my_role_code() rather than through this gate');
select throws_ok(
  $$ select * from public.feed_leaderboard('consistency', null, 'club', 10) $$, 'P0001', 'not authorized',
  'and feed_leaderboard');
select throws_ok(
  $$ select public.attendance_classmates_today(10) $$, 'P0001', 'not authorized',
  'and attendance_classmates_today');
select throws_ok(
  $$ select * from public.admin_search_members('m') $$, 'P0001', 'not authorized',
  'and admin_search_members');
select throws_ok(
  $$ select * from public.coach_new_members(30) $$, 'P0001', 'not authorized',
  'and the coach tools');
select is_empty(
  $$ select * from public.my_permissions() $$,
  'and my_permissions answers with nothing, which is the same boundary said as a set');

-- =====================================================================
-- 5. The gate is one line, in one place, in each function
-- =====================================================================
-- The bodies in 202609060009 were read back out of the database with
-- pg_get_functiondef() and re-emitted with a single line added, rather than
-- retyped. This pins that: exactly one occurrence per function, and the
-- pre-existing auth.uid() check still immediately above it.
select is(
  (select count(*)::int from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('feed_page', 'community_search', 'club_summary')
     and p.prosrc like '%if v_uid is null then raise exception ''not authorized''; end if;' ||
                       chr(10) || '  if not public.is_community_member() then raise exception ''recovery method required''; end if;%'),
  3,
  'the three whole-club functions carry the gate on the line immediately after their original auth.uid() check, and nowhere else');
select is(
  (select count(*)::int from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'community_profile'
     and p.prosrc like '%v_target <> v_uid and not public.is_community_member()%'),
  1,
  'while community_profile''s sits after the coalesce, because its self branch cannot be evaluated before v_target exists');
select is(
  (select count(*)::int from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'feed_page'
     and p.prosecdef),
  1,
  'and feed_page is still security definer - the gate replaces the missing check, it does not replace the reason the function has owner rights');

select * from finish();
rollback;
