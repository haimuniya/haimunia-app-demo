-- Coverage for the 202609050001..202609050005 batch:
--
--   0001  admin_actions.action_type admits 'member_password_reset'
--   0002  reports.target_type admits 'profile'; report() validates a profile
--         target and leaves post_id null; mod_queue() and mod_review()
--         understand a profile target
--   0003  AFTER INSERT on reports notifies the club's moderators through
--         notif_create(), once per moderator, de-duped per TARGET
--   0004  events.map_link must be null or http(s)
--   0005  retention_purge_telemetry() deletes past the window and keeps
--         inside it; the seven+one cron jobs exist; cron_invoke_edge_function
--         refuses to fire on placeholder secrets and refuses a bad slug
--
-- The feed_impressions grant revoke from 0005 is asserted in
-- supabase/tests/0006_feed_telemetry_test.sql, next to the telemetry
-- boundaries it changes, rather than duplicated here.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 202609050001 - the password-reset audit label
-- =====================================================================
-- Inserted as the bootstrap superuser: admin_actions has no INSERT grant and
-- no INSERT policy for any client role (log_admin_action is the only writer),
-- so this asserts the CHECK constraint and nothing else.
select tests.clear_auth();
select lives_ok(
  $$ insert into public.admin_actions (admin_id, action_type, target_type, target_id)
     values (tests.uid('admin'), 'member_password_reset', 'member', tests.uid('m1')) $$,
  'admin_actions accepts action_type = member_password_reset against target_type = member');
select throws_ok(
  $$ insert into public.admin_actions (admin_id, action_type, target_type, target_id)
     values (tests.uid('admin'), 'member_password_resetx', 'member', tests.uid('m1')) $$,
  '23514',
  null,
  'and the list is still closed - a near-miss label is refused');
select lives_ok(
  $$ insert into public.admin_actions (admin_id, action_type, target_type, target_id)
     values (tests.uid('admin'), 'onboarding_content_updated', 'onboarding_step', null) $$,
  'the widening did not drop a previously legal label');

-- admin_log_password_reset(): the only thing that can write that row.
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_log_password_reset(tests.uid('m2')) $$,
  'P0001',
  'not authorized',
  'a plain member cannot write a password-reset audit row');
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.admin_log_password_reset(tests.uid('m2')) $$,
  'P0001',
  'not authorized',
  'and neither can a coach - the gate is real profiles.is_admin, not is_staff()');
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.admin_log_password_reset('00000000-0000-4000-8000-0000000000fe') $$,
  'P0001',
  'member not found',
  'an admin cannot log a reset against a member who does not exist');
select lives_ok(
  $$ select public.admin_log_password_reset(tests.uid('m2')) $$,
  'an admin can log a reset');
select tests.clear_auth();
select results_eq(
  $$ select admin_id from public.admin_actions
     where action_type = 'member_password_reset' and target_id = tests.uid('m2') $$,
  $$ select tests.uid('admin') $$,
  'and the row names the ACTING ADMIN, taken from auth.uid() and never from an argument');
select results_eq(
  $$ select before_data is null and after_data = '{"method": "admin_temp_password"}'::jsonb
     from public.admin_actions
     where action_type = 'member_password_reset' and target_id = tests.uid('m2') $$,
  $$ values (true) $$,
  'with no credential material in either blob');

-- =====================================================================
-- 202609050002 - profile as a report target
-- =====================================================================
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body)
values ('b0630000-0000-4000-8000-000000000001', tests.uid('m2'), 'club', 'P1 (post target)');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.report('profile', tests.uid('m2'), 'harassment', 'the bio is abusive') $$,
  'a member can report a PROFILE');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.reports
     where target_type = 'profile' and target_id = tests.uid('m2') $$,
  $$ values (1) $$,
  'and the row lands with target_type = profile');
select results_eq(
  $$ select post_id is null from public.reports
     where target_type = 'profile' and target_id = tests.uid('m2') $$,
  $$ values (true) $$,
  'post_id stays NULL for a profile report, the way it already does for a comment report');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.report('member', tests.uid('m3'), 'spam', '') $$,
  'P0001',
  'unknown target type member',
  'the target_type list is still closed - only post, comment and profile');
select throws_ok(
  $$ select public.report('profile', '00000000-0000-4000-8000-0000000000ff', 'spam', '') $$,
  'P0001',
  'target not found',
  'a profile that does not exist is refused with the same message a missing post gets');

