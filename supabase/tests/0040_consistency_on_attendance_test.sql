-- COMM-306: behavioural coverage for 202608310004 (consistency_week_streaks
-- re-created on attendance_log, feed_leaderboard's consistency filter gaining
-- show_attendance, community_profile's inline streak following both).
--
-- The ticket names five boundaries and every one of them gets a direct
-- assertion here rather than an indirect one:
--
--   1. The source really moved. A member with three weeks of POSTED workouts
--      and no attendance reads 0; a member with attendance and no posts at
--      all reads their real streak. Under 202608290015 those two numbers were
--      the other way round, so this pair fails on any revision where the old
--      body is still in place - which a fixture built only on attendance
--      could not detect.
--   2. show_attendance off EXCLUDES a member from the ranked set - no row,
--      not a row worth 0 - asserted by flipping the toggle on an unchanged
--      set of attendance_log rows and watching the same data go from absent
--      to ranked and back, the same proof style 0039 used. A member zeroed
--      and a member excluded are different claims about them, and only the
--      flip can tell which one the code makes.
--   3. The caller is still always in their own board, with their own toggle
--      off, at their real value. That is the existing self-always-included
--      rule and the new predicate must not have narrowed it.
--   4. Zero is real: a member with no attendance_log row at all is RANKED at
--      0, in both the board and the profile, never absent and never an error.
--   5. The two copies still cannot drift, now widened past 0034's single
--      member to every member on the board at once.
--
-- Plus the boundary the ticket draws by exclusion: training_frequency and
-- recent_workouts still read workout_posts, are still gated on
-- show_workout_results alone, and are still there on a profile whose
-- current_streak the attendance toggle has just removed.
--
-- The caller for every substantive assertion is tests.uid('m1'), a plain
-- member: can_view_profile_field() short-circuits true for is_admin(), so a
-- privacy test run as an admin would pass whatever the toggles said and prove
-- nothing - the same reason 0034 and 0039 give for the same choice.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures. Bootstrap superuser, so RLS and attendance_log's "no client
-- write" rule stay out of the way while the world is built. Nothing here
-- asserts anything about who may write that table - 0037 owns that.
-- =====================================================================
select tests.clear_auth();

-- ATTENDANCE, written directly rather than through private_records: what is
-- under test is the readers, not the trigger that fills the table.
-- current_date - 7 lands in the previous ISO week whatever weekday the suite
-- runs on, so every streak below is the same number every day of the year.
--
--   m1    (the caller)  three consecutive weeks -> 3
--   m2    two weeks                             -> 2
--   coach one week, and NO posts at all         -> 1
--   norec the same two weeks as m2, but show_attendance stays OFF (the
--         column default) - boundary 2's fixture
--   m3    no attendance at all, but three weeks of POSTED workouts, which
--         scored 3 under the old body - boundary 1's fixture
--   owner, admin  nothing at all                -> 0
insert into public.attendance_log (user_id, occurred_on)
values
  (tests.uid('m1'),    current_date),
  (tests.uid('m1'),    current_date - 7),
  (tests.uid('m1'),    current_date - 14),
  (tests.uid('m2'),    current_date),
  (tests.uid('m2'),    current_date - 7),
  (tests.uid('norec'), current_date),
  (tests.uid('norec'), current_date - 7),
  (tests.uid('coach'), current_date);

-- Posts, and only posts, for m3: three weeks that the pre-COMM-306 body would
-- have counted as a 3-week streak. They are also what training_frequency and
-- recent_workouts read, which is the point of keeping them.
insert into public.workout_posts (id, author_id, post_type, status, title, occurred_on)
values
  ('c3060000-0000-4000-8000-000000000001', tests.uid('m3'), 'POST_WORKOUT', 'active', 'D0', current_date),
  ('c3060000-0000-4000-8000-000000000002', tests.uid('m3'), 'POST_WORKOUT', 'active', 'D1', current_date - 7),
  ('c3060000-0000-4000-8000-000000000003', tests.uid('m3'), 'POST_PR',      'active', 'D2', current_date - 14);

-- norec gets one post as well as their two attendance weeks, so that when
-- their attendance toggle goes off there is something post-derived left on
-- the profile to still be there. A member with neither would prove nothing.
insert into public.workout_posts (id, author_id, post_type, status, title, occurred_on)
values ('c3060000-0000-4000-8000-000000000004', tests.uid('norec'), 'POST_WORKOUT', 'active', 'N0', current_date);

-- show_workout_results and show_attendance both default to FALSE
-- (202608280003). Opting everyone in except norec is what lets one caller
-- read every other member's profile numbers, so the drift pin below can run
-- set-wide instead of one member at a time.
update public.profiles set show_workout_results = true;
update public.profiles set show_attendance = true where id <> tests.uid('norec');

-- =====================================================================
-- consistency_week_streaks is still internal, and now reads the other table
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'consistency_week_streaks'),
  false,
  'consistency_week_streaks is still SECURITY INVOKER - it borrows the rights of feed_leaderboard, which is how it sees every member past attendance_log_self_select, and grants none of its own');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.consistency_week_streaks()', 'execute'),
  'authenticated still cannot execute consistency_week_streaks');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.consistency_week_streaks()', 'execute'),
  'anon still cannot execute it');
