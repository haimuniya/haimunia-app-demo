// Redesign, Phase 1/3: dedicated coverage for the "ניהול" (Manage) top-level
// tab (window.renderManageApp, cloud.js) that no other test file owns end to
// end. Executed for real (bootCommunity + createMockSupabase), the same
// real render/click path every sibling community test file uses - not
// source-text matches.
//
// Covers:
// - The ?tab=manage non-staff denial regression (a plain member who lands
//   on the URL directly, not through the bottom-bar button which is hidden
//   for them entirely, still gets renderManageApp()'s own internal
//   isStaff() refusal instead of the real dashboard).
// - All 7 sub-tabs (dashboard/members/onboarding/moderation/settings/
//   analytics/invites) render as the active pill with real content.
// - Both renderManageDashboard() "needs attention" states - the red
//   pending-reports row and its green all-clear empty state - the exact
//   canModerate-vs-pendingReports condition fixed this session (see that
//   function's own comment in cloud.js).
// - The dashboard's two shortcut buttons (pending reports -> moderation,
//   inactive members -> members).
// - Booting straight into Manage via ?tab=manage (staff) still triggers
//   ensureCommunityDataLoaded(), the same cascade Community's own boot
//   triggers, without ever visiting the Community tab first.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

// role: "admin" (is_admin true - every Manage permission, including
// community.club.manage_modules and community.analytics.view, both of
// which a plain coach lacks), "coach" (is_staff true via role, holds
// community.comment.moderate, nothing else), or "member" (neither, and no
// Manage entry in the nav at all).
function seeded(extra, role) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: role === "admin", recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: role === "admin" ? "member" : (role || "member"), redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], club_features: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

// ===== P1: the ?tab=manage non-staff denial regression =====================

test("a plain member who lands on ?tab=manage directly sees the denial state, not the Manage dashboard", async () => {
  const mock = seeded(null, "member");
  const window = await bootCommunity(mock, { syncEnabled: false, url: "https://example.test/index.html?tab=manage" });
  // The bottom-bar button never exists for a non-staff caller (getNavItems()
  // omits the whole entry) - the regression is specifically about reaching
  // the tab a second way, straight off the URL, which does not go through
  // getNavItems() at all.
  assert.equal(window.document.getElementById("tabManageBtn"), null, "no Manage nav button renders for a plain member");
  await waitFor(() => window.document.body.textContent.includes("אין הרשאה לצפות בעמוד זה"), 3000);
  assert.ok(!window.document.querySelector(".subtabbar"), "no Manage sub-tab bar renders for the denied caller");
});

// ===== P2: all 7 sub-tabs render ============================================

test("all 7 Manage sub-tabs render as the active pill with real content", async () => {
  const mock = seeded(null, "admin");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);

  const ids = ["dashboard", "members", "onboarding", "moderation", "settings", "analytics", "invites"];
  for (const id of ids) {
    window.document.querySelector(`[data-community-action="set-manage-tab"][data-tab="${id}"]`).click();
    await waitFor(() => {
      const active = window.document.querySelector(".subtabbtn.active");
      return !!active && active.dataset.tab === id;
    }, 3000);
    const active = window.document.querySelector(".subtabbtn.active");
    assert.equal(active.dataset.tab, id, `the ${id} pill becomes active`);
    assert.equal(active.getAttribute("aria-selected"), "true", `the ${id} pill reports aria-selected`);
    const content = window.document.querySelector("main");
    assert.ok(content && content.textContent.trim().length > 0, `${id} sub-tab renders non-empty content`);
  }
});

// ===== P2: dashboard "needs attention" states ==============================

