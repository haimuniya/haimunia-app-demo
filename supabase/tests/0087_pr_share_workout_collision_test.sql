-- Contracts review of 202609060019, closed by 202609060025.
--
-- WHAT WAS BROKEN. pr_share()'s prior-post probe matched on (author_id,
-- source_type in ('strength_entry','wod_entry'), source_record_id) and never
-- filtered on post_type. The unique constraint it stands in for -
-- workout_posts(author_id, source_type, source_record_id), from
-- 202608260001 - does not include post_type either, so ONE logged record owns
-- ONE slot in that table. publishWorkout() (cloud.js) has always written into
-- that same slot with the same entry.id.
--
-- So: member shares a workout to the feed (POST_WORKOUT), the same set was a
-- PR, the prompt appears, the member taps "שיתוף" - and pr_share returned the
-- POST_WORKOUT's id, created no POST_PR, and discarded the note and photo,
-- while sharePrPrompt() showed "השיא שותף לקהילה" and emitted POST_CREATED
-- with post_type "POST_PR". A false success, reachable in four ordinary taps.
--
-- THE RESOLUTION UNDER TEST: one record yields one post, and the PR share
-- UPGRADES the existing workout card into the PR card. This file exists so
-- that cannot regress, and it also pins the three things the upgrade must
-- NOT do - widen visibility, bump published_at, or revive a moderated post.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- m1's training history: the PR being shared and an older, lighter set at the
-- same rep count, so the server has a real previous_result to recompute.
insert into public.private_records (user_id, record_type, record_id, payload) values
  (tests.uid('m1'), 'movement', 'mv-87', '{"name":"סקוואט אחורי"}'),
  (tests.uid('m1'), 'strength_entry', 'set-87-collide',
   '{"exerciseId":"mv-87","type":"reps","weight":100,"reps":5,"date":"2026-09-01","ts":2000,"est1RM":112.5}'),
  (tests.uid('m1'), 'strength_entry', 'set-87-old',
   '{"exerciseId":"mv-87","type":"reps","weight":90,"reps":5,"date":"2026-08-01","ts":1000,"est1RM":101.25}'),
  -- Three more records, one per boundary case below.
  (tests.uid('m1'), 'strength_entry', 'set-87-deleted',
   '{"exerciseId":"mv-87","type":"reps","weight":102,"reps":5,"date":"2026-09-02","ts":2100}'),
  (tests.uid('m1'), 'strength_entry', 'set-87-removed',
   '{"exerciseId":"mv-87","type":"reps","weight":103,"reps":5,"date":"2026-09-03","ts":2200}'),
  (tests.uid('m1'), 'strength_entry', 'set-87-fresh',
   '{"exerciseId":"mv-87","type":"reps","weight":104,"reps":5,"date":"2026-09-04","ts":2300}');

-- =====================================================================
-- 0. THE CONSTRAINT MUST NOT HAVE MOVED
-- =====================================================================
-- The tempting fix was to add post_type to this unique constraint. It is
-- deliberately NOT taken: publishWorkout() upserts with
-- `on conflict author_id,source_type,source_record_id`, and dropping the
-- three-column unique removes that statement's arbiter, so Postgres raises
-- 42P10 and the legacy workout share breaks for every member. Asserted here
-- so a later "cleanup" cannot quietly remove it.
select is(
  (select array_to_string(array_agg(a.attname order by k.ord), ',')
     from pg_constraint c
     join unnest(c.conkey) with ordinality k(att, ord) on true
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att
    where c.conrelid = 'public.workout_posts'::regclass and c.contype = 'u'),
  'author_id,source_type,source_record_id',
  'the natural key is still exactly (author_id, source_type, source_record_id) - publishWorkout''s on-conflict arbiter is untouched, so this migration cannot break the legacy workout share');

