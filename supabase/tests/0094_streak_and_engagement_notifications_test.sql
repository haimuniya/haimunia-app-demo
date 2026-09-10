-- Community structure research, 2026-09-10: two new scheduled notification
-- jobs closing the "weak retention loop" and "coach tooling is proactive but
-- still pull-only" gaps that research pass found. Covers:
--   notif_streak_at_risk()          - 202609100002
--   coach_notify_engagement_flags() - 202609100002
-- plus the two new club_features toggles gating each ('streak_risk_nudges',
-- 'engagement_alerts').

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- Called the way the scheduler would: as service_role, the only role either
-- function grants execute to. Same shape 0044 uses for
-- coach_detect_engagement_decline and 0035 uses for chal_notify_ending_soon.
create or replace function tests.run_streak_job() returns integer
language plpgsql as $fn$
declare v_n integer;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v_n := public.notif_streak_at_risk();
  perform pg_catalog.set_config('role', 'postgres', true);
  return v_n;
end $fn$;
grant execute on function tests.run_streak_job() to anon, authenticated, service_role;

create or replace function tests.run_engagement_notify_job() returns integer
language plpgsql as $fn$
declare v_n integer;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v_n := public.coach_notify_engagement_flags();
  perform pg_catalog.set_config('role', 'postgres', true);
  return v_n;
end $fn$;
grant execute on function tests.run_engagement_notify_job() to anon, authenticated, service_role;

-- =====================================================================
-- 1. notif_streak_at_risk() - the retention job
-- =====================================================================

-- m2: a real 3-day streak ending YESTERDAY - has not opened the app yet
-- today. This is the one member who should be notified.
insert into public.activity_pings (user_id, activity_date) values
  (tests.uid('m2'), current_date - 1),
  (tests.uid('m2'), current_date - 2),
  (tests.uid('m2'), current_date - 3);

-- m1: opened the app TODAY. Streak is not at risk regardless of length.
insert into public.activity_pings (user_id, activity_date) values
  (tests.uid('m1'), current_date),
  (tests.uid('m1'), current_date - 1),
  (tests.uid('m1'), current_date - 2);

-- m3: a 2-day streak ending yesterday - real, but under the 3-day floor.
insert into public.activity_pings (user_id, activity_date) values
  (tests.uid('m3'), current_date - 1),
  (tests.uid('m3'), current_date - 2);

-- coach: a 3-day streak, but broken TWO days ago (last activity is
-- current_date - 2, not current_date - 1) - already reset to 0 by
-- community_streaks()'s own rule, so must not be notified either.
insert into public.activity_pings (user_id, activity_date) values
  (tests.uid('coach'), current_date - 2),
  (tests.uid('coach'), current_date - 3),
  (tests.uid('coach'), current_date - 4);

select is(tests.run_streak_job(), 1, 'exactly one member (m2) is at risk and gets notified');

select is(
  (select count(*)::int from public.notifications where type = 'streak_at_risk' and user_id = tests.uid('m2')), 1,
  'm2 has exactly one streak_at_risk notification');
select is(
  (select category from public.notifications where type = 'streak_at_risk' and user_id = tests.uid('m2')), 'training',
  'streak_at_risk is category training');
select ok(
  (select body from public.notifications where type = 'streak_at_risk' and user_id = tests.uid('m2')) like '3 %',
  'the body names the actual streak length (3 days)');

select is(
  (select count(*)::int from public.notifications where type = 'streak_at_risk' and user_id = tests.uid('m1')), 0,
  'm1 already opened the app today - not notified');
select is(
  (select count(*)::int from public.notifications where type = 'streak_at_risk' and user_id = tests.uid('m3')), 0,
  'm3''s streak (2 days) is under the 3-day floor - not notified');
select is(
  (select count(*)::int from public.notifications where type = 'streak_at_risk' and user_id = tests.uid('coach')), 0,
  'coach''s streak already broke two days ago (reset to 0) - not notified');

-- Idempotent within the dedupe window: running the same evening's job twice
-- must not double-notify m2.
select tests.run_streak_job();
select is(
  (select count(*)::int from public.notifications where type = 'streak_at_risk' and user_id = tests.uid('m2')), 1,
  'running the job again the same day does not double-notify - notif_create''s own dedupe window catches it');

