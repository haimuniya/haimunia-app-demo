-- Launch-readiness audit, finding 8 (202609060007). post_edit_caption() and
-- post_set_visibility() exist now.
--
-- WHAT WAS BROKEN. contracts.md has documented both since Phase 1, sitting
-- immediately above post_delete's "Shipped in 202608280025" entry, and
-- cloud.js has a complete wired UI for both - the own-post menu's
-- "עריכת כיתוב" and "שינוי נראוּת" items, calling client.rpc() by these exact
-- names with these exact argument names. Neither function had ever been
-- created, so both buttons answered PGRST202 and showed a failure toast.
--
-- ARGUMENT NAMES. post_id / body / visibility, unprefixed, because PostgREST
-- resolves an RPC by argument NAME - these are the names the shipped client
-- sends and the names contracts.md published. Asserted first, below, since a
-- correct function with the wrong parameter names is still an unreachable
-- one.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into public.workout_posts (id, author_id, post_type, visibility, body, status, published_at, occurred_on)
values
  ('40730000-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_TEXT', 'club', 'original caption', 'active', now(), current_date),
  ('40730000-0000-4000-8000-000000000002', tests.uid('m1'), 'POST_PHOTO', 'club', null, 'active', now(), current_date),
  ('40730000-0000-4000-8000-000000000003', tests.uid('m2'), 'POST_TEXT', 'club', 'not yours', 'active', now(), current_date),
  ('40730000-0000-4000-8000-000000000004', tests.uid('m1'), 'POST_TEXT', 'club', 'already gone', 'removed', now(), current_date);
update public.workout_posts set photo_path = tests.uid('m1')::text || '/p.jpg'
where id = '40730000-0000-4000-8000-000000000002';

-- =====================================================================
-- 1. The signatures the client actually calls
-- =====================================================================
select is(
  (select pg_catalog.pg_get_function_identity_arguments(p.oid)
   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_edit_caption'),
  'post_id uuid, body text',
  'post_edit_caption takes (post_id uuid, body text) - the names PostgREST resolves on, which is what makes the already-shipped button reach it');
select is(
  (select pg_catalog.pg_get_function_identity_arguments(p.oid)
   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_set_visibility'),
  'post_id uuid, visibility post_visibility',
  'and post_set_visibility takes (post_id uuid, visibility post_visibility) - the enum, exactly as post_create''s own parameter is, so the enum IS the validation');
select is(
  (select prosecdef from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_edit_caption'), true,
  'both are security definer...');
select is(
  (select has_function_privilege('anon', 'public.post_edit_caption(uuid, text)', 'execute')), false,
  '...and neither is executable by anon');
select is(
  (select has_function_privilege('authenticated', 'public.post_set_visibility(uuid, public.post_visibility)', 'execute')), true,
  'while authenticated can call them, which is the whole point');

-- =====================================================================
-- 2. post_edit_caption: the happy path
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', 'edited caption') $$,
  'the author edits their own caption');
select is(
  (select body from public.workout_posts where id = '40730000-0000-4000-8000-000000000001'),
  'edited caption',
  'and the body really changed');
select ok(
  (select updated_at from public.workout_posts where id = '40730000-0000-4000-8000-000000000001') >= now() - interval '1 minute',
  'and updated_at was stamped by the workout_posts_touch trigger, so an edit is never silent even without an edited_at column');

-- Normalisation is post_create's, character for character. Two functions
-- normalising one column differently is how a post that was legal to create
-- becomes illegal to edit.
select lives_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001',
       '  ' || chr(7) || 'bell stripped, ' || chr(9) || 'tab kept' || chr(10) || 'newline kept  ') $$,
  'control characters are stripped and the value trimmed...');
select is(
  (select body from public.workout_posts where id = '40730000-0000-4000-8000-000000000001'),
  'bell stripped, ' || chr(9) || 'tab kept' || chr(10) || 'newline kept',
  '...with tab and newline deliberately kept, because the card renders the body white-space: pre-wrap - identical to post_create');
select lives_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', repeat('x', 1500)) $$,
  'an over-long caption is accepted...');
