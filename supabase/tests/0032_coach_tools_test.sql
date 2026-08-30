-- COMM-223 / COMM-224 / COMM-225: behavioural coverage for
-- 202608290013 (coach_celebrate_feed, profiles.assigned_coach_id +
-- coach_assign_coach, member_contact_log).
--
-- Behaviour, coach_celebrate_feed: real rows of all three kinds through the
-- real function, for a real coach - not an admin. The distinction matters:
-- can_view_profile_field() short-circuits true for is_admin(), so an
-- admin-run privacy test would pass no matter what the toggles said and
-- would prove nothing. tests.uid('coach') is rank-20 staff and no more,
-- which is exactly the caller COMM-223 is about.
--
-- What is asserted: the three kinds union and sort by recency; p_days is a
-- real window and its 1..30 clamp holds at both ends; a PR vanishes the
-- moment its author turns show_prs off, a completion the moment the member
-- leaves in_leaderboards, an anniversary the moment the member hides from
-- the club; a non-staff caller and an unauthenticated caller are both
-- refused by the database rather than by a hidden nav item.
--
-- And the one that keeps two features honest: the anniversary window agrees
-- with ach_claim(). The same member, on the same day, both appears in
-- Celebrate and can claim anniversary_year_1 - the feed is ach_claim's
-- "reached it" test plus a window bound, so a coach is never congratulating
-- someone for a badge the server would refuse to grant, and never missing
-- one it just granted.
--
-- Behaviour, assigned_coach_id: staff-writable really means staff, and only
-- through coach_assign_coach(). The two ways a client could try to write it
-- directly are both covered, and both are silent no-ops rather than errors,
-- which is what makes writing them down here worthwhile - a silent no-op is
-- invisible until someone asserts on it.
--
-- Behaviour, member_contact_log: staff read every row, write only in their
-- own name, and a plain member reads nothing - not even about themselves.
-- The deliberate contrast with coach_engagement_flags is asserted directly:
-- a staff member may log contact with themselves here, which that table's
-- `user_id <> auth.uid()` forbids by design.
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

-- m1 opts into PR visibility. m2 does not: show_prs defaults off, and that
-- default is the whole point of assertion #3 below.
update public.profiles set show_prs = true where id = tests.uid('m1');

insert into public.workout_posts
  (id, author_id, post_type, visibility, status, title, result_text, occurred_on, created_at, published_at, metadata)
values
  ('bbbbbbbb-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_PR', 'club', 'active',
   'Back Squat', '120 ק"ג', current_date, now() - interval '6 hours', now() - interval '6 hours',
   '{"movement": "Back Squat", "new_result": "120 ק\"ג"}'::jsonb),
  -- Same shape, same week, different author: only show_prs separates them.
  ('bbbbbbbb-0000-4000-8000-000000000002', tests.uid('m2'), 'POST_PR', 'club', 'active',
   'Deadlift', '150 ק"ג', current_date, now() - interval '6 hours', now() - interval '6 hours',
   '{"movement": "Deadlift", "new_result": "150 ק\"ג"}'::jsonb),
  -- Twenty days old: outside the 7-day default, inside a 30-day window.
  ('bbbbbbbb-0000-4000-8000-000000000003', tests.uid('m1'), 'POST_PR', 'club', 'active',
   'Snatch', '70 ק"ג', current_date - 20, now() - interval '20 days', now() - interval '20 days',
   '{"movement": "Snatch", "new_result": "70 ק\"ג"}'::jsonb);

