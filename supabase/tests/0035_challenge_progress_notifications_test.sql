-- COMM-234 QA sweep: real two-user pgTAP coverage for
-- 202608290003_challenge_progress_view.sql through
-- 202608290006_challenge_notifications.sql, plus the one-line
-- 202608290012_notif_create_service_role.sql grant. All four/five had only
-- manual "verified locally this run" notes in docs/community/backlog.md's
-- "Phase 2 schema handoff for qa" (Challenges section) and no committed,
-- CI-running pgTAP file - a real gap this sweep closes, not a duplicate of
-- anything: 0009_challenges_test.sql covers 202608280009's own boundaries
-- (create/edit/join/leave) and stops there.
--
-- This file's central purpose is COMM-208: pinning the chosen
-- "joined/completed" notification routing (batched to every OTHER active
-- participant, never immediate, never to the actor) as an executing test,
-- not just acceptance-criteria prose.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixture challenges, created as the bootstrap superuser (RLS out of the
-- way), one per challenge_type this file exercises.
-- =====================================================================
insert into public.challenges (id, title, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
values
  ('c0350000-0000-4000-8000-000000000001', 'Individual target', 'individual_target', 'session_count', 100, now() - interval '1 day', now() + interval '20 days', 'active', tests.uid('coach')),
  ('c0350000-0000-4000-8000-000000000002', 'Cooperative pool', 'cooperative', 'reps', 1000, now() - interval '1 day', now() + interval '20 days', 'active', tests.uid('coach')),
  ('c0350000-0000-4000-8000-000000000003', 'Coach-scored', 'coach', 'reps', null, now() - interval '1 day', now() + interval '20 days', 'active', tests.uid('coach')),
  ('c0350000-0000-4000-8000-000000000004', 'Ending soon', 'individual_target', 'session_count', 5, now() - interval '10 days', now() + interval '10 hours', 'active', tests.uid('coach'));

insert into public.challenge_participants (challenge_id, user_id, status)
values
  ('c0350000-0000-4000-8000-000000000001', tests.uid('m1'), 'active'),
  ('c0350000-0000-4000-8000-000000000003', tests.uid('m3'), 'active'),
  ('c0350000-0000-4000-8000-000000000004', tests.uid('m1'), 'active');

-- =====================================================================
-- challenge_progress_apply: running total and completion
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta) values ('c0350000-0000-4000-8000-000000000001', tests.uid('m1'), 60) $$,
  'm1 logs a first contribution to the individual_target challenge');
select results_eq(
  $$ select progress_value, status from public.challenge_participants where challenge_id = 'c0350000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  $$ values (60::numeric, 'active'::text) $$,
  'the trigger summed the delta into progress_value and left status active, below target');

select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta) values ('c0350000-0000-4000-8000-000000000001', tests.uid('m1'), 50) $$,
  'a second contribution crosses the 100 target');
select results_eq(
  $$ select progress_value, status, completed_at is not null from public.challenge_participants where challenge_id = 'c0350000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  $$ values (110::numeric, 'completed'::text, true) $$,
  'crossing target_value flips status to completed and stamps completed_at, total keeps summing past it');

select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta) values ('c0350000-0000-4000-8000-000000000001', tests.uid('m1'), -80) $$,
  'a later compensating negative delta is accepted (the log is append-only, corrections are new rows)');
select results_eq(
  $$ select progress_value, status from public.challenge_participants where challenge_id = 'c0350000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  $$ values (30::numeric, 'completed'::text) $$,
  'the negative correction lowers progress_value but a completed challenge never un-completes');

-- =====================================================================
-- challenge_progress_apply: cooperative milestone posts
-- =====================================================================
select tests.clear_auth();
insert into public.challenge_participants (challenge_id, user_id, status) values ('c0350000-0000-4000-8000-000000000002', tests.uid('m2'), 'active');
select tests.set_auth(tests.uid('m2'));

select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta) values ('c0350000-0000-4000-8000-000000000002', tests.uid('m2'), 650) $$,
  'm2 contributes 65% of the cooperative target in one delta');
select results_eq(
  $$ select count(*)::int from public.workout_posts where post_type = 'POST_CHALLENGE' and (metadata ->> 'challenge_id') = 'c0350000-0000-4000-8000-000000000002' $$,
  $$ values (2) $$,
  'a single contribution that crosses two thresholds at once (25% and 50%) posts both milestones in the same transaction');
