-- Security hunt round 4 (202609110004): a plain member used to be able to
-- forge a POST_PR/POST_ACHIEVEMENT by inserting (or updating) directly into
-- workout_posts, with fabricated metadata and zero backing private_records/
-- member_achievements row - confirmed live before this fix, bypassing
-- pr_share()/ach_share() entirely. This file proves the direct bypass is
-- closed and that the real RPCs, which set the new app.allow_pr_achievement_write
-- pin around their own writes, are completely unaffected.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into public.workout_posts
  (id, author_id, post_type, visibility, status, title, body, created_at, published_at)
values
  ('ee000000-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_TEXT', 'club', 'active',
   null, 'שלום עולם', now(), now());

-- =====================================================================
-- THE BYPASS THIS MIGRATION CLOSES: a direct insert/update, no RPC at all.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select throws_ok(
  format($$ insert into public.workout_posts (author_id, post_type, visibility, body, metadata)
            values (%L, 'POST_ACHIEVEMENT', 'club', 'זייפתי הישג',
                    '{"achievement_name":"1000 attendances (FAKE)"}'::jsonb) $$,
         tests.uid('m1')::text),
  'P0001', 'post type requires server-verified evidence',
  'a plain member cannot forge a POST_ACHIEVEMENT with a direct insert - no member_achievements row backs it');

select throws_ok(
  format($$ insert into public.workout_posts (author_id, post_type, visibility, body, metadata, occurred_on)
            values (%L, 'POST_PR', 'club', 'זייפתי שיא',
                    '{"movement":"Deadlift (FAKE)","new_result":"500kg"}'::jsonb, '2020-01-01') $$,
         tests.uid('m1')::text),
  'P0001', 'post type requires server-verified evidence',
  'nor a POST_PR with a fabricated result and a backdated occurred_on - no private_records row backs it');

select is_empty(
  $$ select 1 from public.workout_posts where post_type in ('POST_PR', 'POST_ACHIEVEMENT') and author_id = tests.uid('m1') $$,
  'neither forged insert actually landed a row');

select throws_ok(
  $$ update public.workout_posts set post_type = 'POST_PR' where id = 'ee000000-0000-4000-8000-000000000001' $$,
  'P0001', 'post type requires server-verified evidence',
  'and promoting an existing own post to POST_PR by direct UPDATE is refused the same way');

select results_eq(
  $$ select post_type::text from public.workout_posts where id = 'ee000000-0000-4000-8000-000000000001' $$,
  $$ values ('POST_TEXT') $$,
  'the post is still POST_TEXT - the UPDATE never landed');

-- =====================================================================
-- publishAchievement()'s still-live legacy shape: source_type='achievement',
-- no post_type in the insert at all (default_post_type() derives it), a
-- non-uuid local badge slug. Must still work - this is not the exploit.
-- =====================================================================
select lives_ok(
  format($$ insert into public.workout_posts (author_id, source_type, source_record_id, visibility, title, result_text, occurred_on)
            values (%L, 'achievement', 'sessions-50', 'followers', 'מדליה חדשה', 'חמישים אימונים', current_date) $$,
         tests.uid('m1')::text),
  'publishAchievement()''s own shape - a non-uuid local badge slug - is unaffected by the guard');
select results_eq(
  $$ select post_type::text from public.workout_posts where author_id = tests.uid('m1') and source_record_id = 'sessions-50' $$,
  $$ values ('POST_ACHIEVEMENT') $$,
  'and default_post_type() still derives POST_ACHIEVEMENT for it, exactly as before this fix');

-- But a uuid-SHAPED source_record_id - the one shape a real ach_share() row
-- actually has - gets no such exemption, so this narrow carve-out cannot be
-- used to forge a fake ach_share()-style row.
select throws_ok(
  format($$ insert into public.workout_posts (author_id, source_type, source_record_id, visibility, title, result_text, occurred_on)
            values (%L, 'achievement', %L, 'club', 'זייפתי הישג אמיתי', 'FAKE', current_date) $$,
         tests.uid('m1')::text, gen_random_uuid()::text),
  'P0001', 'post type requires server-verified evidence',
  'a uuid-shaped source_record_id (mimicking a real member_achievements.id) still requires the real pin - the carve-out is not a general bypass');

-- Editing something else on the same row (not touching post_type at all)
-- must be completely unaffected - this guard only fires on a real move.
select lives_ok(
  $$ update public.workout_posts set body = 'עדכון כותרת' where id = 'ee000000-0000-4000-8000-000000000001' $$,
  'an ordinary caption edit that never names post_type in its SET list is untouched');

select tests.clear_auth();

-- =====================================================================
-- THE REAL RPCS STILL WORK: pr_share() and ach_share() set the pin around
-- their own writes and are unaffected by this guard.
-- =====================================================================
insert into public.private_records (user_id, record_type, record_id, payload) values
  (tests.uid('m2'), 'movement', 'mv-97', '{"name":"לחיצת חזה"}'),
  (tests.uid('m2'), 'strength_entry', 'set-97-real',
   '{"exerciseId":"mv-97","type":"reps","weight":80,"reps":5,"sets":1,"date":"2026-09-05","ts":3000}');

-- Security hunt round 6 (202609120001): member_achievements.verified is
-- now computed from this definition's own metric/trigger_type by
-- member_achievements_verified_trg - config carries metric:tenure_days so
-- the directly-inserted row below (this fixture predates ach_claim
-- entirely; it is standing in for "member already has a real achievement",
-- not exercising the claim path) is recognized as verified, which
-- ach_share() now requires.
insert into public.achievement_definitions
  (id, code, name, description, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values
  ('a0970000-0000-4000-8000-000000000001', 'test_forgery_guard', 'עשרה אימונים', 'עשרה אימונים',
   'performance', 'PR_CREATED', 10, false, 'club', '⭐', true, '{"client_claimable": true, "metric": "tenure_days"}');
insert into public.member_achievements (id, user_id, achievement_id, visibility, unlocked_at) values
  ('b0970000-0000-4000-8000-000000000001', tests.uid('m2'), 'a0970000-0000-4000-8000-000000000001', 'club', now());

select tests.set_auth(tests.uid('m2'));

select isnt_empty(
  format($$ select public.pr_share(%L) $$, 'set-97-real'),
  'pr_share() - the legitimate path - still creates a real POST_PR, unaffected by the new guard');
select results_eq(
  $$ select post_type::text from public.workout_posts where author_id = tests.uid('m2') and source_record_id = 'set-97-real' $$,
  $$ values ('POST_PR') $$,
  'and the row really is POST_PR');

select isnt_empty(
  format($$ select public.ach_share(%L) $$, 'b0970000-0000-4000-8000-000000000001'::text),
  'ach_share() also still works');
select results_eq(
  $$ select post_type::text from public.workout_posts where author_id = tests.uid('m2') and source_type = 'achievement' $$,
  $$ values ('POST_ACHIEVEMENT') $$,
  'and creates a real POST_ACHIEVEMENT');

select tests.clear_auth();
select * from finish();
rollback;