insert into public.challenges
  (id, title, description, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
values
  ('cccccccc-1111-4000-8000-000000000001', 'חודש הסקוואט', '', 'individual_target', 'reps', 500,
   now() - interval '40 days', now() + interval '1 day', 'active', tests.uid('coach'));

insert into public.challenge_participants
  (challenge_id, user_id, status, progress_value, completed_at)
values
  ('cccccccc-1111-4000-8000-000000000001', tests.uid('m1'), 'completed', 500, now() - interval '2 days'),
  -- Forty days old: outside every legal window, so m3 never shows a
  -- completion no matter what p_days says.
  ('cccccccc-1111-4000-8000-000000000001', tests.uid('m3'), 'completed', 500, now() - interval '40 days');

-- Anniversaries. redeemed_at is the only tenure source (there is no birth
-- date column to celebrate instead), and the crossing is redeemed_at + 365
-- days, so these two are 3 days and 20 days past their first year.
update public.invite_redemptions set redeemed_at = now() - interval '368 days' where user_id = tests.uid('m2');
update public.invite_redemptions set redeemed_at = now() - interval '385 days' where user_id = tests.uid('m3');

-- =====================================================================
-- coach_celebrate_feed: who may call it at all
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.coach_celebrate_feed() $$,
  'P0001',
  'not authorized',
  'a plain member is refused by the function itself, not by a hidden dashboard');

select tests.clear_auth();
select pg_catalog.set_config('role', 'authenticated', true);
select throws_ok(
  $$ select * from public.coach_celebrate_feed() $$,
  'P0001',
  'not authorized',
  'an authenticated request with no user is refused before anything is read');
select tests.clear_auth();

-- =====================================================================
-- coach_celebrate_feed: the three kinds, unioned and sorted
-- =====================================================================
select tests.set_auth(tests.uid('coach'));

select results_eq(
  $$ select item ->> 'kind' from public.coach_celebrate_feed() as t(item) $$,
  $$ values ('pr'), ('challenge_completion'), ('anniversary') $$,
  'one call returns all three kinds, newest first: PR 6h, completion 2d, anniversary 3d');

select results_eq(
  $$ select item ->> 'kind', item ->> 'user_id' from public.coach_celebrate_feed() as t(item) order by 1, 2 $$,
  format($$ values ('anniversary', %L), ('challenge_completion', %L), ('pr', %L) $$,
         tests.uid('m2')::text, tests.uid('m1')::text, tests.uid('m1')::text),
  'and exactly those rows: m2 PR excluded by show_prs, m3 has nothing inside the window');

select results_eq(
  $$ select item -> 'detail' ->> 'movement', item -> 'detail' ->> 'result'
     from public.coach_celebrate_feed() as t(item) where item ->> 'kind' = 'pr' $$,
  $$ values ('Back Squat', '120 ק"ג') $$,
  'the PR row carries the movement and result the client renders, read from metadata');

select results_eq(
  $$ select (item ->> 'post_id' is not null), item ->> 'handle'
     from public.coach_celebrate_feed() as t(item) where item ->> 'kind' = 'pr' $$,
  $$ values (true, 'member_a') $$,
  'a PR row carries its source post id - COMM-225 branches on exactly this to pick add_post_comment');

select results_eq(
  $$ select bool_or(item ->> 'post_id' is null)
     from public.coach_celebrate_feed() as t(item) where item ->> 'kind' <> 'pr' $$,
  $$ values (true) $$,
  'an anniversary or completion has no source post, so Congratulate falls to post_create');

select results_eq(
  $$ select item -> 'detail' ->> 'years', item -> 'detail' ->> 'code'
     from public.coach_celebrate_feed() as t(item) where item ->> 'kind' = 'anniversary' $$,
  $$ values ('1', 'anniversary_year_1') $$,
  'years is a plain integer, not the numeric threshold divided out to twenty decimals');

select results_eq(
  $$ select item -> 'detail' ->> 'title'
     from public.coach_celebrate_feed() as t(item) where item ->> 'kind' = 'challenge_completion' $$,
  $$ values ('חודש הסקוואט') $$,
  'a completion names the challenge it completed');

-- =====================================================================
-- p_days is a real window, and the clamp is real at both ends
-- =====================================================================
select results_eq(
  $$ select count(*)::int from public.coach_celebrate_feed(30) $$,
  $$ values (5) $$,
  'a 30-day window also picks up the 20-day-old PR and m3 first anniversary');

select results_eq(
  $$ select count(*)::int from public.coach_celebrate_feed(1) $$,
  $$ values (1) $$,
  'a 1-day window sees only the PR from six hours ago');

select results_eq(
  $$ select count(*)::int from public.coach_celebrate_feed(0) $$,
  $$ values (1) $$,
  'p_days 0 clamps up to 1 rather than returning an empty dashboard');

