-- Security hunt, round 7 (202609120006): post_create's media-item loop and
-- feed_record_impressions both used to cast caller-supplied jsonb scalars
-- straight into a column cast with no validation, so a wrong-shaped value
-- (an out-of-smallint-range "position", a non-numeric "width", a
-- not-a-uuid "post_id"/"feed_session_id") raised a raw, unhandled
-- Postgres error instead of a clean, predictable outcome. This proves both
-- RPCs now handle malformed shapes the same way they already handle a
-- MISSING field - by falling back / filtering - rather than throwing.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body)
values ('b1030000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'feed target');

-- --- feed_record_impressions: malformed rows are silently skipped, ------
-- --- not a thrown 22P02, and a well-formed row in the SAME batch still --
-- --- lands -----------------------------------------------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.feed_record_impressions(jsonb_build_array(
       jsonb_build_object('post_id', 'not-a-uuid', 'feed_session_id', gen_random_uuid()::text),
       jsonb_build_object('post_id', 'b1030000-0000-4000-8000-000000000001', 'feed_session_id', 'also-not-a-uuid'),
       jsonb_build_object('post_id', 'b1030000-0000-4000-8000-000000000001', 'feed_session_id', '00000000-0000-4000-8000-0000000000b1', 'position', 'abc'),
       jsonb_build_object('post_id', 'b1030000-0000-4000-8000-000000000001', 'feed_session_id', '00000000-0000-4000-8000-0000000000b2', 'position', 5)
     )) $$,
  'a batch mixing malformed and well-formed rows does not raise');
select is(
  (select count(*)::integer from public.feed_impressions
   where user_id = tests.uid('m1')
     and feed_session_id in ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2')),
  2,
  'only the two well-formed rows landed - the not-a-uuid and non-numeric-position rows were dropped, not crashed on');
select is(
  (select "position" from public.feed_impressions
   where user_id = tests.uid('m1') and feed_session_id = '00000000-0000-4000-8000-0000000000b1'),
  0::smallint,
  'a non-numeric position falls back to 0, matching the existing null-position default');

-- --- post_create: an out-of-range position / non-numeric width/height --
-- --- fall back instead of throwing, and the post still lands ----------
select lives_ok(
  $$ select public.post_create('malformed media test', 'club',
       jsonb_build_array(jsonb_build_object(
         'storage_path', tests.uid('m1')::text || '/0.jpg',
         'position', 999999,
         'width', 'abc',
         'height', '200'
       )),
       null) $$,
  'post_create with an out-of-range position and a non-numeric width does not raise');
select is(
  (select p.position from public.post_media p
   join public.workout_posts w on w.id = p.post_id
   where w.body = 'malformed media test' and w.author_id = tests.uid('m1')),
  0::smallint,
  'the out-of-range position falls back to the item''s own index (0), not the raw value');
select is(
  (select p.width from public.post_media p
   join public.workout_posts w on w.id = p.post_id
   where w.body = 'malformed media test' and w.author_id = tests.uid('m1')),
  null::integer,
  'the non-numeric width becomes null, not a thrown cast error');
select is(
  (select p.height from public.post_media p
   join public.workout_posts w on w.id = p.post_id
   where w.body = 'malformed media test' and w.author_id = tests.uid('m1')),
  200,
  'a well-formed height in the same item still lands');

select * from finish();
rollback;
