-- Club Modules (202609010012). Real two-user RLS enforcement for the
-- club_features table, club_feature_enabled(), admin_set_club_feature(),
-- and the six gated read policies/functions it extends.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. club_features itself: world-readable, no direct write path
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select is( public.club_feature_enabled('does_not_exist'), true,
  'no row for a key = ungated, never accidentally hidden' );
select is( public.club_feature_enabled('announcements'), true,
  'the seeded default is enabled' );

select isnt_empty(
  $$ select 1 from public.club_features where module_key = 'feed' $$,
  'a plain member can read club_features directly');

select throws_ok(
  $$ insert into public.club_features (module_key, enabled) values ('rogue', true) $$,
  '42501', null,
  'a plain member cannot insert into club_features directly - no write policy exists at all');
select throws_ok(
  $$ update public.club_features set enabled = false where module_key = 'feed' $$,
  '42501', null,
  'a plain member cannot update club_features directly either');

select tests.clear_auth();

-- =====================================================================
-- 2. admin_set_club_feature(): authorization, write, audit log, upsert
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_set_club_feature('feed', false) $$,
  'P0001', 'not authorized',
  'a plain member cannot toggle a module');
select tests.clear_auth();

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('events', false) $$,
  'owner (has_perm bypass) can toggle a module');

select tests.clear_auth();
select results_eq(
  $$ select enabled from public.club_features where module_key = 'events' $$,
  $$ values (false) $$,
  'the row was actually written');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'club_feature_toggle' and target_type = 'club' $$,
  $$ values (1) $$,
  'exactly one admin_actions row was logged for the toggle');

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('events', true) $$,
  'a second call with a different value upserts in place');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.club_features where module_key = 'events' $$,
  $$ values (1) $$,
  'still exactly one row for the module - primary key upsert, not a duplicate');

-- =====================================================================
-- 3. RLS extension. One fixture row per gated table, read by a member who
-- is neither its creator nor the achievement's own owner, before/after
-- toggling.
-- =====================================================================
select tests.clear_auth();
insert into public.announcements (author_id, title, body)
  values (tests.uid('m1'), 'Test announcement', 'Body text');
insert into public.events (title, event_type, start_at, created_by, status)
  values ('Test event', 'social_night', now() + interval '1 day', tests.uid('m1'), 'published');
insert into public.challenges (title, challenge_type, metric_type, start_at, end_at, created_by, status)
  values ('Test challenge', 'individual_target', 'reps', now(), now() + interval '7 days', tests.uid('m1'), 'active');
insert into public.member_achievements (user_id, achievement_id, visibility)
  select tests.uid('m1'), id, 'club' from public.achievement_definitions where code = 'first_workout';
insert into public.workout_posts (author_id, source_type, source_record_id, visibility, title, result_text, occurred_on)
  values (tests.uid('m1'), 'strength_entry', 'test-src-1', 'club', 'Test post', 'Result text', current_date);

-- --- announcements ---
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.announcements where title = 'Test announcement' $$,
  'announcements: readable while the module is on');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('announcements', false);
select tests.clear_auth();
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.announcements where title = 'Test announcement' $$,
  'announcements: genuinely unqueryable once the module is off');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('announcements', true);
select tests.clear_auth();

-- --- events ---
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.events where title = 'Test event' $$,
  'events: readable while the module is on');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('events', false);
select tests.clear_auth();
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.events where title = 'Test event' $$,
  'events: unqueryable once off, even though it is a published, non-draft event');
select tests.clear_auth();
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.events where title = 'Test event' $$,
  'events: the creator''s own OR-branch is gated too - off means off for everyone, not just ordinary members');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('events', true);
select tests.clear_auth();

-- --- challenges ---
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.challenges where title = 'Test challenge' $$,
  'challenges: readable while the module is on');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('challenges', false);
select tests.clear_auth();
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.challenges where title = 'Test challenge' $$,
  'challenges: unqueryable once off');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('challenges', true);
select tests.clear_auth();

-- --- achievements (own-row branch must be gated too) ---
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.member_achievements ma
     join public.achievement_definitions ad on ad.id = ma.achievement_id
     where ad.code = 'first_workout' and ma.user_id = tests.uid('m1') $$,
  'achievements: a clubmate can read a club-visible unlock while the module is on');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('achievements', false);
select tests.clear_auth();
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.member_achievements ma
     join public.achievement_definitions ad on ad.id = ma.achievement_id
     where ad.code = 'first_workout' and ma.user_id = tests.uid('m1') $$,
  'achievements: unqueryable to a clubmate once off');
select tests.clear_auth();
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.member_achievements ma
     join public.achievement_definitions ad on ad.id = ma.achievement_id
     where ad.code = 'first_workout' and ma.user_id = tests.uid('m1') $$,
  'achievements: the module off hides even the owner''s own past unlock, matching "genuinely unqueryable" rather than just hidden from other members');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('achievements', true);
select tests.clear_auth();

-- --- feed (comments/reactions ride along, not independently re-tested here
-- since they key off the same workout_posts visibility check) ---
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.workout_posts where title = 'Test post' $$,
  'feed: readable while the module is on');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('feed', false);
select tests.clear_auth();
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.workout_posts where title = 'Test post' $$,
  'feed: unqueryable once off');
select tests.clear_auth();
select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('feed', true);
select tests.clear_auth();

-- =====================================================================
-- 4. Leaderboards - function-body gate, not a table policy
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select * from public.feed_leaderboard('consistency') $$,
  'leaderboards: callable while the module is on');
select tests.clear_auth();

select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('leaderboards', false);
select tests.clear_auth();

select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select * from public.feed_leaderboard('consistency') $$,
  'P0001', 'leaderboards disabled',
  'leaderboards: raises once the module is off, not just an empty result');
select tests.clear_auth();

select tests.set_auth(tests.uid('owner'));
select public.admin_set_club_feature('leaderboards', true);
select tests.clear_auth();

select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select * from public.feed_leaderboard('consistency') $$,
  'leaderboards: callable again once re-enabled - the toggle is fully reversible');
select tests.clear_auth();

select * from finish();
rollback;
