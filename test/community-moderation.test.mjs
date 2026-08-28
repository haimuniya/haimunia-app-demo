// review_report() (202608270006) existed with nothing calling it - an admin
// had no way to see or act on a report short of the SQL editor. This wires
// a moderation queue: loadReports()/reviewReport() gated on real is_admin
// (matching review_report()'s own check, not the broader coach-inclusive
// isStaff()), rendered in the Account tab, with a pending-count badge on
// the tab itself.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const sql = fs.readFileSync(new URL("../supabase/migrations/202608270009_admin_moderation_visibility.sql", import.meta.url), "utf8");

test("isAdmin() is narrower than isStaff() - real is_admin only, no coach-role bypass", () => {
  assert.match(src, /function isAdmin\(\) \{ return !!\(state\.profile && state\.profile\.is_admin\); \}/);
});

test("loadReports() and reviewReport() are admin-gated and call review_report() via rpc", () => {
  assert.match(src, /async function loadReports\(\) \{\s*if \(!state\.user \|\| !isAdmin\(\)\) return;/);
  assert.match(src, /\.from\("reports"\)/);
  assert.match(src, /async function reviewReport\(reportId, status\) \{\s*if \(!state\.user \|\| !isAdmin\(\)\) return;/);
  assert.match(src, /client\.rpc\("review_report", \{ p_report_id: reportId, p_status: status \}\)/);
});

test("reports load only for an admin session, on both the initial load and the auth-state-change path", () => {
  assert.match(src, /if \(isAdmin\(\)\) await loadReports\(\);/);
  assert.match(src, /\.then\(\(\) => \(isAdmin\(\) \? loadReports\(\) : null\)\)/);
});

test("the moderation queue is admin-only and dispatches review-report with a status", () => {
  assert.match(src, /function renderModeration\(\) \{\s*if \(!isAdmin\(\)\) return "";/);
  assert.match(src, /data-community-action="review-report" data-id="\$\{safeText\(r\.id\)\}" data-status="reviewing"/);
  assert.match(src, /data-community-action="review-report" data-id="\$\{safeText\(r\.id\)\}" data-status="resolved"/);
  assert.match(src, /data-community-action="review-report" data-id="\$\{safeText\(r\.id\)\}" data-status="dismissed"/);
  assert.match(src, /action === "review-report"\) reviewReport\(el\.dataset\.id, el\.dataset\.status\)/);
  assert.match(src, /accountTab = account \+ privacyPanel \+ people \+ newMembersHtml \+ inactiveHtml \+ renderModeration\(\)/);
});

test("the account tab shows a pending-open-reports badge, admin-only", () => {
  assert.match(src, /const pendingReports = isAdmin\(\) \? state\.reports\.filter\(\(r\) => r\.status === "open"\)\.length : 0;/);
  assert.match(src, /class="tab-badge"/);
});

test("migration: real admin (not the broader coach-inclusive is_staff()) gets an explicit visibility bypass on reported posts, both via post_visible_to_viewer and a direct RLS policy", () => {
  const adminCheck = /exists \(select 1 from public\.profiles where id = auth\.uid\(\) and is_admin and deleted_at is null\)/;
  assert.match(sql, adminCheck);
  assert.doesNotMatch(sql, /public\.is_staff\(\)/, "must not call is_staff() here - that would also grant a coach-role redemption read access to private posts it has no way to act on");
  assert.match(sql, /create policy posts_select_admin_review on public\.workout_posts for select to authenticated\s*using \(exists \(select 1 from public\.profiles where id = auth\.uid\(\) and is_admin and deleted_at is null\)\);/);
});
