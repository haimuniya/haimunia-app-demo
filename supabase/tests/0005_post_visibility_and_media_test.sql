-- COMM-020: real two-user RLS enforcement for 202608280005 (post visibility
-- rules and post_media).
-- Boundaries: the viewer matrix over club / friends / only_me / hidden, per
-- viewer role (author, mutual follow, one-way follower, stranger, blocked,
-- real admin). post_media: position bounded 0..3, (post_id, position)
-- unique, storage path must start with the author uid, read follows the
-- parent post, insert only by the author and only while not removed.
-- add_post_comment and toggle_reaction raise without recovery, but removing
-- a reaction already left still works.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- posts, all authored by member A -------------------------------
select tests.set_auth(tests.uid('m1'));
insert into public.workout_posts (id, author_id, visibility, body) values
  ('b0050000-0000-4000-8000-000000000001', tests.uid('m1'), 'club',    'club post'),
  ('b0050000-0000-4000-8000-000000000002', tests.uid('m1'), 'friends', 'friends post'),
  ('b0050000-0000-4000-8000-000000000003', tests.uid('m1'), 'only_me', 'only me post'),
  ('b0050000-0000-4000-8000-000000000004', tests.uid('m1'), 'club',    'to be hidden'),
  ('b0050000-0000-4000-8000-000000000005', tests.uid('m1'), 'club',    'to be removed');
-- Written as the bootstrap superuser, not as m1. `status` is one of the seven
-- columns workout_posts_guard_moderated_fields() (202609060011, SEC-002/005)
-- refuses to let an AUTHENTICATED session change by hand - that guard is what
-- stops a post's author reversing a moderator's removal. No shipped code path
-- sets status = 'hidden' (grep: neither cloud.js nor any migration does; the
-- moderation path is post_delete() -> 'removed'), so this is purely a fixture
-- for the read matrix below, and the guard deliberately skips non-authenticated
-- sessions exactly so fixtures like this one stay writable.
select tests.clear_auth();
update public.workout_posts set status = 'hidden' where id = 'b0050000-0000-4000-8000-000000000004';
select tests.set_auth(tests.uid('m1'));

-- relationships: m1 <-> m2 mutual, m3 -> m1 one way, coach is a stranger
insert into public.follows (follower_id, followed_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m2'));
insert into public.follows (follower_id, followed_id) values (tests.uid('m2'), tests.uid('m1'));
select tests.set_auth(tests.uid('m3'));
insert into public.follows (follower_id, followed_id) values (tests.uid('m3'), tests.uid('m1'));

-- --- author sees everything of their own -------------------------
select tests.set_auth(tests.uid('m1'));
select isnt_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000003' $$,
  'the author sees their own only_me post');
select isnt_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000004' $$,
  'the author sees their own hidden post');

-- --- mutual follow (friends) ----------------------------------
select tests.set_auth(tests.uid('m2'));
select isnt_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000001' $$,
  'a mutual follow sees a club post');
select isnt_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000002' $$,
  'a mutual follow sees a friends post');
select is_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000003' $$,
  'a mutual follow does not see an only_me post');
select is_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000004' $$,
  'a mutual follow does not see a hidden post');

-- --- one-way follower ---------------------------------------
select tests.set_auth(tests.uid('m3'));
select isnt_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000001' $$,
  'a one-way follower sees a club post');
select is_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000002' $$,
  'a one-way follower does not see a friends post');

-- --- stranger -------------------------------------------
select tests.set_auth(tests.uid('coach'));
select isnt_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000001' $$,
  'a stranger member sees a club post (club-wide scope)');
select is_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000002' $$,
  'a stranger does not see a friends post');
select is_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000003' $$,
  'a stranger does not see an only_me post');

-- --- real admin review read --------------------------------
select tests.set_auth(tests.uid('admin'));
select isnt_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000003' $$,
  'a real admin sees an only_me post for review');
select isnt_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000004' $$,
  'a real admin sees a hidden post for review');

-- --- block edge overrides a club post -----------------------
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m3'));
select tests.set_auth(tests.uid('m3'));
select is_empty($$ select 1 from public.workout_posts where id = 'b0050000-0000-4000-8000-000000000001' $$,
  'a block edge hides an otherwise visible club post');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m1') and blocked_id = tests.uid('m3');

-- --- post_media -----------------------------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.post_media (post_id, storage_path, "position")
     values ('b0050000-0000-4000-8000-000000000001', tests.uid('m1')::text || '/p0.jpg', 0) $$,
  'the author can attach a media row at position 0');
select throws_ok(
  $$ insert into public.post_media (post_id, storage_path, "position")
     values ('b0050000-0000-4000-8000-000000000001', tests.uid('m1')::text || '/p4.jpg', 4) $$,
  '23514',
  null,
  'a fifth slot fails the position 0..3 check');
select throws_ok(
  $$ insert into public.post_media (post_id, storage_path, "position")
     values ('b0050000-0000-4000-8000-000000000001', tests.uid('m1')::text || '/dup.jpg', 0) $$,
  '23505',
  null,
  '(post_id, position) is unique');
select throws_ok(
  $$ insert into public.post_media (post_id, storage_path, "position")
     values ('b0050000-0000-4000-8000-000000000001', tests.uid('m2')::text || '/x.jpg', 1) $$,
  'P0001',
  'media path must belong to the post author',
  'a storage path not prefixed by the author uid is rejected by the trigger');

select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ insert into public.post_media (post_id, storage_path, "position")
     values ('b0050000-0000-4000-8000-000000000001', tests.uid('m2')::text || '/y.jpg', 2) $$,
  '42501',
  null,
  'a non-author cannot attach media to the post');

select tests.set_auth(tests.uid('m1'));
insert into public.post_media (post_id, storage_path, "position")
  values ('b0050000-0000-4000-8000-000000000003', tests.uid('m1')::text || '/priv0.jpg', 0);
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.post_media where post_id = 'b0050000-0000-4000-8000-000000000003' $$,
  'media on an only_me post is invisible to a second member');
select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.post_media where post_id = 'b0050000-0000-4000-8000-000000000003' $$,
  'media on an only_me post is visible to its author');

-- Superuser again, same reason as the status = 'hidden' fixture above:
-- workout_posts_guard_moderated_fields() (202609060011) refuses a hand-written
-- status change from an authenticated session. The sanctioned path is
-- post_delete(); this is a fixture for the media-attachment rule below.
select tests.clear_auth();
update public.workout_posts set status = 'removed' where id = 'b0050000-0000-4000-8000-000000000005';
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.post_media (post_id, storage_path, "position")
     values ('b0050000-0000-4000-8000-000000000005', tests.uid('m1')::text || '/r0.jpg', 0) $$,
  '42501',
  null,
  'media cannot be attached while the post is removed');

-- --- comment and reaction recovery gate ---------------------
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select public.add_post_comment('b0050000-0000-4000-8000-000000000001', 'hi') $$,
  'P0001',
  'recovery method required',
  'add_post_comment raises for a member with no recovery method');
select throws_ok(
  $$ select public.toggle_reaction('b0050000-0000-4000-8000-000000000001') $$,
  'P0001',
  'recovery method required',
  'toggle_reaction raises when a member with no recovery method adds one');

select tests.clear_auth();
insert into public.reactions (post_id, user_id, kind)
  values ('b0050000-0000-4000-8000-000000000001', tests.uid('norec'), 'cheer');
select tests.set_auth(tests.uid('norec'));
select is(
  public.toggle_reaction('b0050000-0000-4000-8000-000000000001'),
  false,
  'the same member can still remove a reaction they already left');

select * from finish();
rollback;