select is(
  (select char_length(body) from public.workout_posts where id = '40730000-0000-4000-8000-000000000001'), 1000,
  '...and capped at 1000, the same cap post_create applies');

-- =====================================================================
-- 3. post_edit_caption: every refusal
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', 'hijacked') $$,
  'P0001',
  'not authorized',
  'a member cannot edit somebody else''s post - author only, as contracts.md says, with no moderator branch (a moderator removes, they do not rewrite)');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-00000000ffff', 'x') $$,
  'P0001',
  'post not found',
  'a post that does not exist raises rather than silently doing nothing');
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000004', 'x') $$,
  'P0001',
  'post is no longer editable',
  'and a removed post cannot be edited back into circulation');
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', '   ') $$,
  'P0001',
  'a post needs text or at least one photo',
  'a text-only post cannot be emptied - post_create''s rule, asked the other way round');
select lives_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000002', '') $$,
  'but a post WITH a photo can drop its caption entirely...');
select is(
  (select body from public.workout_posts where id = '40730000-0000-4000-8000-000000000002'), null,
  '...and the empty string is stored as NULL, not as an empty body');

select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', 'x') $$,
  'P0001',
  'not authorized',
  'a member with no verified recovery method is refused - here as a non-author, since the author check comes first');

-- The COMM-153 gate. An edit is a community write, for the reason
-- comment_edit's own comment gives: rewriting an old post into new content is
-- the obvious way around a posting restriction.
select tests.clear_auth();
insert into public.posting_restrictions (user_id, restriction_type, moderator_id, expires_at)
values (tests.uid('m1'), 'temporary', tests.uid('admin'), now() + interval '1 day');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', 'restricted rewrite') $$,
  'P0001',
  'posting_restricted',
  'a restricted member cannot rewrite an old post into new content');

-- =====================================================================
-- 4. post_set_visibility
-- =====================================================================
-- Still restricted from section 3, on purpose: narrowing has to work while
-- restricted, widening must not.
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'only_me') $$,
  'a RESTRICTED member can still narrow their own post to only_me - taking your own content down must never be blocked');
select is(
  (select visibility::text from public.workout_posts where id = '40730000-0000-4000-8000-000000000001'), 'only_me',
  'and it really moved');
select throws_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'club') $$,
  'P0001',
  'posting_restricted',
  'but widening it again while restricted is refused - only_me -> club under a COMM-153 restriction is publishing during the restriction');
select tests.clear_auth();
delete from public.posting_restrictions where user_id = tests.uid('m1');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'club') $$,
  'once the restriction is gone the same widening goes through');
select lives_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'club') $$,
  'setting the value it already has is a no-op and never an error, so a double tap on the selected option is safe');
select lives_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'friends') $$,
  'friends is accepted...');
select lives_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'followers') $$,
  '...and so are the two legacy labels a pre-202608280004 row can still carry, so an author can move an old post without a migration');
select throws_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'everyone') $$,
  '22P02',
  null,
  'while a label that is not in the enum is refused by the TYPE, before the function body runs - which is what "validate against the same enum posts already use" means here');
select throws_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', null) $$,
  'P0001',
  'visibility is required',
  'and null is refused explicitly rather than defaulted to something the caller did not ask for');

select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'only_me') $$,
  'P0001',
  'not authorized',
  'and only the author can re-aim a post');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000004', 'club') $$,
  'P0001',
  'post is no longer editable',
  'a removed post cannot be republished by changing its visibility');

-- =====================================================================
-- 5. The change is real: it moves who can read the row
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'club') $$,
  'back to club...');
select tests.set_auth(tests.uid('m2'));
select is(
  (select count(*)::int from public.workout_posts where id = '40730000-0000-4000-8000-000000000001'), 1,
  '...and another member reads it');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_set_visibility('40730000-0000-4000-8000-000000000001', 'only_me') $$,
  'then only_me...');
select tests.set_auth(tests.uid('m2'));
select is(
  (select count(*)::int from public.workout_posts where id = '40730000-0000-4000-8000-000000000001'), 0,
  '...and they cannot, because posts_feed_select is re-evaluated against the new value - the function does not just write a label, it moves the boundary');

select * from finish();
rollback;
