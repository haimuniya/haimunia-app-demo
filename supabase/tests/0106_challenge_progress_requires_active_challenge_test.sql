-- Security hunt, round 10 (202609120009): neither challenge_progress_
-- insert_self nor chal_record_progress ever checked the parent
-- challenge's own status - only the participant's. Archiving a challenge
-- (a plain client-side UPDATE, not a dedicated RPC) never froze its
-- progress log: a coach entry or a self-insert kept landing, kept
-- flipping participants to completed, and kept auto-posting real
-- milestone cards for cooperative challenges that had already been
-- closed out.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.challenges (id, title, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
     values ('c1060000-0000-4000-8000-000000000001', 'To be archived', 'cooperative', 'reps', 100,
             now(), now() + interval '7 days', 'active', tests.uid('coach')) $$,
  'seed an active cooperative challenge');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('c1060000-0000-4000-8000-000000000001', tests.uid('m1')) $$,
  'm1 joins while it is still active');
select tests.set_auth(tests.uid('coach'));

-- The exact repro: archive, THEN try to log progress.
select lives_ok(
  $$ update public.challenges set status = 'archived' where id = 'c1060000-0000-4000-8000-000000000001' $$,
  'the challenge is archived');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c1060000-0000-4000-8000-000000000001', tests.uid('m1'), 50) $$,
  '42501',
  null,
  'a self-insert into an archived challenge is refused, even by an active participant');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.chal_record_progress('c1060000-0000-4000-8000-000000000001', tests.uid('m1'), 50, null) $$,
  'P0001',
  'challenge is not active',
  'chal_record_progress refuses to log progress against an archived challenge');

select is_empty(
  $$ select 1 from public.challenge_progress where challenge_id = 'c1060000-0000-4000-8000-000000000001' $$,
  'no progress row landed against the archived challenge');
select is_empty(
  $$ select 1 from public.workout_posts
     where post_type = 'POST_CHALLENGE'
       and metadata ->> 'challenge_id' = 'c1060000-0000-4000-8000-000000000001' $$,
  'no fake milestone celebration was posted for the archived challenge');

-- The legitimate case is untouched: an active challenge still accepts
-- progress exactly as before.
select lives_ok(
  $$ insert into public.challenges (id, title, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
     values ('c1060000-0000-4000-8000-000000000002', 'Still active', 'individual_target', 'reps', 100,
             now(), now() + interval '7 days', 'active', tests.uid('coach')) $$,
  'seed a second, still-active challenge');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('c1060000-0000-4000-8000-000000000002', tests.uid('m1')) $$,
  'm1 joins the active one');
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c1060000-0000-4000-8000-000000000002', tests.uid('m1'), 10) $$,
  'progress into a genuinely active challenge still works');

select * from finish();
rollback;
