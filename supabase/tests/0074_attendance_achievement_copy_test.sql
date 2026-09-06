-- Launch-readiness audit, finding 9 (202609060008). The four live attendance
-- achievements carry real Hebrew copy and an icon.
--
-- WHAT WAS BROKEN. 202608280007 seeded them as English placeholders with no
-- icon and enabled = false. 202608310007 built the attendance source and
-- flipped exactly the flag that migration's comment promised
-- (`set enabled = true where trigger_type = 'ATTENDANCE_RECORDED'`) without
-- coming back for the copy - so four placeholders became four live producers
-- in one statement. attendance_first_class has threshold 1, so it fires for
-- essentially every member on their first synced session, and the English
-- reached the unlock sheet, "ההישגים שלי", the notification, the monthly
-- recap, and metadata.milestone_label on the club feed card.
--
-- This file asserts the copy is Hebrew and complete, and - more usefully for
-- the next reader - asserts the two structural properties that would have
-- caught it automatically: no enabled definition may lack an icon, and none
-- may still read as ASCII-only Latin text.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. The four rows, by code
-- =====================================================================
select results_eq(
  $$ select code, name, description, icon
     from public.achievement_definitions
     where trigger_type = 'ATTENDANCE_RECORDED'
     order by code $$,
  $$ values
     ('attendance_100_classes', '100 שיעורים',   'נוכחות ב-100 שיעורים במועדון',     '💯'),
     ('attendance_25_classes',  '25 שיעורים',    'נוכחות ב-25 שיעורים במועדון',      '💪'),
     ('attendance_first_class', 'השיעור הראשון', 'השתתפות ראשונה בשיעור במועדון',    '👋'),
     ('attendance_weekly_streak', 'רצף שבועי',   'נוכחות בכל שבוע, ארבעה שבועות ברצף', '⚡') $$,
  'all four ATTENDANCE_RECORDED definitions carry real Hebrew name, description and icon - they were English placeholders with a null icon while already live');

-- =====================================================================
-- 2. The structural rules that would have caught this on their own
-- =====================================================================
select is(
  (select count(*)::int from public.achievement_definitions
   where enabled and (icon is null or btrim(icon) = '')), 0,
  'no ENABLED definition anywhere in the table is missing an icon - a definition without one renders as a blank badge on every surface that prints icon || name');
select is(
  (select count(*)::int from public.achievement_definitions
   where enabled and name ~ '^[\x20-\x7E]+$'), 0,
  'and no enabled definition''s name is still pure ASCII - every member-visible label in this app is Hebrew, so a Latin-only name is a placeholder that escaped');
select is(
  (select count(*)::int from public.achievement_definitions
   where enabled and description <> '' and description ~ '^[\x20-\x7E]+$'), 0,
  'and the same for descriptions');

-- =====================================================================
-- 3. What was deliberately NOT touched
-- =====================================================================
-- This is a copy fix. Changing threshold would silently re-arm or disarm a
-- producer; config is empty on all four because none is client_claimable -
-- the count comes from attendance_log, which the browser cannot compute.
select results_eq(
  $$ select code, threshold::int, repeatable, enabled, category, trigger_type, config::text
     from public.achievement_definitions
     where trigger_type = 'ATTENDANCE_RECORDED'
     order by code $$,
  $$ values
     ('attendance_100_classes',   100, false, true, 'consistency', 'ATTENDANCE_RECORDED', '{}'),
     ('attendance_25_classes',     25, false, true, 'consistency', 'ATTENDANCE_RECORDED', '{}'),
     ('attendance_first_class',     1, false, true, 'consistency', 'ATTENDANCE_RECORDED', '{}'),
     ('attendance_weekly_streak',   4, true,  true, 'consistency', 'ATTENDANCE_RECORDED', '{}') $$,
  'threshold, repeatable, enabled, category, trigger_type and config are all exactly as 202608280007 and 202608310007 left them - none of them is copy');
select is(
  (select count(*)::int from public.achievement_definitions
   where trigger_type = 'ATTENDANCE_RECORDED' and (config ? 'client_claimable')), 0,
  'and none of the four is client_claimable, because the count comes from attendance_log rather than from anything the browser holds');

-- =====================================================================
-- 4. The copy really is what the live surfaces print
-- =====================================================================
-- attendance_milestones_on_log stamps metadata.milestone_label from the
-- definition's own `name` on purpose, so the feed card and the profile badge
-- can never announce two different things. That is exactly why the English
-- leaked as far as it did, and exactly why fixing the row fixes the card.
select tests.clear_auth();
-- show_attendance defaults to false and attendance_milestones_on_log reads it
-- straight off the member's own row as a write-time gate, so the post only
-- exists for a member who opted in. Opting m1 in is what makes the card
-- reachable at all here.
update public.profiles set show_attendance = true where id = tests.uid('m1');
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m1'), current_date - (g * 11) from generate_series(24, 1, -1) g;
insert into public.attendance_log (user_id, occurred_on) values (tests.uid('m1'), current_date);

select is(
  (select p.metadata ->> 'milestone_label' from public.workout_posts p
   where p.post_type = 'POST_ATTENDANCE_MILESTONE'
     and (p.metadata ->> 'member_id') = tests.uid('m1')::text),
  '25 שיעורים',
  'a real 25-class crossing now posts a Hebrew milestone_label to the club feed - the same card said "25 classes" in the middle of a Hebrew feed before this migration');
select is(
  (select d.name from public.achievement_definitions d
   join public.member_achievements ma on ma.achievement_id = d.id
   where ma.user_id = tests.uid('m1') and d.code = 'attendance_first_class'),
  'השיעור הראשון',
  'and the unlock the member actually earned - threshold 1, so essentially every member gets it on their first synced session - now resolves to Hebrew through the definition the client already fetches');

select * from finish();
rollback;
