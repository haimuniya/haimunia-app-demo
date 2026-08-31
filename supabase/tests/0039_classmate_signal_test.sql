-- COMM-302: behavioural coverage for 202608310003 (classmate_day_counts, and
-- feed_page + people_suggestions re-created to use it).
--
-- The ticket names five boundaries and every one of them gets a direct
-- assertion here rather than an indirect one:
--
--   1. A pair that shared training days scores ABOVE a pair that shared none,
--      in feed_page, by exactly the normalised amount - three posts identical
--      in every scored respect except their author's overlap with the viewer,
--      with the gaps between their feed_score values asserted as well as the
--      absolute values. 4 shared days out of the 8-day saturation is exactly
--      half of v_w_class; 1 day is exactly an eighth; 8 and 12 days are both
--      exactly all of it, which is what "capped at 1 before the weight
--      applies" has to mean.
--   2. people_suggestions returns 'classmate' as a reason with the right
--      shared_classmate_days count, and the three pre-existing signals keys
--      are still there under their old names with their old meanings.
--   3. The new priority order - challenge, classmate, interaction, event -
--      holds across four candidates each carrying a different strongest
--      signal, and holds LEXICOGRAPHICALLY: one shared challenge outranks
--      four shared training days, and four shared training days outrank a
--      shared reaction.
--   4. show_attendance off on the candidate zeroes the signal in BOTH
--      functions while their attendance_log rows still exist - asserted by
--      flipping the toggle on an unchanged set of rows and watching the same
--      data go from nothing to a full signal and back. That is the
--      difference between "no data" and "private data", and it is the whole
--      point of the toggle.
--   5. A block edge in EITHER direction removes the pair from both functions
--      and from the helper, whatever the overlap would have been.
--
-- The caller for every substantive assertion is tests.uid('m1'), a plain
-- member. can_view_profile_field() short-circuits true for is_admin(), so a
-- privacy test run as an admin would pass whatever the toggles said and prove
-- nothing - the same reason 0034 gives for the same choice.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures. Bootstrap superuser, so RLS and the "no client write" rule on
-- attendance_log stay out of the way while the world is built. Nothing
-- below asserts anything about who may write that table - 0037 owns that.
-- =====================================================================
select tests.clear_auth();

-- rls_helpers' invite_redemptions rows fire the POST_NEW_MEMBER trigger
-- (202608290014). Those posts are authorless, published at now() and carry
-- gen_random_uuid() ids, so leaving them in would make a pinned feed order
-- non-deterministic for reasons that have nothing to do with this ticket.
-- Same reason 0038 removes them.
delete from public.workout_posts where post_type = 'POST_NEW_MEMBER';

-- ATTENDANCE. Written directly rather than through private_records, because
-- what is under test here is every reader of the table, not the trigger that
-- fills it (0037 owns that end).
--
--   m1 (the viewer/caller): ten recent days, plus one 100 days back.
--   m2:    the same four most recent days -> 4 shared. show_attendance ON.
--   m3:    one of them                    -> 1 shared. show_attendance ON.
--   norec: the same four as m2            -> 4 shared, but show_attendance
--          is OFF (it is the column default), so the signal is 0 and the
--          rows still exist. This is boundary 4's fixture.
--   coach: only the day 100 days back, which m1 also has -> 0 shared,
--          because the window is 60 days and BOTH sides are filtered by it.
--          show_attendance ON, so nothing but the window excludes them.
--   owner, admin: no attendance at all.
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m1'), current_date - g from generate_series(1, 10) g;
insert into public.attendance_log (user_id, occurred_on) values
  (tests.uid('m1'), current_date - 100),
  (tests.uid('coach'), current_date - 100);
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m2'), current_date - g from generate_series(1, 4) g;
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('norec'), current_date - g from generate_series(1, 4) g;
insert into public.attendance_log (user_id, occurred_on) values
  (tests.uid('m3'), current_date - 1);

-- show_attendance defaults to FALSE (202608280003), so this is what an
-- opted-in member looks like. norec is deliberately left at the default.
update public.profiles set show_attendance = true
where id in (tests.uid('m1'), tests.uid('m2'), tests.uid('m3'), tests.uid('coach'), tests.uid('owner'));

