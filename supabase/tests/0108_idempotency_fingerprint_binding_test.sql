-- Security hunt, round 10 (202609120011): request_idempotency's claim key
-- was (user, action, key) only, never bound to WHAT the call was about.
-- Reusing a key across two logically different calls (two different
-- posts, in toggle_reaction's case) used to silently return the first
-- call's cached "success" for a second call that never actually ran. This
-- proves a reused key across two different targets is now refused
-- outright, while a genuine replay (same key, same target) still works
-- exactly as 0080_write_idempotency_test already covers.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body, status)
values
  ('b1080000-0000-4000-8000-000000000001', tests.uid('m2'), 'club', 'post A', 'active'),
  ('b1080000-0000-4000-8000-000000000002', tests.uid('m2'), 'club', 'post B', 'active');

select tests.set_auth(tests.uid('m1'));
select is(
  public.toggle_reaction('b1080000-0000-4000-8000-000000000001', 'e1080000-0000-4000-8000-000000000001'),
  true,
  'm1 cheers post A with key K');
select is(
  (select count(*)::int from public.reactions
   where post_id = 'b1080000-0000-4000-8000-000000000001' and user_id = tests.uid('m1')), 1,
  'post A really got the reaction');

-- THE FIX: the exact same key K, reused for a DIFFERENT post, must not
-- silently return true for a call that never actually reacted to post B.
select throws_ok(
  $$ select public.toggle_reaction('b1080000-0000-4000-8000-000000000002', 'e1080000-0000-4000-8000-000000000001') $$,
  'P0001',
  'idempotency key already used for a different request',
  'reusing key K for a different post (B, not A) is refused outright, not silently no-op''d');
select is(
  (select count(*)::int from public.reactions
   where post_id = 'b1080000-0000-4000-8000-000000000002' and user_id = tests.uid('m1')), 0,
  'post B correctly got no reaction - the caller was told this failed, not lied to about success');

-- A genuinely fresh key for post B still works normally.
select is(
  public.toggle_reaction('b1080000-0000-4000-8000-000000000002', 'e1080000-0000-4000-8000-000000000002'),
  true,
  'a real, un-reused key for post B works fine');

select * from finish();
rollback;
