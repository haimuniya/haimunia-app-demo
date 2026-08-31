-- COMM-305: behavioural coverage for 202608310007 (the four
-- ATTENDANCE_RECORDED achievement definitions going live, the AFTER INSERT
-- trigger on attendance_log that earns them, and POST_ATTENDANCE_MILESTONE's
-- first producer).
--
-- The ticket names seven boundaries and every one of them gets a direct
-- assertion here rather than an indirect one:
--
--   1. Crossing 1 / 25 / 100 total distinct attendance days fires the
--      matching achievement EXACTLY ONCE each - asserted by continuing to log
--      days past the threshold and watching the count stay at one, which is
--      the only form of the assertion that can tell "fires on the crossing"
--      apart from "fires whenever it qualifies".
--   2. attendance_weekly_streak, the one repeatable code, fires on a FRESH
--      four-week streak and not on every day of a run already qualifying:
--      silent on a second day inside an already-counted week, silent when the
--      run grows to five weeks, and firing a SECOND time once the streak has
--      been broken and rebuilt.
--   3. ach_claim still refuses all four codes directly, now that they are
--      enabled - the refusal that used to be doubly held (disabled AND
--      ATTENDANCE_RECORDED) is down to one, so this is where it gets proven.
--   4. The two count milestones, and only those, also produce an authorless
--      club-visible POST_ATTENDANCE_MILESTONE carrying the metadata shape
--      cloud.js's renderAttendanceMilestonePostCard has read since Phase 1.
--      A first class is an achievement and nothing else.
--   5. show_attendance off suppresses the POST and not the achievement,
--      asserted on one member across a toggle flip with their attendance rows
--      untouched, and alongside a second member holding the identical days
--      with the toggle on - the same two-sided proof style 0039 and 0040 use.
--   6. A milestone is never double-posted, asserted against the guard that
--      actually answers it: a pre-planted POST_ATTENDANCE_MILESTONE row for a
--      member and a count stops that member's real crossing from posting
--      again, which is only true if "already posted" is read from
--      workout_posts itself rather than from a second piece of state.
--   7. The ACHIEVEMENT_UNLOCKED notification fires for an attendance-sourced
--      unlock. This one is asserted rather than assumed on purpose: the claim
--      the ticket makes is that member_achievements_notify (202608280027)
--      already covers every new row regardless of source and needs no new
--      code, and the honest way to state "no new code was needed" is to show
--      the notification arriving from a path that did not exist when that
--      trigger was written.
--
-- Plus the drift pin the ticket's "the two must never be able to disagree
-- about what a streak is" requires: attendance_week_streak() and
-- consistency_week_streaks() (COMM-306) are compared for every member of the
-- fixture at once, in the shape 0040 established.
--
-- TWO FIXTURE MECHANICS WORTH READING BEFORE THE ASSERTIONS
--
--   * The count-milestone members log days FIFTEEN DAYS APART. Fifteen days
--     always spans two or three ISO week boundaries and never one, so those
--     members never hold two consecutive trained weeks and their weekly-streak
--     badge is guaranteed silent. That is what keeps the count assertions and
--     the streak assertions from measuring each other.
--   * The second fresh streak is produced by DELETING the member's attendance
--     rows and rebuilding four weeks. What separates two runs in production is
--     time passing, and a test cannot move current_date, so it moves the data
--     to the state a break leaves behind: no live streak, then four fresh
--     weeks logged one statement at a time through the real trigger. The
--     member_achievements row from the first run survives the delete, which is
--     what makes a final count of two the proof.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- Monday of the ISO week `p_offset` weeks ago. Every streak date below is
-- expressed through this so the fixture means the same thing whatever weekday
-- the suite runs on - the same reason 0034 and 0040 anchor on current_date - 7.
create or replace function tests.wk(p_offset int) returns date
language sql stable as $fn$
  select (date_trunc('week', current_date::timestamp)::date - (p_offset * 7))::date
$fn$;
grant execute on function tests.wk(int) to anon, authenticated, service_role;

create or replace function tests.ach_count(p_user uuid, p_code text) returns integer
language sql stable as $fn$
  select count(*)::integer
  from public.member_achievements ma
  join public.achievement_definitions d on d.id = ma.achievement_id
  where ma.user_id = p_user and d.code = p_code
$fn$;
grant execute on function tests.ach_count(uuid, text) to anon, authenticated, service_role;

