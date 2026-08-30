-- COMM-020 run B: real enforcement for 202608280023 (post_create).
-- Boundaries, checked in the order post_create itself checks them: a null
-- caller raises not authorized; a caller without community.post.create
-- raises not authorized; a member with no recovery method raises recovery
-- method required; a member with an active posting_restrictions row raises
-- posting_restricted, and that check runs before the rate limit so a
-- restricted member burns no rate-limit budget; the 21st call in 10 minutes
-- raises rate_limited; more than 4 media items raises before the empty-
-- body-and-no-media check runs; an empty body with empty media raises; each
-- media item needs a storage_path; a storage_path whose first segment is
-- not the caller's own uid is rejected by enforce_post_media_ownership and
-- the whole call rolls back, post row included; a decorative item stores a
-- null alt_text; post_type is POST_PHOTO only for media with no text, else
-- POST_TEXT; visibility round-trips club, friends, and only_me; the post
-- row and its post_media rows either all land or none do.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. a null caller raises
-- =====================================================================
select tests.clear_auth();
select throws_ok(
  $$ select public.post_create('hi', 'club', null, null) $$,
  'P0001',
  'not authorized',
  'post_create raises for a null caller');

-- =====================================================================
-- 2. a caller without community.post.create raises not authorized, even
-- though they are otherwise a fully verified community member. There is no
-- seeded role that actually lacks the permission, so a throwaway role is
-- created here and m3's existing invite_redemptions row is pointed at it
-- for the one call, then restored.
-- =====================================================================
insert into public.roles (code, label, rank) values ('no_post_perm', 'No post perm', 5)
on conflict (code) do nothing;
update public.invite_redemptions set role = 'no_post_perm' where user_id = tests.uid('m3');

select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.post_create('hi', 'club', null, null) $$,
  'P0001',
  'not authorized',
  'a fully verified member whose role carries no community.post.create raises not authorized');

select tests.clear_auth();
update public.invite_redemptions set role = 'member' where user_id = tests.uid('m3');

-- =====================================================================
-- 3. a member with no recovery method raises recovery method required
-- =====================================================================
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select public.post_create('hi', 'club', null, null) $$,
  'P0001',
  'recovery method required',
  'a member with no recovery method cannot post_create');

-- =====================================================================
-- 4. a restricted member raises posting_restricted, and the rate limit is
-- never consulted: pre-seed m3's rate_limits row at the 20-per-10-minute
-- cap first, so a rate_limited raise here would prove the ordering wrong.
-- =====================================================================
select tests.clear_auth();
insert into public.rate_limits (user_id, action, window_started_at, attempt_count)
values (tests.uid('m3'), 'post_create', now(), 20)
on conflict (user_id, action) do update set window_started_at = now(), attempt_count = 20;

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.mod_restrict_member(tests.uid('m3'), 'temporary', now() + interval '1 day', 'testing', null) $$,
  'an admin restricts m3''s posting ability');

select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.post_create('hi', 'club', null, null) $$,
  'P0001',
  'posting_restricted',
  'a restricted member raises posting_restricted, not rate_limited, even sitting at the rate cap');
select tests.clear_auth();
select results_eq(
  $$ select attempt_count from public.rate_limits where user_id = tests.uid('m3') and action = 'post_create' $$,
  $$ values (20) $$,
  'the restricted member''s rate-limit counter did not move: check_rate_limit was never reached');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.mod_lift_restriction(
       (select id from public.posting_restrictions where user_id = tests.uid('m3') order by created_at desc limit 1),
       'lifted for the rest of the suite') $$,
  'the restriction on m3 is lifted so later assertions in this file are unaffected');

-- =====================================================================
-- 5. rate limiting: the 21st call in 10 minutes is rate limited. Uses m1,
-- who carries no restriction, so this exercises the rate-limit branch on
-- its own rather than riding on the posting_restricted path above.
-- =====================================================================
select tests.clear_auth();
insert into public.rate_limits (user_id, action, window_started_at, attempt_count)
values (tests.uid('m1'), 'post_create', now(), 20)
on conflict (user_id, action) do update set window_started_at = now(), attempt_count = 20;

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.post_create('over the limit', 'club', null, null) $$,
  'P0001',
  'rate_limited',
  'the 21st post_create call in the window is rate limited');
select tests.clear_auth();
delete from public.rate_limits where user_id = tests.uid('m1') and action = 'post_create';

-- =====================================================================
-- 6. more than 4 media items raises, checked before the empty-body test
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.post_create('', 'club',
       jsonb_build_array(
         jsonb_build_object('storage_path', tests.uid('m1')::text || '/0.jpg'),
         jsonb_build_object('storage_path', tests.uid('m1')::text || '/1.jpg'),
         jsonb_build_object('storage_path', tests.uid('m1')::text || '/2.jpg'),
         jsonb_build_object('storage_path', tests.uid('m1')::text || '/3.jpg'),
         jsonb_build_object('storage_path', tests.uid('m1')::text || '/4.jpg')),
       null) $$,
  'P0001',
  'at most 4 photos per post',
  'a 5-item media array is refused, ahead of the empty-body check');

-- =====================================================================
-- 7. an empty body with empty media raises
-- =====================================================================
select throws_ok(
  $$ select public.post_create('   ', 'club', null, null) $$,
  'P0001',
  'a post needs text or at least one photo',
  'a whitespace-only body with no media is refused');
select throws_ok(
  $$ select public.post_create('', 'club', '[]'::jsonb, null) $$,
  'P0001',
  'a post needs text or at least one photo',
  'an empty body with an empty media array is refused');

