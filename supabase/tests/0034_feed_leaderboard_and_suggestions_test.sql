-- COMM-210 / COMM-211 / COMM-212 / COMM-232: behavioural coverage for
-- 202608290015 (leaderboard_row, consistency_week_streaks,
-- feed_leaderboard, people_suggestions).
--
-- COMM-306 (202608310004) changed one thing in this file and nothing else:
-- the consistency fixture is attendance_log days instead of POST_WORKOUT /
-- POST_PR rows, because that is where the streak now comes from. Every
-- assertion below is the one 202608290015 shipped with, re-run against the
-- new source - including the "the two copies agree" pin, which was the
-- reason the source had to move in both functions at once.
--
-- Real rows, real toggles, real callers. The caller for almost every
-- assertion is tests.uid('m1'), a plain member: can_view_profile_field()
-- short-circuits true for is_admin(), so a privacy test run as an admin
-- would pass whatever the toggles said and prove nothing. Where a second
-- caller is needed it is m3 or the coach, neither of which is an admin
-- either.
--
-- What feed_leaderboard is held to here: the consistency value is the same
-- number community_profile already publishes for the same member (asserted
-- directly, so the new set-based streak and the old inline one cannot drift);
-- rank is a position with ties broken by tenure and then by name; every
-- eligible member is ranked including the zeros, which is what makes the
-- caller's own rank real; the caller's row comes back even from outside
-- p_limit and even when the caller opted out of leaderboards themselves;
-- in_leaderboards, visible_to_club and a block edge in either direction each
-- remove a row; friends scope is a mutual follow and still keeps the caller;
-- progress mode refuses to run without a challenge, refuses an invisible one,
-- and ranks only its participants.
--
-- What people_suggestions is held to: the three signals rank in the stated
-- order, each one alone is enough to be suggested, the 60-day window is real
-- on both sides of an interaction, 'open' telemetry and an 'interested' RSVP
-- are not overlap, and a follow edge in either direction, a block in either
-- direction, either visibility toggle, and the caller themselves are all out.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures. Bootstrap superuser, so RLS and the protect_* triggers stay
-- out of the way while the world is built.
-- =====================================================================

-- Training weeks. COMM-306 (202608310004) moved consistency off posted
-- workouts and onto verified attendance, so the fixture that feeds every
-- streak assertion below is now attendance_log rather than workout_posts.
-- The days are written directly, because what is under test here is a reader
-- of that table, not the trigger that fills it - 0037 owns that end. Nothing
-- else in this file moved: the same members hold the same streaks and every
-- ranking, tie-break, toggle and scope assertion is the one 202608290015
-- shipped with.
--
-- current_date - 7 lands in the previous ISO week whatever weekday the suite
-- runs on, so these streaks are 3, 2, 1 and 0 every day of the year: m1 three
-- consecutive weeks, m2 two, coach one, m3 a single week a month ago (anchor
-- too old to count for anything), and admin, owner and norec have never
-- trained at all.
insert into public.attendance_log (user_id, occurred_on)
values
  (tests.uid('m1'),    current_date),
  (tests.uid('m1'),    current_date - 7),
  (tests.uid('m1'),    current_date - 14),
  (tests.uid('m2'),    current_date),
  (tests.uid('m2'),    current_date - 7),
  (tests.uid('coach'), current_date),
  (tests.uid('m3'),    current_date - 28);

-- show_attendance is attendance's own toggle (202608280003) and it defaults
-- to FALSE, so a consistency board of members who have never opted in is a
-- board of one: the caller. Every fixture member opts in here so the rest of
-- this file keeps measuring what it was written to measure. The exclusion
-- that toggle now enforces is asserted in
-- 0040_consistency_on_attendance_test.sql, on a flip rather than on a
-- default, which is the only form of the assertion that proves a gate.
update public.profiles set show_attendance = true;

-- =====================================================================
-- Who may call it at all
-- =====================================================================
select tests.clear_auth();
select pg_catalog.set_config('role', 'authenticated', true);
select throws_ok(
  $$ select * from public.feed_leaderboard('consistency') $$,
  'P0001',
  'not authorized',
  'an authenticated request with no user is refused before anything is read');
