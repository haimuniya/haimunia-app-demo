-- Launch-readiness audit, finding 1 (202609060001). The anonymous read gate.
--
-- THE VECTOR THIS FILE REPRODUCES. Anonymous sign-in is enabled and the
-- publishable key ships in the browser, so anyone can mint a real
-- `authenticated` JWT with a real auth.uid() and NOTHING else: no invite
-- redemption, no profile row, no recovery method. tests.set_auth() produces
-- exactly that state for any uuid that has no fixture rows behind it, which
-- is what the 'ghost' session below is - the same shape the live probe used.
--
-- The three questions this file has to answer separately, because conflating
-- them is how the hole got shipped:
--   1. a ghost session reads NOTHING of the club                (the fix)
--   2. a mid-onboarding member still reads their OWN profile row (the
--      regression the fix must not cause - without it the client can never
--      read back the profile it just created and the member is stranded on
--      the "complete your profile" form forever)
--   3. the three pre-redemption content surfaces stay open      (the
--      deliberate exception, which the security review asked for by name)

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- The ghost: an auth.users row and nothing else. No profile, no redemption,
-- no recovery method. This is precisely what /auth/v1/signup with
-- {"data":{}} on an anonymous-enabled project hands back.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0067-4000-8000-000000000001',
        'authenticated', 'authenticated', 'ghost@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

-- Club content for the ghost to try to read. Written as the bootstrap
-- superuser so no policy is involved in creating it.
insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on, status)
values ('40670000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'Back squat', '100 kg', current_date, 'active');
insert into public.announcements (id, author_id, title, body)
values ('40670000-0000-4000-8000-000000000002', tests.uid('admin'), 'Closed Friday', 'The box is closed this Friday.');
insert into public.activity_pings (user_id, activity_date)
values (tests.uid('m1'), current_date), (tests.uid('m1'), current_date - 1);

-- =====================================================================
-- 1. is_community_member() itself
-- =====================================================================
-- Definer is not a style choice here: an invoker function that reads
-- public.profiles, called from profiles' own policy, is an infinite
-- recursion. If this ever flips back, every assertion below turns into
-- "infinite recursion detected in policy for relation profiles" instead of a
-- clean refusal, so it is pinned.
select results_eq(
  $$ select prosecdef from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'is_community_member' $$,
  $$ values (true) $$,
  'is_community_member() is security definer - as an invoker function reading public.profiles it would recurse through the profiles policy that now calls it');
select results_eq(
  $$ select has_function_privilege('anon', 'public.is_community_member()', 'execute') $$,
  $$ values (false) $$,
  'and it is still not executable by the anon role');

select tests.set_auth('aaaaaaaa-0067-4000-8000-000000000001'::uuid);
select is(public.is_community_member(), false,
  'a ghost session - a real authenticated JWT with no profile and no redemption - is not a community member');
select tests.set_auth(tests.uid('norec'));
select is(public.is_community_member(), false,
  'nor is a redeemed member who has not verified a recovery method yet');
select tests.set_auth(tests.uid('m1'));
select is(public.is_community_member(), true,
  'a redeemed, recovery-verified member is');

-- =====================================================================
-- 2. THE HOLE, reproduced: a ghost session reads nothing
-- =====================================================================
select tests.set_auth('aaaaaaaa-0067-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from public.profiles), 0,
  'THE FIX: a ghost session reads ZERO profiles - before 202609060001 this returned every member of the club, name, handle, bio and avatar');
select is(
  (select count(*)::int from public.workout_posts), 0,
  'and ZERO posts, where before it read every club-visible post in the feed with its author attached');
select is(
  (select count(*)::int from public.announcements), 0,
  'and ZERO announcements');
select is(
  (select count(*)::int from public.community_streaks), 0,
  'and ZERO rows from community_streaks, which publishes a handle and a display name per member and was the same surface');

-- The same call a real member makes, to prove the rows genuinely exist and
-- the four zeros above are a refusal rather than an empty database.
select tests.set_auth(tests.uid('m2'));
select is(
  (select count(*)::int from public.profiles where id = tests.uid('m1')), 1,
  'the control: a real member reads m1''s profile...');
select is(
  (select count(*)::int from public.workout_posts where id = '40670000-0000-4000-8000-000000000001'), 1,
  '...and the post...');
select is(
  (select count(*)::int from public.announcements where id = '40670000-0000-4000-8000-000000000002'), 1,
  '...and the announcement, so the zeros above are a boundary and not an empty fixture');

-- =====================================================================
-- 3. A ghost cannot buy its way in with a profile row either
-- =====================================================================
-- profiles_insert_self has required an invite_redemptions row since
-- 202608280003. Asserted here because "just create a profile" is the first
-- thing anyone would try against the new gate.
select tests.set_auth('aaaaaaaa-0067-4000-8000-000000000001'::uuid);
select throws_ok(
  $$ insert into public.profiles (id, handle, display_name)
     values ('aaaaaaaa-0067-4000-8000-000000000001', 'ghost', 'Ghost') $$,
  '42501',
  null,
  'and it cannot create a profile to get past the gate - profiles_insert_self still requires a redeemed invite');

-- =====================================================================
-- 4. The onboarding regression the gate must NOT cause
-- =====================================================================
-- norec is redeemed, has a profile row, and has recovery_verified_at null -
-- exactly the state a member is in between profile creation and
-- mark_recovery_verified(). The client reads its own row back at that moment
-- (PROFILE_COLUMNS in cloud.js); if that read returned nothing, the app would
-- render the "complete your profile" form forever.
select tests.set_auth(tests.uid('norec'));
select is(
  (select handle from public.profiles where id = tests.uid('norec')), 'member_norec',
  'a mid-onboarding member STILL reads their own profile row - the self branch is deliberately outside the gate, and without it the recovery screen is unreachable');
select is(
  (select count(*)::int from public.profiles where id <> tests.uid('norec')), 0,
  'but reads nobody else''s');
select is(
  (select count(*)::int from public.workout_posts), 0,
  'and no posts - renderCommunityApp() shows the recovery card and nothing else at this point, so there is no surface for these to feed');
select is(
  (select count(*)::int from public.announcements), 0,
  'and no announcements');

-- Own posts stay readable through the ungated author branch. Nothing can
-- reach this state through the shipped client (posts_insert_self has carried
-- is_community_member() since 202608280015), which is exactly why the branch
-- costs nothing - but it is what keeps the policy symmetric with profiles'.
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on, status)
values ('40670000-0000-4000-8000-000000000003', tests.uid('norec'), 'club', 'Planted', 'x', current_date, 'active');
select tests.set_auth(tests.uid('norec'));
select is(
  (select count(*)::int from public.workout_posts), 1,
  'the one post it reads is its OWN - author_id = auth.uid() is outside the gate, the same way id = auth.uid() is on profiles');
