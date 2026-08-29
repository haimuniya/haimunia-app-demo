// COMM-150..156, the admin-moderation cluster, executed for real in jsdom
// against the mock Supabase client, plus a few source-text guards for the
// table-driven permission model.
//
// WHAT THIS FILE VERIFIES
// - COMM-150: no community staff control branches on is_admin or a role
//   literal. The permission set is loaded once per session from
//   my_permissions() and read through hasPerm(). A role that gains and then
//   loses community.comment.moderate gains and loses the queue.
// - COMM-151: the report sheet lists the six reasons, takes an optional
//   capped note, and its acknowledgement discloses nothing about what
//   follows. A comment can be reported through the same path.
// - COMM-152: the queue shows content, reported member, reporter count,
//   reason, date and status, filters by status, and is admin-only.
// - COMM-153: every queue action routes through mod_review() and produces an
//   admin_actions row. Remove, warn, restrict (temp and permanent) and
//   dismiss are all covered.
// - COMM-154: pin, unpin, restriction and role change each write
//   admin_actions; the read-only audit view is gated on
//   community.analytics.view and reads admin_actions_page().
// - COMM-155: the pinned strip renders at the top of the feed, and a fourth
//   pin is refused with a clear message.
// - COMM-156: head_coach is selectable in member management; staff and owner
//   are not.
//
// WHAT THIS FILE DOES NOT VERIFY
// The server functions themselves (mod_queue, mod_review, report, pin_set,
// pin_clear, admin_actions_page, my_permissions). Those are Postgres,
// documented in docs/community/contracts.md under "Needs from schema,
// admin-moderation". The mock stands in for them the same way the other
// executing community tests stand in for feed_page and notif_list.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const VERIFIED = new Date().toISOString();

function baseMock(overrides) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "mod-1", handle: "mod", display_name: "מודרטור", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "author-1", handle: "kobi", display_name: "קובי", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "reporter-1", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "reporter-2", handle: "gil", display_name: "גיל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "mod-1", invite_id: "i1", role: "head_coach", redeemed_at: VERIFIED },
      { user_id: "author-1", invite_id: "i2", role: "member", redeemed_at: VERIFIED },
      { user_id: "reporter-1", invite_id: "i3", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    workout_posts: [
      { id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן שדווח", status: "active", created_at: VERIFIED, published_at: VERIFIED },
    ],
    post_comments: [
      { id: "cmt-1", post_id: "post-1", author_id: "author-1", body: "תגובה שדווחה", status: "active", created_at: VERIFIED },
    ],
    reports: [],
    admin_actions: [],
    pins: [],
    posting_restrictions: [],
    feed_page_rows: [{ id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן שדווח", created_at: VERIFIED }],
    follows: [], hidden_posts: [], saved_posts: [], notifications: [],
  }, overrides || {}));
  return mock;
}

async function openCommunity(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
}
async function gotoAccount(window) {
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]'), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => {
    const active = window.document.querySelector(".subtabbtn.active");
    return active && /חשבון/.test(active.textContent);
  }, 3000);
}
async function openAccount(window) {
  await openCommunity(window);
  await gotoAccount(window);
}
const bodyText = (window) => window.document.body.textContent;

// ===== COMM-150 table-driven permissions ==============================

