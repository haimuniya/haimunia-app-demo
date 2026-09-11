-- Security hunt round 2 (202609110002): coach_congratulate() closes a
-- confirmed live duplicate-congratulation bypass. congratulateCelebrateItem()
-- (cloud.js) used to enforce "once per coach per achievement/PR" entirely
-- client-side (an exact-body-text SELECT plus an in-memory map); a direct
-- add_post_comment/post_create call - any member's own devtools console,
-- bypassing the UI - produced real duplicate congratulation comments with no
-- server-side objection. This file proves the replacement: a unique claim on
-- (coach_id, kind, target_user_id, occurred_at) is the actual boundary, not
-- the client-supplied body text or any idempotency key the caller controls.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into public.workout_posts
  (id, author_id, post_type, visibility, status, title, result_text, occurred_on, created_at, published_at, metadata)
values
  ('dddddddd-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_PR', 'club', 'active',
   'Back Squat', '120 ק"ג', current_date, now() - interval '6 hours', now() - interval '6 hours',
   '{"movement": "Back Squat", "new_result": "120 ק\"ג"}'::jsonb);

-- =====================================================================
-- Who may call it at all
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  format($$ select public.coach_congratulate('pr', %L, now(), 'dddddddd-0000-4000-8000-000000000001'::uuid, null, 'כל הכבוד!') $$,
         tests.uid('m1')::text),
  'P0001', 'not authorized',
  'a plain member cannot call coach_congratulate on their own PR');
select tests.clear_auth();

select pg_catalog.set_config('role', 'authenticated', true);
select throws_ok(
  format($$ select public.coach_congratulate('pr', %L, now(), 'dddddddd-0000-4000-8000-000000000001'::uuid, null, 'כל הכבוד!') $$,
         tests.uid('m1')::text),
  'P0001', 'not authorized',
  'an authenticated request with no user is refused before anything is read');
select tests.clear_auth();

-- =====================================================================
-- Input validation
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  format($$ select public.coach_congratulate(null, %L, now(), null, null, 'כל הכבוד!') $$, tests.uid('m1')::text),
  'P0001', 'invalid kind', 'a null kind is refused');
select throws_ok(
  format($$ select public.coach_congratulate('', %L, now(), null, null, 'כל הכבוד!') $$, tests.uid('m1')::text),
  'P0001', 'invalid kind', 'an empty kind is refused');
select throws_ok(
  format($$ select public.coach_congratulate(repeat('x', 41), %L, now(), null, null, 'כל הכבוד!') $$, tests.uid('m1')::text),
  'P0001', 'invalid kind', 'a kind over 40 chars is refused');
select throws_ok(
  $$ select public.coach_congratulate('pr', null, now(), null, null, 'כל הכבוד!') $$,
  'P0001', 'invalid item', 'a null target_user_id is refused');
select throws_ok(
  format($$ select public.coach_congratulate('pr', %L, null, null, null, 'כל הכבוד!') $$, tests.uid('m1')::text),
  'P0001', 'invalid item', 'a null occurred_at is refused');

-- =====================================================================
-- THE FIX: the comment path (p_post_id set) claims once, real duplicate
-- calls - exactly what a direct RPC bypass of the UI would do - claim
-- nothing and write nothing the second time.
-- =====================================================================
\set occurred1 '''2026-09-11 06:00:00+00'''

select results_eq(
  format($$ select (public.coach_congratulate('pr', %L, %L::timestamptz, 'dddddddd-0000-4000-8000-000000000001'::uuid, null, 'כל הכבוד על הסקוואט!') is not null) $$,
         tests.uid('m1')::text, :occurred1),
  $$ values (true) $$,
  'the first congratulation for this real event succeeds and returns a comment id');

select results_eq(
  $$ select count(*)::int from public.post_comments
     where post_id = 'dddddddd-0000-4000-8000-000000000001' and author_id = tests.uid('coach') $$,
  $$ values (1) $$,
  'exactly one congratulation comment exists after the first call');

select results_eq(
  format($$ select public.coach_congratulate('pr', %L, %L::timestamptz, 'dddddddd-0000-4000-8000-000000000001'::uuid, null, 'כל הכבוד על הסקוואט!') $$,
         tests.uid('m1')::text, :occurred1),
  $$ values (null::uuid) $$,
  'a second call for the SAME (coach, kind, member, moment) - the direct-RPC-replay attack this migration closes - claims nothing and returns null');

select results_eq(
  $$ select count(*)::int from public.post_comments
     where post_id = 'dddddddd-0000-4000-8000-000000000001' and author_id = tests.uid('coach') $$,
  $$ values (1) $$,
  'and still exactly one comment - no duplicate was written, unlike the pre-fix behaviour this test regresses against');

-- A different real event (different occurred_at) is a different congratulation
-- and is not blocked - the fix must not become a one-congratulation-ever cap.
select results_eq(
  format($$ select (public.coach_congratulate('pr', %L, now(), 'dddddddd-0000-4000-8000-000000000001'::uuid, null, 'עוד כל הכבוד!') is not null) $$,
         tests.uid('m1')::text),
  $$ values (true) $$,
  'a genuinely different moment (different occurred_at) is a separate congratulation and succeeds');
select results_eq(
  $$ select count(*)::int from public.post_comments
     where post_id = 'dddddddd-0000-4000-8000-000000000001' and author_id = tests.uid('coach') $$,
  $$ values (2) $$,
  'now two real comments exist - one per real event, which is the whole point of keying on occurred_at rather than a client-supplied idempotency key');

-- =====================================================================
-- The standalone-post path (p_post_id null): anniversary/challenge-completion
-- congratulations, same claim-then-write, same dedup.
-- =====================================================================
select results_eq(
  format($$ select (public.coach_congratulate('anniversary', %L, %L::timestamptz, null, null, 'שנה מדהימה איתנו!') is not null) $$,
         tests.uid('m2')::text, :occurred1),
  $$ values (true) $$,
  'the first anniversary congratulation creates a new post and returns its id');
select results_eq(
  $$ select post_type::text from public.workout_posts
     where author_id = tests.uid('coach') and visibility = 'club'
     order by created_at desc limit 1 $$,
  $$ values ('POST_COACH') $$,
  'the created post is tagged POST_COACH, same as the client''s own direct post_create + update did');
select results_eq(
  $$ select count(*)::int from public.workout_posts where author_id = tests.uid('coach') $$,
  $$ values (1) $$,
  'exactly one coach post exists so far');

select results_eq(
  format($$ select public.coach_congratulate('anniversary', %L, %L::timestamptz, null, null, 'שנה מדהימה איתנו!') $$,
         tests.uid('m2')::text, :occurred1),
  $$ values (null::uuid) $$,
  'replaying the identical anniversary congratulation claims nothing and creates no second post');
select results_eq(
  $$ select count(*)::int from public.workout_posts where author_id = tests.uid('coach') $$,
  $$ values (1) $$,
  'still exactly one coach post - the duplicate-post bypass is closed on this path too');

select tests.clear_auth();
select * from finish();
rollback;