-- The off switch. Disabling the module must make the job a true no-op, not
-- just suppress delivery - zero notifications written, for a club that
-- would otherwise have a fresh at-risk member.
delete from public.notifications where type = 'streak_at_risk';
delete from public.activity_pings where user_id = tests.uid('m1');
insert into public.activity_pings (user_id, activity_date) values
  (tests.uid('m1'), current_date - 1), (tests.uid('m1'), current_date - 2), (tests.uid('m1'), current_date - 3);
update public.club_features set enabled = false where module_key = 'streak_risk_nudges';
select is(tests.run_streak_job(), 0, 'disabled via club_features, the job writes nothing even though m1 now qualifies');
select is_empty(
  $$ select 1 from public.notifications where type = 'streak_at_risk' $$,
  'and no row exists for anyone');
update public.club_features set enabled = true where module_key = 'streak_risk_nudges';

-- =====================================================================
-- 2. coach_notify_engagement_flags() - the coach-tooling job
-- =====================================================================

-- One fresh open flag on m2 (a plain member - never a recipient of the
-- alert itself, only ever its subject).
insert into public.coach_engagement_flags (user_id, level, baseline_sessions_per_week, recent_sessions_per_week)
values (tests.uid('m2'), 'significant', 3.0, 1.0);

select is(tests.run_engagement_notify_job(), 3, 'fans out to exactly 3 recipients: coach, admin, owner');

select is(
  (select count(*)::int from public.notifications n
   join public.profiles p on p.id = n.user_id
   where n.type = 'engagement_decline_flagged' and p.handle in ('coach_x', 'admin_x', 'owner_x')), 3,
  'coach, admin and owner each got exactly one notification');
select is(
  (select count(*)::int from public.notifications where type = 'engagement_decline_flagged' and user_id = tests.uid('m2')), 0,
  'the flagged member themselves never receives this notification - PRIVACY.md: hidden from the member it is about');
select is(
  (select count(*)::int from public.notifications where type = 'engagement_decline_flagged' and user_id in (tests.uid('m1'), tests.uid('m3'))), 0,
  'plain members who are not staff receive nothing');
select ok(
  not exists (
    select 1 from public.notifications
    where type = 'engagement_decline_flagged'
      and (title ilike '%Member B%' or title ilike '%member_b%' or body ilike '%Member B%' or body ilike '%member_b%')
  ),
  'no notification carries the flagged member''s own name or handle');

select is(
  (select notified_at is not null from public.coach_engagement_flags where user_id = tests.uid('m2')), true,
  'the flag itself is stamped notified_at after the fan-out');

-- Running again must not re-notify: notified_at already set gates the loop,
-- same "notify once per flag row" contract the doc comment states.
delete from public.notifications where type = 'engagement_decline_flagged';
select is(tests.run_engagement_notify_job(), 0, 'a second run finds no un-notified open flags left - writes nothing');

-- A second, genuinely NEW flag (different member) is still caught.
insert into public.coach_engagement_flags (user_id, level, baseline_sessions_per_week, recent_sessions_per_week)
values (tests.uid('m3'), 'inactive', 2.5, 0);
select is(tests.run_engagement_notify_job(), 3, 'a later, separate flag on a different member still fans out to all 3 recipients');

-- The off switch, same shape as the streak job's own.
delete from public.notifications where type = 'engagement_decline_flagged';
update public.coach_engagement_flags set notified_at = null where user_id in (tests.uid('m2'), tests.uid('m3'));
update public.club_features set enabled = false where module_key = 'engagement_alerts';
select is(tests.run_engagement_notify_job(), 0, 'disabled via club_features, the job writes nothing even with open un-notified flags');
select is_empty(
  $$ select 1 from public.notifications where type = 'engagement_decline_flagged' $$,
  'and no row exists for anyone');
update public.club_features set enabled = true where module_key = 'engagement_alerts';

-- =====================================================================
-- 3. The toggles exist and are on by default (what the owner asked for)
-- =====================================================================
select is(
  (select enabled from public.club_features where club_id = public.default_club_id() and module_key = 'streak_risk_nudges'), true,
  'streak_risk_nudges seeds enabled - a migration must never silently turn a new feature off for a live club either');
select is(
  (select enabled from public.club_features where club_id = public.default_club_id() and module_key = 'engagement_alerts'), true,
  'engagement_alerts seeds enabled');
select is(
  (select public.club_feature_enabled('streak_risk_nudges')), true,
  'the read predicate agrees');
select is(
  (select public.club_feature_enabled('engagement_alerts')), true,
  'the read predicate agrees for the second toggle too');

select * from finish();
rollback;