select tests.clear_auth();
delete from public.workout_posts where id = '40670000-0000-4000-8000-000000000003';

-- =====================================================================
-- 5. The deliberate exceptions: the pre-redemption content surfaces
-- =====================================================================
-- Gating these would break the very screens that run BEFORE redemption.
-- 0066 already asserts norec reads the carousel; this asserts the harder
-- case, the ghost, and asserts all three together so a future "gate
-- everything" pass has to argue with a named test rather than a comment.
select tests.set_auth('aaaaaaaa-0067-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from public.intro_carousel_content), 3,
  'intro_carousel_content stays open to a ghost session - it is the screen a visitor sees BEFORE any invite exists');
select is(
  (select count(*)::int from public.onboarding_step_content), 5,
  'so does onboarding_step_content');
select isnt_empty(
  $$ select module_key from public.club_features $$,
  'and so do the club_features flags - none of the three carries a single member-identifying field');

-- =====================================================================
-- 6. Reading is gated; nothing about WRITING moved
-- =====================================================================
-- The gate is additive to policies that were already write-closed. Pinned so
-- a future edit to these predicates cannot quietly open a write.
select tests.set_auth('aaaaaaaa-0067-4000-8000-000000000001'::uuid);
select throws_ok(
  $$ insert into public.workout_posts (author_id, visibility, title, result_text, occurred_on)
     values ('aaaaaaaa-0067-4000-8000-000000000001', 'club', 'x', 'y', current_date) $$,
  '42501',
  null,
  'a ghost session still cannot write a post');
select throws_ok(
  $$ insert into public.announcements (author_id, title, body)
     values ('aaaaaaaa-0067-4000-8000-000000000001', 'x', 'y') $$,
  '42501',
  null,
  'nor an announcement');

-- =====================================================================
-- 7. Everything the gate did NOT change, on the member path
-- =====================================================================
-- A member who hides is still hidden; a member who does not is still
-- visible; blocks still cut both ways; self always wins. All four are
-- 202608280003 rules that the added clause has to leave exactly as they
-- were.
select tests.clear_auth();
update public.profiles set visible_to_club = false where id = tests.uid('m3');
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.profiles where id = tests.uid('m3')), 0,
  'visible_to_club still hides a member from another member');
select tests.set_auth(tests.uid('m3'));
select is(
  (select count(*)::int from public.profiles where id = tests.uid('m3')), 1,
  'and still never hides them from themselves');
select tests.set_auth(tests.uid('admin'));
select is(
  (select count(*)::int from public.profiles where id = tests.uid('m3')), 1,
  'and an admin still sees them');
select tests.clear_auth();
update public.profiles set visible_to_club = true where id = tests.uid('m3');

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m2'));
select is(
  (select count(*)::int from public.profiles where id = tests.uid('m1')), 0,
  'and a block still cuts in the direction it was not made in');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m1') and blocked_id = tests.uid('m2');

select * from finish();
rollback;
