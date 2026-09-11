-- Five-persona UX audit, defect 1 (202609060019). pr_share() and ach_share()
-- exist now.
--
-- WHAT WAS BROKEN. Both are called by name from cloud.js - sharePrPrompt()
-- and shareAchievementUnlock() - and neither had ever been created, so
-- PostgREST answered PGRST202 and the two moments the whole community layer
-- is built around ("share your PR", "share your badge") had never worked
-- once.
--
-- ARGUMENT NAMES AND TYPES ARE ASSERTED FIRST, because a correct function
-- with the wrong parameter names is still an unreachable one - PostgREST
-- resolves an RPC by the exact set of named arguments in the request body.
-- pr_share.record_id is deliberately TEXT and not the uuid contracts.md
-- line 991 publishes: the id is uid("set") output ("set-<uuid>"), so a uuid
-- parameter would fail to cast on every single call.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- m1's own training history: the PR being shared, an older lighter set at
-- the same rep count (the previous best the server has to find for itself),
-- and the custom movement the two point at.
insert into public.private_records (user_id, record_type, record_id, payload) values
  (tests.uid('m1'), 'movement', 'mv-83', '{"name":"סקוואט אחורי"}'),
  (tests.uid('m1'), 'strength_entry', 'set-83-new',
   '{"exerciseId":"mv-83","type":"reps","weight":100,"reps":5,"sets":1,"date":"2026-09-01","ts":2000,"est1RM":112.5}'),
  (tests.uid('m1'), 'strength_entry', 'set-83-old',
   '{"exerciseId":"mv-83","type":"reps","weight":90,"reps":5,"sets":1,"date":"2026-08-01","ts":1000,"est1RM":101.25}'),
  -- A row whose numbers are junk. The share must not abort on it.
  (tests.uid('m1'), 'strength_entry', 'set-83-junk',
   '{"exerciseId":"mv-83","type":"reps","weight":"heavy","reps":"","date":"nope"}'),
  -- m2's record. m1 must never be able to attach a post to it.
  (tests.uid('m2'), 'strength_entry', 'set-83-m2',
   '{"exerciseId":"mv-99","type":"reps","weight":80,"reps":3,"date":"2026-09-01","ts":900}');