select results_eq(
  $$ select count(*)::int from public.coach_celebrate_feed(999) $$,
  $$ values (5) $$,
  'p_days 999 clamps down to 30 - the 40-day-old completion stays out');

select results_eq(
  $$ select count(*)::int from public.coach_celebrate_feed(null) $$,
  $$ values (3) $$,
  'a null p_days falls back to the 7-day default');

-- =====================================================================
-- Celebrate never bypasses the member's own toggle
-- =====================================================================
select tests.clear_auth();
update public.profiles set show_prs = false where id = tests.uid('m1');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.coach_celebrate_feed(30) as t(item) where item ->> 'kind' = 'pr' $$,
  'show_prs off removes every PR of that member from Celebrate, both the recent and the old one');

select tests.clear_auth();
update public.profiles set show_prs = true where id = tests.uid('m1');
update public.profiles set in_leaderboards = false where id = tests.uid('m1');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.coach_celebrate_feed() as t(item) where item ->> 'kind' = 'challenge_completion' $$,
  'in_leaderboards off removes the completion: opting out of the board is not opting in to an announcement');
select isnt_empty(
  $$ select 1 from public.coach_celebrate_feed() as t(item) where item ->> 'kind' = 'pr' $$,
  'and it removes only the completion - the PR toggle is a separate answer to a separate question');

select tests.clear_auth();
update public.profiles set in_leaderboards = true where id = tests.uid('m1');
update public.profiles set visible_to_club = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.coach_celebrate_feed() as t(item) where item ->> 'kind' = 'anniversary' $$,
  'a member hidden from the club is hidden from Celebrate too');

select tests.clear_auth();
update public.profiles set visible_to_club = true where id = tests.uid('m2');

-- A block edge in either direction ends it as well, through the same
-- helper - no separate block rule was invented for this feed.
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('coach'));
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.coach_celebrate_feed() as t(item) where item ->> 'user_id' = tests.uid('m2')::text $$,
  'a member who blocked the coach does not appear in that coach Celebrate list');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m2') and blocked_id = tests.uid('coach');

-- A deleted profile drops out, so Celebrate never renders a name that no
-- longer exists.
update public.profiles set deleted_at = now() where id = tests.uid('m2');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.coach_celebrate_feed() as t(item) where item ->> 'user_id' = tests.uid('m2')::text $$,
  'a deleted member leaves the feed');
select tests.clear_auth();
update public.profiles set deleted_at = null where id = tests.uid('m2');

-- =====================================================================
-- The anniversary window agrees with ach_claim's own tenure arithmetic
-- =====================================================================
-- m2 crossed one year three days ago: in the 7-day feed, and claimable.
select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select item ->> 'user_id' from public.coach_celebrate_feed() as t(item)
     where item ->> 'kind' = 'anniversary' $$,
  format($$ values (%L) $$, tests.uid('m2')::text),
  'm2 first anniversary is in the feed');

select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select code from public.ach_claim(array['anniversary_year_1']) $$,
  $$ values ('anniversary_year_1') $$,
  'and ach_claim grants that same badge on that same day - one tenure rule, not two');

select is_empty(
  $$ select code from public.ach_claim(array['anniversary_year_2']) $$,
  'while the two-year badge is refused, from the same redeemed_at');

-- m1 redeemed today: not in any legal window, and not claimable either.
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select code from public.ach_claim(array['anniversary_year_1']) $$,
  'a member who joined today claims nothing');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.coach_celebrate_feed(30) as t(item)
     where item ->> 'kind' = 'anniversary' and item ->> 'user_id' = tests.uid('m1')::text $$,
  'and has no anniversary to celebrate');

-- m3 crossed 20 days ago: past ach_claim's "reached it" line, outside the
-- default window and inside a 30-day one. That gap is the only difference
-- between the two tests, which is what makes them the same arithmetic.
select is_empty(
  $$ select 1 from public.coach_celebrate_feed(7) as t(item)
     where item ->> 'kind' = 'anniversary' and item ->> 'user_id' = tests.uid('m3')::text $$,
  'm3 anniversary was 20 days ago, so a 7-day Celebrate does not repeat it');