select throws_ok(
  $$ select * from public.people_suggestions() $$,
  'P0001',
  'not authorized',
  'and so is a suggestion strip with nobody to suggest to');
select tests.clear_auth();

select tests.set_auth(tests.uid('m1'));

-- =====================================================================
-- Consistency mode, club scope: the ranking itself
-- =====================================================================
select results_eq(
  $$ select user_id, rank, value, is_self
     from public.feed_leaderboard('consistency', null, 'club', 3) $$,
  format($$ values (%L::uuid, 1, 3::numeric, true),
                   (%L::uuid, 2, 2::numeric, false),
                   (%L::uuid, 3, 1::numeric, false) $$,
         tests.uid('m1')::text, tests.uid('m2')::text, tests.uid('coach')::text),
  'three consecutive weeks outrank two outrank one, and the caller row is flagged is_self');

select results_eq(
  $$ select count(*)::int from public.feed_leaderboard('consistency', null, 'club', 100) $$,
  $$ values (7) $$,
  'every eligible member is ranked, including the four who have never trained');

select results_eq(
  $$ select bool_and(value = 0) from public.feed_leaderboard('consistency', null, 'club', 100)
     where rank > 3 $$,
  $$ values (true) $$,
  'a member with no qualifying activity is a real row worth 0, not a missing one - that is what makes a rank real');

select results_eq(
  $$ select rank from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('m3') $$,
  $$ values (5) $$,
  'ranks are positions, not shared: the four zeros are 4, 5, 6, 7 by display name, m3 is 5');

-- The number is the number community_profile already publishes. If the
-- set-based streak and the inline one ever disagree, this fails. COMM-306
-- moved BOTH onto attendance_log in one migration precisely so this assertion
-- keeps holding, and it is re-run here against the new source rather than
-- retired: two copies of one rule need a standing pin whatever the rule reads
-- from. 0040 widens it to every fixture member.
select results_eq(
  $$ select value from public.feed_leaderboard('consistency', null, 'club', 100) where is_self $$,
  $$ select ((public.community_profile(tests.uid('m1')) ->> 'current_streak'))::numeric $$,
  'the leaderboard value is exactly community_profile current_streak - one streak rule, computed twice, agreeing');

-- =====================================================================
-- The caller's own row always comes back
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select results_eq(
  $$ select user_id, rank, is_self from public.feed_leaderboard('consistency', null, 'club', 2) $$,
  format($$ values (%L::uuid, 1, false), (%L::uuid, 2, false), (%L::uuid, 5, true) $$,
         tests.uid('m1')::text, tests.uid('m2')::text, tests.uid('m3')::text),
  'a caller ranked 5th with a limit of 2 gets the top two and then their own row, last, with its real rank');

select results_eq(
  $$ select count(*)::int from public.feed_leaderboard('consistency', null, 'club', 0) $$,
  $$ values (2) $$,
  'p_limit 0 clamps up to 1 - one ranked row plus the caller, never an empty board');

select results_eq(
  $$ select count(*)::int from public.feed_leaderboard('consistency', null, 'club', null) $$,
  $$ values (7) $$,
  'a null p_limit falls back to 50, which this club is nowhere near');

select results_eq(
  $$ select count(*)::int from public.feed_leaderboard('consistency', null, 'club', 9999) $$,
  $$ values (7) $$,
  'and an absurd p_limit clamps to 100 rather than being handed to the planner');

-- =====================================================================
-- COMM-212 friends scope
-- =====================================================================
select tests.clear_auth();
-- m1 and m2 follow each other. m1 follows the coach one way only, which is
-- not friendship and must not read as it.
insert into public.follows (follower_id, followed_id) values
  (tests.uid('m1'), tests.uid('m2')),
  (tests.uid('m2'), tests.uid('m1')),
  (tests.uid('m1'), tests.uid('coach'));

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id, rank from public.feed_leaderboard('consistency', null, 'friends', 50) $$,
  format($$ values (%L::uuid, 1), (%L::uuid, 2) $$, tests.uid('m1')::text, tests.uid('m2')::text),
  'friends scope is the mutual follow and the caller - the one-way follow of the coach is not a friend');