-- Security hunt round 6 (202609120001): member_achievements.verified is
-- computed from each definition's own metric/trigger_type by
-- member_achievements_verified_trg - config carries metric:tenure_days so
-- the directly-inserted rows below (this fixture predates ach_claim
-- entirely; standing in for "member already has a real achievement", not
-- exercising the claim path) are recognized as verified, which ach_share()
-- now requires.
insert into public.achievement_definitions
  (id, code, name, description, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values
  ('a0830000-0000-4000-8000-000000000001', 'test_share_club', 'עשרה שיאים', 'עשרה שיאים אישיים',
   'performance', 'PR_CREATED', 10, false, 'club', '⭐', true, '{"client_claimable": true, "metric": "tenure_days"}'),
  -- A second definition, because member_achievements_once_idx allows one
  -- unlock per member per non-repeatable definition and this file needs a
  -- club-visible one and a private one for the SAME member.
  ('a0830000-0000-4000-8000-000000000002', 'test_share_private', 'עיטור פרטי', 'עיטור שמוגדר פרטי',
   'performance', 'PR_CREATED', 1, false, 'only_me', '🔒', true, '{"client_claimable": true, "metric": "tenure_days"}');

insert into public.member_achievements (id, user_id, achievement_id, visibility, unlocked_at) values
  ('b0830000-0000-4000-8000-000000000001', tests.uid('m1'), 'a0830000-0000-4000-8000-000000000001', 'club',  '2026-09-02T08:00:00Z'),
  ('b0830000-0000-4000-8000-000000000002', tests.uid('m1'), 'a0830000-0000-4000-8000-000000000002', 'only_me','2026-09-02T08:00:00Z'),
  ('b0830000-0000-4000-8000-000000000003', tests.uid('m2'), 'a0830000-0000-4000-8000-000000000001', 'club',  '2026-09-02T08:00:00Z');

-- =====================================================================
-- 0. The call shape the client actually sends
-- =====================================================================
select is(
  (select pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pr_share'),
  'record_id text, note text, media jsonb, p_idempotency_key uuid',
  'pr_share takes record_id as TEXT - contracts.md says uuid, and a uuid parameter would reject every real call ("set-<uuid>") before the body ran');
select is(
  (select array_to_string(p.proargnames, ',')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pr_share'),
  'record_id,note,media,p_idempotency_key',
  'and by the argument NAMES cloud.js sends, since PostgREST resolves an RPC by name');
select is(
  (select array_to_string(p.proargnames, ',')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'ach_share'),
  'member_achievement_id,caption,media,p_idempotency_key',
  'ach_share likewise');
select is(
  (select has_function_privilege('authenticated', 'public.pr_share(text, text, jsonb, uuid)', 'execute')), true,
  'pr_share is callable by a member');
select is(
  (select has_function_privilege('anon', 'public.pr_share(text, text, jsonb, uuid)', 'execute')), false,
  'and not by anon');
select is(
  (select has_function_privilege('anon', 'public.ach_share(uuid, text, jsonb, uuid)', 'execute')), false,
  'nor is ach_share');
select is(
  (select has_function_privilege('authenticated', 'public.private_record_number(jsonb, text)', 'execute')), false,
  'the payload-number helper is not client-callable');

-- =====================================================================
-- 1. pr_share: the happy path, and every figure on the card is the
--    server's own arithmetic
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.pr_share('set-83-new', 'הרגשתי חזק', '[]'::jsonb) $$,
  'a member shares their own PR');

select is(
  (select post_type::text from public.workout_posts where source_record_id = 'set-83-new'),
  'POST_PR', 'it is a POST_PR');
select is(
  (select title from public.workout_posts where source_record_id = 'set-83-new'),
  'סקוואט אחורי', 'the movement name is read from the member''s own synced movement record');
select is(
  (select result_text from public.workout_posts where source_record_id = 'set-83-new'),
  '100 ק"ג × 5', 'the result is recomputed from the record, not sent by the client');
select is(
  (select metadata ->> 'previous_result' from public.workout_posts where source_record_id = 'set-83-new'),
  '90 ק"ג × 5',
  'THE POINT OF THE CONTRACT: the previous best is found server-side, from the member''s own earlier record at the same rep count');
select is(
  (select metadata ->> 'improvement' from public.workout_posts where source_record_id = 'set-83-new'),
  '+10 ק"ג', 'and the improvement is arithmetic on those two numbers, never a client-supplied string');
select is(
  (select body from public.workout_posts where source_record_id = 'set-83-new'),
  'הרגשתי חזק', 'the note is the only thing the request contributes');
select is(
  (select occurred_on::text from public.workout_posts where source_record_id = 'set-83-new'),
  '2026-09-01', 'the date comes from the record too');

-- =====================================================================
-- 2. Ownership
-- =====================================================================
select throws_ok(
  $$ select public.pr_share('set-83-m2', 'לא שלי', '[]'::jsonb) $$,
  'P0001', 'not authorized',
  'a member cannot attach a post to ANOTHER member''s record id - the id is untrusted, and this is the boundary');

-- The opt-out case: a record id nobody holds server-side. Allowed, because
-- cloud backup is opt-OUT and a member who declined it still owns the PR -
-- but it publishes no figures at all.
select lives_ok(
  $$ select public.pr_share('set-83-never-synced', 'שיא בלי גיבוי', '[]'::jsonb) $$,
  'an unsynced record can still be shared - refusing would break sharing forever for a member who turned cloud backup off');
select ok(
  (select result_text is null and metadata -> 'new_result' is null
     from public.workout_posts where source_record_id = 'set-83-never-synced'),
  'and it carries NO performance claim, because there is nothing server-side to compute one from');
select throws_ok(
  $$ select public.pr_share('set-83-also-never-synced', '', '[]'::jsonb) $$,
  'P0001', 'a post needs text or at least one photo',
  'with no figures, no note and no photo there is nothing to publish');

-- =====================================================================
-- 3. Malformed payloads never abort a share
-- =====================================================================
select lives_ok(
  $$ select public.pr_share('set-83-junk', 'בכל זאת', '[]'::jsonb) $$,
  'a record whose weight is "heavy" and whose date is "nope" does not blow up the share on a cast');
select ok(
  (select result_text is null from public.workout_posts where source_record_id = 'set-83-junk'),
  'it simply publishes no numbers');

-- =====================================================================
-- 4. Idempotency, with and without a key
-- =====================================================================
select is(
  public.pr_share('set-83-new', 'שוב', '[]'::jsonb),
  (select id from public.workout_posts where source_record_id = 'set-83-new'),
  'sharing the same record twice returns the FIRST post id - the natural key (author_id, source_type, source_record_id) converges instead of raising 23505');
select is(
  (select count(*)::int from public.workout_posts where source_record_id = 'set-83-new'), 1,
  'and there is still exactly one post');
select is(
  (select body from public.workout_posts where source_record_id = 'set-83-new'), 'הרגשתי חזק',
  'the second call did not overwrite the first note either');

-- =====================================================================
-- 5. The write gates
-- =====================================================================
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select public.pr_share('set-83-new', 'x', '[]'::jsonb) $$,
  'P0001', 'recovery method required',
  'a member who has not verified a recovery method cannot share - the same gate post_create carries');
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select public.ach_share('b0830000-0000-4000-8000-000000000001', 'x', '[]'::jsonb) $$,
  'P0001', 'recovery method required',
  'and neither can they share an achievement');

