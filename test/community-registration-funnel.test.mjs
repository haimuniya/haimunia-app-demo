// COMM-379. Registration funnel analytics screen, client half. Schema half
// is registration_funnel(p_period_start, p_period_end) (COMM-375,
// 202609030006) - gated on community.analytics.view or real is_admin(),
// the SAME pair analytics_dashboard() and COMM-310's own client half use,
// NOT is_staff() (so a coach who can browse the roster, COMM-377, is still
// refused here).
//
// Built to extend COMM-310's dashboard shell exactly the way COMM-311's
// member segmentation did (see test/community-member-engagement-
// segmentation.test.mjs, the template this file follows): appended INSIDE
// the same populated branch, reusing the one period selector, its own
// independent loading/error/populated switch.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(extra, role) {
  const profiles = [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: role === "admin", recovery_verified_at: VERIFIED, visible_to_club: true },
  ];
  const mock = createMockSupabase(Object.assign({
    profiles,
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: role === "admin" ? "member" : (role || "member"), redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

// Redesign, Phase 1: renderRegistrationFunnel() itself did not move, but its
// container renderAdminAnalyticsDashboard() did - from Community's "account"
// sub-tab to the Manage tab's own "analytics" sub-tab.
async function openAccountTab(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="analytics"]').click();
}

function minimalDashboardFixture() { return { core: {}, additional: {} }; }
function minimalSegmentsFixture() { return []; }

function funnelFixture(overrides) {
  return Object.assign({
    period: { start: "2026-08-01", end: "2026-08-07", end_exclusive: "2026-08-08", days: 7 },
    shared_codes: { active_count: 2, redemptions_in_period: 5 },
    per_person_invites: { created_in_period: 10, redeemed_in_period: 8, revoked_in_period: 1, pending_now: 3, expired_unredeemed_now: 1 },
    funnel: { invites_issued: 10, redeemed: 8, profile_completed: 6, verified: 4, redeemed_rate: 0.8, profile_completed_rate: 0.75, verified_rate: 2 / 3 },
  }, overrides || {});
}

test("Loading: the funnel section shows its own skeleton while registration_funnel is in flight, then renders", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  let resolveFunnel;
  const calls = [];
  mock.onRpc("registration_funnel", (args) => { calls.push(args); return new Promise((resolve) => { resolveFunnel = resolve; }); });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("משפך הרשמה"), 3000);
  await waitFor(() => !!window.document.querySelector('[data-registration-funnel-skeleton="1"]'), 3000);

  resolveFunnel({ data: funnelFixture(), error: null });
  await waitFor(() => window.document.body.textContent.includes("השלימו פרופיל"), 3000);
  assert.equal(window.document.querySelector('[data-registration-funnel-skeleton="1"]'), null);
  assert.equal(calls.length, 1);
});

