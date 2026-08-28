-- COMM-020: real two-user RLS enforcement for 202608280004 (post_type enum
-- and the new workout_posts columns).
-- Boundaries checked here: the default_post_type trigger derives post_type
-- from the row, the NOT NULL then holds, status defaults to active, the
-- widened source_type check accepts the new labels, and a member with no
-- recovery_verified_at cannot insert a post at all.
-- The full visibility matrix and post_media live in 0005.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- default_post_type derivation -----------------------------------
select tests.set_auth(tests.uid('m1'));

select lives_ok(
  $$ insert into public.workout_posts (id, author_id, source_type, source_record_id, title, result_text, occurred_on)
     values ('b0040000-0000-4000-8000-000000000001', tests.uid('m1'), 'strength_entry', 'r1', 'Back squat', '100kg', current_date) $$,
  'a member can insert a workout-shaped post');
select is(
  (select post_type from public.workout_posts where id = 'b0040000-0000-4000-8000-000000000001'),
  'POST_WORKOUT'::public.post_type,
  'the trigger derived POST_WORKOUT from a strength_entry source');
select is(
  (select status from public.workout_posts where id = 'b0040000-0000-4000-8000-000000000001'),
  'active'::public.post_status,
  'status defaults to active');

select lives_ok(
  $$ insert into public.workout_posts (id, author_id, body, visibility)
     values ('b0040000-0000-4000-8000-000000000002', tests.uid('m1'), 'just a note', 'club') $$,
  'a member can insert a text post with no workout fields');
select is(
  (select post_type from public.workout_posts where id = 'b0040000-0000-4000-8000-000000000002'),
  'POST_TEXT'::public.post_type,
  'the trigger derived POST_TEXT when nothing else fit');

-- --- widened source_type check ------------------------------------
select lives_ok(
  $$ insert into public.workout_posts (id, author_id, source_type, source_id, body)
     values ('b0040000-0000-4000-8000-000000000003', tests.uid('m1'), 'announcement', gen_random_uuid(), 'x') $$,
  'the widened source_type check accepts a new label such as announcement');

-- --- recovery gate on insert ------------------------------------
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ insert into public.workout_posts (author_id, source_type, source_record_id, title, result_text, occurred_on)
     values (tests.uid('norec'), 'strength_entry', 'rn', 'T', 'R', current_date) $$,
  '42501',
  null,
  'a member with no recovery_verified_at cannot insert a post');

select * from finish();
rollback;