select isnt_empty(
  $$ select 1 from public.coach_celebrate_feed(30) as t(item)
     where item ->> 'kind' = 'anniversary' and item ->> 'user_id' = tests.uid('m3')::text $$,
  'a 30-day window reaches back to it');
select tests.set_auth(tests.uid('m3'));
select results_eq(
  $$ select code from public.ach_claim(array['anniversary_year_1']) $$,
  $$ values ('anniversary_year_1') $$,
  'and ach_claim still grants it - the feed adds a window, it does not change the tenure test');

-- =====================================================================
-- profiles.assigned_coach_id
-- =====================================================================
select tests.clear_auth();
select has_column('public', 'profiles', 'assigned_coach_id', 'the column exists');
select col_is_null('public', 'profiles', 'assigned_coach_id', 'and is nullable - assigning a coach is optional');

select tests.set_auth(tests.uid('coach'));
select results_eq(
  format($$ select public.coach_assign_coach(%L, %L) $$, tests.uid('m1')::text, tests.uid('coach')::text),
  format($$ values (%L::uuid) $$, tests.uid('coach')::text),
  'a coach assigns themselves to a new member and gets back the value written');
select results_eq(
  $$ select assigned_coach_id from public.profiles where id = tests.uid('m1') $$,
  format($$ values (%L::uuid) $$, tests.uid('coach')::text),
  'and the column really holds it');

-- The two direct-write paths a client might reach for. Neither errors;
-- both change nothing, which is precisely why they are asserted.
select lives_ok(
  format($$ update public.profiles set assigned_coach_id = %L where id = %L $$,
         tests.uid('admin')::text, tests.uid('m2')::text),
  'a direct staff UPDATE of another member profile raises nothing');
select is_empty(
  $$ select 1 from public.profiles where id = tests.uid('m2') and assigned_coach_id is not null $$,
  'but matches zero rows - profiles_update_self is own-row only, which is why coach_assign_coach exists');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  format($$ update public.profiles set assigned_coach_id = %L where id = %L $$,
         tests.uid('m2')::text, tests.uid('m1')::text),
  'a member updating their own row raises nothing');
select results_eq(
  $$ select assigned_coach_id from public.profiles where id = tests.uid('m1') $$,
  format($$ values (%L::uuid) $$, tests.uid('coach')::text),
  'and the value is pinned by protect_is_admin - a field a member can set about themselves is not a coach assignment');

select throws_ok(
  format($$ select public.coach_assign_coach(%L, %L) $$, tests.uid('m2')::text, tests.uid('coach')::text),
  'P0001',
  'not authorized',
  'a plain member cannot call coach_assign_coach at all');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  format($$ select public.coach_assign_coach(%L, %L) $$, tests.uid('m1')::text, tests.uid('m2')::text),
  'P0001',
  'assigned coach must be staff',
  'the assigned coach must actually be staff, or every dashboard reading the field lies');
select throws_ok(
  $$ select public.coach_assign_coach('aaaaaaaa-0000-4000-8000-0000000000ff', null) $$,
  'P0001',
  'member not found',
  'assigning a coach to nobody is an error, not a silent success');
select throws_ok(
  $$ select public.coach_assign_coach(null, null) $$,
  'P0001',
  'member required',
  'and neither is a null member');

select results_eq(
  format($$ select public.coach_assign_coach(%L) $$, tests.uid('m1')::text),
  $$ values (null::uuid) $$,
  'the default second argument clears the assignment - unassign needs no second function');
select results_eq(
  $$ select assigned_coach_id from public.profiles where id = tests.uid('m1') $$,
  $$ values (null::uuid) $$,
  'and the column is really null again');

-- ON DELETE SET NULL: a coach leaving does not take their members rows.
select results_eq(
  format($$ select public.coach_assign_coach(%L, %L) $$, tests.uid('m1')::text, tests.uid('admin')::text),
  format($$ values (%L::uuid) $$, tests.uid('admin')::text),
  'an admin is staff too, so they can be assigned');
select tests.clear_auth();
delete from public.profiles where id = tests.uid('admin');
select results_eq(
  $$ select assigned_coach_id from public.profiles where id = tests.uid('m1') $$,
  $$ values (null::uuid) $$,
  'deleting that staff profile nulls the assignment instead of cascading the member away');