select tests.set_auth(tests.uid('m3'));
select results_eq(
  $$ select user_id, rank, value, is_self from public.feed_leaderboard('consistency', null, 'friends', 50) $$,
  format($$ values (%L::uuid, 1, 0::numeric, true) $$, tests.uid('m3')::text),
  'a member with no mutual follows still gets themselves back, ranked 1 of 1, not an empty result set');

-- =====================================================================
-- The two toggles and the block edge
-- =====================================================================
select tests.clear_auth();
update public.profiles set in_leaderboards = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('m2') $$,
  'in_leaderboards off removes the member from the board entirely');
select is_empty(
  $$ select 1 from public.feed_leaderboard('consistency', null, 'friends', 50)
     where user_id = tests.uid('m2') $$,
  'and it holds inside friends scope too - opting out of the board is not opting in for friends');
select results_eq(
  $$ select rank from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('coach') $$,
  $$ values (2) $$,
  'and the members below them move up, so the ranks stay contiguous');

select tests.clear_auth();
update public.profiles set in_leaderboards = true where id = tests.uid('m2');
update public.profiles set visible_to_club = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('m2') $$,
  'a member hidden from the club is hidden from the board, even with in_leaderboards on');

select tests.clear_auth();
update public.profiles set visible_to_club = true where id = tests.uid('m2');

-- Both directions, through can_view_profile_field's own block check - no
-- second block rule was invented for the leaderboard.
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('m2') $$,
  'a member who blocked the caller is off the caller board');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m2') and blocked_id = tests.uid('m1');

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.feed_leaderboard('consistency', null, 'club', 100)
     where user_id = tests.uid('m2') $$,
  'and a member the caller blocked is off it as well');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m1') and blocked_id = tests.uid('m2');

-- COMM-212's whole point: the server-side opt-out is in_leaderboards, and it
-- never hides you from yourself. Hide-my-result is the client's business.
update public.profiles set in_leaderboards = false where id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id, rank, is_self from public.feed_leaderboard('consistency', null, 'club', 100)
     where is_self $$,
  format($$ values (%L::uuid, 1, true) $$, tests.uid('m1')::text),
  'a caller who left the leaderboard still gets their own row back - the server never withholds it, the client chooses not to draw it');
select tests.clear_auth();
update public.profiles set in_leaderboards = true where id = tests.uid('m1');

-- =====================================================================
-- COMM-210 tie-breaks: longer tenure first, then display name
-- =====================================================================
-- The coach gets a second week, tying m2 at 2.
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('coach'), current_date - 7);

update public.invite_redemptions set redeemed_at = now() - interval '400 days' where user_id = tests.uid('coach');
update public.invite_redemptions set redeemed_at = now() - interval '10 days' where user_id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id, value from public.feed_leaderboard('consistency', null, 'club', 3) $$,
  format($$ values (%L::uuid, 3::numeric), (%L::uuid, 2::numeric), (%L::uuid, 2::numeric) $$,
         tests.uid('m1')::text, tests.uid('coach')::text, tests.uid('m2')::text),
  'two members on the same streak break by longer club tenure - the coach joined 400 days ago, m2 ten');

select tests.clear_auth();
update public.invite_redemptions set redeemed_at = now() - interval '400 days' where user_id = tests.uid('m2');
update public.profiles set display_name = 'Zed Coach' where id = tests.uid('coach');
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id, value from public.feed_leaderboard('consistency', null, 'club', 3) $$,
  format($$ values (%L::uuid, 3::numeric), (%L::uuid, 2::numeric), (%L::uuid, 2::numeric) $$,
         tests.uid('m1')::text, tests.uid('m2')::text, tests.uid('coach')::text),
  'same streak and same tenure breaks alphabetically - Member B before Zed Coach');

select tests.clear_auth();
update public.profiles set display_name = 'Coach X' where id = tests.uid('coach');
update public.invite_redemptions set redeemed_at = now() where user_id in (tests.uid('m2'), tests.uid('coach'));
delete from public.attendance_log where user_id = tests.uid('coach') and occurred_on = current_date - 7;