select isnt_empty(
  $$ select 1 from public.workout_posts where post_type = 'POST_CHALLENGE' and author_id is null and (metadata ->> 'challenge_id') = 'c0350000-0000-4000-8000-000000000002' and (metadata ->> 'milestone')::int = 50 $$,
  'the milestone post is authorless (author_id null), matching the cooperative-post design');

select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta) values ('c0350000-0000-4000-8000-000000000002', tests.uid('m2'), 40) $$,
  'a further contribution that keeps the total above 50% does not cross a new threshold');
select results_eq(
  $$ select count(*)::int from public.workout_posts where post_type = 'POST_CHALLENGE' and (metadata ->> 'challenge_id') = 'c0350000-0000-4000-8000-000000000002' $$,
  $$ values (2) $$,
  'still exactly two milestone posts - no repeat post for a threshold already crossed');

-- =====================================================================
-- chal_record_progress: the coach-entry write path (COMM-206)
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.chal_record_progress('c0350000-0000-4000-8000-000000000003', tests.uid('m3'), 10, 'video count') $$,
  'P0001',
  'not authorized',
  'a plain member without community.challenge.create cannot use the coach-entry path');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.chal_record_progress('c0350000-0000-4000-8000-000000000003', tests.uid('m2'), 10, null) $$,
  'P0001',
  'not an active participant',
  'the coach cannot log progress for someone who never joined the challenge');

select lives_ok(
  $$ select public.chal_record_progress('c0350000-0000-4000-8000-000000000003', tests.uid('m3'), 25, 'counted from video') $$,
  'the coach records progress for an active participant');
select results_eq(
  $$ select source_type, entered_by, note from public.challenge_progress where challenge_id = 'c0350000-0000-4000-8000-000000000003' and user_id = tests.uid('m3') $$,
  $$ values ('coach_entry'::text, tests.uid('coach'), 'counted from video'::text) $$,
  'the written row is source_type coach_entry, stamped with the coach as entered_by, note preserved');
select results_eq(
  $$ select progress_value from public.challenge_participants where challenge_id = 'c0350000-0000-4000-8000-000000000003' and user_id = tests.uid('m3') $$,
  $$ values (25::numeric) $$,
  'the coach entry applied through challenge_progress_apply exactly like a self-insert');

select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, entered_by) values ('c0350000-0000-4000-8000-000000000003', tests.uid('m3'), tests.uid('coach')) $$,
  '42501',
  null,
  'a member cannot self-insert with entered_by set to anyone, coach included - only chal_record_progress may set that column');

-- =====================================================================
-- COMM-208: notif_on_challenge_join - batched, others only, never the joiner
-- =====================================================================
select tests.clear_auth();
insert into public.challenges (id, title, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
  values ('c0350000-0000-4000-8000-000000000005', 'Join fanout', 'individual_target', 'session_count', 10, now() - interval '1 day', now() + interval '20 days', 'active', tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id, status) values ('c0350000-0000-4000-8000-000000000005', tests.uid('m1'), 'active');

select is_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('m1') and type = 'challenge_update' $$,
  'before anyone else joins, m1 has no challenge_update notification at all');

insert into public.challenge_participants (challenge_id, user_id, status) values ('c0350000-0000-4000-8000-000000000005', tests.uid('m2'), 'active');

select is_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('m2') and type = 'challenge_update' $$,
  'COMM-208: the joiner (m2) never gets an immediate notifications row about their own join');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m2') and category = 'challenges' $$,
  'COMM-208: the joiner is never enqueued into their own batch either');
select isnt_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m1') and category = 'challenges' $$,
  'COMM-208: the existing participant (m1) is enqueued into a batched challenges entry when m2 joins');
select results_eq(
  $$ select (pending #>> array['challenge_update', 'count'])::int from public.notification_batches where user_id = tests.uid('m1') and category = 'challenges' $$,
  $$ values (1) $$,
  'exactly one challenge_update pending for m1 after one join event');
select is_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('m1') and type = 'challenge_update' $$,
  'COMM-208: routing is batched, never an immediate notifications row for a join');