-- Three candidate posts, identical in every scored respect except who wrote
-- them: same post_type (POST_TEXT scores zero on the coach, achievement and
-- challenge components and is diversity-neutral, so no reordering pass can
-- touch them), same visibility, same published_at, no reactions, no
-- comments, no mention of the viewer, no follow edges anywhere in this file.
-- Every difference in their final score is therefore the class component and
-- nothing else. All three authors are plain members, so none of them picks
-- up the coach half-component either.
insert into public.workout_posts (id, author_id, post_type, status, visibility, body, published_at, created_at)
values
  ('c3020000-0000-4000-8000-0000000000a1', tests.uid('m2'),    'POST_TEXT', 'active', 'club', 'four shared days',  now() - interval '5 hours', now() - interval '5 hours'),
  ('c3020000-0000-4000-8000-0000000000a2', tests.uid('m3'),    'POST_TEXT', 'active', 'club', 'one shared day',    now() - interval '5 hours', now() - interval '5 hours'),
  ('c3020000-0000-4000-8000-0000000000a3', tests.uid('norec'), 'POST_TEXT', 'active', 'club', 'attendance hidden', now() - interval '5 hours', now() - interval '5 hours');

-- =====================================================================
-- classmate_day_counts is internal, not a second API surface
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'classmate_day_counts'),
  false,
  'classmate_day_counts is SECURITY INVOKER - it borrows the rights of the definer function that calls it and grants none of its own, the same shape relationship_score and consistency_week_streaks already have');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.classmate_day_counts(timestamptz)', 'execute'),
  'authenticated cannot execute classmate_day_counts');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.classmate_day_counts(timestamptz)', 'execute'),
  'anon cannot execute classmate_day_counts');
select ok(
  not pg_catalog.has_function_privilege('public', 'public.classmate_day_counts(timestamptz)', 'execute'),
  'and neither can PUBLIC, so the default grant every new function starts with really was revoked');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.classmate_day_counts() $$,
  '42501',
  null,
  'a real authenticated caller reaching for it directly is refused by the grant - a member must not be able to ask who trains with whom, only to be ranked by it');

-- Everything from here to the feed assertions needs both auth.uid() (for the
-- show_attendance gate, which resolves its viewer from auth.uid() and takes
-- no parameter) and the rights to call an ungranted internal function, which
-- is exactly the context feed_page's definer body runs in. Claims stay m1,
-- the role goes back to the owner. Same pattern as 0038.
select pg_catalog.set_config('role', 'postgres', true);

-- =====================================================================
-- The overlap count itself
-- =====================================================================
select results_eq(
  $$ select user_id, shared_days from public.classmate_day_counts()
     order by shared_days desc, user_id $$,
  format($$ values (%L::uuid, 4), (%L::uuid, 1) $$,
         tests.uid('m2')::text, tests.uid('m3')::text),
  'exactly the two opted-in members who trained on the same days as the caller, counted in days: four and one');

select is_empty(
  $$ select 1 from public.classmate_day_counts() where user_id = auth.uid() $$,
  'a member is not their own classmate, so their own posts pick up no class connection - the same self-exclusion relationship_score keeps');

select is_empty(
  $$ select 1 from public.classmate_day_counts() where user_id = tests.uid('coach') $$,
  'a day both members trained 100 days ago is outside the trailing 60-day window and counts for nothing - a partnership from eight months ago must not outrank someone trained beside last week');

select is_empty(
  $$ select 1 from public.classmate_day_counts() where user_id = tests.uid('owner') $$,
  'and a member with no attendance rows at all is simply absent, which both callers read as 0');

-- =====================================================================
-- show_attendance, boundary 4, at the helper. The rows do not move; only
-- the toggle does.
-- =====================================================================
select is(
  (select count(*)::integer from public.attendance_log where user_id = tests.uid('norec')),
  4,
  'norec has four attendance days on record - they trained, and those rows still count toward their own achievements and their own leaderboard rank');

select is_empty(
  $$ select 1 from public.classmate_day_counts() where user_id = tests.uid('norec') $$,
  'and contributes no classmate signal to anyone, because show_attendance is off - attendance has its own privacy toggle, separate from visible_to_club, and it defaults to off');

select tests.clear_auth();
update public.profiles set show_attendance = true where id = tests.uid('norec');
select tests.set_auth(tests.uid('m1'));
select pg_catalog.set_config('role', 'postgres', true);