-- =====================================================================
-- 8. each media item needs a storage_path
-- =====================================================================
select throws_ok(
  $$ select public.post_create('', 'club', jsonb_build_array(jsonb_build_object('alt_text', 'no path')), null) $$,
  'P0001',
  'each media item needs a storage_path',
  'a media item with no storage_path is refused');

-- =====================================================================
-- 9. storage_path ownership: a caller cannot claim someone else's uid
-- prefix, and the whole call rolls back - the post row does not land
-- either. Inside post_create the author is always the caller, so the
-- ownership trigger takes its "self-inflicted anomaly" branch (P0001), not
-- the cross-caller 42501 branch.
-- =====================================================================
select results_eq(
  $$ select count(*)::int from public.workout_posts where author_id = tests.uid('m1') and body = 'someone else''s path' $$,
  $$ values (0) $$,
  'sanity: no such post exists yet');
select throws_ok(
  $$ select public.post_create('someone else''s path', 'club',
       jsonb_build_array(jsonb_build_object('storage_path', tests.uid('m2')::text || '/stolen.jpg')), null) $$,
  'P0001',
  'media path must belong to the post author',
  'a storage_path prefixed with another member''s uid is refused by the ownership trigger');
select results_eq(
  $$ select count(*)::int from public.workout_posts where author_id = tests.uid('m1') and body = 'someone else''s path' $$,
  $$ values (0) $$,
  'the whole call rolled back: the post row itself was not left behind by the failed media insert');

-- =====================================================================
-- 10. decorative clears alt_text (post_media_normalize_alt trigger, fired
-- from inside post_create's own insert)
-- =====================================================================
select lives_ok(
  $$ select public.post_create('a decorative photo post', 'club',
       jsonb_build_array(jsonb_build_object(
         'storage_path', tests.uid('m1')::text || '/deco.jpg',
         'alt_text', 'a sunset', 'decorative', true)),
       null) $$,
  'a post with one decorative media item is created');
select results_eq(
  $$ select alt_text from public.post_media m
     join public.workout_posts p on p.id = m.post_id
     where p.author_id = tests.uid('m1') and p.body = 'a decorative photo post' $$,
  $$ values (null::text) $$,
  'the decorative item''s alt_text was cleared by the normalizer trigger');

-- =====================================================================
-- 11. post_type: POST_PHOTO only for media with no text, else POST_TEXT
-- =====================================================================
select lives_ok(
  $$ select public.post_create('', 'club',
       jsonb_build_array(jsonb_build_object('storage_path', tests.uid('m1')::text || '/photoonly.jpg')), null) $$,
  'a photo-only post (empty body) is created');
select results_eq(
  $$ select post_type::text from public.workout_posts
     where author_id = tests.uid('m1')
       and id = (select post_id from public.post_media where storage_path like '%photoonly.jpg') $$,
  $$ values ('POST_PHOTO') $$,
  'a photo with no text is filed as POST_PHOTO');

select lives_ok(
  $$ select public.post_create('caption and photo', 'club',
       jsonb_build_array(jsonb_build_object('storage_path', tests.uid('m1')::text || '/captioned.jpg')), null) $$,
  'a photo with a caption is created');
select results_eq(
  $$ select post_type::text from public.workout_posts
     where author_id = tests.uid('m1') and body = 'caption and photo' $$,
  $$ values ('POST_TEXT') $$,
  'a photo with text is filed as POST_TEXT, not POST_PHOTO');

select lives_ok(
  $$ select public.post_create('text only, no media', 'club', null, null) $$,
  'a text-only post is created');
select results_eq(
  $$ select post_type::text from public.workout_posts
     where author_id = tests.uid('m1') and body = 'text only, no media' $$,
  $$ values ('POST_TEXT') $$,
  'a text-only post is filed as POST_TEXT');

-- =====================================================================
-- 12. visibility round-trips club, friends, only_me
-- =====================================================================
select lives_ok(
  $$ select public.post_create('friends visibility', 'friends', null, null) $$,
  'a friends-visibility post is created');
select results_eq(
  $$ select visibility::text from public.workout_posts where author_id = tests.uid('m1') and body = 'friends visibility' $$,
  $$ values ('friends') $$,
  'friends visibility round-trips');

select lives_ok(
  $$ select public.post_create('only me visibility', 'only_me', null, null) $$,
  'an only_me-visibility post is created');
select results_eq(
  $$ select visibility::text from public.workout_posts where author_id = tests.uid('m1') and body = 'only me visibility' $$,
  $$ values ('only_me') $$,
  'only_me visibility round-trips');

select lives_ok(
  $$ select public.post_create('club visibility', 'club', null, null) $$,
  'a club-visibility post is created');
select results_eq(
  $$ select visibility::text from public.workout_posts where author_id = tests.uid('m1') and body = 'club visibility' $$,
  $$ values ('club') $$,
  'club visibility round-trips');

-- =====================================================================
-- 13. the post row and its media rows either all land or none do (the
-- positive case: a valid 2-item media post lands with both rows)
-- =====================================================================
select lives_ok(
  $$ select public.post_create('two photos', 'club',
       jsonb_build_array(
         jsonb_build_object('storage_path', tests.uid('m1')::text || '/multi0.jpg'),
         jsonb_build_object('storage_path', tests.uid('m1')::text || '/multi1.jpg')),
       null) $$,
  'a post with two media items is created');
select results_eq(
  $$ select count(*)::int from public.post_media m
     join public.workout_posts p on p.id = m.post_id
     where p.author_id = tests.uid('m1') and p.body = 'two photos' $$,
  $$ values (2) $$,
  'both media rows landed alongside the post row');

select * from finish();
rollback;
