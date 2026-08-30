-- COMM-020 run B: real enforcement for 202608280024 (reports target and
-- status columns).
-- Boundaries: target_type is post or comment, anything else fails the
-- CHECK; target_id is NOT NULL; every pre-existing row (the two seeded here
-- before the constraint tightens) has target_type = 'post' and target_id =
-- post_id; post_id is nullable now; the unique key is (reporter_id,
-- target_type, target_id), the old (reporter_id, post_id) key is gone;
-- review_note defaults '' and is capped at 500 chars; action_taken is a
-- valid report_status label and resolved is untouched. Reports still has no
-- direct INSERT grant for a client - report()/submit_report() are the only
-- writers, unchanged by this migration.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body) values
  ('c0240000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'reportable post');
insert into public.post_comments (id, post_id, author_id, body) values
  ('c0240000-0000-4000-8000-000000000011', 'c0240000-0000-4000-8000-000000000001', tests.uid('m1'), 'reportable comment');

-- =====================================================================
-- target_type CHECK
-- =====================================================================
select throws_ok(
  $$ insert into public.reports (reporter_id, target_type, target_id, reason)
     values (tests.uid('m2'), 'event', 'c0240000-0000-4000-8000-000000000001', 'spam') $$,
  '23514',
  null,
  'an unknown target_type fails the CHECK');

-- =====================================================================
-- target_id NOT NULL
-- =====================================================================
select throws_ok(
  $$ insert into public.reports (reporter_id, target_type, target_id, reason)
     values (tests.uid('m2'), 'post', null, 'spam') $$,
  '23502',
  null,
  'a null target_id is refused');

-- =====================================================================
-- still no direct INSERT grant for a client - report()/submit_report()
-- are the only writers
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ insert into public.reports (reporter_id, target_type, target_id, reason)
     values (tests.uid('m2'), 'post', 'c0240000-0000-4000-8000-000000000001', 'spam') $$,
  '42501',
  null,
  'a direct .insert() on reports still fails for an authenticated member');

-- =====================================================================
-- widened reason CHECK: unsafe_advice is now valid
-- =====================================================================
select tests.clear_auth();
select lives_ok(
  $$ insert into public.reports (reporter_id, target_type, target_id, reason)
     values (tests.uid('m2'), 'post', 'c0240000-0000-4000-8000-000000000001', 'unsafe_advice') $$,
  'the widened reason CHECK accepts unsafe_advice');
delete from public.reports where reporter_id = tests.uid('m2');

-- =====================================================================
-- pre-existing (pre-202608280024) rows: target_type = 'post' and
-- target_id = post_id, backfilled by the migration
-- =====================================================================
insert into public.reports (reporter_id, target_type, target_id, post_id, reason)
values (tests.uid('m3'), 'post', 'c0240000-0000-4000-8000-000000000001', 'c0240000-0000-4000-8000-000000000001', 'spam');
select results_eq(
  $$ select target_type, target_id, post_id from public.reports
     where reporter_id = tests.uid('m3') and target_id = 'c0240000-0000-4000-8000-000000000001' $$,
  $$ values ('post'::text, 'c0240000-0000-4000-8000-000000000001'::uuid, 'c0240000-0000-4000-8000-000000000001'::uuid) $$,
  'a post-target row carries target_type post and target_id = post_id');

-- =====================================================================
-- post_id is nullable now: a comment-target report leaves it null
-- =====================================================================
insert into public.reports (reporter_id, target_type, target_id, reason)
values (tests.uid('m2'), 'comment', 'c0240000-0000-4000-8000-000000000011', 'harassment');
select results_eq(
  $$ select post_id from public.reports
     where reporter_id = tests.uid('m2') and target_type = 'comment'
       and target_id = 'c0240000-0000-4000-8000-000000000011' $$,
  $$ values (null::uuid) $$,
  'a comment-target row leaves post_id null');

-- =====================================================================
-- unique key: (reporter_id, target_type, target_id) is what fires now.
-- The prior report on this exact target_type/target_id pair (m3, post,
-- <post id>) above is what this collides with; report() itself (tested in
-- 0025) is the dedup-by-update path, this is the raw constraint underneath
-- it.
-- =====================================================================
select throws_ok(
  $$ insert into public.reports (reporter_id, target_type, target_id, reason)
     values (tests.uid('m3'), 'post', 'c0240000-0000-4000-8000-000000000001', 'harassment') $$,
  '23505',
  null,
  'a duplicate (reporter_id, target_type, target_id) collides on the new unique key');

-- =====================================================================
-- review_note: defaults '', capped at 500, separate from details
-- =====================================================================
select results_eq(
  $$ select review_note from public.reports
     where reporter_id = tests.uid('m3') and target_id = 'c0240000-0000-4000-8000-000000000001' $$,
  $$ values (''::text) $$,
  'review_note defaults to an empty string');
select throws_ok(
  $$ update public.reports set review_note = repeat('x', 501)
     where reporter_id = tests.uid('m3') and target_id = 'c0240000-0000-4000-8000-000000000001' $$,
  '23514',
  null,
  'a review_note over 500 characters fails the CHECK');
select lives_ok(
  $$ update public.reports set review_note = repeat('x', 500)
     where reporter_id = tests.uid('m3') and target_id = 'c0240000-0000-4000-8000-000000000001' $$,
  'a review_note at exactly 500 characters is accepted');

-- =====================================================================
-- report_status: action_taken is a valid label, resolved is untouched
-- =====================================================================
select lives_ok(
  $$ update public.reports set status = 'action_taken'
     where reporter_id = tests.uid('m3') and target_id = 'c0240000-0000-4000-8000-000000000001' $$,
  'action_taken is a valid report_status label');
select lives_ok(
  $$ update public.reports set status = 'resolved'
     where reporter_id = tests.uid('m2') and target_type = 'comment' $$,
  'the pre-existing resolved label still works, untouched by the widening');

select * from finish();
rollback;