select results_eq(
  $$ select shared_days from public.classmate_day_counts() where user_id = tests.uid('norec') $$,
  $$ values (4) $$,
  'flipping only that toggle, with not one attendance row added or removed, turns the same four days into a full signal - so it was the privacy choice doing the hiding, not missing data');

select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('norec');

-- =====================================================================
-- feed_page. Boundary 1: a shared-attendance pair outscores a no-overlap
-- pair, by exactly the normalised amount.
--
--   recency          40 * 0.5^(5/36)                    = 36.328735
--   m2    4 days     36.328735 + 6 * least(1, 4/8)      = 39.328735
--   m3    1 day      36.328735 + 6 * least(1, 1/8)      = 37.078735
--   norec hidden     36.328735 + 6 * 0                  = 36.328735
--
-- now() is fixed for the whole transaction and the posts are published at
-- now() - 5 hours, so the recency term is exact rather than approximate and
-- these numbers are reproducible on any revision by pasting the fixture
-- block above into a psql transaction.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select id, feed_score from public.feed_page(null, 40) $$,
  $$ values ('c3020000-0000-4000-8000-0000000000a1'::uuid, 39.328735::numeric),
            ('c3020000-0000-4000-8000-0000000000a2'::uuid, 37.078735::numeric),
            ('c3020000-0000-4000-8000-0000000000a3'::uuid, 36.328735::numeric) $$,
  'the member the viewer trained beside four times ranks above the one they trained beside once, which ranks above the one whose attendance is private');

-- The same three rows expressed as gaps, which is time-independent: the
-- recency, engagement, personal and repetition terms are equal on all three
-- and cancel exactly, so what is left IS the class component.
select results_eq(
  $$ with f as (select id, feed_score from public.feed_page(null, 40))
     select (select feed_score from f where id = 'c3020000-0000-4000-8000-0000000000a1')
          - (select feed_score from f where id = 'c3020000-0000-4000-8000-0000000000a3') $$,
  $$ values (3.0::numeric) $$,
  'four of the eight saturating days is exactly half of v_w_class (6) - the component is normalised to 0..1 before the weight applies, like every other component');

select results_eq(
  $$ with f as (select id, feed_score from public.feed_page(null, 40))
     select (select feed_score from f where id = 'c3020000-0000-4000-8000-0000000000a2')
          - (select feed_score from f where id = 'c3020000-0000-4000-8000-0000000000a3') $$,
  $$ values (0.75::numeric) $$,
  'and one day is exactly an eighth of it - the normalisation is linear up to the cap, not a step');

-- =====================================================================
-- The cap is real: least(1.0, days / 8) really does stop at 1
-- =====================================================================
select tests.clear_auth();
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m2'), current_date - g from generate_series(5, 8) g;
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select feed_score from public.feed_page(null, 40)
     where id = 'c3020000-0000-4000-8000-0000000000a1' $$,
  $$ values (42.328735::numeric) $$,
  'eight shared days is the whole class component, 6.000000 on top of the recency term');

select tests.clear_auth();
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m2'), current_date - g from generate_series(9, 10) g;
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select feed_score from public.feed_page(null, 40)
     where id = 'c3020000-0000-4000-8000-0000000000a1' $$,
  $$ values (42.328735::numeric) $$,
  'and twelve is still exactly the whole of it - the component saturates rather than growing, so no single term can run away with the ranking');

-- Back to four shared days for everything below.
select tests.clear_auth();
delete from public.attendance_log
where user_id = tests.uid('m2') and occurred_on < current_date - 4;
select tests.set_auth(tests.uid('m1'));
select pg_catalog.set_config('role', 'postgres', true);
select results_eq(
  $$ select shared_days from public.classmate_day_counts() where user_id = tests.uid('m2') $$,
  $$ values (4) $$,
  'the fixture is back to four shared days for the assertions below');