select isnt_empty(
  $$ select 1 from public.profiles where id = tests.uid('m1') $$,
  'and the member is still there');

-- =====================================================================
-- member_contact_log
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  format($$ insert into public.member_contact_log (user_id, note) values (%L, 'התקשרתי, מצוין') $$,
         tests.uid('m1')::text),
  'staff logs contact with a member without naming themselves');
select results_eq(
  $$ select contacted_by, note from public.member_contact_log where user_id = tests.uid('m1') $$,
  format($$ values (%L::uuid, 'התקשרתי, מצוין') $$, tests.uid('coach')::text),
  'contacted_by defaults to the caller, so the client inserts only user_id and note');
select results_eq(
  $$ select (contacted_at is not null) from public.member_contact_log where user_id = tests.uid('m1') $$,
  $$ values (true) $$,
  'and contacted_at stamps itself');

-- The deliberate difference from coach_engagement_flags.
select lives_ok(
  format($$ insert into public.member_contact_log (user_id, note) values (%L, 'הערה לעצמי') $$,
         tests.uid('coach')::text),
  'a staff row about themselves is allowed here - being welcomed is not a decline flag');

select throws_ok(
  format($$ insert into public.member_contact_log (user_id, contacted_by, note) values (%L, %L, 'לא אני') $$,
         tests.uid('m1')::text, tests.uid('owner')::text),
  '42501',
  null,
  'but staff cannot log contact in another coach name');

-- A member sees nothing, including their own row.
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.member_contact_log $$,
  'a plain member reads no contact log at all, not even the row about themselves');
select throws_ok(
  format($$ insert into public.member_contact_log (user_id, note) values (%L, 'שלום') $$, tests.uid('m2')::text),
  '42501',
  null,
  'and cannot write one');
select lives_ok(
  $$ delete from public.member_contact_log where user_id = tests.uid('m1') $$,
  'a member delete raises nothing');

select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select count(*)::int from public.member_contact_log where user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'because it matched nothing - the row the coach wrote is still there');

-- Another staff member reads it, but does not get to rewrite it.
select tests.set_auth(tests.uid('owner'));
select results_eq(
  $$ select count(*)::int from public.member_contact_log $$,
  $$ values (2) $$,
  'every staff member reads every row - that is what makes this coordination');
select lives_ok(
  $$ update public.member_contact_log set note = 'שוכתב' where user_id = tests.uid('m1') $$,
  'a second coach rewriting the first note raises nothing');
select results_eq(
  $$ select note from public.member_contact_log where user_id = tests.uid('m1') $$,
  $$ values ('התקשרתי, מצוין') $$,
  'and changes nothing: an entry belongs to whoever made it');

-- Own rows are the author's to correct or withdraw.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.member_contact_log set note = 'עודכן' where user_id = tests.uid('m1') $$,
  'the author corrects their own note');
select results_eq(
  $$ select note from public.member_contact_log where user_id = tests.uid('m1') $$,
  $$ values ('עודכן') $$,
  'and that one lands');
select lives_ok(
  $$ delete from public.member_contact_log where user_id = tests.uid('coach') $$,
  'and withdraws their own row');
select results_eq(
  $$ select count(*)::int from public.member_contact_log $$,
  $$ values (1) $$,
  'leaving exactly the other one');

select tests.clear_auth();
select pg_catalog.set_config('role', 'anon', true);
select throws_ok(
  $$ select 1 from public.member_contact_log $$,
  '42501',
  null,
  'anon has no grant on the table at all');
select tests.clear_auth();

-- =====================================================================
-- COMM-226: coach_engagement_flags is untouched by this migration
-- =====================================================================
select is_empty(
  $$ select 1 from public.coach_engagement_flags $$,
  'the Engage table still ships empty in Phase 2');
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  format($$ insert into public.coach_engagement_flags (user_id, level) values (%L, 'mild') $$,
         tests.uid('coach')::text),
  '42501',
  null,
  'and still refuses a staff row about themselves - the rule this migration deliberately did not copy');
select tests.clear_auth();

select * from finish();
rollback;
