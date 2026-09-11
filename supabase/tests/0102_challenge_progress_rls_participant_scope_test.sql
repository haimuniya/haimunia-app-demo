-- Security hunt, round 7 (202609120002): challenge_progress_insert_self's
-- WITH CHECK had a self-referential subquery bug (cp.challenge_id compared
-- to the bare column name, which resolved to cp.challenge_id itself, not
-- the row being inserted) that let a member active in ANY challenge write
-- a challenge_progress row into ANY OTHER challenge, joined or not. This
-- file proves the specific gap the old policy missed: 0009_challenges_test
-- already covered "zero participation anywhere is rejected" and stayed
-- green throughout, because that case was never the hole.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, status, created_by)
     values ('c9990000-0000-4000-8000-0000000000a1', 'A - m1 joins this one', 'individual_target', 'reps',
             now(), now() + interval '7 days', 'active', tests.uid('coach')) $$,
  'seed challenge A');
select lives_ok(
  $$ insert into public.challenges (id, title, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
     values ('c9990000-0000-4000-8000-0000000000a2', 'B - m1 never joins this one', 'cooperative', 'reps', 100,
             now(), now() + interval '7 days', 'active', tests.uid('coach')) $$,
  'seed challenge B, cooperative, target 100');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('c9990000-0000-4000-8000-0000000000a1', tests.uid('m1')) $$,
  'm1 joins challenge A only');

-- The exact shape the old tautology let through: active-in-A, not
-- in-B, posting progress into B.
select throws_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c9990000-0000-4000-8000-0000000000a2', tests.uid('m1'), 111111) $$,
  '42501',
  null,
  'a member active in challenge A cannot forge progress into challenge B, which they never joined');

select is_empty(
  $$ select 1 from public.challenge_progress
     where challenge_id = 'c9990000-0000-4000-8000-0000000000a2' and user_id = tests.uid('m1') $$,
  'no forged row landed in challenge B');
select is_empty(
  $$ select 1 from public.workout_posts
     where post_type = 'POST_CHALLENGE'
       and metadata ->> 'challenge_id' = 'c9990000-0000-4000-8000-0000000000a2' $$,
  'no fake milestone celebration was posted for challenge B - the RLS rejection ran before challenge_progress_apply ever fired');

-- The legitimate case: progress into the challenge actually joined.
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c9990000-0000-4000-8000-0000000000a1', tests.uid('m1'), 5) $$,
  'a member still appends their own progress into a challenge they actually joined');

-- A 'completed' participant may still log a compensating delta into the
-- SAME challenge (challenge_progress_apply, 202608290004: "a completed
-- challenge never un-completes", already relied on by
-- 0035_challenge_progress_notifications_test) - the fix widened 'active'
-- to 'active' or 'completed' while closing the cross-challenge hole above,
-- specifically so this still works.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.challenge_participants set status = 'completed'
     where challenge_id = 'c9990000-0000-4000-8000-0000000000a1' and user_id = tests.uid('m1') $$,
  'seed: m1''s participation in A is marked completed');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c9990000-0000-4000-8000-0000000000a1', tests.uid('m1'), -1) $$,
  'a completed participant can still log a compensating correction into the same challenge');

-- A 'withdrawn' participant, by contrast, is correctly still refused.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.challenge_participants set status = 'withdrawn'
     where challenge_id = 'c9990000-0000-4000-8000-0000000000a1' and user_id = tests.uid('m1') $$,
  'seed: m1 withdraws from A');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c9990000-0000-4000-8000-0000000000a1', tests.uid('m1'), 1) $$,
  '42501',
  null,
  'a withdrawn participant cannot log any further progress into that challenge');

select * from finish();
rollback;