-- =====================================================================
-- feed_page, boundary 4: show_attendance off zeroes the component while the
-- rows still exist. norec's post is already the 36.328735 row above, on
-- exactly the same four days m2 has - so this is the same comparison run
-- with the toggle as the only difference.
-- =====================================================================
select tests.clear_auth();
update public.profiles set show_attendance = true where id = tests.uid('norec');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select feed_score from public.feed_page(null, 40)
     where id = 'c3020000-0000-4000-8000-0000000000a3' $$,
  $$ values (39.328735::numeric) $$,
  'with show_attendance on, the same unchanged four days score norec identically to m2 - which proves the 36.328735 above was the toggle and not the data');

select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('norec');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select feed_score from public.feed_page(null, 40)
     where id = 'c3020000-0000-4000-8000-0000000000a3' $$,
  $$ values (36.328735::numeric) $$,
  'and turning it back off returns them to the bare recency term - a member with attendance private contributes no classmate signal to anyone');

-- =====================================================================
-- Zero shared days is 0, not an error and not an omitted row
-- =====================================================================
select tests.set_auth(tests.uid('owner'));
select results_eq(
  $$ select count(*)::integer, count(distinct feed_score)::integer
     from public.feed_page(null, 40) $$,
  $$ values (3, 1) $$,
  'a viewer who has never logged a session still gets every row, all three scoring the same because the class component is 0 for all of them - no overlap is a zero, never a missing term and never a raise');

-- =====================================================================
-- COMM-232 + COMM-302 people_suggestions.
--
-- Four candidates, one per signal, so the priority order is asserted as an
-- order and not as four separate labels:
--   m3    a live challenge with the caller (and, incidentally, one shared
--         training day - which is the point: challenge still wins)
--   m2    four shared training days and nothing else
--   coach a shared post interaction and nothing else (their only attendance
--         day is outside the window)
--   owner a shared 'going' RSVP and nothing else
--   norec four shared training days, show_attendance off - no other signal,
--         so no card at all
-- =====================================================================
select tests.clear_auth();

insert into public.challenges
  (id, title, description, challenge_type, metric_type, start_at, end_at, status, created_by)
values ('c3020000-3333-4000-8000-000000000001', 'אתגר חי', '', 'individual_target', 'reps',
        now() - interval '5 days', now() + interval '5 days', 'active', tests.uid('admin'));
insert into public.challenge_participants (challenge_id, user_id, status, progress_value)
values
  ('c3020000-3333-4000-8000-000000000001', tests.uid('m1'), 'active', 0),
  ('c3020000-3333-4000-8000-000000000001', tests.uid('m3'), 'active', 0);

-- The interaction signal. feed_interactions is telemetry, so this changes no
-- feed score; 'react' and 'comment' are the only kinds that count as
-- engagement with another member.
insert into public.feed_interactions (user_id, post_id, kind, created_at) values
  (tests.uid('m1'),    'c3020000-0000-4000-8000-0000000000a3', 'react',   now() - interval '2 days'),
  (tests.uid('coach'), 'c3020000-0000-4000-8000-0000000000a3', 'comment', now() - interval '1 day');

insert into public.events (id, title, event_type, start_at, status, created_by)
values ('c3020000-5555-4000-8000-000000000001', 'ערב קהילה', 'social_night',
        now() + interval '7 days', 'published', tests.uid('admin'));
insert into public.event_attendees (event_id, user_id, response, registered_at) values
  ('c3020000-5555-4000-8000-000000000001', tests.uid('m1'),    'going', now() - interval '3 days'),
  ('c3020000-5555-4000-8000-000000000001', tests.uid('owner'), 'going', now() - interval '3 days');

select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select item ->> 'user_id', item ->> 'reason' from public.people_suggestions() as t(item) $$,
  format($$ values (%L, 'challenge'), (%L, 'classmate'), (%L, 'interaction'), (%L, 'event') $$,
         tests.uid('m3')::text, tests.uid('m2')::text,
         tests.uid('coach')::text, tests.uid('owner')::text),
  'the four signals rank in the order COMM-302 states: shared live challenge, then shared training days, then shared post, then shared event');

select results_eq(
  $$ select item -> 'signals' ->> 'shared_classmate_days'
     from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  $$ values ('4') $$,
  'and the classmate row carries the real count of overlapping days, not a boolean');

-- Lexicographic, not a weighted sum. m3 has ONE shared training day and m2
-- has four; m3 still comes first, because a challenge outranks any number of
-- training days and nothing about the weaker signal can overtake it.
select results_eq(
  $$ select item ->> 'user_id' from public.people_suggestions() as t(item) limit 1 $$,
  format($$ values (%L) $$, tests.uid('m3')::text),
  'one shared challenge outranks four shared training days - the ordering is lexicographic by signal strength, exactly as COMM-232 established for the first three');

