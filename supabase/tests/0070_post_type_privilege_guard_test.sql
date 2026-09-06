-- Launch-readiness audit, finding 4 (202609060004). A member cannot award
-- themselves a staff post_type.
--
-- THE TWO VECTORS THIS FILE REPRODUCES, both verified live against a plain
-- member with no role and no permissions, and both refused now:
--
--   insert into public.workout_posts (author_id, post_type)
--     values (me, 'POST_COACH');
--   update public.workout_posts set post_type = 'POST_COACH'
--     where id = <a post I already own>;
--
-- posts_insert_self and posts_update_self gate the author of a row and say
-- nothing about post_type; default_post_type() only fills the column when it
-- arrives NULL. The label carries the "מאמן/ת" badge, 10 of feed_page's 110
-- ranking points, and membership of the `coach` feed scope.
--
-- The privileged set is four labels, not one, because the other three are
-- worth at least as much: POST_ANNOUNCEMENT shares the coach ranking weight
-- and the coach scope, POST_SYSTEM and POST_NEW_MEMBER are scored as
-- 'system' by feed_page's own diversity bucketing.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. The trigger exists, on both events, on the right column
-- =====================================================================
select is(
  (select count(*)::int from pg_catalog.pg_trigger
   where tgrelid = 'public.workout_posts'::regclass
     and tgname::text = 'workout_posts_guard_privileged_type'), 1,
  'the guard trigger is installed on workout_posts');
select is(
  (select prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'workout_posts_guard_privileged_type'), true,
  'and is security definer - it reads invite_redemptions and profiles for an author who is not the caller');
select is(
  (select has_function_privilege('authenticated', 'public.workout_posts_guard_privileged_type()', 'execute')), false,
  'and is callable by no client role');

-- =====================================================================
-- 2. THE INSERT VECTOR
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.workout_posts (id, author_id, post_type, visibility, title, result_text, occurred_on)
     values ('40700000-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_COACH', 'club', 'Fake coach note', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'THE FIX, vector 1: a plain member can no longer INSERT a POST_COACH row under their own name');
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('m1'), 'POST_ANNOUNCEMENT', 'club', 'Fake announcement', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'nor POST_ANNOUNCEMENT, which carries the same +10 coach weight and the same coach feed scope');
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('m1'), 'POST_SYSTEM', 'club', 'Fake system note', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'nor POST_SYSTEM');
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('m1'), 'POST_NEW_MEMBER', 'club', 'Fake welcome', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'nor POST_NEW_MEMBER');

-- Putting somebody else's uid in author_id is not a way round it either -
-- posts_insert_self refuses that first, with a policy error rather than the
-- trigger's message. Both boundaries stand.
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('coach'), 'POST_COACH', 'club', 'Ghost-written', 'x', current_date) $$,
  '42501',
  null,
  'and attributing it to a real coach is refused by posts_insert_self before the trigger is even reached');

-- =====================================================================
-- 3. THE UPDATE VECTOR - the one a WITH CHECK could not have closed
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on)
     values ('40700000-0000-4000-8000-000000000002', tests.uid('m1'), 'club', 'An ordinary post', 'x', current_date) $$,
  'a member creates an ordinary post, which default_post_type() files as POST_TEXT');
select throws_ok(
  $$ update public.workout_posts set post_type = 'POST_COACH'
     where id = '40700000-0000-4000-8000-000000000002' $$,
  'P0001',
  'post type is staff only',
  'THE FIX, vector 2: and cannot promote it afterwards - this is the half an UPDATE policy''s WITH CHECK structurally cannot express, since it sees only the new row');
select is(
  (select post_type::text from public.workout_posts where id = '40700000-0000-4000-8000-000000000002'),
  'POST_TEXT',
  'and the row still carries the type it was filed under');

-- =====================================================================
-- 4. What a member CAN still do
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.workout_posts set post_type = 'POST_PHOTO'
     where id = '40700000-0000-4000-8000-000000000002' $$,
  'an unprivileged post_type is untouched by the guard - this closes four labels, it does not freeze the column');