-- =====================================================================
-- COMM-211 progress mode
-- =====================================================================
insert into public.challenges
  (id, title, description, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
values
  ('cccccccc-2222-4000-8000-000000000001', 'אתגר התקדמות', '', 'individual_performance', 'reps', 100,
   now() - interval '10 days', now() + interval '10 days', 'active', tests.uid('coach')),
  -- A draft nobody but its creator may see, so the leaderboard cannot be
  -- used to find out it exists.
  ('cccccccc-2222-4000-8000-000000000002', 'טיוטה', '', 'individual_performance', 'reps', 100,
   now() - interval '1 day', now() + interval '10 days', 'draft', tests.uid('coach'));

insert into public.challenge_participants (challenge_id, user_id, status, progress_value)
values
  ('cccccccc-2222-4000-8000-000000000001', tests.uid('m2'),    'active', 30),
  ('cccccccc-2222-4000-8000-000000000001', tests.uid('coach'), 'active', 20),
  ('cccccccc-2222-4000-8000-000000000001', tests.uid('m1'),    'active', 10),
  -- Withdrawn, and holding the highest number in the table: if a withdrawal
  -- ever stops being filtered this row is impossible to miss.
  ('cccccccc-2222-4000-8000-000000000001', tests.uid('m3'),    'withdrawn', 99);

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id, rank, value, is_self
     from public.feed_leaderboard('progress', 'cccccccc-2222-4000-8000-000000000001', 'club', 50) $$,
  format($$ values (%L::uuid, 1, 30::numeric, false),
                   (%L::uuid, 2, 20::numeric, false),
                   (%L::uuid, 3, 10::numeric, true) $$,
         tests.uid('m2')::text, tests.uid('coach')::text, tests.uid('m1')::text),
  'progress ranks the challenge participants by progress_value - the withdrawn 99 is not among them');

select results_eq(
  $$ select user_id, rank, is_self
     from public.feed_leaderboard('progress', 'cccccccc-2222-4000-8000-000000000001', 'club', 1) $$,
  format($$ values (%L::uuid, 1, false), (%L::uuid, 3, true) $$,
         tests.uid('m2')::text, tests.uid('m1')::text),
  'the same self-row rule holds in progress mode: the leader, then me, with my real rank');

select results_eq(
  $$ select user_id from public.feed_leaderboard('progress', 'cccccccc-2222-4000-8000-000000000001', 'friends', 50) $$,
  format($$ values (%L::uuid), (%L::uuid) $$, tests.uid('m2')::text, tests.uid('m1')::text),
  'friends scope narrows progress the same way it narrows consistency, and still keeps the caller');

select tests.set_auth(tests.uid('owner'));
select results_eq(
  $$ select count(*)::int, bool_or(is_self)
     from public.feed_leaderboard('progress', 'cccccccc-2222-4000-8000-000000000001', 'club', 50) $$,
  $$ values (3, false) $$,
  'a caller who never joined the challenge sees the board and no row of their own - there is no standing to invent');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.feed_leaderboard('progress', null, 'club', 50) $$,
  'P0001',
  'challenge required',
  'progress with no challenge raises instead of silently returning a club-wide ranking of something else');

select throws_ok(
  $$ select * from public.feed_leaderboard('progress', 'cccccccc-2222-4000-8000-0000000000ff', 'club', 50) $$,
  'P0001',
  'challenge not found',
  'and an unknown challenge is an error, not an empty board');

select throws_ok(
  $$ select * from public.feed_leaderboard('progress', 'cccccccc-2222-4000-8000-000000000002', 'club', 50) $$,
  'P0001',
  'challenge not found',
  'a draft challenge is not found for a member, so the leaderboard is no existence oracle');

select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.feed_leaderboard('progress', 'cccccccc-2222-4000-8000-000000000002', 'club', 50) $$,
  'while its own creator gets a real, empty board back rather than an error');

-- in_leaderboards is enforced in progress mode by the same call, not by a
-- second rule that only consistency happens to run.
select tests.clear_auth();
update public.profiles set in_leaderboards = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id, rank
     from public.feed_leaderboard('progress', 'cccccccc-2222-4000-8000-000000000001', 'club', 50) $$,
  format($$ values (%L::uuid, 1), (%L::uuid, 2) $$, tests.uid('coach')::text, tests.uid('m1')::text),
  'the participant who left the leaderboard is gone from progress too, and the ranks close up');