select is(
  (select pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pr_share'),
  'record_id text, note text, media jsonb, p_idempotency_key uuid',
  'pr_share''s signature is unchanged - the fix needed no client change');

-- =====================================================================
-- 1. THE COLLISION ITSELF
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

-- Exactly what publishWorkout() (cloud.js) writes: source_type = the entry
-- type, source_record_id = the entry id, visibility 'followers', a
-- client-supplied score and comparison_key, and NO post_type - so
-- workout_posts_default_post_type() labels it POST_WORKOUT.
insert into public.workout_posts
  (author_id, source_type, source_record_id, visibility, title, result_text,
   comparison_key, score_value, score_direction, occurred_on, published_at)
values
  (tests.uid('m1'), 'strength_entry', 'set-87-collide', 'followers',
   'סקוואט', '100 ק"ג × 5', 'mv-87:5', 999, 'higher', '2026-09-01',
   '2026-09-01T10:00:00Z');

select is(
  (select post_type::text from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  'POST_WORKOUT',
  'the legacy workout share lands as a POST_WORKOUT, holding this record''s only slot');

-- Step 3 of the reachable sequence: the member taps "שיתוף" on the PR prompt.
-- The storage path is interpolated because enforce_post_media_ownership()
-- requires its first segment to be the post author's own uuid.
select lives_ok(
  format($$ select public.pr_share('set-87-collide', 'שיא חדש אחרי חצי שנה',
       '[{"storage_path":"%s/pr87.jpg","alt_text":"סקוואט","position":0}]'::jsonb) $$,
    tests.uid('m1')),
  'sharing the PR for a record that was already shared as a workout succeeds');

-- THE REGRESSION GUARD. Before 202609060025 this was 0.
select is(
  (select count(*)::int from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'
      and post_type = 'POST_PR'),
  1,
  'a POST_PR now EXISTS for that record - the whole defect was that the client reported success while this stayed 0');

select is(
  (select count(*)::int from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  1,
  'and there is still exactly ONE post for the record: one logged set is one card, not a workout card plus a near-identical PR card the diversity pass would steer adjacent to it');

select is(
  (select body from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  'שיא חדש אחרי חצי שנה',
  'the note the member typed into the PR prompt is actually published - it used to be silently thrown away');

select is(
  (select count(*)::int from public.post_media pm
     join public.workout_posts p on p.id = pm.post_id
    where p.author_id = tests.uid('m1') and p.source_record_id = 'set-87-collide'),
  1,
  'and so is the photo they attached');

select is(
  (select p.metadata ->> 'improvement' from public.workout_posts p
    where p.author_id = tests.uid('m1') and p.source_record_id = 'set-87-collide'),
  '+10 ק"ג',
  'the improvement is recomputed server-side from m1''s own prior 90kg×5 and written onto the upgraded card');

select is(
  (select p.metadata ->> 'new_result' from public.workout_posts p
    where p.author_id = tests.uid('m1') and p.source_record_id = 'set-87-collide'),
  '100 ק"ג × 5',
  'as is new_result - the exact metadata key renderPrPostCard reads and feed_page redacts under show_workout_results');

-- =====================================================================
-- 2. WHAT THE UPGRADE MUST NOT MOVE
-- =====================================================================
select is(
  (select visibility::text from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  'followers',
  'VISIBILITY IS NOT WIDENED. pr_share''s insert path writes ''club''; promoting an already-published ''followers'' post to ''club'' would broaden its audience without the member asking, which is an identity-privacy boundary');

select is(
  (select published_at from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  '2026-09-01T10:00:00Z'::timestamptz,
  'PUBLISHED_AT IS NOT BUMPED. pr_share is reachable directly over PostgREST for any of the caller''s own record ids, so bumping it would let a member re-float an arbitrarily old post to the top of every feed');

select is(
  (select comparison_key from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  'mv-87:5',
  'the leaderboard comparison_key belongs to the workout share that computed it and is left alone');

select is(
  (select score_value from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  112.5::numeric,
  'score_value IS replaced - publishWorkout''s 999 was client-supplied, and the upgrade substitutes the est1RM recomputed here from the caller''s own private_records');

-- =====================================================================
-- 3. IDEMPOTENCY SURVIVES THE FIX
-- =====================================================================
-- The natural key still has to converge a double tap on "שיתוף" - the reason
-- 202609060019 wrote the probe in the first place. It just has to converge on
-- a POST_PR now instead of on whatever held the slot.
select is(
  (select public.pr_share('set-87-collide', 'טקסט אחר לגמרי', '[]'::jsonb)),
  (select id from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  'a second share of the same record returns the SAME post id');

select is(
  (select body from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  'שיא חדש אחרי חצי שנה',
  'and writes nothing - the already-POST_PR path returns untouched, so a retry cannot overwrite the published note');

select is(
  (select count(*)::int from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-collide'),
  1,
  'and still no second post');

-- =====================================================================
-- 4. REACTIONS AND COMMENTS SURVIVE THE UPGRADE
-- =====================================================================
-- The card is still the card for that set, so the cheers and comments people
-- left on it stay attached. A considered consequence, pinned so it is a
-- decision rather than an accident.
select tests.clear_auth();
insert into public.reactions (post_id, user_id)
select id, tests.uid('m2') from public.workout_posts
 where author_id = tests.uid('m1') and source_record_id = 'set-87-collide';
insert into public.post_comments (post_id, author_id, body)
select id, tests.uid('m2'), 'כל הכבוד!' from public.workout_posts
 where author_id = tests.uid('m1') and source_record_id = 'set-87-collide';
select tests.set_auth(tests.uid('m1'));

select is(
  (select count(*)::int from public.reactions r
     join public.workout_posts p on p.id = r.post_id
    where p.source_record_id = 'set-87-collide'),
  1,
  'a cheer left on the workout card is still on the card after it became the PR card');

-- =====================================================================
-- 5. A SOFT-DELETED WORKOUT POST IS REVIVED AS THE PR POST
-- =====================================================================
-- The member is at this moment explicitly asking to publish this record to
-- the feed. Returning a deleted post's id and calling it a success is the
-- exact failure this migration ends.
select tests.clear_auth();
insert into public.workout_posts
  (author_id, source_type, source_record_id, visibility, title, result_text,
   occurred_on, deleted_at)
values
  (tests.uid('m1'), 'strength_entry', 'set-87-deleted', 'club',
   'סקוואט', '102 ק"ג × 5', '2026-09-02', now());
select tests.set_auth(tests.uid('m1'));

select lives_ok(
  $$ select public.pr_share('set-87-deleted', 'חוזר לשתף', '[]'::jsonb) $$,
  'sharing a PR whose workout card the member had deleted succeeds');
select is(
  (select post_type::text || '/' || coalesce(deleted_at::text, 'live')
     from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-deleted'),
  'POST_PR/live',
  'and the card comes back as the PR post rather than the share silently doing nothing');

-- =====================================================================
-- 6. A MODERATED POST IS REFUSED, NOT RELAUNCHED
-- =====================================================================
-- The boundary that makes the revive above safe. If a moderator hid or
-- removed the card, re-publishing the same content under a new post_type
-- would be moderation evasion.
select tests.clear_auth();
insert into public.workout_posts
  (author_id, source_type, source_record_id, visibility, title, result_text,
   occurred_on, status)
values
  (tests.uid('m1'), 'strength_entry', 'set-87-removed', 'club',
   'סקוואט', '103 ק"ג × 5', '2026-09-03', 'removed');
select tests.set_auth(tests.uid('m1'));

select throws_ok(
  $$ select public.pr_share('set-87-removed', 'נסיון', '[]'::jsonb) $$,
  'post is not available',
  'a PR share cannot relaunch a post a moderator removed - it fails honestly instead');
select is(
  (select post_type::text from public.workout_posts
    where author_id = tests.uid('m1') and source_record_id = 'set-87-removed'),
  'POST_WORKOUT',
  'and the removed post is left exactly as the moderator left it');

-- =====================================================================
-- 7. THE PLAIN PATH IS UNCHANGED
-- =====================================================================
-- No prior post for the record: still a straight insert, still visibility
-- 'club', still POST_PR. 202609060019's behaviour, preserved.
select public.pr_share('set-87-fresh', 'שיא ראשון', '[]'::jsonb);
select is(
  (select p.post_type::text || '/' || p.visibility::text
     from public.workout_posts p
    where p.author_id = tests.uid('m1') and p.source_record_id = 'set-87-fresh'),
  'POST_PR/club',
  'a PR for a record with no prior post is still inserted fresh as a club-visible POST_PR');

-- =====================================================================
-- 8. SIBLING RISK: publishAchievement() vs ach_share()
-- =====================================================================
-- Both write source_type 'achievement' into the SAME unique slot, so the
-- question is whether their id spaces can ever meet. They cannot:
-- publishAchievement sends app.js's local badge slug ("sessions-50",
-- "pr-squat-gold", "well-rounded", "capstone", "rx-<wod>", "tenure-<id>",
-- "streak-<tier>"), while ach_share sends member_achievements.id, a column
-- typed uuid with a gen_random_uuid() default. No slug is uuid-shaped, so the
-- two never collide - verified here rather than assumed.
select tests.clear_auth();
insert into public.achievement_definitions
  (id, code, name, description, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values
  ('a0870000-0000-4000-8000-000000000001', 'test_sibling_87', 'חמישים אימונים', 'חמישים ימי אימון',
   'performance', 'PR_CREATED', 50, false, 'club', '🏅', true, '{"client_claimable": true}');
insert into public.member_achievements (id, user_id, achievement_id, visibility, unlocked_at)
values
  ('b0870000-0000-4000-8000-000000000001', tests.uid('m3'),
   'a0870000-0000-4000-8000-000000000001', 'club', '2026-09-02T08:00:00Z');

select isnt(
  (select id::text from public.member_achievements where id = 'b0870000-0000-4000-8000-000000000001'),
  'sessions-50',
  'a member_achievements id is a uuid and can never equal an app.js badge slug - the two id spaces are disjoint by column type');

select tests.set_auth(tests.uid('m3'));
-- publishAchievement()'s write, byte for byte: the slug as source_record_id.
insert into public.workout_posts
  (author_id, source_type, source_record_id, visibility, title, result_text, occurred_on)
values
  (tests.uid('m3'), 'achievement', 'sessions-50', 'followers', 'עיטור חדש', 'עיטור חדש נפתח', '2026-09-02');

select lives_ok(
  $$ select public.ach_share('b0870000-0000-4000-8000-000000000001'::uuid, 'גאה בזה', '[]'::jsonb) $$,
  'ach_share still creates its own post for a member who also used the app.js share button - the slug and the uuid do not contend for one slot');

select is(
  (select count(*)::int from public.workout_posts
    where author_id = tests.uid('m3') and source_type = 'achievement'
      and post_type = 'POST_ACHIEVEMENT'),
  2,
  'both writes land, each in its own slot. Unlike pr_share''s defect neither reports a success it did not perform - this is duplicate CONTENT (a member can share the same milestone from two different sheets), not a false success, and it is recorded rather than silently fixed here');

select * from finish();
rollback;