-- A soft-deleted member is not reportable.
select tests.clear_auth();
update public.profiles set deleted_at = now() where id = tests.uid('m3');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.report('profile', tests.uid('m3'), 'spam', '') $$,
  'P0001',
  'target not found',
  'a soft-deleted profile is not reportable');
select tests.clear_auth();
update public.profiles set deleted_at = null where id = tests.uid('m3');

-- mod_queue understands the new target type.
select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select content_author_id from public.mod_queue('all', null, 50)
     where target_type = 'profile' and target_id = tests.uid('m2') $$,
  $$ select tests.uid('m2') $$,
  'mod_queue reports a profile as its OWN author, so the queue''s member controls work unchanged');
select ok(
  (select content_excerpt like 'Member B%'
   from public.mod_queue('all', null, 50)
   where target_type = 'profile' and target_id = tests.uid('m2')),
  'and the excerpt is the reported member''s own profile text, not an empty string');

-- mod_review understands it too.
select throws_ok(
  $$ select public.mod_review(
       (select id from public.reports where target_type = 'profile' and target_id = tests.uid('m2')),
       'remove', 'nothing to remove', null) $$,
  'P0001',
  'a profile report has no content to remove',
  'remove is refused by name on a profile target rather than raising "comment not found"');
select lives_ok(
  $$ select public.mod_review(
       (select id from public.reports where target_type = 'profile' and target_id = tests.uid('m2')),
       'restrict_permanent', 'abusive bio', null) $$,
  'restrict_permanent is the decision that DOES work on a profile report');
select ok(
  public.is_posting_restricted(tests.uid('m2')),
  'and it restricts the reported member, because a profile is its own author');
select results_eq(
  $$ select status::text from public.reports
     where target_type = 'profile' and target_id = tests.uid('m2') $$,
  $$ values ('action_taken') $$,
  'the report group is stamped action_taken like any other decided report');

-- =====================================================================
-- 202609050003 - the moderator alert trigger
-- =====================================================================
-- The fixture club has exactly three members who can act on the queue:
-- coach (role coach holds community.comment.moderate), admin (profiles.is_admin)
-- and owner (role owner short-circuits every permission).
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.mod_alert_recipients(
       (select club_id from public.profiles where id = tests.uid('m1'))) $$,
  $$ values (3) $$,
  'mod_alert_recipients finds exactly the coach, the admin and the owner');
select set_eq(
  $$ select * from public.mod_alert_recipients(
       (select club_id from public.profiles where id = tests.uid('m1'))) $$,
  $$ values (tests.uid('coach')), (tests.uid('admin')), (tests.uid('owner')) $$,
  'and nobody else - a plain member is not a recipient');

-- The profile report m1 filed above already fired the trigger once.
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'new_report' and source_id = tests.uid('m2') $$,
  $$ values (3) $$,
  'one new_report notification per moderator, from the profile report filed earlier');
select is_empty(
  $$ select 1 from public.notifications
     where type = 'new_report' and user_id = tests.uid('m1') $$,
  'the reporter is never notified about their own report');
select results_eq(
  $$ select distinct source_type from public.notifications where type = 'new_report' $$,
  $$ values ('profile') $$,
  'source_type carries the reported target type, not the literal "report"');
select results_eq(
  $$ select distinct deep_link from public.notifications where type = 'new_report' $$,
  $$ select '/community/account?user=' || tests.uid('m2')::text $$,
  'and the deep link points at the reported profile');

-- A SECOND reporter on the SAME target inside notif_dedupe_window() must not
-- produce a second round of pings: notif_create de-dupes on
-- (user, type, source_id), and source_id is the target.
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.report('profile', tests.uid('m2'), 'spam', 'same target, different reporter') $$,
  'a second member reports the same profile');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.reports
     where target_type = 'profile' and target_id = tests.uid('m2') $$,
  $$ values (2) $$,
  'which really is a second report row');
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'new_report' and source_id = tests.uid('m2') $$,
  $$ values (3) $$,
  'but still only three notifications - a pile-on on one target pings each moderator once');

-- A DIFFERENT target does alert again.
select tests.set_auth(tests.uid('m1'));
select public.report('post', 'b0630000-0000-4000-8000-000000000001', 'spam', '');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'new_report' and source_id = 'b0630000-0000-4000-8000-000000000001' $$,
  $$ values (3) $$,
  'a report on a different target alerts the same three moderators again');
