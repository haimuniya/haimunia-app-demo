-- COMM-020: real two-user RLS enforcement for 202608280016 (comment
-- threads).
-- Boundaries: reply depth capped at 2 in both directions (a reply to a
-- reply fails, and giving a parent to a comment that already has replies
-- fails too). A reply whose parent sits on another post fails. A removed
-- or soft-deleted comment is invisible to everyone but its author and a
-- community.comment.moderate holder, and the reply pointing at it keeps its
-- parent_comment_id. A 1000-character body is accepted, a longer one is
-- truncated by the function rather than rejected. There is still no INSERT
-- and no UPDATE grant on post_comments. comment_edit refuses a non-author,
-- always stamps edited_at, and refuses an all-whitespace body. The two-
-- argument add_post_comment still resolves and behaves as before. Rate
-- limiting (20 comments / 10 min, 30 edits / 10 min) actually trips.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- fixture posts and the two comments the depth/visibility tests key
-- off, built directly with fixed ids so the rest of the file can refer to
-- them without depending on a generated uuid. Building them directly (not
-- through add_post_comment) still exercises enforce_comment_depth, which is
-- a trigger and fires regardless of how the row gets written; separate
-- lives_ok calls further down exercise add_post_comment itself end to end.
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body) values
  ('c0160000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'host post'),
  ('c0160000-0000-4000-8000-000000000002', tests.uid('m1'), 'club', 'second post');
insert into public.post_comments (id, post_id, author_id, body) values
  ('c0160000-0000-4000-8000-000000000011', 'c0160000-0000-4000-8000-000000000001', tests.uid('m1'), 'top level');
insert into public.post_comments (id, post_id, author_id, body, parent_comment_id) values
  ('c0160000-0000-4000-8000-000000000012', 'c0160000-0000-4000-8000-000000000001', tests.uid('m2'), 'a reply', 'c0160000-0000-4000-8000-000000000011');

-- =====================================================================
-- add_post_comment itself, end to end, for a top-level comment and a
-- depth-1 reply (using the fixed parent id above).
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.add_post_comment('c0160000-0000-4000-8000-000000000001', 'another top level', null) $$,
  'a top-level comment is created through add_post_comment');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.add_post_comment('c0160000-0000-4000-8000-000000000001', 'a second reply',
       'c0160000-0000-4000-8000-000000000011') $$,
  'a second member replies to the same top-level comment (depth 1) through add_post_comment');

-- =====================================================================
-- reply depth cap
-- =====================================================================
select throws_ok(
  $$ select public.add_post_comment('c0160000-0000-4000-8000-000000000001', 'a reply to a reply',
       'c0160000-0000-4000-8000-000000000012') $$,
  'P0001',
  'reply depth is capped at 2',
  'a reply to a reply is refused by add_post_comment''s own depth check');

-- --- the trigger also closes the upward direction on its own, independent
-- of the function's own check above ---------------------------------
select tests.clear_auth();
select throws_ok(
  $$ insert into public.post_comments (post_id, author_id, body, parent_comment_id)
     values ('c0160000-0000-4000-8000-000000000001', tests.uid('m3'), 'direct depth 3',
             'c0160000-0000-4000-8000-000000000012') $$,
  'P0001',
  'reply depth is capped at 2',
  'the depth trigger itself refuses a direct insert at depth 3');

-- --- a comment that already has replies cannot become a reply --------
-- TOP1 (011) already has REPLY1 (012) as a child. Its new parent has to be
-- top-level itself (parent_comment_id null), so this hits the "already has
-- replies" branch specifically rather than the depth-3 branch above: the
-- top-level "another top level" comment created earlier is exactly that.
select throws_ok(
  $$ update public.post_comments set parent_comment_id = (
       select id from public.post_comments
       where post_id = 'c0160000-0000-4000-8000-000000000001' and body = 'another top level')
     where id = 'c0160000-0000-4000-8000-000000000011' $$,
  'P0001',
  'a comment that already has replies cannot become a reply',
  'giving a parent to a comment that already has replies is refused');

-- --- a reply whose parent sits on another post fails ------------------
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.add_post_comment('c0160000-0000-4000-8000-000000000002', 'cross post reply',
       'c0160000-0000-4000-8000-000000000011') $$,
  'P0001',
  'parent comment is on another post',
  'add_post_comment refuses a parent that sits on a different post');

select tests.clear_auth();
select throws_ok(
  $$ insert into public.post_comments (post_id, author_id, body, parent_comment_id)
     values ('c0160000-0000-4000-8000-000000000002', tests.uid('m2'), 'direct cross post',
             'c0160000-0000-4000-8000-000000000011') $$,
  'P0001',
  'a reply must sit on the same post as its parent',
  'the depth trigger itself refuses a cross-post parent, independent of the function');

-- =====================================================================
-- no INSERT / no UPDATE grant on post_comments
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.post_comments (post_id, author_id, body)
     values ('c0160000-0000-4000-8000-000000000001', tests.uid('m1'), 'direct insert') $$,
  '42501',
  null,
  'a direct .insert() on post_comments fails for everyone');