create or replace function tests.milestone_posts(p_user uuid) returns integer
language sql stable as $fn$
  select count(*)::integer from public.workout_posts p
  where p.post_type = 'POST_ATTENDANCE_MILESTONE'
    and (p.metadata ->> 'member_id') = p_user::text
$fn$;
grant execute on function tests.milestone_posts(uuid) to anon, authenticated, service_role;

-- show_attendance defaults to FALSE (202608280003). m3 is deliberately left
-- at the default for boundary 5; everyone else opts in so the post branch is
-- reachable at all.
update public.profiles set show_attendance = true where id <> tests.uid('m3');

-- =====================================================================
-- The definitions are live, and the trigger that earns them exists
-- =====================================================================
select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where trigger_type = 'ATTENDANCE_RECORDED' and enabled $$,
  $$ values (4) $$,
  'all four ATTENDANCE_RECORDED definitions are enabled - seeded disabled by 202608280007 with a comment saying enabling them later would be an UPDATE, which is what COMM-305 is');

select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where trigger_type = 'ATTENDANCE_RECORDED' and repeatable $$,
  $$ values (1) $$,
  'exactly one of them is repeatable, which is the weekly streak - the other three unlock once ever');

select isnt_empty(
  $$ select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.attendance_log'::regclass
       and t.tgname = 'attendance_log_milestones'
       and not t.tgisinternal $$,
  'attendance_log carries the AFTER INSERT trigger COMM-305 hangs the evaluation off, rather than waiting on the still-unbuilt generic ach_evaluate consumer');

select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'attendance_milestones_on_log'),
  true,
  'the trigger function is SECURITY DEFINER - it crosses two no-client-write boundaries on purpose (member_achievements has no insert grant, and an authorless post is unreachable through posts_insert_self)');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.attendance_milestones_on_log()', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.attendance_milestones_on_log()', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.attendance_milestones_on_log()', 'execute'),
  'and it is not callable as an RPC by anyone - reachable as a trigger and nowhere else');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.attendance_week_streak(uuid, date)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.attendance_week_streak(uuid, date)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.attendance_week_streak(uuid, date)', 'execute'),
  'attendance_week_streak is internal plumbing with no grant to any role, the same shape consistency_week_streaks and classmate_day_counts already have');

-- =====================================================================
-- Boundary 4a and the first-class distinction: an achievement, not a post
-- =====================================================================
-- The coach logs exactly one day, with show_attendance ON, so nothing but the
-- rule itself can be suppressing the post.
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('coach'), current_date - 400);

select results_eq(
  $$ select tests.ach_count(tests.uid('coach'), 'attendance_first_class') $$,
  $$ values (1) $$,
  'one logged day unlocks attendance_first_class');

select results_eq(
  $$ select tests.milestone_posts(tests.uid('coach')) $$,
  $$ values (0) $$,
  'and posts nothing: a first class is celebrated once, as an unlock, not duplicated as a feed post - the same way ach_claim writes a member_achievements row for a first PR and never a post');

-- =====================================================================
-- Boundary 1 and 4b: 25 classes, once, with a post
-- =====================================================================
-- m1 logs 25 days fifteen days apart. Day one first, on its own, then the
-- next twenty-three in one statement, then the twenty-fifth on its own.
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m1'), current_date - 360);

select results_eq(
  $$ select tests.ach_count(tests.uid('m1'), 'attendance_first_class'),
            tests.ach_count(tests.uid('m1'), 'attendance_25_classes') $$,
  $$ values (1, 0) $$,
  'm1 holds the first-class badge after one day and nothing else');

insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m1'), current_date - (g * 15) from generate_series(23, 1, -1) g;

select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m1') $$,
  $$ values (24) $$,
  'twenty-four days logged');

select results_eq(
  $$ select tests.ach_count(tests.uid('m1'), 'attendance_first_class'),
            tests.ach_count(tests.uid('m1'), 'attendance_25_classes'),
            tests.milestone_posts(tests.uid('m1')) $$,
  $$ values (1, 0, 0) $$,
  'twenty-four days is not twenty-five: no second first-class row from twenty-three further inserts, and the 25-class badge has not been minted early');

insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m1'), current_date);

select results_eq(
  $$ select tests.ach_count(tests.uid('m1'), 'attendance_25_classes') $$,
  $$ values (1) $$,
  'the twenty-fifth day unlocks attendance_25_classes');

