-- COMM-020 run B: real enforcement for 202608280022 (profile view and
-- decorative media).
-- Boundaries: community_profile(user_id) - a fully private target
-- (visible_to_club off) returns no posts/prs/achievements/counts key at
-- all; a target with show_prs off omits the prs key entirely while show_prs
-- on with no PRs returns an empty array, same for achievements; a block
-- edge in either direction raises; a deleted target raises; an anonymous
-- caller raises. post_media.decorative defaults false, an insert marked
-- decorative with alt text stores a null alt_text (and so does a
-- whitespace-only alt text on a non-decorative row), and updating a row to
-- decorative clears its alt text in the same statement.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- fixture posts, owned by m2, m2 is also the profile-privacy subject
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body, published_at) values
  ('c0220000-0000-4000-8000-000000000001', tests.uid('m2'), 'club', 'm2 club post', now());

-- =====================================================================
-- community_profile: auth gate
-- =====================================================================
select throws_ok(
  $$ select public.community_profile(tests.uid('m2')) $$,
  'P0001',
  'not authorized',
  'community_profile raises for a null caller');

-- =====================================================================
-- a deleted target raises
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.community_profile('00000000-0000-4000-8000-00000000dead') $$,
  'P0001',
  'profile not found',
  'community_profile raises for a target that does not exist');

select tests.clear_auth();
update public.profiles set deleted_at = now() where id = tests.uid('m3');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.community_profile(tests.uid('m3')) $$,
  'P0001',
  'profile not found',
  'community_profile raises for a target whose profile is soft-deleted');
select tests.clear_auth();
update public.profiles set deleted_at = null where id = tests.uid('m3');

-- =====================================================================
-- a block edge in either direction raises, not the bare header
-- =====================================================================
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m3'));

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.community_profile(tests.uid('m3')) $$,
  'P0001',
  'not authorized',
  'the blocker cannot view the blocked member''s profile');
select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.community_profile(tests.uid('m1')) $$,
  'P0001',
  'not authorized',
  'the blocked member cannot view the blocker''s profile either');

select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m1') and blocked_id = tests.uid('m3');

-- =====================================================================
-- fully private target: visible_to_club off. Only the header keys, none
-- of posts/prs/achievements/counts.
-- =====================================================================
update public.profiles set visible_to_club = false where id = tests.uid('m2');

select tests.set_auth(tests.uid('m1'));
select is(
  (public.community_profile(tests.uid('m2')) ->> 'display_name'),
  'Member B',
  'a fully private target still returns display_name');
select ok(
  (public.community_profile(tests.uid('m2')) -> 'role') is not null,
  'a fully private target still returns role');
select ok(
  (public.community_profile(tests.uid('m2')) -> 'member_since') is not null,
  'a fully private target still returns member_since');
select ok(
  not (public.community_profile(tests.uid('m2')) ? 'posts'),
  'a fully private target has no posts key at all');
select ok(
  not (public.community_profile(tests.uid('m2')) ? 'prs'),
  'a fully private target has no prs key at all');
select ok(
  not (public.community_profile(tests.uid('m2')) ? 'achievements'),
  'a fully private target has no achievements key at all');
select ok(
  not (public.community_profile(tests.uid('m2')) ? 'follower_count'),
  'a fully private target has no follower_count key at all');

select tests.clear_auth();
update public.profiles set visible_to_club = true where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));

-- =====================================================================
-- show_prs off omits the prs key; on with none returns []
-- =====================================================================
select tests.clear_auth();
update public.profiles set show_prs = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select ok(
  not (public.community_profile(tests.uid('m2')) ? 'prs'),
  'show_prs off: the prs key is absent entirely, not an empty array');

select tests.clear_auth();
update public.profiles set show_prs = true where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is(
  (public.community_profile(tests.uid('m2')) -> 'prs'),
  '[]'::jsonb,
  'show_prs on with no PRs on file: prs is an empty array, distinguishable from hidden');
select tests.clear_auth();
update public.profiles set show_prs = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));

-- =====================================================================
-- same distinction for achievements
-- =====================================================================
select tests.clear_auth();
update public.profiles set show_achievements = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select ok(
  not (public.community_profile(tests.uid('m2')) ? 'achievements'),
  'show_achievements off: the achievements key is absent entirely');

select tests.clear_auth();
update public.profiles set show_achievements = true where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is(
  (public.community_profile(tests.uid('m2')) -> 'achievements'),
  '[]'::jsonb,
  'show_achievements on with no unlocks on file: achievements is an empty array');

-- =====================================================================
-- an anonymous / signed-out caller raises (same auth gate assertion,
-- exercised again with clear_auth to be explicit about "no session" too)
-- =====================================================================
select tests.clear_auth();
select throws_ok(
  $$ select public.community_profile(tests.uid('m2')) $$,
  'P0001',
  'not authorized',
  'a signed-out caller (no jwt at all) cannot call community_profile');

-- =====================================================================
-- post_media.decorative
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ insert into public.post_media (post_id, storage_path, "position")
     values ('c0220000-0000-4000-8000-000000000001', tests.uid('m2')::text || '/plain.jpg', 0) $$,
  'a plain media row inserts');
select results_eq(
  $$ select decorative from public.post_media
     where post_id = 'c0220000-0000-4000-8000-000000000001' and storage_path like '%plain.jpg' $$,
  $$ values (false) $$,
  'decorative defaults to false');

select lives_ok(
  $$ insert into public.post_media (post_id, storage_path, alt_text, decorative, "position")
     values ('c0220000-0000-4000-8000-000000000001', tests.uid('m2')::text || '/deco.jpg', 'a sunset', true, 1) $$,
  'a decorative row with alt text inserts');
select results_eq(
  $$ select alt_text from public.post_media
     where post_id = 'c0220000-0000-4000-8000-000000000001' and storage_path like '%deco.jpg' $$,
  $$ values (null::text) $$,
  'the normalizer trigger clears alt_text on a decorative insert');

select lives_ok(
  $$ insert into public.post_media (post_id, storage_path, alt_text, decorative, "position")
     values ('c0220000-0000-4000-8000-000000000001', tests.uid('m2')::text || '/blank.jpg', '   ', false, 2) $$,
  'a non-decorative row with whitespace-only alt text inserts');
select results_eq(
  $$ select alt_text from public.post_media
     where post_id = 'c0220000-0000-4000-8000-000000000001' and storage_path like '%blank.jpg' $$,
  $$ values (null::text) $$,
  'whitespace-only alt text is normalized to null even when not decorative');

select lives_ok(
  $$ update public.post_media set decorative = true
     where post_id = 'c0220000-0000-4000-8000-000000000001' and storage_path like '%plain.jpg' $$,
  'updating a row to decorative is allowed');
select results_eq(
  $$ select alt_text from public.post_media
     where post_id = 'c0220000-0000-4000-8000-000000000001' and storage_path like '%plain.jpg' $$,
  $$ values (null::text) $$,
  'flipping decorative to true in an update clears alt_text in the same statement');

select * from finish();
rollback;
