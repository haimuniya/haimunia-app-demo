-- COMM-020: real two-user RLS enforcement for 202608280006 (feed telemetry).
-- Boundaries: feed_impressions and feed_interactions are strictly own-row
-- read and insert. No client (admin included) reads another member's
-- stream. No UPDATE path on feed_impressions, so opened and engaged cannot
-- be rewritten. feed_record_impressions caps a batch at 50 and de-dupes a
-- repeated batch.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- a post to point impressions at
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body)
values ('b0060000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'feed target');

-- --- own-row insert and read ------------------------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.feed_impressions (user_id, post_id, "position", feed_session_id)
     values (tests.uid('m1'), 'b0060000-0000-4000-8000-000000000001', 0, gen_random_uuid()) $$,
  'a member inserts an impression for their own user_id');
select throws_ok(
  $$ insert into public.feed_impressions (user_id, post_id, "position", feed_session_id)
     values (tests.uid('m2'), 'b0060000-0000-4000-8000-000000000001', 0, gen_random_uuid()) $$,
  '42501',
  null,
  'a member cannot insert an impression under another user_id');

select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.feed_impressions where user_id = tests.uid('m1') $$,
  'a member cannot read another member impression stream');
select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select 1 from public.feed_impressions where user_id = tests.uid('m1') $$,
  'an admin cannot read another member impression stream either');

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.feed_impressions $$,
  $$ values (1) $$,
  'a member reads their own impression rows');

-- --- no UPDATE path -------------------------------------------
select throws_ok(
  $$ update public.feed_impressions set opened = true where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'feed_impressions has no update grant, so opened cannot be rewritten');

-- --- feed_interactions is own-row too ------------------------
select lives_ok(
  $$ insert into public.feed_interactions (user_id, post_id, kind)
     values (tests.uid('m1'), 'b0060000-0000-4000-8000-000000000001', 'open') $$,
  'a member inserts their own interaction row');
select throws_ok(
  $$ insert into public.feed_interactions (user_id, post_id, kind)
     values (tests.uid('m2'), 'b0060000-0000-4000-8000-000000000001', 'open') $$,
  '42501',
  null,
  'a member cannot insert an interaction under another user_id');
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.feed_interactions where user_id = tests.uid('m1') $$,
  'a member cannot read another member interaction stream');

-- --- feed_record_impressions batch limits -------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.feed_record_impressions(
       (select jsonb_agg(jsonb_build_object(
          'post_id', 'b0060000-0000-4000-8000-000000000001',
          'feed_session_id', gen_random_uuid()))
        from generate_series(1, 20)) ) $$,
  'a batch of 20 impressions in one call succeeds');
select throws_ok(
  $$ select public.feed_record_impressions(
       (select jsonb_agg(jsonb_build_object(
          'post_id', 'b0060000-0000-4000-8000-000000000001',
          'feed_session_id', gen_random_uuid()))
        from generate_series(1, 51)) ) $$,
  'P0001',
  'at most 50 impressions per call',
  'a batch of 51 raises');

-- de-dupe: the same (session, post) written twice counts once
select tests.clear_auth();
delete from public.feed_impressions where user_id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));
select public.feed_record_impressions(
  jsonb_build_array(jsonb_build_object(
    'post_id', 'b0060000-0000-4000-8000-000000000001',
    'feed_session_id', '00000000-0000-4000-8000-0000000000aa')));
select public.feed_record_impressions(
  jsonb_build_array(jsonb_build_object(
    'post_id', 'b0060000-0000-4000-8000-000000000001',
    'feed_session_id', '00000000-0000-4000-8000-0000000000aa')));
select results_eq(
  $$ select count(*)::int from public.feed_impressions
     where feed_session_id = '00000000-0000-4000-8000-0000000000aa' $$,
  $$ values (1) $$,
  'a repeated batch does not double-count');

select * from finish();
rollback;