test("dashboard: a moderator with genuinely open reports sees the red attention row, and its shortcut opens Moderation", async () => {
  const mock = seeded({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "author-1", handle: "kobi", display_name: "קובי", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    workout_posts: [{ id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן שדווח", status: "active", created_at: VERIFIED, published_at: VERIFIED }],
    reports: [{ id: "rep-1", reporter_id: "author-1", target_type: "post", target_id: "post-1", reason: "spam", note: "", status: "open", created_at: VERIFIED }],
  }, "coach");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  await waitFor(() => window.document.body.textContent.includes("דיווחים ממתינים למודרציה"), 3000);
  assert.match(window.document.body.textContent, /1 דיווחים ממתינים למודרציה/, "the real open-report count renders, not a stale placeholder");
  assert.ok(!window.document.body.textContent.includes("אין דבר שדורש תשומת לב כרגע"), "the red row and the green all-clear are mutually exclusive");

  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="moderation"]').click();
  await waitFor(() => {
    const active = window.document.querySelector(".subtabbtn.active");
    return !!active && active.dataset.tab === "moderation";
  }, 3000);
  assert.ok(window.document.body.textContent.includes("תור מודרציה"), "the shortcut lands on the real moderation queue");
});

test("dashboard: a moderator with zero open reports sees the green all-clear empty state, not a red 0-count row", async () => {
  // COMM regression covered here: this row used to be gated on canModerate
  // alone (truthy for any moderator regardless of the real count), so a
  // moderator with a genuinely empty queue permanently saw a red
  // "0 דיווחים ממתינים למודרציה" row and the green empty state below was
  // unreachable. Fixed to gate on the real pendingReports count instead.
  const mock = seeded({ reports: [] }, "coach");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  await waitFor(() => window.document.body.textContent.includes("דורש תשומת לב"), 3000);
  assert.ok(window.document.body.textContent.includes("אין דבר שדורש תשומת לב כרגע"), "the green all-clear empty state renders");
  assert.doesNotMatch(window.document.body.textContent, /\d+ דיווחים ממתינים למודרציה/, "no red pending-count row, not even a 0 one");
});

test("dashboard: an inactive-members shortcut navigates to Members", async () => {
  const mock = seeded(null, "admin");
  // A GENUINELY lapsed member: someone we have recorded activity for, whose
  // most recent activity is old. The fixture used to be
  // `{ last_activity_on: null }` with no state at all, which is the "we have
  // never recorded anything about this person" case - and asserting that it
  // produced an attention row was asserting the defect 202609060020 fixed.
  // The attention row counts state === 'lapsed' only; a no_data member is
  // not something to alarm a coach with, and the assertion that they are
  // excluded lands with the client half of that change.
  mock.onRpc("coach_inactive_members", () => ({ data: [{ user_id: "u-someone", display_name: "מישהו", handle: "someone", last_activity_on: "2026-08-01", state: "lapsed", days_since_activity: 37, joined_on: "2026-05-01" }], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  // Waits on the shortcut itself rather than on its Hebrew label: this test
  // is about the row navigating to Members, and pinning the copy here made
  // it a second, accidental owner of a string it does not assert anything
  // about.
  //
  // `button.log-row` is load-bearing, not decoration. The bare
  // [data-community-action="set-manage-tab"][data-tab="members"] selector
  // ALSO matches the sub-tab bar pill, which exists from the first paint -
  // so waiting on it resolves before any data has loaded, and clicking it
  // clicks the nav pill rather than the attention shortcut this test is
  // named after. The attention row is the only .log-row of the pair.
  const shortcut = 'button.log-row[data-community-action="set-manage-tab"][data-tab="members"]';
  await waitFor(() => !!window.document.querySelector(shortcut), 3000);

  window.document.querySelector(shortcut).click();
  await waitFor(() => {
    const active = window.document.querySelector(".subtabbtn.active");
    return !!active && active.dataset.tab === "members";
  }, 3000);
  assert.ok(window.document.body.textContent.includes("ניהול חברים"), "the shortcut lands on the real member-management sub-tab");
});

// The other half of the same rule, and the reason the attention row exists
// at all. Before 202609060020 this row counted every row the RPC returned,
// including every member the club had simply never recorded anything for -
// so a club whose members had not yet produced a single activity ping was
// told on its own landing screen that all of them were inactive. That is the
// 8-of-8 failure, on the first screen a box owner sees.
test("dashboard: members we have NO data about never produce an attention row", async () => {
  const mock = seeded(null, "admin");
  mock.onRpc("coach_inactive_members", () => ({
    data: [
      { user_id: "u-a", display_name: "אלף", handle: "alef", last_activity_on: null, state: "no_data", days_since_activity: null, joined_on: "2026-01-01" },
      { user_id: "u-b", display_name: "בית", handle: "bet", last_activity_on: null, state: "no_data", days_since_activity: null, joined_on: "2026-01-02" },
      { user_id: "u-c", display_name: "גימל", handle: "gimel", last_activity_on: null, state: "no_data", days_since_activity: null, joined_on: "2026-01-03" },
    ],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  // Wait on the RPC having actually been answered, not on a DOM node. The
  // dashboard renders its green all-clear immediately, before any data
  // arrives, so asserting the all-clear on its own would pass even if the
  // three rows were later counted - the assertion has to run AFTER the
  // three no_data rows are in state.
  await waitFor(() => mock.callsTo("coach_inactive_members").length > 0, 3000);
  await waitFor(() => window.document.body.textContent.includes("אין דבר שדורש תשומת לב כרגע"), 3000);
  assert.equal(
    window.document.querySelector('button.log-row[data-community-action="set-manage-tab"][data-tab="members"]'),
    null,
    "three members we know nothing about must produce NO attention shortcut - an absence of data is not an alert",
  );
  assert.doesNotMatch(
    window.document.body.textContent,
    /\d+ חברים לא נכנסו לאפליקציה לאחרונה/,
    "and no count row of any size",
  );
});

test("dashboard: the attention row counts only genuinely lapsed members, not the whole list", async () => {
  const mock = seeded(null, "admin");
  mock.onRpc("coach_inactive_members", () => ({
    data: [
      { user_id: "u-a", display_name: "אלף", handle: "alef", last_activity_on: "2026-08-01", state: "lapsed", days_since_activity: 37, joined_on: "2026-01-01" },
      { user_id: "u-b", display_name: "בית", handle: "bet", last_activity_on: null, state: "no_data", days_since_activity: null, joined_on: "2026-01-02" },
      { user_id: "u-c", display_name: "גימל", handle: "gimel", last_activity_on: null, state: "no_data", days_since_activity: null, joined_on: "2026-01-03" },
    ],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  // `button.log-row` and not the bare attribute pair - see the note in the
  // shortcut test above: the sub-tab BAR pill carries the same two
  // attributes and exists from the first paint, so the bare selector
  // resolves before any data has loaded and races the assertion.
  await waitFor(() => !!window.document.querySelector('button.log-row[data-community-action="set-manage-tab"][data-tab="members"]'), 3000);
  assert.match(
    window.document.body.textContent,
    /1 חברים לא נכנסו לאפליקציה לאחרונה/,
    "one lapsed member out of three rows - the two no_data members are not counted",
  );
});

// ===== P2: booting straight into Manage triggers ensureCommunityDataLoaded() =

test("booting straight into ?tab=manage (staff) triggers ensureCommunityDataLoaded(), without ever visiting Community first", async () => {
  const mock = seeded(null, "admin");
  const window = await bootCommunity(mock, { syncEnabled: false, url: "https://example.test/index.html?tab=manage" });
  await waitFor(() => !!window.document.getElementById("tabManageBtn"), 3000);
  // my_permissions() is only ever called from inside ensureCommunityDataLoaded()'s
  // own Promise.all - never eagerly at session-ready - so seeing it fire at
  // all, having never clicked the Community tab, proves the cascade ran
  // from afterRenderManage()'s own hook instead.
  await waitFor(() => mock.callsTo("my_permissions").length > 0, 3000);
  assert.ok(mock.callsTo("my_permissions").length > 0, "the deferred data cascade ran from Manage's own boot, not just Community's");
});