select results_eq(
  $$ select item -> 'signals' from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m3')::text $$,
  $$ values ('{"shared_events": 0, "shared_challenges": 1, "shared_interactions": 0, "shared_classmate_days": 1}'::jsonb) $$,
  'signals is ADDITIVE: the three keys COMM-232 shipped keep their names and their meanings and shared_classmate_days joins them, so a client reading shared_challenges today needs no change');

select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('norec')::text $$,
  'a member whose only overlap with the caller is attendance they keep private gets no card at all - not a card ranked lower, no card');

-- =====================================================================
-- show_attendance, boundary 4, at people_suggestions. Same rows, toggle
-- flipped, on a candidate whose ONLY signal is attendance.
-- =====================================================================
select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));

select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  'turning show_attendance off on a candidate whose only signal was four shared training days removes them from the strip entirely');

-- Counted as the bootstrap superuser: attendance_log's own select policy is
-- own-row for a member (202608310001), so m1 cannot see m2's rows at all and
-- an authenticated count here would read 0 for the wrong reason.
select tests.clear_auth();
select is(
  (select count(*)::integer from public.attendance_log where user_id = tests.uid('m2')),
  4,
  'while every one of those four attendance rows still exists - the toggle governs what other members may be told, never whether the member trained');

update public.profiles set show_attendance = true where id = tests.uid('m2');

-- =====================================================================
-- COMM-125. A block edge in either direction, in both functions and in the
-- helper. The blocked pair here is the one with the HIGHEST overlap, so
-- nothing can pass on the strength of its signal.
-- =====================================================================
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));

select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  'a member the caller blocked is never suggested, whatever their attendance overlap');
select is_empty(
  $$ select id from public.feed_page(null, 40)
     where id = 'c3020000-0000-4000-8000-0000000000a1' $$,
  'and their post leaves the feed entirely - a block is strictly stronger than the class component, not merely heavier than it');

select pg_catalog.set_config('role', 'postgres', true);
select is_empty(
  $$ select 1 from public.classmate_day_counts() where user_id = tests.uid('m2') $$,
  'the helper itself refuses the pair, so neither caller has to re-implement the block check - can_view_profile_field settles it before any toggle');

select tests.clear_auth();
delete from public.blocks;
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('m1'));

select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  'and so is a member who blocked the caller - the edge counts in either direction');
select is_empty(
  $$ select id from public.feed_page(null, 40)
     where id = 'c3020000-0000-4000-8000-0000000000a1' $$,
  'their post is gone from the feed on the same rule');

select pg_catalog.set_config('role', 'postgres', true);
select is_empty(
  $$ select 1 from public.classmate_day_counts() where user_id = tests.uid('m2') $$,
  'and the helper is symmetric about it too');

select tests.clear_auth();
delete from public.blocks;

-- =====================================================================
-- The two functions cannot answer differently about who trains with whom
-- =====================================================================
-- The same drift pin 0034 uses for consistency_week_streaks() versus
-- community_profile and 0038 uses for feed_page versus relationship_score:
-- people_suggestions' shared_classmate_days and feed_page's class component
-- both come from classmate_day_counts(), and this asserts it rather than
-- trusting the comment that says so.
select isnt_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'feed_page'
       and p.prosrc like '%classmate_day_counts%' $$,
  'feed_page reads the shared helper rather than repeating the overlap query');
select isnt_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'people_suggestions'
       and p.prosrc like '%classmate_day_counts%' $$,
  'and so does people_suggestions - one copy of the window, the overlap count and the show_attendance gate, so the two surfaces cannot drift apart');

select tests.set_auth(tests.uid('m1'));
select pg_catalog.set_config('role', 'postgres', true);
select results_eq(
  $$ select c.shared_days
     from public.classmate_day_counts() c where c.user_id = tests.uid('m2') $$,
  $$ select (item -> 'signals' ->> 'shared_classmate_days')::integer
     from public.people_suggestions() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  'and the number the strip publishes is the number the helper returned, unmodified');

select * from finish();
rollback;