select tests.clear_auth();
update public.profiles set in_leaderboards = true where id = tests.uid('m2');

-- =====================================================================
-- Bad arguments
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.feed_leaderboard('weekly', null, 'club', 50) $$,
  'P0001',
  'unknown leaderboard mode weekly',
  'an unknown mode names itself in the error rather than defaulting to consistency');
select throws_ok(
  $$ select * from public.feed_leaderboard(null, null, 'club', 50) $$,
  'P0001',
  'unknown leaderboard mode <NULL>',
  'and so does a null one');
select throws_ok(
  $$ select * from public.feed_leaderboard('consistency', null, 'everyone', 50) $$,
  'P0001',
  'unknown leaderboard scope everyone',
  'an unknown scope is refused rather than quietly widened to the whole club');
select lives_ok(
  $$ select * from public.feed_leaderboard('CONSISTENCY', null, 'CLUB', 50) $$,
  'mode and scope are matched case-insensitively, so a client casing slip is not an outage');
select results_eq(
  $$ select count(*)::int from public.feed_leaderboard('consistency') $$,
  $$ values (7) $$,
  'the defaults are club scope and 50 rows, so a consistency board is a one-argument call');

-- =====================================================================
-- COMM-232 people_suggestions
-- =====================================================================
select tests.clear_auth();
-- Clear the follow edges the friends-scope tests needed: a follow is an
-- exclusion here, and the exclusion gets its own assertions below.
delete from public.follows;
-- And clear the attendance days the consistency board above needed. Since
-- COMM-302 a shared training day is people_suggestions' second-strongest
-- signal, so leaving them in would rank the fixtures below by an overlap this
-- section was never about - the classmate signal has its own file, 0039.
-- Everything from here down rests on fixtures built for this section alone.
delete from public.attendance_log;
-- The progress challenge is over, so it stops being a signal. Everything
-- below rests on fixtures built for this section alone.
update public.challenges set status = 'completed' where id = 'cccccccc-2222-4000-8000-000000000001';

-- Signal 1: m1 and m2 in the same live challenge.
insert into public.challenges
  (id, title, description, challenge_type, metric_type, start_at, end_at, status, created_by)
values ('cccccccc-3333-4000-8000-000000000001', 'אתגר חי', '', 'individual_target', 'reps',
        now() - interval '5 days', now() + interval '5 days', 'active', tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id, status, progress_value)
values
  ('cccccccc-3333-4000-8000-000000000001', tests.uid('m1'), 'active', 0),
  ('cccccccc-3333-4000-8000-000000000001', tests.uid('m2'), 'active', 0);

-- Signal 2: m1 and m3 both engaged with the owner's post. norec only opened
-- it, which is telemetry, not engagement.
insert into public.workout_posts (id, author_id, post_type, status, body)
values ('eeeeeeee-0000-4000-8000-00000000000a', tests.uid('owner'), 'POST_TEXT', 'active', 'פוסט');
insert into public.feed_interactions (user_id, post_id, kind, created_at) values
  (tests.uid('m1'),    'eeeeeeee-0000-4000-8000-00000000000a', 'react',   now() - interval '2 days'),
  (tests.uid('m3'),    'eeeeeeee-0000-4000-8000-00000000000a', 'comment', now() - interval '1 day'),
  (tests.uid('norec'), 'eeeeeeee-0000-4000-8000-00000000000a', 'open',    now() - interval '1 day');

-- Signal 3: m1 and the coach are both going to the same event. The owner is
-- only interested, which is not showing up.
insert into public.events (id, title, event_type, start_at, status, created_by)
values ('a5a5a5a5-0000-4000-8000-000000000001', 'ערב קהילה', 'social_night',
        now() + interval '7 days', 'published', tests.uid('coach'));
insert into public.event_attendees (event_id, user_id, response, registered_at) values
  ('a5a5a5a5-0000-4000-8000-000000000001', tests.uid('m1'),    'going',      now() - interval '3 days'),
  ('a5a5a5a5-0000-4000-8000-000000000001', tests.uid('coach'), 'going',      now() - interval '3 days'),
  ('a5a5a5a5-0000-4000-8000-000000000001', tests.uid('owner'), 'interested', now() - interval '3 days');