select tests.clear_auth();
insert into public.posting_restrictions (user_id, restriction_type, reason, moderator_id)
values (tests.uid('m3'), 'permanent', 'test', tests.uid('admin'));
insert into public.private_records (user_id, record_type, record_id, payload) values
  (tests.uid('m3'), 'strength_entry', 'set-83-m3', '{"exerciseId":"mv-83","type":"reps","weight":50,"reps":5,"date":"2026-09-01","ts":10}');
select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.pr_share('set-83-m3', 'x', '[]'::jsonb) $$,
  'P0001', 'posting_restricted',
  'a COMM-153 speech sanction covers sharing a PR, not just the composer - otherwise the restriction is trivially routed around');

-- =====================================================================
-- 6. ach_share
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.ach_share('b0830000-0000-4000-8000-000000000001', 'סוף סוף', '[]'::jsonb) $$,
  'a member shares their own achievement');
select is(
  (select post_type::text from public.workout_posts
    where source_record_id = 'b0830000-0000-4000-8000-000000000001'),
  'POST_ACHIEVEMENT', 'it is a POST_ACHIEVEMENT');
select is(
  (select title from public.workout_posts where source_record_id = 'b0830000-0000-4000-8000-000000000001'),
  'עשרה שיאים', 'the title comes from the achievement definition, never from the request');
select is(
  (select metadata ->> 'badge_icon' from public.workout_posts
    where source_record_id = 'b0830000-0000-4000-8000-000000000001'),
  '⭐', 'and so does the icon renderAchievementPostCard reads');
select ok(
  (select shared_at is not null from public.member_achievements
    where id = 'b0830000-0000-4000-8000-000000000001'),
  'shared_at is stamped, which is what contracts.md promises and what the client renders as "shared"');

select throws_ok(
  $$ select public.ach_share('b0830000-0000-4000-8000-000000000002', 'x', '[]'::jsonb) $$,
  'P0001', 'a private achievement cannot be shared',
  'an only_me decoration is refused server-side - the client checks this too, which is exactly why the server must');
select throws_ok(
  $$ select public.ach_share('b0830000-0000-4000-8000-000000000003', 'x', '[]'::jsonb) $$,
  'P0001', 'not authorized',
  'and another member''s achievement is refused as unauthorised, not reported as missing');
select throws_ok(
  $$ select public.ach_share('b0830000-0000-4000-8000-0000000000ff', 'x', '[]'::jsonb) $$,
  'P0001', 'achievement not found',
  'an unknown id is a plain not-found');

select is(
  public.ach_share('b0830000-0000-4000-8000-000000000001', 'שוב', '[]'::jsonb),
  (select id from public.workout_posts where source_record_id = 'b0830000-0000-4000-8000-000000000001'),
  'a repeat share converges on the first post too');
select is(
  (select count(*)::int from public.workout_posts
    where source_record_id = 'b0830000-0000-4000-8000-000000000001'), 1,
  'one achievement, one post');

-- =====================================================================
-- 7. The post-type privilege guard still holds over both
-- =====================================================================
-- Neither function takes a post_type from its caller, so there is no input
-- that could reach POST_COACH through them. Asserted as the property that
-- matters rather than as an attempted call: the guard (202609060004) is what
-- would refuse the write, and this pins that these two new writers did not
-- open a way around it.
select is(
  (select count(*)::int from public.workout_posts
    where author_id = tests.uid('m1')
      and post_type in ('POST_COACH', 'POST_ANNOUNCEMENT', 'POST_SYSTEM', 'POST_NEW_MEMBER')),
  0, 'no share by a plain member ever produced a staff-attributed post');

-- =====================================================================
-- 8. The idempotency key path, for when the client routes these through
--    the outbox
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.ach_share('b0830000-0000-4000-8000-000000000003', 'שלי', '[]'::jsonb,
                             'e0830000-0000-4000-8000-000000000001') $$,
  'ach_share accepts an idempotency key, the same shape post_create takes');
select is(
  public.ach_share('b0830000-0000-4000-8000-000000000003', 'שלי', '[]'::jsonb,
                   'e0830000-0000-4000-8000-000000000001'),
  (select id from public.workout_posts where source_record_id = 'b0830000-0000-4000-8000-000000000003'),
  'and replaying the key returns the original post id without writing again');

select * from finish();
rollback;