test("Populated: renders an ordered funnel with a real count and a real percentage-of-previous-step at each stage, plus shared-code and per-person supporting panels", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  mock.onRpc("registration_funnel", () => ({ data: funnelFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("משפך הרשמה"), 3000);
  const section = window.document.querySelector('[data-registration-funnel-section="1"]');
  assert.ok(section);
  const text = section.textContent;
  assert.match(text, /הזמנות אישיות שהופצו\s*10/);
  assert.match(text, /מומשו\s*8\s*·\s*80%/);
  assert.match(text, /השלימו פרופיל\s*6\s*·\s*75%/);
  assert.match(text, /אומתו\s*4\s*·\s*66\.7%/);
  // Shared-code activity is its own line, never folded into the funnel.
  assert.match(text, /קודים פעילים\s*2/);
  assert.match(text, /מימושים בתקופה\s*5/);
  assert.match(text, /נוצרו בתקופה\s*10/);
  assert.match(text, /ממתינות כרגע\s*3/);
});

test("invites_issued's per-person-only scope is labelled clearly, so it never reads as 'everyone who could have joined'", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  mock.onRpc("registration_funnel", () => ({ data: funnelFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("משפך הרשמה"), 3000);
  assert.match(window.document.querySelector('[data-registration-funnel-section="1"]').textContent, /הזמנות שהופצו״ סופר רק הזמנות אישיות/);
});

test("redeemed can exceed invites_issued and redeemed_rate can exceed 100% - rendered honestly, not clamped", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  mock.onRpc("registration_funnel", () => ({
    data: funnelFixture({ funnel: { invites_issued: 2, redeemed: 20, profile_completed: 18, verified: 10, redeemed_rate: 10, profile_completed_rate: 0.9, verified_rate: 0.5556 } }),
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("משפך הרשמה"), 3000);
  const text = window.document.querySelector('[data-registration-funnel-section="1"]').textContent;
  assert.match(text, /מומשו\s*20\s*·\s*1000%/, "redeemed (20) exceeds invites_issued (2) and the rate renders as a real >100% figure, not clamped to 100%");
});

test("Empty: a period with zero invites of either kind renders honest zeros and em-dash rates, not an error", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  mock.onRpc("registration_funnel", () => ({
    data: funnelFixture({
      shared_codes: { active_count: 0, redemptions_in_period: 0 },
      per_person_invites: { created_in_period: 0, redeemed_in_period: 0, revoked_in_period: 0, pending_now: 0, expired_unredeemed_now: 0 },
      funnel: { invites_issued: 0, redeemed: 0, profile_completed: 0, verified: 0, redeemed_rate: null, profile_completed_rate: null, verified_rate: null },
    }),
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("משפך הרשמה"), 3000);
  const text = window.document.querySelector('[data-registration-funnel-section="1"]').textContent;
  assert.match(text, /הזמנות אישיות שהופצו\s*0/);
  assert.match(text, /מומשו\s*0\s*·\s*—/, "a null ratio renders an em dash, never 0% or NaN%");
});

test("Error: registration_funnel failing shows its own copy, independent of COMM-310's dashboard which loaded fine, with a working retry that does not re-call analytics_dashboard", async () => {
  const mock = seeded({}, "admin");
  const dashCalls = [];
  mock.onRpc("analytics_dashboard", () => { dashCalls.push(1); return { data: minimalDashboardFixture(), error: null }; });
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  let funnelCalls = 0;
  mock.onRpc("registration_funnel", () => {
    funnelCalls++;
    if (funnelCalls === 1) return { data: null, error: { message: "boom" } };
    return { data: funnelFixture(), error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את נתוני ההרשמה."), 3000);
  assert.doesNotMatch(window.document.body.textContent, /לא ניתן היה לטעון את הנתונים\./, "COMM-310's own dashboard did not error");
  window.document.querySelector('[data-community-action="registration-funnel-retry"]').click();
  await waitFor(() => window.document.body.textContent.includes("השלימו פרופיל") && funnelCalls === 2, 3000);
  assert.equal(dashCalls.length, 1, "retrying the funnel section alone never re-calls analytics_dashboard");
});

test("both real server refusals map to their own short Hebrew message, and an unmapped error falls back to the ticket's own generic copy", async () => {
  const cases = [
    ["not authorized", "אין לך הרשאה לצפות בנתוני ההרשמה."],
    ["period exceeds 366 days", "טווח התאריכים ארוך מדי (מקסימום 366 ימים)."],
    ["some_new_server_message", "לא ניתן היה לטעון את נתוני ההרשמה."],
  ];
  for (const [serverMessage, expected] of cases) {
    const mock = seeded({}, "admin");
    mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
    mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
    mock.onRpc("registration_funnel", () => ({ data: null, error: { message: serverMessage } }));
    const window = await bootCommunity(mock, { syncEnabled: false });
    await openAccountTab(window);
    try {
      await waitFor(() => window.document.body.textContent.includes(expected), 3000);
    } catch (e) {
      throw new Error(`expected "${expected}" for server message "${serverMessage}": ${e.message}`);
    }
  }
});

test("the funnel section reuses COMM-310's own single period selector, nested inside the same dashboard container", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  mock.onRpc("registration_funnel", () => ({ data: funnelFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("משפך הרשמה"), 3000);
  assert.equal(window.document.querySelectorAll('[data-community-action="admin-analytics-mode"]').length, 2, "still exactly one week/month toggle pair");
  const dashboard = window.document.querySelector('[data-admin-analytics-dashboard="1"]');
  assert.ok(dashboard.querySelector('[data-registration-funnel-section="1"]'), "nested inside COMM-310's own dashboard container");
});

test("registration_funnel is called with the same period as analytics_dashboard, and re-queried on period paging", async () => {
  const mock = seeded({}, "admin");
  const dashArgs = [];
  mock.onRpc("analytics_dashboard", (args) => { dashArgs.push(args); return { data: minimalDashboardFixture(), error: null }; });
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  const funnelArgs = [];
  mock.onRpc("registration_funnel", (args) => { funnelArgs.push(args); return { data: funnelFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => funnelArgs.length === 1, 3000);
  assert.deepEqual(funnelArgs[0], { p_period_start: dashArgs[0].p_period_start, p_period_end: dashArgs[0].p_period_end });

  window.document.querySelector('[data-community-action="admin-analytics-shift"][data-dir="-1"]').click();
  await waitFor(() => funnelArgs.length === 2, 3000);
  assert.deepEqual(funnelArgs[1], { p_period_start: dashArgs[1].p_period_start, p_period_end: dashArgs[1].p_period_end });
});

test("registration_funnel is never called on its own before analytics_dashboard resolves", async () => {
  const mock = seeded({}, "admin");
  let resolveDash;
  mock.onRpc("analytics_dashboard", () => new Promise((resolve) => { resolveDash = resolve; }));
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  const funnelCalls = [];
  mock.onRpc("registration_funnel", (args) => { funnelCalls.push(args); return { data: funnelFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-admin-analytics-skeleton="1"]'), 3000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(funnelCalls.length, 0);
  resolveDash({ data: minimalDashboardFixture(), error: null });
  await waitFor(() => funnelCalls.length === 1, 3000);
});

// ---- the permission gate: community.analytics.view or real is_admin, NOT is_staff ---

test("a coach (is_staff, no community.analytics.view) never sees the funnel section, even though the roster (is_staff) is visible to them", async () => {
  const mock = seeded({}, "coach");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  const funnelCalls = [];
  mock.onRpc("registration_funnel", (args) => { funnelCalls.push(args); return { data: funnelFixture(), error: null }; });
  mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.body.textContent.includes("משפך הרשמה"), false);
  assert.equal(funnelCalls.length, 0);
  // Redesign, Phase 1: the roster is on a DIFFERENT Manage sub-tab
  // ("members") than the funnel/analytics ("analytics") now - navigate
  // there separately to check it still renders for the same coach.
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="members"]').click();
  await waitFor(() => !!window.document.querySelector('[data-member-roster-section="1"]'), 3000);
  assert.ok(window.document.querySelector('[data-member-roster-section="1"]'), "the roster still renders for the same coach (is_staff, looser gate)");
});

test("a plain member never sees the funnel section either", async () => {
  const mock = seeded({}, "member");
  mock.onRpc("registration_funnel", () => ({ data: funnelFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.equal(window.document.getElementById("tabManageBtn"), null, "a plain member never gets the Manage tab at all");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-registration-funnel-section="1"]'), null);
});

test("an admin (real is_admin, holds community.analytics.view) sees the funnel section", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: minimalSegmentsFixture(), error: null }));
  mock.onRpc("registration_funnel", () => ({ data: funnelFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-registration-funnel-section="1"]'), 3000);
});