select results_eq(
  $$ select tests.milestone_posts(tests.uid('m1')) $$,
  $$ values (1) $$,
  'and, unlike the first class, produces exactly one POST_ATTENDANCE_MILESTONE');

-- The card contract, read off the row rather than off the migration text.
select results_eq(
  $$ select p.post_type::text, p.visibility::text, p.status::text,
            p.author_id, p.source_type, p.source_id,
            p.metadata ->> 'milestone_label', (p.metadata ->> 'count')::int
     from public.workout_posts p
     where p.post_type = 'POST_ATTENDANCE_MILESTONE'
       and (p.metadata ->> 'member_id') = tests.uid('m1')::text $$,
  format($$ values ('POST_ATTENDANCE_MILESTONE', 'club', 'active',
                    null::uuid, 'member', %L::uuid, '25 classes', 25) $$,
         tests.uid('m1')::text),
  'the post is authorless, club-visible and active, with source_type member - the same shape post_new_member_on_join and challenge_progress_apply''s cooperative milestone already write - and metadata carries the milestone_label and count keys renderAttendanceMilestonePostCard has read since Phase 1');

select is(
  (select p.metadata ->> 'milestone_label' from public.workout_posts p
   where p.post_type = 'POST_ATTENDANCE_MILESTONE'
     and (p.metadata ->> 'member_id') = tests.uid('m1')::text),
  (select d.name from public.achievement_definitions d where d.code = 'attendance_25_classes'),
  'milestone_label is the definition''s own name rather than a string composed in the trigger, so the feed post and the badge on the member''s profile can never announce two different things');

select is(
  (select (p.metadata ->> 'count')::numeric from public.workout_posts p
   where p.post_type = 'POST_ATTENDANCE_MILESTONE'
     and (p.metadata ->> 'member_id') = tests.uid('m1')::text),
  (select d.threshold from public.achievement_definitions d where d.code = 'attendance_25_classes'),
  'and count is the definition''s own threshold - the trigger reads 1, 25, 100 and 4 from the table and keeps no second copy of them');

-- The post really is club-visible to another member, not just labelled 'club'.
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.workout_posts p
     where p.post_type = 'POST_ATTENDANCE_MILESTONE'
       and (p.metadata ->> 'member_id') = tests.uid('m1')::text
       and public.post_visible_to_viewer(p.id) $$,
  'another member can actually see it: visibility club is a real target here, matching POST_NEW_MEMBER and the cooperative POST_CHALLENGE milestone');
select tests.clear_auth();

-- Boundary 1, the half that matters: past the threshold, nothing re-fires.
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m1'), current_date - (360 + g) from generate_series(1, 5) g;

select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m1') $$,
  $$ values (30) $$,
  'm1 keeps training: thirty days now');

select results_eq(
  $$ select tests.ach_count(tests.uid('m1'), 'attendance_first_class'),
            tests.ach_count(tests.uid('m1'), 'attendance_25_classes'),
            tests.milestone_posts(tests.uid('m1')) $$,
  $$ values (1, 1, 1) $$,
  'five more days past the threshold add no second badge and no second post - the milestone fires on the crossing, not on every day that qualifies afterwards');

-- =====================================================================
-- Boundary 7: the ACHIEVEMENT_UNLOCKED notification, from a path that did
-- not exist when member_achievements_notify was written
-- =====================================================================
select isnt_empty(
  $$ select 1 from public.notifications n
     join public.member_achievements ma on ma.id = n.source_id
     join public.achievement_definitions d on d.id = ma.achievement_id
     where n.user_id = tests.uid('m1')
       and n.type = 'achievement_unlocked'
       and n.source_type = 'achievement'
       and d.code = 'attendance_25_classes' $$,
  'the attendance unlock notifies exactly like a claimed one: member_achievements_notify (202608280027) is AFTER INSERT on member_achievements with no WHEN clause and no source filter, so COMM-305 needed no notification code at all - asserted rather than assumed');

select results_eq(
  $$ select count(*)::int from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.member_achievements'::regclass
       and t.tgname = 'member_achievements_notify'
       and t.tgqual is null $$,
  $$ values (1) $$,
  'and that trigger still carries no WHEN clause, which is the structural half of the same claim');

-- =====================================================================
-- Boundary 5: show_attendance suppresses the POST and never the achievement
-- =====================================================================
-- m3 holds exactly the days m1 holds. The only difference between the two
-- members is the toggle.
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m3'), current_date - (g * 15) from generate_series(24, 1, -1) g;
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m3'), current_date);