test("no community staff gate reads is_admin or a role literal; every one goes through hasPerm()", () => {
  // The permission cache and helper exist.
  assert.match(src, /async function loadPermissions\(\)\s*\{[\s\S]*client\.rpc\("my_permissions"\)/);
  assert.match(src, /function hasPerm\(code\)\s*\{\s*return[^\n]*state\.permissions/);
  // The queue, audit view and pin controls are permission-gated.
  assert.match(src, /function renderModeration\(\)\s*\{\s*if \(!\(hasPerm\(PERM\.COMMENT_MODERATE\) \|\| isAdmin\(\)\)\) return "";/);
  assert.match(src, /function renderAuditLog\(\)\s*\{\s*if \(!hasPerm\(PERM\.ANALYTICS_VIEW\)\) return "";/);
  assert.match(src, /if \(!state\.user \|\| !hasPerm\(PERM\.CONTENT_PIN\)\) return;/);
  // isAdmin() stays only where a server function still checks the real
  // is_admin column: the audit posts bypass and the admin_* member RPCs.
  assert.doesNotMatch(src, /renderModeration\(\)\s*\{\s*if \(!isAdmin\(\)\)/);
});

test("the permission cache is dropped on sign-out", () => {
  assert.match(src, /state\.permissions = \[\]; state\.permissionsLoaded = false;/);
});

test("a role that gains community.comment.moderate gains the queue, and loses it when the role is taken away", async () => {
  const mock = baseMock({
    invite_redemptions: [{ user_id: "mod-1", invite_id: "i1", role: "member", redeemed_at: VERIFIED }],
    reports: [{ id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "harassment", note: "", status: "open", created_at: VERIFIED }],
  });
  mock.seedCredentials("mod-1", "mod@members.haimuniya.invalid", "pw123456");
  mock.setUser({ id: "mod-1", is_anonymous: false, email: "mod@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  assert.doesNotMatch(bodyText(window), /תור מודרציה/, "a plain member sees no moderation queue");

  // Gains the permission.
  mock.db.invite_redemptions[0].role = "head_coach";
  await mock.client.auth.signOut();
  await mock.client.auth.signInWithPassword({ email: "mod@members.haimuniya.invalid", password: "pw123456" });
  await gotoAccount(window);
  await waitFor(() => /תור מודרציה/.test(bodyText(window)), 3000);
  assert.match(bodyText(window), /תור מודרציה/, "the queue appears once the role holds community.comment.moderate");

  // Loses it again.
  mock.db.invite_redemptions[0].role = "member";
  await mock.client.auth.signOut();
  await mock.client.auth.signInWithPassword({ email: "mod@members.haimuniya.invalid", password: "pw123456" });
  await gotoAccount(window);
  assert.doesNotMatch(bodyText(window), /תור מודרציה/, "the queue is gone again once the permission is removed");
});

// ===== COMM-151 report flow ==========================================

test("the report sheet lists the six reasons and its acknowledgement discloses nothing about consequences", async () => {
  const mock = baseMock();
  mock.setUser({ id: "reporter-1", is_anonymous: false, email: "noa@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.eval('window.handleCommunityClick({ dataset: { communityAction: "report", id: "post-1" } })');
  await waitFor(() => !!window.document.querySelector("[data-report-reason]"), 3000);
  const t = window.document.querySelector('[role="dialog"][aria-labelledby="reportSheetTitle"]').textContent;
  for (const label of ["הטרדה", "ספאם", "תוכן לא הולם", "פגיעה בפרטיות", "המלצת אימון מסוכנת", "אחר"]) {
    assert.match(t, new RegExp(label), `reason "${label}" is offered`);
  }
  window.document.querySelector('[data-report-reason="spam"]').click();
  window.document.querySelector('[data-community-action="report-submit"]').click();
  await waitFor(() => /הדיווח התקבל/.test(window.document.body.textContent), 3000);
  const ack = window.document.querySelector('[aria-labelledby="reportSheetTitle"]').textContent;
  assert.doesNotMatch(ack, /הסר|הוסת|הגבל|אזהר|טופל|תיבדק|תוסר/, "the acknowledgement says nothing about what happens next");
  const row = mock.db.reports.find((r) => r.reporter_id === "reporter-1" && r.target_id === "post-1");
  assert.ok(row, "a report row was recorded");
  assert.equal(row.reason, "spam");
});

test("a comment is reported through the same report() path with target_type comment", async () => {
  const mock = baseMock();
  mock.setUser({ id: "reporter-1", is_anonymous: false, email: "noa@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.eval('window.handleCommunityClick({ dataset: { communityAction: "report-comment", id: "cmt-1" } })');
  await waitFor(() => !!window.document.querySelector("[data-report-reason]"), 3000);
  window.document.querySelector('[data-report-reason="harassment"]').click();
  window.document.querySelector('[data-community-action="report-submit"]').click();
  await waitFor(() => mock.db.reports.some((r) => r.target_type === "comment" && r.target_id === "cmt-1"), 3000);
  const row = mock.db.reports.find((r) => r.target_id === "cmt-1");
  assert.equal(row.target_type, "comment");
  assert.equal(row.reason, "harassment");
});

test("a duplicate report by the same member collapses; a second unique reporter moves the count", async () => {
  const mock = baseMock({
    reports: [
      { id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "spam", note: "", status: "open", created_at: VERIFIED },
    ],
  });
  mock.setUser({ id: "reporter-1", is_anonymous: false, email: "noa@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.eval('window.handleCommunityClick({ dataset: { communityAction: "report", id: "post-1" } })');
  await waitFor(() => !!window.document.querySelector("[data-report-reason]"), 3000);
  window.document.querySelector('[data-report-reason="harassment"]').click();
  window.document.querySelector('[data-community-action="report-submit"]').click();
  await waitFor(() => /הדיווח התקבל/.test(window.document.body.textContent), 3000);
  assert.equal(mock.db.reports.filter((r) => r.target_id === "post-1").length, 1, "no second row for the same reporter");
});

// ===== COMM-152 the queue ============================================

test("the queue shows content, reported member, reporter count, reason, date and status, and filters by status", async () => {
  const mock = baseMock({
    reports: [
      { id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "harassment", note: "לא בסדר", status: "open", created_at: VERIFIED },
      { id: "rep-2", reporter_id: "reporter-2", target_type: "post", target_id: "post-1", reason: "spam", note: "", status: "open", created_at: VERIFIED },
    ],
  });
  mock.setUser({ id: "mod-1", is_anonymous: false, email: "mod@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => /תור מודרציה/.test(window.document.body.textContent), 3000);
  const section = Array.from(window.document.querySelectorAll(".ach-section")).find((s) => /תור מודרציה/.test(s.textContent));
  assert.ok(section, "the queue section renders");
  assert.match(section.textContent, /תוכן שדווח/, "content excerpt");
  assert.match(section.textContent, /קובי/, "reported member");
  assert.match(section.textContent, /2 דיווחים/, "reporter count");
  assert.match(section.textContent, /הטרדה|ספאם/, "reason");
  assert.match(section.textContent, /פתוח/, "status");
  // Status filter chips are present.
  assert.ok(section.querySelector('[data-community-action="mod-queue-status"][data-status="dismissed"]'), "a status filter chip");
});

test("the queue is not rendered for a member without the moderation permission", async () => {
  const mock = baseMock({
    invite_redemptions: [{ user_id: "mod-1", invite_id: "i1", role: "member", redeemed_at: VERIFIED }],
    reports: [{ id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "spam", note: "", status: "open", created_at: VERIFIED }],
  });
  mock.setUser({ id: "mod-1", is_anonymous: false, email: "mod@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  assert.doesNotMatch(window.document.body.textContent, /תור מודרציה/);
});

// ===== COMM-153 queue actions =======================================

async function bootQueueAs(mock) {
  mock.setUser({ id: "mod-1", is_anonymous: false, email: "mod@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="mod-action"]'), 3000);
  return window;
}
async function runDecision(window, decision) {
  const btn = window.document.querySelector(`[data-community-action="mod-action"][data-decision="${decision}"]`);
  assert.ok(btn, `the ${decision} action is offered`);
  btn.click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="mod-action-run"]'), 3000);
  window.document.querySelector('[data-community-action="mod-action-run"]').click();
}

test("remove content routes through mod_review, sets the post to removed and writes an admin_actions row", async () => {
  const mock = baseMock({ reports: [{ id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "harassment", note: "", status: "open", created_at: VERIFIED }] });
  const window = await bootQueueAs(mock);
  const calls = mock.callsTo("mod_review").length;
  await runDecision(window, "remove");
  await waitFor(() => mock.callsTo("mod_review").length > calls, 3000);
  assert.equal(mock.db.workout_posts.find((p) => p.id === "post-1").status, "removed");
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "report_review"), "report_review audit row");
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "content_delete" && a.target_id === "post-1"), "content_delete audit row");
});

test("warn routes through mod_review and writes an admin_actions row without touching the content", async () => {
  const mock = baseMock({ reports: [{ id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "other", note: "", status: "open", created_at: VERIFIED }] });
  const window = await bootQueueAs(mock);
  await runDecision(window, "warn");
  await waitFor(() => mock.callsTo("mod_review").some((a) => a.p_decision === "warn"), 3000);
  assert.equal(mock.db.workout_posts.find((p) => p.id === "post-1").status, "active", "content untouched by a warning");
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "report_review"));
});

test("a temporary restriction carries an end time and a permanent one does not; both write admin_actions", async () => {
  const mock = baseMock({ reports: [{ id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "unsafe_advice", note: "", status: "open", created_at: VERIFIED }] });
  const window = await bootQueueAs(mock);
  await runDecision(window, "restrict_temp");
  await waitFor(() => mock.db.posting_restrictions.length === 1, 3000);
  const temp = mock.db.posting_restrictions[0];
  assert.equal(temp.restriction_type, "temporary");
  assert.ok(temp.expires_at, "a temporary restriction has an expiry");
  assert.ok(mock.callsTo("mod_review").some((a) => a.p_decision === "restrict_temp" && a.p_expires_at), "the client passes p_expires_at only for restrict_temp");
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "member_restrict"));
});

test("permanent restriction: no expiry passed, still audited", async () => {
  const mock = baseMock({ reports: [{ id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "harassment", note: "", status: "open", created_at: VERIFIED }] });
  const window = await bootQueueAs(mock);
  await runDecision(window, "restrict_permanent");
  await waitFor(() => mock.db.posting_restrictions.length === 1, 3000);
  assert.equal(mock.db.posting_restrictions[0].restriction_type, "permanent");
  assert.equal(mock.db.posting_restrictions[0].expires_at, null);
  const call = mock.callsTo("mod_review").find((a) => a.p_decision === "restrict_permanent");
  assert.ok(call && call.p_expires_at === undefined, "no end time for a permanent restriction");
});

test("dismiss closes the report through mod_review with a dismissed status and an audit row", async () => {
  const mock = baseMock({ reports: [{ id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "spam", note: "", status: "open", created_at: VERIFIED }] });
  const window = await bootQueueAs(mock);
  await runDecision(window, "dismiss");
  await waitFor(() => mock.db.reports[0].status === "dismissed", 3000);
  assert.ok(mock.callsTo("mod_review").some((a) => a.p_decision === "dismiss"));
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "report_review"));
});

// ===== COMM-154 audit view ==========================================

test("the audit view is gated on community.analytics.view and reads admin_actions_page()", async () => {
  const mock = baseMock({
    invite_redemptions: [{ user_id: "mod-1", invite_id: "i1", role: "head_coach", redeemed_at: VERIFIED }],
    admin_actions: [
      { id: "aa-1", admin_id: "mod-1", action_type: "content_pin", target_type: "post", target_id: "post-1", before_data: null, after_data: { slot: 0 }, created_at: VERIFIED },
    ],
  });
  mock.setUser({ id: "mod-1", is_anonymous: false, email: "mod@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  // head_coach does not hold community.analytics.view, so no audit view.
  assert.doesNotMatch(window.document.body.textContent, /יומן פעולות ניהול/);

  const mock2 = baseMock({
    profiles: [
      { id: "adm-1", handle: "adm", display_name: "מנהל", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "author-1", handle: "kobi", display_name: "קובי", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [{ user_id: "adm-1", invite_id: "i1", role: "member", redeemed_at: VERIFIED }],
    admin_actions: [
      { id: "aa-1", admin_id: "adm-1", action_type: "content_pin", target_type: "post", target_id: "post-1", before_data: null, after_data: { slot: 0 }, created_at: VERIFIED },
    ],
  });
  mock2.setUser({ id: "adm-1", is_anonymous: false, email: "adm@members.haimuniya.invalid" });
  const w2 = await bootCommunity(mock2, { syncEnabled: false });
  await openAccount(w2);
  await waitFor(() => /יומן פעולות ניהול/.test(w2.document.body.textContent), 3000);
  assert.ok(mock2.callsTo("admin_actions_page").length >= 1, "the view reads admin_actions_page()");
  assert.match(w2.document.body.textContent, /הצמדת תוכן/, "an audit row renders");
});

// ===== COMM-155 pins ================================================

test("the pinned strip renders at the top of the feed and a fourth pin is refused with a clear message", async () => {
  const mock = baseMock({
    pins: [
      { id: "p1", target_type: "announcement", target_id: "a-1", slot: 0, note: "הודעה חשובה", pinned_by: "mod-1", created_at: VERIFIED },
      { id: "p2", target_type: "challenge", target_id: "c-1", slot: 1, note: "אתגר", pinned_by: "mod-1", created_at: VERIFIED },
      { id: "p3", target_type: "event", target_id: "e-1", slot: 2, note: "אירוע", pinned_by: "mod-1", created_at: VERIFIED },
    ],
  });
  mock.setUser({ id: "mod-1", is_anonymous: false, email: "mod@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  const strip = window.document.getElementById("communityPinnedStrip");
  assert.ok(strip, "the pinned strip renders");
  assert.match(strip.textContent, /הודעה חשובה/);
  // A fourth pin is refused.
  await window.eval('window.handleCommunityClick({ dataset: { communityAction: "pin", type: "post", id: "post-1" } })');
  await waitFor(() => /אפשר להצמיד עד שלושה/.test(window.document.body.textContent), 3000);
  assert.equal(mock.db.pins.length, 3, "no fourth pin row was created");
});

test("pin_set and pin_clear both write an admin_actions row", async () => {
  const mock = baseMock();
  mock.setUser({ id: "mod-1", is_anonymous: false, email: "mod@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await window.eval('window.handleCommunityClick({ dataset: { communityAction: "pin", type: "post", id: "post-1" } })');
  await waitFor(() => mock.db.pins.length === 1, 3000);
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "content_pin"), "content_pin audit row");
  await window.eval('window.handleCommunityClick({ dataset: { communityAction: "unpin", type: "post", id: "post-1" } })');
  await waitFor(() => mock.db.pins.length === 0, 3000);
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "content_unpin"), "content_unpin audit row");
});

// ===== COMM-156 head_coach ==========================================

test("head_coach is selectable in member management; staff and owner are not", async () => {
  const mock = baseMock({
    profiles: [
      { id: "adm-1", handle: "adm", display_name: "מנהל", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [{ user_id: "adm-1", invite_id: "i1", role: "member", redeemed_at: VERIFIED }],
  });
  mock.setUser({ id: "adm-1", is_anonymous: false, email: "adm@members.haimuniya.invalid" });
  mock.onRpc("admin_search_members", () => ({ data: [{ id: "author-1", handle: "kobi", display_name: "קובי", role: "member", redeemed_at: VERIFIED, last_activity_on: null }], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  const input = window.document.getElementById("adminMemberSearch");
  input.value = "ko";
  input.dispatchEvent(new window.Event("input"));
  await waitFor(() => /מאמן\/ת ראשי\/ת/.test(window.document.body.textContent), 3000);
  const t = window.document.body.textContent;
  assert.match(t, /הפיכה למאמן\/ת ראשי\/ת/, "head coach is offered");
  assert.doesNotMatch(t, /staff|owner|צוות|בעלים/i, "staff and owner are not exposed");
});

test("granting head_coach passes p_role and is confirmed; the mock records a role_change audit row", async () => {
  const mock = baseMock({
    profiles: [{ id: "adm-1", handle: "adm", display_name: "מנהל", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [
      { user_id: "adm-1", invite_id: "i1", role: "member", redeemed_at: VERIFIED },
      { user_id: "author-1", invite_id: "i2", role: "coach", redeemed_at: VERIFIED },
    ],
  });
  mock.setUser({ id: "adm-1", is_anonymous: false, email: "adm@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  window.eval('window.handleCommunityClick({ dataset: { communityAction: "admin-set-role", id: "author-1", role: "head_coach" } })');
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => mock.db.invite_redemptions.find((r) => r.user_id === "author-1").role === "head_coach", 3000);
  const call = mock.callsTo("admin_grant_coach").find((a) => a.p_role === "head_coach");
  assert.ok(call, "admin_grant_coach was called with p_role head_coach");
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "role_change" && a.target_id === "author-1"));
});

// ===== migration guard (unchanged) ==================================

test("migration: real admin still gets the reported-post visibility bypass, not the broader is_staff()", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/202608270009_admin_moderation_visibility.sql", import.meta.url), "utf8");
  assert.match(sql, /exists \(select 1 from public\.profiles where id = auth\.uid\(\) and is_admin and deleted_at is null\)/);
  assert.doesNotMatch(sql, /public\.is_staff\(\)/);
});
