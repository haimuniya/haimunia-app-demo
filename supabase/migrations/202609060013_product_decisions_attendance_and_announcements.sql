begin;

-- Production-readiness audit, 2026-09-06, part 3. Resolves the two findings
-- the audit deliberately left as PRODUCT DECISIONS rather than deciding
-- unilaterally: SEC-009/PRIV-001 (who may read raw attendance) and SEC-010
-- (who may edit an announcement, and whether it is audited).
--
-- Both are decided here toward the safer option, per the standing tiebreak
-- rule: lower privacy exposure, lower security risk, stronger data
-- protection, easier rollback. Both are verified non-breaking against the
-- shipped client first - see each section for the evidence.

-- =====================================================================
-- DECISION 1 (SEC-009 / PRIV-001): raw attendance_log is admin-only.
-- =====================================================================
-- THE PROBLEM. attendance_log_staff_select (202608310001) was
-- `has_perm('community.analytics.view') OR is_staff()`, i.e. EVERY coach
-- (rank >= 20) could read every member's raw per-day attendance rows -
-- including members who had explicitly switched show_attendance OFF, a
-- toggle that defaults false and that community_streaks, feed_leaderboard,
-- recap_weekly_classmates and chal_progress all honour. Meanwhile
-- PRIVACY.md:60-70 tells members coaches see "your baseline rate and your
-- recent rate, NOT a detailed log". The written promise and the schema
-- disagreed.
--
-- THE OPTIONS.
--   (a) Keep the wide policy, and rewrite PRIVACY.md to admit coaches hold
--       raw read access. Cheapest, but it widens the disclosed privacy
--       exposure of a health-adjacent dataset to satisfy a capability
--       nothing actually uses.
--   (b) Narrow the policy to has_perm('community.analytics.view') - the
--       admin/owner permission - so the schema enforces what PRIVACY.md
--       already promises. Chosen.
--
-- WHY (b) IS NOT A BREAKING CHANGE, verified before writing it:
--   * The shipped client reads attendance_log in exactly one place
--     (cloud.js ~1262, `select occurred_on ... eq(user_id, own id)`), for
--     the first_class/third_class onboarding steps. That read is served by
--     attendance_log_self_select, which this migration does not touch.
--   * Every aggregate coach feature that consumes attendance - the
--     engagement-decline signal (202608310008), weekly/monthly recaps,
--     classmates, consistency streaks, the health score, feed weights -
--     runs inside SECURITY DEFINER functions, which execute as the function
--     owner and are not subject to this policy at all. Narrowing it cannot
--     affect them.
--   * So the capability being removed is one no shipped surface exercises:
--     a coach hand-querying PostgREST for another member's attendance rows.
--
-- ROLLBACK is a one-line policy swap back to the OR form.
drop policy if exists attendance_log_staff_select on public.attendance_log;
create policy attendance_log_staff_select on public.attendance_log for select to authenticated
  using (public.has_perm('community.analytics.view'));

comment on table public.attendance_log is
  'Verified class attendance, one row per member per training day. READ ACCESS: a member reads their own rows (attendance_log_self_select); raw cross-member reads require community.analytics.view (admin/owner) as of 202609060013 - NOT plain coach rank, which is what PRIVACY.md has always promised members. Coach-facing attendance features (engagement decline, recaps, classmates, streaks, health score) read this table through SECURITY DEFINER functions instead, which is what lets them stay aggregate-only. WRITES are trigger-only, from private_records_attendance_log.';

-- =====================================================================
-- DECISION 2 (SEC-010): an announcement is editable by its author or an
-- admin, and a cross-author edit is audited.
-- =====================================================================
-- THE PROBLEM. announcements_update_admin (202608270006) was
-- `using (is_staff()) with check (is_staff())` - no author scope at all,
-- asymmetric with the INSERT policy immediately above it which DOES require
-- author_id = auth.uid(). There is no DELETE grant, so removal is a soft
-- delete via deleted_at, which is an UPDATE and therefore equally open. And
-- announcements writes never call log_admin_action(), so one coach editing
-- or removing another coach's (or an admin's) announcement left no trace.
--
-- THE OPTIONS.
--   (a) Leave it. Defensible in a small trusted-coach club, but it is an
--       unaudited cross-author content-mutation path, which is exactly the
--       shape of an insider finding, and it contradicts its own INSERT
--       policy one line above.
--   (b) Scope UPDATE to the author, plus admins for the cases where
--       somebody has to be able to fix or pull a colleague's post, and log
--       an admin_actions row whenever the editor is not the author. Chosen.
--
-- WHY (b) IS NOT A BREAKING CHANGE, verified before writing it: the shipped
-- client never updates announcements at all. `grep -n 'from("announcements")'
-- cloud.js` returns exactly two call sites - a select (1603) and an insert
-- (1635). No edit UI, no delete UI, no soft-delete call. So this policy
-- governs a path only a hand-written PostgREST call can reach today, and
-- tightening it removes no shipped behaviour.
--
-- ROLLBACK is a one-line policy swap back to the bare is_staff() form plus
-- dropping the trigger.
drop policy if exists announcements_update_admin on public.announcements;
create policy announcements_update_admin on public.announcements for update to authenticated
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());

-- admin_actions.action_type is a closed list; a cross-author announcement
-- edit is not honestly any of the twenty existing labels, and reusing
-- 'content_hide' or 'achievement_edit' would make the audit log lie about
-- what happened - the one thing an audit log may not do. Same reasoning
-- 202609010001 used when it added 'member_of_week_publish'.
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review', 'member_of_week_publish',
  'monthly_recap_publish', 'club_feature_toggle', 'invite_created',
  'invite_revoked', 'shared_code_created', 'shared_code_status_changed',
  'onboarding_content_updated', 'member_password_reset',
  -- 202609060013, SEC-010.
  'announcement_edit'
));

create or replace function public.announcements_audit_cross_author_edit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Only an authenticated session editing somebody ELSE's announcement is
  -- audit-worthy. An author editing their own is ordinary authorship, and a
  -- service-role/scheduled write is not a human act.
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;
  if old.author_id = auth.uid() then return new; end if;

  perform public.log_admin_action(
    'announcement_edit', 'announcement', new.id,
    jsonb_build_object('title', old.title, 'body', old.body, 'deleted_at', old.deleted_at),
    jsonb_build_object('title', new.title, 'body', new.body, 'deleted_at', new.deleted_at)
  );
  return new;
end $$;
revoke all on function public.announcements_audit_cross_author_edit() from public, anon, authenticated;

drop trigger if exists announcements_audit_cross_author_edit_trigger on public.announcements;
create trigger announcements_audit_cross_author_edit_trigger
  before update on public.announcements
  for each row execute function public.announcements_audit_cross_author_edit();

comment on function public.announcements_audit_cross_author_edit() is
  'Launch-readiness audit, SEC-010. BEFORE UPDATE on announcements. Writes one admin_actions row (action_type ''announcement_edit'', target_type ''announcement'') whenever an authenticated caller edits or soft-deletes an announcement they do not author - the cross-author case that announcements_update_admin now restricts to admins. An author editing their own announcement writes no audit row, and a non-authenticated (service role, scheduled) write is skipped entirely.';

commit;