select results_eq(
  $$ select tests.ach_count(tests.uid('m3'), 'attendance_first_class'),
            tests.ach_count(tests.uid('m3'), 'attendance_25_classes') $$,
  $$ values (1, 1) $$,
  'a member with show_attendance OFF still earns both attendance achievements - achievements carry their own toggle (show_achievements), and this one is not it');

select results_eq(
  $$ select tests.milestone_posts(tests.uid('m3')) $$,
  $$ values (0) $$,
  'and gets no milestone post at all, while m1 - identical days, toggle on - got one: the privacy choice is doing that, not the data');

select results_eq(
  $$ select count(*)::int from public.attendance_log where user_id = tests.uid('m3') $$,
  $$ values (25) $$,
  'their twenty-five attendance rows all exist: the toggle governs what the club is told, never whether the member trained or what their own achievements count');

-- The flip, on rows that do not change.
update public.profiles set show_attendance = true where id = tests.uid('m3');

select results_eq(
  $$ select (select count(*)::int from public.attendance_log where user_id = tests.uid('m3')),
            tests.milestone_posts(tests.uid('m3')) $$,
  $$ values (25, 0) $$,
  'flipping the toggle on, with not one attendance row added or removed, does NOT retro-publish the milestone they crossed while it was off - the gate is read at the moment of the unlock and the moment is not replayed, the same one-shot shape a welcome post has');

-- ... but the next crossing, with the toggle now on, does post. Same member,
-- same mechanism, same kind of crossing, opposite outcome.
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m3'), current_date - (g * 15) from generate_series(98, 25, -1) g;

select results_eq(
  $$ select (select count(*)::int from public.attendance_log where user_id = tests.uid('m3')),
            tests.ach_count(tests.uid('m3'), 'attendance_100_classes') $$,
  $$ values (99, 0) $$,
  'ninety-nine days is not one hundred');

insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m3'), current_date - (99 * 15));

select results_eq(
  $$ select tests.ach_count(tests.uid('m3'), 'attendance_100_classes') $$,
  $$ values (1) $$,
  'the hundredth day unlocks attendance_100_classes');

select results_eq(
  $$ select (p.metadata ->> 'count')::int, p.metadata ->> 'milestone_label'
     from public.workout_posts p
     where p.post_type = 'POST_ATTENDANCE_MILESTONE'
       and (p.metadata ->> 'member_id') = tests.uid('m3')::text $$,
  $$ values (100, '100 classes') $$,
  'and posts it, because the toggle is on now - exactly one post for this member, carrying the hundred and not the twenty-five they crossed in private');

-- =====================================================================
-- Boundary 4c: no first-class post exists anywhere in the club
-- =====================================================================
select is_empty(
  $$ select 1 from public.workout_posts
     where post_type = 'POST_ATTENDANCE_MILESTONE'
       and (metadata ->> 'count')::int = 1 $$,
  'no member anywhere has a milestone post for their first class, said set-wide rather than per member - the rule is threshold-driven, not a two-code allow list');

select isnt_empty(
  $$ select 1 from public.workout_posts where post_type = 'POST_ATTENDANCE_MILESTONE' $$,
  'and there are milestone posts in the club, so the assertion above is not passing because the producer is inert');

-- =====================================================================
-- Boundary 6: a milestone is never double-posted, and the guard that stops
-- it is workout_posts itself
-- =====================================================================
-- norec's 25-class post is planted BEFORE they have trained a single day.
-- Nothing else about them differs from m1, so if their crossing posts anyway,
-- "already posted" is being answered by something other than the posts.
insert into public.workout_posts
  (author_id, post_type, visibility, body, metadata, status, published_at, source_type, source_id)
values (
  null, 'POST_ATTENDANCE_MILESTONE', 'club', 'planted by the test',
  jsonb_build_object('member_id', tests.uid('norec'), 'milestone_label', '25 classes', 'count', 25),
  'active', now(), 'member', tests.uid('norec'));

insert into public.attendance_log (user_id, occurred_on)
select tests.uid('norec'), current_date - (g * 15) from generate_series(24, 1, -1) g;
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('norec'), current_date);