select ok(
  not pg_catalog.has_function_privilege('public', 'public.consistency_week_streaks()', 'execute'),
  'and neither can PUBLIC, so the default grant a re-created function starts with really was revoked again');

select isnt_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'consistency_week_streaks'
       and p.prosrc like '%attendance_log%' and p.prosrc not like '%workout_posts%' $$,
  'and its body reads attendance_log and no longer mentions workout_posts at all - the one function 202608290015 named as the change site');

select isnt_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'community_profile'
       and p.prosrc like '%attendance_log%' and p.prosrc like '%workout_posts%' $$,
  'community_profile reads BOTH: attendance_log for the streak, workout_posts for training_frequency and recent_workouts, which this ticket rules out by name');

-- =====================================================================
-- Boundary 1: the source moved. Posts no longer make a streak; attendance
-- does, with no post anywhere behind it.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select value from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('m3') $$,
  $$ values (0::numeric) $$,
  'a member with three weeks of posted workouts and no logged sessions scores 0 - the board counts weeks a member trained, not weeks they posted, which is the whole of COMM-306');

select results_eq(
  $$ select value from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('coach') $$,
  $$ values (1::numeric) $$,
  'while a member who has never posted anything at all is ranked on the week they trained - the two members are the old body and the new one pointed at each other');

select results_eq(
  $$ select user_id, rank, value, is_self
     from public.feed_leaderboard('consistency', null, 'club', 3) $$,
  format($$ values (%L::uuid, 1, 3::numeric, true),
                   (%L::uuid, 2, 2::numeric, false),
                   (%L::uuid, 3, 1::numeric, false) $$,
         tests.uid('m1')::text, tests.uid('m2')::text, tests.uid('coach')::text),
  'three consecutive training weeks outrank two outrank one, and the caller row is still flagged is_self');

-- The same swap, on the profile side, where the second copy of the rule lives.
select is(
  (public.community_profile(tests.uid('m3')) ->> 'current_streak'),
  '0',
  'community_profile agrees: the posting member reads a 0-week streak, so the inline copy moved with the set-based one rather than being left behind');

select is(
  (public.community_profile(tests.uid('coach')) ->> 'current_streak'),
  '1',
  'and the training member reads 1 on their profile with no post of any kind in the club');

-- =====================================================================
-- The two fields COMM-306 explicitly does NOT touch
-- =====================================================================
select ok(
  (public.community_profile(tests.uid('m3')) ? 'training_frequency'),
  'training_frequency is still there for the member whose only activity is posts - it reads workout_posts directly and answers what a member chose to share, which COMM-306 leaves alone');

select results_eq(
  $$ select jsonb_array_length(public.community_profile(tests.uid('m3')) -> 'recent_workouts') $$,
  $$ values (2) $$,
  'and recent_workouts still lists their two POST_WORKOUT rows from the same source, unchanged (the POST_PR is not a workout, exactly as before)');

select ok(
  not (public.community_profile(tests.uid('coach')) ? 'training_frequency'),
  'while the member who trains and never posts still has no training_frequency at all - the two numbers answer different questions and did not merge');

-- =====================================================================
-- Boundary 2: show_attendance EXCLUDES, and it is the toggle doing it.
-- norec holds exactly the two weeks m2 holds, so the only difference between
-- the two members is the toggle.
-- =====================================================================
select results_eq(
  $$ select count(*)::int from public.feed_leaderboard('consistency', null, 'club', 100) $$,
  $$ values (6) $$,
  'six of the seven members are ranked - the seventh is not missing data, they are opted out');

select is_empty(
  $$ select 1 from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('norec') $$,
  'a member with show_attendance off is absent from the consistency board entirely - not ranked last, not ranked at 0, absent, the same way a visible_to_club-off member already is');

select tests.clear_auth();
select is(
  (select count(*)::integer from public.attendance_log where user_id = tests.uid('norec')),
  2,
  'while both of their attendance rows still exist - the toggle governs what other members may be told, never whether the member trained (counted as the bootstrap superuser, because attendance_log select is own-row for a member)');

update public.profiles set show_attendance = true where id = tests.uid('norec');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select value from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('norec') $$,
  $$ values (2::numeric) $$,
  'flipping only that toggle, with not one attendance row added or removed, puts the same two weeks on the board at their real value - so it was the privacy choice doing the hiding, not missing data');

select results_eq(
  $$ select count(*)::int from public.feed_leaderboard('consistency', null, 'club', 100) $$,
  $$ values (7) $$,
  'and the ranked set is seven again, which is the same assertion said as a count: exclusion, not zeroing');

