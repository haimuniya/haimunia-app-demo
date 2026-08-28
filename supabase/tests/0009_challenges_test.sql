-- COMM-020: real two-user RLS enforcement for 202608280009 (challenges set).
-- Boundaries: a draft challenge is readable only by its creator or a
-- community.challenge.create holder, and only that permission can create,
-- edit, or delete one. challenge_teams read with the parent, write with the
-- permission. challenge_participants: self-join only, only on an active
-- challenge, only with recovery, and no editing another participant.
-- challenge_progress: append only, own active-participant rows only.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- challenges created by the coach --------------------------
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, status, created_by)
     values ('c9990000-0000-4000-8000-000000000001', 'Active one', 'individual_target', 'reps',
             now(), now() + interval '7 days', 'active', tests.uid('coach')) $$,
  'a community.challenge.create holder creates an active challenge');
insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, status, created_by)
  values ('c9990000-0000-4000-8000-000000000002', 'Draft one', 'team', 'reps',
          now(), now() + interval '7 days', 'draft', tests.uid('coach'));

-- --- draft visibility -------------------------------------
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.challenges where id = 'c9990000-0000-4000-8000-000000000002' $$,
  'a plain member cannot see a draft challenge');
select isnt_empty(
  $$ select 1 from public.challenges where id = 'c9990000-0000-4000-8000-000000000001' $$,
  'a plain member sees an active challenge');
select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select 1 from public.challenges where id = 'c9990000-0000-4000-8000-000000000002' $$,
  'the creator sees their own draft');

-- --- only the permission can create ----------------------
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.challenges (title, challenge_type, metric_type, start_at, end_at, created_by)
     values ('Mine', 'team', 'reps', now(), now() + interval '1 day', tests.uid('m1')) $$,
  '42501',
  null,
  'a plain member cannot create a challenge');

-- --- challenge_teams ------------------------------------
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.challenge_teams (challenge_id, name)
     values ('c9990000-0000-4000-8000-000000000001', 'Reds') $$,
  'a permission holder writes a challenge team');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.challenge_teams (challenge_id, name)
     values ('c9990000-0000-4000-8000-000000000001', 'Blues') $$,
  '42501',
  null,
  'a plain member cannot write a challenge team');
select isnt_empty(
  $$ select 1 from public.challenge_teams where challenge_id = 'c9990000-0000-4000-8000-000000000001' $$,
  'a plain member reads teams of a challenge they can see');

-- --- challenge_participants -----------------------------
select lives_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('c9990000-0000-4000-8000-000000000001', tests.uid('m1')) $$,
  'a member joins an active challenge as themselves');
select throws_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('c9990000-0000-4000-8000-000000000001', tests.uid('m2')) $$,
  '42501',
  null,
  'a member cannot join on another member behalf');

select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('c9990000-0000-4000-8000-000000000001', tests.uid('norec')) $$,
  '42501',
  null,
  'a member with no recovery method cannot join');

select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('c9990000-0000-4000-8000-000000000002', tests.uid('m2')) $$,
  '42501',
  null,
  'a member cannot join a challenge that is not active');
select lives_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('c9990000-0000-4000-8000-000000000001', tests.uid('m2')) $$,
  'member B also joins the active challenge');

select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ with u as (
       update public.challenge_participants set progress_value = 999
       where challenge_id = 'c9990000-0000-4000-8000-000000000001' and user_id = tests.uid('m2')
       returning user_id
     ) select user_id from u $$,
  'a member cannot edit another participant row');

-- --- challenge_progress is append only ------------------
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c9990000-0000-4000-8000-000000000001', tests.uid('m1'), 5) $$,
  'an active participant appends their own progress row');
select throws_ok(
  $$ update public.challenge_progress set delta = 100 where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'no client can update challenge_progress');
select throws_ok(
  $$ delete from public.challenge_progress where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'no client can delete challenge_progress');

select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('c9990000-0000-4000-8000-000000000001', tests.uid('m3'), 1) $$,
  '42501',
  null,
  'a non-participant cannot append a progress row');

select * from finish();
rollback;