select results_eq(
  $$ select tests.ach_count(tests.uid('norec'), 'attendance_25_classes'),
            tests.milestone_posts(tests.uid('norec')) $$,
  $$ values (1, 1) $$,
  'the real crossing still unlocks the achievement but adds no second post: "already posted this milestone" is read from workout_posts itself, the same way challenge_progress_apply asks it, not from a second piece of tracking state that could drift from what was actually posted');

select is(
  (select body from public.workout_posts
   where post_type = 'POST_ATTENDANCE_MILESTONE'
     and (metadata ->> 'member_id') = tests.uid('norec')::text),
  'planted by the test',
  'and the surviving post is the planted one, so the guard suppressed the insert rather than the two rows being counted as one');

-- =====================================================================
-- Boundary 2: the repeatable weekly streak fires on a FRESH crossing
-- =====================================================================
-- m2 trains one day a week for four consecutive weeks, one statement per
-- week, which is the shape the production writer produces (one single-row
-- insert per synced training-log record).
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(3));
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(2));
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(1));

select results_eq(
  $$ select public.attendance_week_streak(tests.uid('m2')),
            tests.ach_count(tests.uid('m2'), 'attendance_weekly_streak') $$,
  $$ values (3, 0) $$,
  'three consecutive trained weeks: no streak badge yet, and the threshold that decided so came from the definition row');

insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(0));

select results_eq(
  $$ select public.attendance_week_streak(tests.uid('m2')),
            tests.ach_count(tests.uid('m2'), 'attendance_weekly_streak') $$,
  $$ values (4, 1) $$,
  'the fourth consecutive week fires attendance_weekly_streak once');

-- A second day inside a week that already counted.
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(1) + 3);

select results_eq(
  $$ select public.attendance_week_streak(tests.uid('m2')),
            tests.ach_count(tests.uid('m2'), 'attendance_weekly_streak') $$,
  $$ values (4, 1) $$,
  'training a second day inside a week that already counted fires nothing: excluding that day leaves the week standing, so the before and after streaks are the same number and nothing crossed');

-- The run gets longer.
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(4));

select results_eq(
  $$ select public.attendance_week_streak(tests.uid('m2')),
            tests.ach_count(tests.uid('m2'), 'attendance_weekly_streak') $$,
  $$ values (5, 1) $$,
  'a fifth week extends the streak and still fires nothing - this is the case a bare "streak >= 4" test would get wrong, re-minting the badge every single training day for the rest of the run');

-- The second fresh streak. See the header for why the break is expressed as a
-- delete: the test cannot move current_date, so it moves the member to the
-- state a break leaves behind - no live streak - and logs four fresh weeks
-- through the real trigger, one statement at a time.
delete from public.attendance_log where user_id = tests.uid('m2');

select results_eq(
  $$ select public.attendance_week_streak(tests.uid('m2')),
            tests.ach_count(tests.uid('m2'), 'attendance_weekly_streak') $$,
  $$ values (0, 1) $$,
  'after the break the member has no live streak, and the badge they already earned is still theirs - member_achievements is not touched by what happens to attendance_log');

insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(3));
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(2));
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(1));

select results_eq(
  $$ select tests.ach_count(tests.uid('m2'), 'attendance_weekly_streak') $$,
  $$ values (1) $$,
  'three weeks into the rebuild, still one badge');

insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m2'), tests.wk(0));

select results_eq(
  $$ select public.attendance_week_streak(tests.uid('m2')),
            tests.ach_count(tests.uid('m2'), 'attendance_weekly_streak') $$,
  $$ values (4, 2) $$,
  'the fourth week of the SECOND run fires it again - which is what repeatable means here, and the whole reason the crossing is computed rather than the current streak simply being tested against the threshold');

select results_eq(
  $$ select count(*)::int from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
     where ma.user_id = tests.uid('m2') and d.code = 'attendance_first_class' $$,
  $$ values (1) $$,
  'while their non-repeatable first-class badge stayed at one across both runs - member_achievements_once_idx is partial on `not repeatable`, so the two codes are held to different rules by the index itself');

-- =====================================================================
-- The crossing test is two-sided, not an equality: a streak that JUMPS
-- =====================================================================
-- The owner holds four consecutive weeks that ended long ago - stale, so worth
-- a streak of 0 - and then trains three recent weeks and finally the week that
-- joins the two runs together. The streak goes 3 -> 8 in one insert. A
-- `streak = 4` test would miss it entirely.
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('owner'), tests.wk(4)), (tests.uid('owner'), tests.wk(5)),
       (tests.uid('owner'), tests.wk(6)), (tests.uid('owner'), tests.wk(7));