select throws_ok(
  $$ update public.post_comments set body = 'edited directly'
     where id = 'c0160000-0000-4000-8000-000000000011' $$,
  '42501',
  null,
  'a direct .update() on post_comments fails, even for the author of the row');

-- =====================================================================
-- visibility of a removed/soft-deleted comment
-- =====================================================================
select lives_ok(
  $$ select public.comment_delete('c0160000-0000-4000-8000-000000000011') $$,
  'the author soft-deletes their own top-level comment');

select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.post_comments where id = 'c0160000-0000-4000-8000-000000000011' $$,
  'a stranger member cannot see the removed comment');
select isnt_empty(
  $$ select 1 from public.post_comments where id = 'c0160000-0000-4000-8000-000000000012' $$,
  'the reply pointing at the removed comment is still visible to a stranger');

select tests.clear_auth();
select results_eq(
  $$ select parent_comment_id from public.post_comments where id = 'c0160000-0000-4000-8000-000000000012' $$,
  $$ values ('c0160000-0000-4000-8000-000000000011'::uuid) $$,
  'the reply keeps its parent_comment_id intact so the client can render the placeholder');

select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.post_comments where id = 'c0160000-0000-4000-8000-000000000011' $$,
  'the author still sees their own removed comment');

select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select 1 from public.post_comments where id = 'c0160000-0000-4000-8000-000000000011' $$,
  'a community.comment.moderate holder still sees the removed comment');

-- =====================================================================
-- body length: accepted at 1000, truncated past it, not rejected
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.add_post_comment('c0160000-0000-4000-8000-000000000002', repeat('a', 1000), null) $$,
  'a 1000-character body is accepted');
select lives_ok(
  $$ select public.add_post_comment('c0160000-0000-4000-8000-000000000002', repeat('b', 1001), null) $$,
  'a 1001-character body is not rejected either');
select results_eq(
  $$ select char_length(body) from public.post_comments
     where post_id = 'c0160000-0000-4000-8000-000000000002' and author_id = tests.uid('m2') and body like 'b%' $$,
  $$ values (1000) $$,
  'the over-long body was truncated to 1000 characters by the function, not rejected');

-- =====================================================================
-- comment_edit
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.comment_edit(
       (select id from public.post_comments
        where post_id = 'c0160000-0000-4000-8000-000000000002' and body like 'a%'),
       'not mine') $$,
  'P0001',
  'not authorized',
  'a non-author cannot edit someone else''s comment');

select tests.set_auth(tests.uid('m2'));
select is(
  (select edited_at from public.post_comments
     where post_id = 'c0160000-0000-4000-8000-000000000002' and body like 'a%'),
  null,
  'edited_at starts out null');
select lives_ok(
  $$ select public.comment_edit(
       (select id from public.post_comments
        where post_id = 'c0160000-0000-4000-8000-000000000002' and author_id = tests.uid('m2') and body like 'a%'),
       'edited body') $$,
  'the author edits their own comment');
select isnt_empty(
  $$ select 1 from public.post_comments
     where post_id = 'c0160000-0000-4000-8000-000000000002' and body = 'edited body' and edited_at is not null $$,
  'the edit stamped edited_at');
select throws_ok(
  $$ select public.comment_edit(
       (select id from public.post_comments
        where post_id = 'c0160000-0000-4000-8000-000000000002' and body = 'edited body'),
       '   ') $$,
  'P0001',
  'comment body required',
  'an all-whitespace body is refused');

-- =====================================================================
-- the two-argument add_post_comment still resolves and behaves as before
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.add_post_comment('c0160000-0000-4000-8000-000000000001', 'legacy two-arg call') $$,
  'the two-argument add_post_comment still resolves');
select results_eq(
  $$ select parent_comment_id from public.post_comments
     where post_id = 'c0160000-0000-4000-8000-000000000001' and body = 'legacy two-arg call' $$,
  $$ values (null::uuid) $$,
  'a two-argument call still lands with no parent');

-- =====================================================================
-- rate limiting: 20 comments / 10 min, 30 edits / 10 min. Pre-seeded
-- rather than looped 20/30 times, so the boundary is asserted without
-- paying for 20 or 30 real inserts.
-- =====================================================================
select tests.clear_auth();
insert into public.rate_limits (user_id, action, window_started_at, attempt_count)
values (tests.uid('m1'), 'post_comment', now(), 20)
on conflict (user_id, action) do update set window_started_at = now(), attempt_count = 20;

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.add_post_comment('c0160000-0000-4000-8000-000000000001', 'over the limit', null) $$,
  'P0001',
  'rate_limited',
  'the 21st comment in the window is rate limited');

select tests.clear_auth();
insert into public.rate_limits (user_id, action, window_started_at, attempt_count)
values (tests.uid('m1'), 'comment_edit', now(), 30)
on conflict (user_id, action) do update set window_started_at = now(), attempt_count = 30;

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.comment_edit(
       (select id from public.post_comments
        where post_id = 'c0160000-0000-4000-8000-000000000001' and body = 'another top level'),
       'over the edit limit') $$,
  'P0001',
  'rate_limited',
  'the 31st edit in the window is rate limited, still active, still authored by the caller');

select * from finish();
rollback;