select results_eq(
  $$ select distinct deep_link from public.notifications
     where type = 'new_report' and source_id = 'b0630000-0000-4000-8000-000000000001' $$,
  $$ values ('/community/feed?post=b0630000-0000-4000-8000-000000000001') $$,
  'with the post deep link this time');

-- The ON CONFLICT path in report() must stay silent.
select tests.set_auth(tests.uid('m1'));
select public.report('post', 'b0630000-0000-4000-8000-000000000001', 'harassment', 'changed my mind about the reason');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.reports
     where target_type = 'post' and target_id = 'b0630000-0000-4000-8000-000000000001' $$,
  $$ values (1) $$,
  'the same reporter re-reporting the same target still UPSERTs to one row');
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'new_report' and source_id = 'b0630000-0000-4000-8000-000000000001' $$,
  $$ values (3) $$,
  'and fires no trigger at all - ON CONFLICT DO UPDATE is an UPDATE, not an INSERT');

-- The fan-out helpers are reachable by nobody.
select ok(
  not has_function_privilege('authenticated', 'public.mod_alert_recipients(uuid)', 'EXECUTE'),
  'mod_alert_recipients is granted to no client role');
select ok(
  not has_function_privilege('authenticated', 'public.notif_on_report()', 'EXECUTE'),
  'notif_on_report is granted to no client role');

-- =====================================================================
-- 202609050004 - events.map_link scheme
-- =====================================================================
select tests.clear_auth();
select throws_ok(
  $$ insert into public.events (title, event_type, start_at, map_link, created_by)
     values ('E1', 'other', now() + interval '1 day', 'javascript:alert(1)', tests.uid('admin')) $$,
  '23514',
  null,
  'a javascript: map_link is refused by the CHECK, not by the UI');
select throws_ok(
  $$ insert into public.events (title, event_type, start_at, map_link, created_by)
     values ('E2', 'other', now() + interval '1 day', 'javascript:void(0)//https://maps.example', tests.uid('admin')) $$,
  '23514',
  null,
  'and the anchor means an http(s) substring later in the string does not rescue it');
select throws_ok(
  $$ insert into public.events (title, event_type, start_at, map_link, created_by)
     values ('E3', 'other', now() + interval '1 day', 'maps.example/here', tests.uid('admin')) $$,
  '23514',
  null,
  'a scheme-less link is refused too');
select lives_ok(
  $$ insert into public.events (title, event_type, start_at, map_link, created_by)
     values ('E4', 'other', now() + interval '1 day', 'https://maps.example/here', tests.uid('admin')) $$,
  'https is accepted');
select lives_ok(
  $$ insert into public.events (title, event_type, start_at, map_link, created_by)
     values ('E5', 'other', now() + interval '1 day', 'HTTP://MAPS.EXAMPLE/HERE', tests.uid('admin')) $$,
  'and the check is case-insensitive');
select lives_ok(
  $$ insert into public.events (title, event_type, start_at, map_link, created_by)
     values ('E6', 'other', now() + interval '1 day', null, tests.uid('admin')) $$,
  'null is still allowed - map_link is optional');
select throws_ok(
  $$ insert into public.events (title, event_type, start_at, map_link, created_by)
     values ('E7', 'other', now() + interval '1 day', 'https://' || repeat('x', 500), tests.uid('admin')) $$,
  '23514',
  null,
  'and the 500-character length rule survived the widening');

-- =====================================================================
-- 202609050005 - retention purge, grants, and the schedule
-- =====================================================================
select tests.clear_auth();
delete from public.feed_impressions;
delete from public.analytics_events;

insert into public.feed_impressions (user_id, post_id, "position", feed_session_id, shown_at)
values
  (tests.uid('m1'), 'b0630000-0000-4000-8000-000000000001', 0,
   '00000000-0000-4000-8000-0000000000b1', now() - interval '200 days'),
  (tests.uid('m1'), 'b0630000-0000-4000-8000-000000000001', 0,
   '00000000-0000-4000-8000-0000000000b2', now() - interval '2 days');
insert into public.analytics_events (user_id, event_name, created_at)
values
  (tests.uid('m1'), 'feed_viewed', now() - interval '200 days'),
  (tests.uid('m1'), 'feed_viewed', now() - interval '2 days');

select results_eq(
  $$ select public.retention_purge_telemetry(90) $$,
  $$ values (2) $$,
  'retention_purge_telemetry returns the TOTAL rows deleted across both tables');