select lives_ok(
  $$ update public.workout_posts set body = 'edited'
     where id = '40700000-0000-4000-8000-000000000002' $$,
  'and an edit that does not name post_type at all never fires the trigger');

-- =====================================================================
-- 5. Staff, by both halves of the predicate
-- =====================================================================
-- This is byte-for-byte feed_page's own author_is_staff branch, so a coach
-- and an is_admin profile are exactly the two ways in.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.workout_posts (id, author_id, post_type, visibility, title, result_text, occurred_on)
     values ('40700000-0000-4000-8000-000000000003', tests.uid('coach'), 'POST_COACH', 'club', 'Real coach note', 'x', current_date) $$,
  'a coach - redeemed at role_rank >= 20 - inserts POST_COACH');
select lives_ok(
  $$ insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on)
     values ('40700000-0000-4000-8000-000000000004', tests.uid('coach'), 'club', 'To be promoted', 'x', current_date) $$,
  'and creates an ordinary post...');
select lives_ok(
  $$ update public.workout_posts set post_type = 'POST_COACH'
     where id = '40700000-0000-4000-8000-000000000004' $$,
  '...then promotes it, which is EXACTLY what congratulateCelebrateItem() and coachEngageReachOut() do in the shipped client: post_create, then one own-row update to POST_COACH');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('admin'), 'POST_ANNOUNCEMENT', 'club', 'Admin note', 'x', current_date) $$,
  'and the profiles.is_admin half of the predicate is a way in too, independently of any redeemed role');

-- =====================================================================
-- 6. The author_id IS NULL exemption - the load-bearing one
-- =====================================================================
-- Every real producer of these four labels writes an authorless row. Without
-- this branch post_new_member_on_join, member_of_week_publish,
-- challenge_progress_apply's cooperative milestone and
-- attendance_milestones_on_log would all break at once.
select tests.clear_auth();
select lives_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, body, status, published_at)
     values (null, 'POST_NEW_MEMBER', 'club', 'server authored', 'active', now()) $$,
  'an authorless POST_NEW_MEMBER still inserts - this is the shape post_new_member_on_join writes');
select lives_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, body, status, published_at)
     values (null, 'POST_ANNOUNCEMENT', 'club', 'server authored', 'active', now()) $$,
  'and an authorless POST_ANNOUNCEMENT, which is the shape member_of_week_publish writes');

-- The real producer, end to end, rather than a hand-written imitation of it.
select tests.clear_auth();
insert into public.challenges (id, title, description, challenge_type, metric_type, status, start_at, end_at, target_value, created_by)
values ('40700000-0000-4000-8000-000000000010', 'Club rows', 'x', 'cooperative', 'reps', 'active',
        now() - interval '1 day', now() + interval '7 days', 100, tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id) values ('40700000-0000-4000-8000-000000000010', tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('40700000-0000-4000-8000-000000000010', tests.uid('m1'), 100) $$,
  'and a real cooperative-challenge milestone crossing still posts its authorless POST_CHALLENGE...');
select tests.clear_auth();
select isnt_empty(
  $$ select 1 from public.workout_posts
     where post_type = 'POST_CHALLENGE'
       and (metadata ->> 'challenge_id') = '40700000-0000-4000-8000-000000000010' $$,
  '...so the guard did not break challenge_progress_apply, which is the producer nearest to it');

-- =====================================================================
-- 7. A staff member who loses their role loses the label with it
-- =====================================================================
-- The predicate is a fact about the ROW's author, re-evaluated on every
-- write, not a permission checked once at creation time.
select tests.clear_auth();
update public.invite_redemptions set role = 'member' where user_id = tests.uid('coach');
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('coach'), 'POST_COACH', 'club', 'After demotion', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'a demoted coach is refused on the next write - the guard asks the redemption table, it does not trust a label already on a neighbouring row');
select tests.clear_auth();
update public.invite_redemptions set role = 'coach' where user_id = tests.uid('coach');

select * from finish();
rollback;