select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select item ->> 'user_id', item ->> 'reason' from public.people_suggestions() as t(item) $$,
  format($$ values (%L, 'challenge'), (%L, 'interaction'), (%L, 'event') $$,
         tests.uid('m2')::text, tests.uid('m3')::text, tests.uid('coach')::text),
  'the three signals rank in the order COMM-232 states: shared challenge, then shared post, then shared event');

select results_eq(
  $$ select item ->> 'handle', item -> 'signals' ->> 'shared_challenges'
     from public.people_suggestions() as t(item) limit 1 $$,
  $$ values ('member_b', '1') $$,
  'each row carries its handle and the per-signal counts a later phase adds a fourth key to');

select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('owner')::text
        or item ->> 'user_id' = tests.uid('norec')::text $$,
  'an interested RSVP and an open event are not overlap, so neither the owner nor norec is suggested');

select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m1')::text $$,
  'and the caller is never suggested to themselves');

select results_eq(
  $$ select count(*)::int from public.people_suggestions(1) $$,
  $$ values (1) $$,
  'p_limit really limits');
select results_eq(
  $$ select count(*)::int from public.people_suggestions(0) $$,
  $$ values (1) $$,
  'p_limit 0 clamps up to 1 rather than returning nothing');
select results_eq(
  $$ select count(*)::int from public.people_suggestions(9999) $$,
  $$ values (3) $$,
  'and an absurd one clamps to 20');

-- A follow edge in either direction ends the suggestion.
select tests.clear_auth();
insert into public.follows (follower_id, followed_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  'somebody the caller already follows is not a suggestion');
select tests.clear_auth();
delete from public.follows;

insert into public.follows (follower_id, followed_id) values (tests.uid('m2'), tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  'and neither is somebody who already follows the caller');
select tests.clear_auth();
delete from public.follows;

-- A block edge in either direction, through the same helper.
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m3')::text $$,
  'a member who blocked the caller is never suggested to them');
select tests.clear_auth();
delete from public.blocks;

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m3'));
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m3')::text $$,
  'and neither is one the caller blocked');
select tests.clear_auth();
delete from public.blocks;

-- The two toggles COMM-232 names.
update public.profiles set allow_follows = false where id = tests.uid('coach');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('coach')::text $$,
  'allow_follows off removes the row - a strip whose only button is Follow does not suggest someone who refuses follows');
select tests.clear_auth();
update public.profiles set allow_follows = true where id = tests.uid('coach');

update public.profiles set visible_to_club = false where id = tests.uid('coach');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('coach')::text $$,
  'and a member hidden from the club is not suggested either');
select tests.clear_auth();
update public.profiles set visible_to_club = true where id = tests.uid('coach');

-- The 60-day window is real, and on both sides of the pair.
update public.feed_interactions set created_at = now() - interval '90 days' where user_id = tests.uid('m3');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m3')::text $$,
  'a candidate whose only interaction is 90 days old drops out of the window');
select tests.clear_auth();
update public.feed_interactions set created_at = now() - interval '1 day' where user_id = tests.uid('m3');
update public.feed_interactions set created_at = now() - interval '90 days' where user_id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m3')::text $$,
  'and the caller own stale interaction does not resurrect the pair either');
select tests.clear_auth();
update public.feed_interactions set created_at = now() - interval '2 days' where user_id = tests.uid('m1');

-- A finished challenge stops being a signal.
update public.challenges set status = 'completed' where id = 'cccccccc-3333-4000-8000-000000000001';
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  'a challenge that is over is no longer shared active participation');
select tests.clear_auth();
update public.challenges set status = 'active' where id = 'cccccccc-3333-4000-8000-000000000001';

-- The honest empty state: a member with no overlap at all gets nothing.
select tests.set_auth(tests.uid('norec'));
select is_empty(
  $$ select 1 from public.people_suggestions() $$,
  'a member whose only act was opening a post gets an empty strip, not a padded list of strangers');

select * from finish();
rollback;