insert into public.challenge_participants (challenge_id, user_id, status) values ('c0350000-0000-4000-8000-000000000005', tests.uid('m3'), 'active');
select results_eq(
  $$ select (pending #>> array['challenge_update', 'count'])::int from public.notification_batches where user_id = tests.uid('m1') and category = 'challenges' $$,
  $$ values (2) $$,
  'a third join increments the same pending counter rather than adding a second batch row');
select results_eq(
  $$ select (pending #>> array['challenge_update', 'count'])::int from public.notification_batches where user_id = tests.uid('m2') and category = 'challenges' $$,
  $$ values (1) $$,
  'm2 (already a participant by now) is enqueued once for m3 joining');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m3') and category = 'challenges' $$,
  'm3, the newest joiner, still has nothing queued about their own join');

-- =====================================================================
-- COMM-208: notif_on_challenge_complete - real transition only, never actor
-- =====================================================================
select tests.clear_auth();
insert into public.challenges (id, title, challenge_type, metric_type, target_value, start_at, end_at, status, created_by)
  values ('c0350000-0000-4000-8000-000000000006', 'Complete fanout', 'individual_target', 'session_count', 5, now() - interval '1 day', now() + interval '20 days', 'active', tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id, status) values
  ('c0350000-0000-4000-8000-000000000006', tests.uid('m1'), 'active'),
  ('c0350000-0000-4000-8000-000000000006', tests.uid('m2'), 'active');

-- Drain the join-fanout batch this insert itself just queued, so the
-- completion assertions below start from a clean, known count.
update public.notification_batches set pending = '{}'::jsonb where category = 'challenges';

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta) values ('c0350000-0000-4000-8000-000000000006', tests.uid('m1'), 3) $$,
  'm1 logs progress that does not yet reach target - no completion transition');
select tests.clear_auth();
select results_eq(
  $$ select coalesce((pending #>> array['challenge_update', 'count'])::int, 0) from public.notification_batches where user_id = tests.uid('m2') and category = 'challenges' $$,
  $$ values (0) $$,
  'an UPDATE that touches status without an actual completed transition (challenge_progress_apply''s own UPDATE always sets status) enqueues nothing - the guard is old.status <> completed, new.status = completed');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta) values ('c0350000-0000-4000-8000-000000000006', tests.uid('m1'), 5) $$,
  'm1 crosses the target - a genuine completion transition');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m1') and category = 'challenges' and pending ? 'challenge_update' $$,
  'COMM-208: the completer (m1) never gets a challenge_update entry about their own completion');
select results_eq(
  $$ select (pending #>> array['challenge_update', 'count'])::int from public.notification_batches where user_id = tests.uid('m2') and category = 'challenges' $$,
  $$ values (1) $$,
  'COMM-208: the other active participant (m2) is enqueued once for m1''s completion');

-- =====================================================================
-- chal_notify_ending_soon: service_role only, idempotent
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.chal_notify_ending_soon() $$,
  '42501',
  null,
  'chal_notify_ending_soon is not callable by authenticated');
select tests.clear_auth();

select pg_catalog.set_config('role', 'service_role', true);
select results_eq(
  $$ select public.chal_notify_ending_soon() $$,
  $$ values (1) $$,
  'one active participant (m1) on the one challenge ending within 48h gets an immediate notification, and the function reports one write');
select isnt_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('m1') and type = 'challenge_ending_soon' and source_id = 'c0350000-0000-4000-8000-000000000004' $$,
  'the ending_soon notification actually landed for the right participant and challenge');
select results_eq(
  $$ select ending_soon_notified_at is not null from public.challenges where id = 'c0350000-0000-4000-8000-000000000004' $$,
  $$ values (true) $$,
  'the challenge is stamped so it is not re-selected');
select results_eq(
  $$ select public.chal_notify_ending_soon() $$,
  $$ values (0) $$,
  'a second call after stamping is a no-op - zero writes, no duplicate notification');
select results_eq(
  $$ select count(*)::int from public.notifications where user_id = tests.uid('m1') and type = 'challenge_ending_soon' $$,
  $$ values (1) $$,
  'still exactly one ending_soon notification after the second, no-op call');
select pg_catalog.set_config('role', 'postgres', true);

-- =====================================================================
-- 202608290012: notif_create's service_role grant
-- =====================================================================
select results_eq(
  $$ select has_function_privilege('service_role', 'public.notif_create(uuid, text, text, text, text, text, uuid, text)', 'execute') $$,
  $$ values (true) $$,
  'service_role can execute notif_create directly over PostgREST - the grant recap_weekly needs to actually send a weekly_recap notification');
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.notif_create(uuid, text, text, text, text, text, uuid, text)', 'execute') $$,
  $$ values (false) $$,
  'authenticated still cannot call notif_create directly - the service_role grant did not widen the client boundary');

select * from finish();
rollback;
