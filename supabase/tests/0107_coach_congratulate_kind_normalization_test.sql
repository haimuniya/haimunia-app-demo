-- Security hunt, round 10 (202609120010): coach_congratulate()'s claim is
-- unique on (coach_id, kind, target_user_id, occurred_at), but kind was
-- never normalized - 'pr', 'PR' and 'pr ' collided with nothing and
-- produced three real duplicate congratulations for the identical event.
-- This proves the normalization closes that and the allowlist refuses
-- anything outside the three kinds cloud.js actually sends.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into public.workout_posts
  (id, author_id, post_type, visibility, status, title, result_text, occurred_on, created_at, published_at, metadata)
values
  ('dddddddd-0000-4000-8000-000000000002', tests.uid('m1'), 'POST_PR', 'club', 'active',
   'Deadlift', '150 ק"ג', current_date, now() - interval '3 hours', now() - interval '3 hours',
   '{"movement": "Deadlift", "new_result": "150 ק\"ג"}'::jsonb);

select tests.set_auth(tests.uid('coach'));

select isnt_empty(
  format($$ select public.coach_congratulate('pr', %L, '2026-09-12 06:00:00+00'::timestamptz, 'dddddddd-0000-4000-8000-000000000002'::uuid, null, 'כל הכבוד!') $$,
         tests.uid('m1')::text),
  'the first congratulation for this real event succeeds');

select results_eq(
  format($$ select public.coach_congratulate('PR', %L, '2026-09-12 06:00:00+00'::timestamptz, 'dddddddd-0000-4000-8000-000000000002'::uuid, null, 'כל הכבוד!') $$,
         tests.uid('m1')::text),
  $$ values (null::uuid) $$,
  'an upper-case spelling of the same kind/event returns null - already claimed, nothing written');

select results_eq(
  format($$ select public.coach_congratulate('pr ', %L, '2026-09-12 06:00:00+00'::timestamptz, 'dddddddd-0000-4000-8000-000000000002'::uuid, null, 'כל הכבוד!') $$,
         tests.uid('m1')::text),
  $$ values (null::uuid) $$,
  'a trailing-space spelling of the same kind/event also returns null');

-- coach_congratulations has no client grant at all (same shape as
-- request_idempotency/rate_limits) - read it as the bootstrap superuser.
select tests.clear_auth();
select is(
  (select count(*)::integer from public.coach_congratulations
   where target_user_id = tests.uid('m1') and occurred_at = '2026-09-12 06:00:00+00'::timestamptz),
  1,
  'exactly one claim row exists for the real event, regardless of how the kind was spelled');
select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::integer from public.post_comments
   where post_id = 'dddddddd-0000-4000-8000-000000000002' and author_id = tests.uid('coach')),
  1,
  'exactly one congratulation comment landed, not three');

select throws_ok(
  format($$ select public.coach_congratulate('spam', %L, now(), null, null, 'x') $$, tests.uid('m1')::text),
  'P0001', 'invalid kind',
  'a kind outside the known three-value vocabulary is refused outright');

select * from finish();
rollback;
