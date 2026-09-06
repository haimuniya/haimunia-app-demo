begin;

-- Launch-readiness audit, finding 9: four live achievements render in raw
-- English.
--
-- THE HISTORY, which is how this got missed. 202608280007 seeded the four
-- ATTENDANCE_RECORDED rows as deliberate placeholders - English name,
-- English description, NO icon, enabled = false - with a comment saying so
-- ("present, described, and disabled until an attendance source exists
-- (COMM-P03) ... Enabling them later is an UPDATE, not a migration").
-- 202608280020 then seeded all 27 real definitions in Hebrew with icons and
-- explicitly did not repeat these four ("they stay seeded and enabled =
-- false until COMM-P03"). 202608310007 built the attendance source and
-- flipped exactly the flag that comment promised:
--
--     update public.achievement_definitions set enabled = true
--     where trigger_type = 'ATTENDANCE_RECORDED' and not enabled;
--
-- It never came back for the copy. So four placeholder rows became four LIVE
-- producers on the same day, and they are not obscure ones:
-- attendance_first_class has threshold 1, so it fires for essentially every
-- member on their first synced session.
--
-- WHERE THE ENGLISH ACTUALLY SURFACES, all four already shipping:
--   * the unlock celebration sheet and "ההישגים שלי" (cloud.js achMeta()
--     falls through COMMUNITY_ACHIEVEMENT_META, which has no entry for any
--     of the four, to the bare CODE string - so a member sees the literal
--     text "attendance_first_class")
--   * the achievement notification
--   * the monthly recap, which can then be shared to the club feed as-is
--   * the milestone feed post attendance_milestones_on_log writes, whose
--     metadata.milestone_label is the definition's own `name` on purpose
--     ("so the post and the achievement badge on the member's profile can
--     never announce two different things") - so today that card says
--     "25 classes" in the middle of a Hebrew feed
--
-- THE COPY follows the 202608280020 / docs/community/achievement-seed.md
-- voice exactly: a short noun phrase for `name`, one unpunctuated clause for
-- `description`, one emoji for `icon`. The four icons chosen (👋 💪 💯 ⚡)
-- are checked against all 27 existing ones and collide with none, so a badge
-- is still identifiable at a glance in a list.
--
-- The wording distinguishes ATTENDANCE from LOGGING throughout - "שיעור"
-- and "נוכחות", never "רישום אימון". That distinction is the entire reason
-- these four exist beside sessions_25 / consistency_weeks_4 rather than
-- replacing them: those count what the member wrote in their own log, these
-- count verified attendance_log rows. Copy that blurred it would make two
-- different badges look like a duplicate.
--
-- attendance_weekly_streak is the repeatable one (threshold 4), and its
-- description says "ארבעה שבועות ברצף" rather than naming a total, because
-- 202608310007's fresh-crossing rule re-fires it on week 4 of each LATER run
-- after a streak is broken and rebuilt.
--
-- WHAT IS DELIBERATELY NOT TOUCHED: code, category, trigger_type, threshold,
-- repeatable, enabled, config. This is a copy fix. Changing `threshold`
-- would silently re-arm or disarm a producer, and `config` is empty on all
-- four on purpose - none is client_claimable, because the count comes from
-- attendance_log, which the browser cannot compute or inflate.
--
-- Idempotent and targeted: an UPDATE keyed by code, so a re-run converges
-- and a row that has since been edited by an admin through
-- achievement_definitions_update_admin is overwritten back to the shipped
-- copy, which is the intended behaviour for a seed correction.

update public.achievement_definitions set
  name = 'השיעור הראשון',
  description = 'השתתפות ראשונה בשיעור במועדון',
  icon = '👋'
where code = 'attendance_first_class';

update public.achievement_definitions set
  name = '25 שיעורים',
  description = 'נוכחות ב-25 שיעורים במועדון',
  icon = '💪'
where code = 'attendance_25_classes';

update public.achievement_definitions set
  name = '100 שיעורים',
  description = 'נוכחות ב-100 שיעורים במועדון',
  icon = '💯'
where code = 'attendance_100_classes';

update public.achievement_definitions set
  name = 'רצף שבועי',
  description = 'נוכחות בכל שבוע, ארבעה שבועות ברצף',
  icon = '⚡'
where code = 'attendance_weekly_streak';

-- A definition with no icon renders as a blank badge on every surface that
-- prints `icon || ' ' || name`. All four had one; nothing else in the table
-- should be able to reach production without one. This is an assertion, not
-- a fix - it fails the migration loudly rather than silently papering over a
-- fifth gap of the same kind.
do $$
declare v_missing text;
begin
  select string_agg(code, ', ' order by code) into v_missing
  from public.achievement_definitions
  where enabled and (icon is null or btrim(icon) = '');
  if v_missing is not null then
    raise exception 'enabled achievement definitions with no icon: %', v_missing;
  end if;
end $$;

commit;