select results_eq(
  $$ select count(*)::int from public.feed_impressions $$,
  $$ values (1) $$,
  'the impression inside the window survives');
select results_eq(
  $$ select count(*)::int from public.analytics_events $$,
  $$ values (1) $$,
  'so does the analytics event inside the window');
select results_eq(
  $$ select public.retention_purge_telemetry(90) $$,
  $$ values (0) $$,
  'and a second pass deletes nothing - the job is safe to run on any schedule');
select results_eq(
  $$ select public.retention_purge_telemetry(1) $$,
  $$ values (2) $$,
  'p_days really is the window: narrowing it to 1 day takes the two-day-old rows');

select ok(
  not has_function_privilege('authenticated', 'public.retention_purge_telemetry(integer)', 'EXECUTE'),
  'retention_purge_telemetry is granted to no client role');
select ok(
  not has_function_privilege('authenticated', 'public.cron_invoke_edge_function(text)', 'EXECUTE'),
  'cron_invoke_edge_function is granted to no client role');

-- The Edge Function bridge, with the committed placeholder secrets still in
-- place - which is the state of every local and CI stack.
select ok(
  public.cron_invoke_edge_function('recap_weekly') is null,
  'cron_invoke_edge_function makes no request and returns null while the Vault secrets are placeholders');
select throws_ok(
  $$ select public.cron_invoke_edge_function('https://evil.example/x') $$,
  'P0001',
  null,
  'and a slug that is not a bare function name is refused, so the call cannot be redirected');
select results_eq(
  $$ select count(*)::int from vault.secrets
     where name in ('edge_functions_base_url', 'edge_functions_service_role_key') $$,
  $$ values (2) $$,
  'both Vault secret slots exist for an operator to fill in on the live project');

-- The schedule itself.
-- REVISED by 202609060015 (FEAT-010). 'feed-weights-recompute' is
-- deliberately NOT in this list any more: recompute_feed_weights() has an
-- intentionally empty body (202608310006 calls itself "A DELIBERATE NO-OP
-- STUB"), so scheduling it produced a weekly green cron row for a feature
-- that was never built - which reads as "personalized ranking works" to
-- anyone checking cron.job_run_details. Its absence is now the assertion.
-- 202609060011/14/15 also added purge-due-accounts, idempotency-purge and
-- community-health, so the set is nine.
select set_eq(
  $$ select jobname from cron.job where jobname in (
       'notif-batch-flush', 'recap_monthly', 'feed-weights-recompute',
       'chal-notify-ending-soon', 'coach-engagement-decline',
       'purge-abandoned-profiles', 'recap-weekly', 'telemetry-retention-purge',
       'purge-due-accounts', 'idempotency-purge', 'community-health') $$,
  $$ values ('notif-batch-flush'), ('recap_monthly'),
            ('chal-notify-ending-soon'), ('coach-engagement-decline'),
            ('purge-abandoned-profiles'), ('recap-weekly'), ('telemetry-retention-purge'),
            ('purge-due-accounts'), ('idempotency-purge'), ('community-health') $$,
  'the nine live jobs are scheduled, and the no-op feed-weights stub is not among them');
select results_eq(
  $$ select schedule from cron.job where jobname = 'notif-batch-flush' $$,
  $$ values ('*/15 * * * *') $$,
  'the batch flusher runs on the 15-minute cadence 202608280028 wrote down');
select results_eq(
  $$ select schedule from cron.job where jobname = 'recap_monthly' $$,
  $$ values ('41 4 1 * *') $$,
  'the monthly recap runs on the cadence 202609010002 wrote down');
-- REVISED by 202609060015 (FEAT-010): unscheduled, so it has no cadence.
-- The function is deliberately KEPT (removing it was not the fix) - only
-- its misleading schedule was removed.
select is_empty(
  $$ select 1 from cron.job where jobname = 'feed-weights-recompute' $$,
  'the feed-weight recompute has no schedule at all - a green weekly row for an unbuilt feature is worse than no row');
select has_function('public', 'recompute_feed_weights', array['integer'],
  'while the stub function itself is retained for whoever builds the derivation');
select is_empty(
  $$ select 1 from cron.job where jobname in (
       'notif-batch-flush', 'recap_monthly', 'feed-weights-recompute',
       'chal-notify-ending-soon', 'coach-engagement-decline',
       'purge-abandoned-profiles', 'recap-weekly', 'telemetry-retention-purge')
     and not active $$,
  'and every one of them is active');

select * from finish();
rollback;