select results_eq(
  $$ select public.attendance_week_streak(tests.uid('owner')),
            tests.ach_count(tests.uid('owner'), 'attendance_weekly_streak') $$,
  $$ values (0, 0) $$,
  'four consecutive weeks that ended a month ago are worth a streak of 0 and no badge: attendance_week_streak carries consistency_week_streaks'' anchor rule, so a streak has to be live, and the two functions cannot disagree about that either');

insert into public.attendance_log (user_id, occurred_on) values (tests.uid('owner'), tests.wk(0));
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('owner'), tests.wk(1));
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('owner'), tests.wk(2));

select results_eq(
  $$ select public.attendance_week_streak(tests.uid('owner')),
            tests.ach_count(tests.uid('owner'), 'attendance_weekly_streak') $$,
  $$ values (3, 0) $$,
  'three fresh weeks, no badge, with the old run still stranded behind a gap');

insert into public.attendance_log (user_id, occurred_on) values (tests.uid('owner'), tests.wk(3));

select results_eq(
  $$ select public.attendance_week_streak(tests.uid('owner')),
            tests.ach_count(tests.uid('owner'), 'attendance_weekly_streak') $$,
  $$ values (8, 1) $$,
  'the joining week takes them from 3 to 8 in one insert and fires exactly once - the crossing is threshold-between-before-and-after, not equality, so a jump is still a single crossing');

-- =====================================================================
-- Boundary 3: ach_claim still refuses all four codes, now that they are live
-- =====================================================================
-- Called as the owner, who holds attendance_weekly_streak - a REPEATABLE code,
-- so if ach_claim accepted it the call would write a second row rather than
-- being absorbed by the once-per-code index. That makes this the strongest
-- form of the assertion available.
select tests.set_auth(tests.uid('owner'));

select is_empty(
  $$ select code from public.ach_claim(array[
       'attendance_first_class', 'attendance_25_classes',
       'attendance_100_classes', 'attendance_weekly_streak']) $$,
  'ach_claim accepts none of the four attendance codes even now that all four are enabled - it refuses on trigger_type (202608280020, untouched by COMM-305), which is what makes attendance the one category in this schema that is purely server-derived and never client-trusted');

select tests.clear_auth();
select results_eq(
  $$ select tests.ach_count(tests.uid('owner'), 'attendance_weekly_streak'),
            tests.ach_count(tests.uid('owner'), 'attendance_first_class') $$,
  $$ values (1, 1) $$,
  'and wrote nothing: the repeatable code did not gain a second row from the claim, and the non-repeatable one is still the single row the trigger minted');

select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select code from public.ach_claim(array['attendance_25_classes']) $$,
  'a single-code claim of a milestone the caller has genuinely reached is refused just the same - qualifying is not the question, the trigger_type is');
select tests.clear_auth();

-- =====================================================================
-- The drift pin: one definition of a streak, computed twice
-- =====================================================================
-- consistency_week_streaks() (COMM-306) is set-wide and has no row for a
-- member with no attendance days, which every caller reads as 0. Compared
-- against attendance_week_streak() for every member of the fixture at once,
-- in the shape 0040 uses for the same question.
select is_empty(
  $$ select p.id from public.profiles p
     where public.attendance_week_streak(p.id) is distinct from
           coalesce((select s.streak from public.consistency_week_streaks() s where s.user_id = p.id), 0) $$,
  'every member''s streak is the same number whether COMM-305''s per-member function or COMM-306''s set-wide one computes it - one rule, two callers, and neither can be edited without the other failing here');

select isnt_empty(
  $$ select 1 from public.consistency_week_streaks() where streak > 0 $$,
  'and the set it agreed on is not all zeros, so the pin above cannot pass vacuously');

-- =====================================================================
-- What COMM-305 deliberately does NOT build
-- =====================================================================
select is_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'ach_evaluate' $$,
  'ach_evaluate, the generic service-role event-bus consumer contracts.md has named since Phase 0, is still not built - COMM-305 follows the direct table-trigger precedent challenge_progress_apply set instead, and explicitly does not build it');

select isnt_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'ach_claim'
       and p.prosrc like '%<> ''ATTENDANCE_RECORDED''%' $$,
  'and ach_claim''s refusal is still the same line of the same function, textually untouched by this ticket');

select * from finish();
rollback;