-- The profile side of the same toggle, on the same unchanged rows.
select is(
  (public.community_profile(tests.uid('norec')) ->> 'current_streak'),
  '2',
  'their profile publishes the streak too while the toggle is on');

select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('norec');
select tests.set_auth(tests.uid('m1'));

select ok(
  not (public.community_profile(tests.uid('norec')) ? 'current_streak'),
  'turning it back off removes the key from their profile rather than zeroing it - absent means hidden here, the same contract every other field in this function keeps, so hidden and zero stay distinguishable end to end');

select ok(
  (public.community_profile(tests.uid('norec')) ? 'training_frequency')
  and (public.community_profile(tests.uid('norec')) ? 'recent_workouts'),
  'and the two fields COMM-306 does not touch are still there on that same profile, under show_workout_results alone - hiding attendance hides the attendance-derived number and nothing else');

-- =====================================================================
-- Boundary 3: the caller is always in their own board, own toggle off
-- =====================================================================
select tests.set_auth(tests.uid('norec'));
select results_eq(
  $$ select user_id, value, is_self from public.feed_leaderboard('consistency', null, 'club', 100)
     where is_self $$,
  format($$ values (%L::uuid, 2::numeric, true) $$, tests.uid('norec')::text),
  'a caller whose own show_attendance is off still gets their own row back at their real streak - can_view_profile_field answers true for the caller before it reads any toggle, so the new predicate is self-exempt like the two beside it');

select results_eq(
  $$ select count(*)::int from public.feed_leaderboard('consistency', null, 'club', 100) $$,
  $$ values (7) $$,
  'their board is the six opted-in members plus themselves - opting out removes you from other members boards, never from your own');

select is(
  (public.community_profile(tests.uid('norec')) ->> 'current_streak'),
  '2',
  'and their own profile still shows them their own streak, for the same reason');

-- =====================================================================
-- Boundary 4: zero is a real value, not an absence and not an error
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id, value from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id in (tests.uid('owner'), tests.uid('admin'))
     order by user_id $$,
  format($$ values (%L::uuid, 0::numeric), (%L::uuid, 0::numeric) $$,
         tests.uid('admin')::text, tests.uid('owner')::text),
  'a member with no attendance_log row at all is ranked at 0 rather than dropped - there is no real rank to report from a set the caller was filtered out of, which is why the zeros have to be in it');

select lives_ok(
  $$ select public.community_profile(tests.uid('owner')) $$,
  'and their profile does not raise: a member the offline app has never synced a session for is a 0, the same zero-is-real rule the board documents');

select is(
  (public.community_profile(tests.uid('owner')) ->> 'current_streak'),
  '0',
  'stated as the number rather than as the absence of an exception');

-- =====================================================================
-- Boundary 5: the two copies still cannot drift, widened to every member
-- =====================================================================
-- 0034 pins one member (the caller's own row) against community_profile.
-- This is the same pin over the whole board at once: every ranked member's
-- value must equal the current_streak their profile publishes, which is only
-- readable set-wide because every fixture member has both toggles on. Written
-- as an is_empty over the disagreements with an isnt_empty beside it, the
-- shape 0038 established, so a fixture with nothing but zeros in it cannot
-- pass vacuously.
select is_empty(
  $$ with board as (
       select user_id, value from public.feed_leaderboard('consistency', null, 'club', 100)
     )
     select b.user_id from board b
     where b.value is distinct from ((public.community_profile(b.user_id) ->> 'current_streak'))::numeric $$,
  'every member on the board carries exactly the streak their own profile publishes - one rule, computed twice, agreeing for all of them and not just for the caller');

select isnt_empty(
  $$ select 1 from public.feed_leaderboard('consistency', null, 'club', 100) where value > 0 $$,
  'and the board it agreed on is not all zeros, so the pin above cannot pass vacuously');

-- =====================================================================
-- Progress mode is untouched by the new predicate
-- =====================================================================
select tests.clear_auth();
insert into public.challenges
  (id, title, description, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
values ('c3060000-3333-4000-8000-000000000001', 'אתגר התקדמות', '', 'individual_performance', 'reps', 100,
        now() - interval '10 days', now() + interval '10 days', 'active', tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id, status, progress_value)
values
  ('c3060000-3333-4000-8000-000000000001', tests.uid('norec'), 'active', 30),
  ('c3060000-3333-4000-8000-000000000001', tests.uid('m1'),    'active', 10);

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id, rank, value
     from public.feed_leaderboard('progress', 'c3060000-3333-4000-8000-000000000001', 'club', 50) $$,
  format($$ values (%L::uuid, 1, 30::numeric), (%L::uuid, 2, 10::numeric) $$,
         tests.uid('norec')::text, tests.uid('m1')::text),
  'the member excluded from the consistency board for show_attendance leads the progress board - the new predicate is inside the consistency branch, and a challenge ranking has nothing to do with attendance');

select * from finish();
rollback;
