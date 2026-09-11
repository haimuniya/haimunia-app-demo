-- Live bug hunt round 8 (202609110007): weekly_challenge_leaderboard used to
-- ignore in_leaderboards entirely (an opted-out member still ranked, with
-- the trophy) and carried no deterministic order at all (two tied scores
-- rendered in whatever order Postgres happened to return, which is not
-- guaranteed stable across identical queries without an ORDER BY). This
-- file proves both are fixed: an opted-out member never appears, and a tie
-- resolves the same, predictable way every time.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- One active weekly challenge, comparison_key movement:back-squat:est1rm.
insert into public.weekly_challenges (id, title, comparison_key, starts_on, ends_on, created_by)
values ('c1000000-0000-4000-8000-000000000001', 'Back Squat Week', 'movement:back-squat:est1rm',
        current_date - 2, current_date + 2, tests.uid('coach'));

-- m2 opts out of every leaderboard - still posts the week's HIGHEST score.
update public.profiles set in_leaderboards = false where id = tests.uid('m2');

insert into public.workout_posts (id, author_id, visibility, title, result_text, comparison_key, score_value, score_direction, occurred_on)
values
  ('c1000000-0000-4000-8000-000000000011', tests.uid('m2'), 'club', 'Back squat', '999 kg', 'movement:back-squat:est1rm', 999, 'higher', current_date),
  -- m1 and m3 tie on score AND on occurred_on, so the tie-break must fall
  -- through to display_name ('Member A' < 'Member C').
  ('c1000000-0000-4000-8000-000000000012', tests.uid('m1'), 'club', 'Back squat', '100 kg', 'movement:back-squat:est1rm', 100, 'higher', current_date),
  ('c1000000-0000-4000-8000-000000000013', tests.uid('m3'), 'club', 'Back squat', '100 kg', 'movement:back-squat:est1rm', 100, 'higher', current_date);

select tests.set_auth(tests.uid('m1'));

-- =====================================================================
-- 1. in_leaderboards = false is honored: m2 never appears, despite the
--    highest raw score in the challenge.
-- =====================================================================
select is_empty(
  $$ select post_id from public.weekly_challenge_leaderboard where author_id = tests.uid('m2') $$,
  'an opted-out member (in_leaderboards=false) never appears on the leaderboard, even with the week''s highest score');

select results_eq(
  $$ select author_id from public.weekly_challenge_leaderboard order by (case when score_direction = 'lower' then -score_value else score_value end) desc $$,
  $$ values (tests.uid('m1')), (tests.uid('m3')) $$,
  'the visible board is exactly the two opted-in tied members, in that column order');

-- =====================================================================
-- 2. Deterministic tie-break: two identical (score, occurred_on) rows
--    resolve by display_name every time, not by incidental row order.
-- =====================================================================
select results_eq(
  $$ select author_id from public.weekly_challenge_leaderboard
     order by (case when score_direction = 'lower' then -score_value else score_value end) desc,
              occurred_on asc, display_name asc, post_id asc $$,
  $$ values (tests.uid('m1')), (tests.uid('m3')) $$,
  'Member A ranks before Member C on a genuine tie - display_name is the deterministic tie-break');

-- The view''s OWN order by (no ORDER BY needed on the query) must already
-- reflect this - proves the fix lives in the view, not merely in how this
-- test happens to query it.
select results_eq(
  $$ select author_id from public.weekly_challenge_leaderboard $$,
  $$ values (tests.uid('m1')), (tests.uid('m3')) $$,
  'the view itself returns the tie in deterministic order with no ORDER BY needed on the query');

select * from finish();
rollback;
