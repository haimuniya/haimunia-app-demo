-- COMM-020: real two-user RLS enforcement for 202608280014 (hidden_posts and
-- saved_posts).
-- Boundaries: strictly own-row on select, insert, and delete for both
-- tables, no UPDATE grant or policy on either. An insert naming another
-- member's user_id fails. An insert for a post the caller cannot see fails
-- on post_visible_to_viewer, so a hide/save row can never be an existence
-- oracle for a post the caller was never allowed to see. A member with no
-- recovery method cannot insert. A repeat save collides on the (user_id,
-- post_id) primary key rather than creating a second row.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- fixture posts, both authored by member A ------------------------
select tests.set_auth(tests.uid('m1'));
insert into public.workout_posts (id, author_id, visibility, body) values
  ('c0140000-0000-4000-8000-000000000001', tests.uid('m1'), 'club',    'club post'),
  ('c0140000-0000-4000-8000-000000000002', tests.uid('m1'), 'only_me', 'private post');

-- =====================================================================
-- hidden_posts
-- =====================================================================

-- --- self insert, visible post -----------------------------------
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ insert into public.hidden_posts (user_id, post_id)
     values (tests.uid('m2'), 'c0140000-0000-4000-8000-000000000001') $$,
  'member B hides a club post they can see');

-- --- insert on a post the caller cannot see fails ------------------
select throws_ok(
  $$ insert into public.hidden_posts (user_id, post_id)
     values (tests.uid('m2'), 'c0140000-0000-4000-8000-000000000002') $$,
  '42501',
  null,
  'hiding an only_me post the caller cannot see fails on post_visible_to_viewer');

-- --- insert naming another member fails -----------------------------
select throws_ok(
  $$ insert into public.hidden_posts (user_id, post_id)
     values (tests.uid('m3'), 'c0140000-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'a member cannot insert a hidden_posts row for someone else');

-- --- recovery gate ---------------------------------------------------
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ insert into public.hidden_posts (user_id, post_id)
     values (tests.uid('norec'), 'c0140000-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'a member with no recovery method cannot insert a hidden_posts row');

-- --- own-row read: the hide is invisible to the post author --------
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.hidden_posts where post_id = 'c0140000-0000-4000-8000-000000000001' $$,
  'the post author cannot see who hid their post');

-- --- own-row read: a third member cannot see it either --------------
select tests.set_auth(tests.uid('m3'));
select is_empty(
  $$ select 1 from public.hidden_posts where user_id = tests.uid('m2') $$,
  'a third member cannot read member B''s hides');

-- --- own-row read: member B reads their own hide --------------------
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.hidden_posts where user_id = tests.uid('m2')
     and post_id = 'c0140000-0000-4000-8000-000000000001' $$,
  'member B reads their own hide');

-- --- no UPDATE grant or policy --------------------------------------
select throws_ok(
  $$ update public.hidden_posts set post_id = 'c0140000-0000-4000-8000-000000000001'
     where user_id = tests.uid('m2') $$,
  '42501',
  null,
  'no client can update a hidden_posts row');

-- --- delete: own row only -------------------------------------------
select tests.set_auth(tests.uid('m3'));
select is_empty(
  $$ with d as (
       delete from public.hidden_posts
       where user_id = tests.uid('m2') and post_id = 'c0140000-0000-4000-8000-000000000001'
       returning post_id
     ) select post_id from d $$,
  'a third member''s delete matches no row of member B''s hide');
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.hidden_posts where user_id = tests.uid('m2') $$,
  'the hide row is still there after the other member''s no-op delete attempt');
select lives_ok(
  $$ delete from public.hidden_posts
     where user_id = tests.uid('m2') and post_id = 'c0140000-0000-4000-8000-000000000001' $$,
  'member B un-hides their own hide');
select is_empty(
  $$ select 1 from public.hidden_posts where user_id = tests.uid('m2') $$,
  'the hide row is gone after the owner''s delete');

-- =====================================================================
-- saved_posts - same four assertions, plus the PK collision
-- =====================================================================

select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ insert into public.saved_posts (user_id, post_id)
     values (tests.uid('m2'), 'c0140000-0000-4000-8000-000000000001') $$,
  'member B saves a club post they can see');

select throws_ok(
  $$ insert into public.saved_posts (user_id, post_id)
     values (tests.uid('m2'), 'c0140000-0000-4000-8000-000000000002') $$,
  '42501',
  null,
  'saving an only_me post the caller cannot see fails on post_visible_to_viewer');

select throws_ok(
  $$ insert into public.saved_posts (user_id, post_id)
     values (tests.uid('m3'), 'c0140000-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'a member cannot insert a saved_posts row for someone else');

select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ insert into public.saved_posts (user_id, post_id)
     values (tests.uid('norec'), 'c0140000-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'a member with no recovery method cannot insert a saved_posts row');

select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.saved_posts where post_id = 'c0140000-0000-4000-8000-000000000001' $$,
  'the post author cannot see who saved their post');

select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ update public.saved_posts set post_id = 'c0140000-0000-4000-8000-000000000001'
     where user_id = tests.uid('m2') $$,
  '42501',
  null,
  'no client can update a saved_posts row');

-- --- a repeat save collides on the primary key, not a second row ----
select throws_ok(
  $$ insert into public.saved_posts (user_id, post_id)
     values (tests.uid('m2'), 'c0140000-0000-4000-8000-000000000001') $$,
  '23505',
  null,
  'a repeat save collides on the (user_id, post_id) primary key');
select results_eq(
  $$ select count(*)::int from public.saved_posts where user_id = tests.uid('m2') $$,
  $$ values (1) $$,
  'the repeat save attempt left exactly one row behind');

select lives_ok(
  $$ delete from public.saved_posts
     where user_id = tests.uid('m2') and post_id = 'c0140000-0000-4000-8000-000000000001' $$,
  'member B unsaves their own save');

select * from finish();
rollback;
