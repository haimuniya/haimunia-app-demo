// COMM-312, client half: community health score, internal only. Schema half
// shipped in supabase/migrations/202609010009_community_health_score.sql -
// ONE read path, community_health_history(p_weeks default 12) returns setof
// jsonb, {week_start, score, components} per row, security definer, gated on
// real is_admin() ALONE - the same narrower bar COMM-313's three retention
// functions use (not the hasPerm(PERM.ANALYTICS_VIEW) || isAdmin() pair
// COMM-310/311 use). There is no write path reachable from a client session
// at all: community_health_generate() is service_role only, so this ticket's
// client half is read-only, period - no "recompute now" button exists to
// test the absence of, because building one was explicitly out of scope.
//
// Executed for real (bootCommunity + the mock Supabase client), the same way
// test/community-retention-correlation-views.test.mjs drives COMM-313's own
// sibling section. mockSupabase.mjs has no built-in stand-in for
// community_health_history (it is new), so every test below registers its
// own handler.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

// role: "admin" (is_admin true), "coach" (is_staff true, no
// community.analytics.view), or "member" (neither). analyticsViewOnly, when
// true, overrides my_permissions() to grant community.analytics.view to a
// NON-admin session - the same negative case COMM-313's own test file
// exercises, since community_health_history() carries the identical
// permission shape (real is_admin() alone, no community.analytics.view
// alternative).
function seeded(extra, role, opts) {
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
    monthly_club_recaps: [], reports: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  if (opts && opts.analyticsViewOnly) {
    mock.onRpc("my_permissions", () => ({ data: ["community.analytics.view"], error: null }));
  }
  return mock;
}

// Redesign, Phase 1: renderCommunityHealthScore() moved from Community's
// "account" sub-tab to the Manage tab's own "dashboard" sub-tab (the
// mockup's own layout call - the score is the dashboard's headline card,
// not one more analytics card). renderAdminAnalyticsDashboard()/
// renderRetentionCorrelations() moved too, to Manage's "analytics" sub-tab
// - a DIFFERENT sub-tab than health's now, where before all three sat on
// the same Account-tab page together.
async function openAccountTab(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="dashboard"]').click();
}
async function openManageAnalytics(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="analytics"]').click();
}

// analytics_dashboard()/member_segments()/the three retention RPCs are
// exercised elsewhere - minimal fixtures here just keep those sibling
// sections from erroring, since all of them render in the same account tab.
function minimalDashboardFixture() { return { core: {}, additional: {} }; }
function registerSiblingRpcs(mock) {
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: [], error: null }));
  mock.onRpc("retention_cohorts", () => ({ data: [], error: null }));
  mock.onRpc("retention_onboarding_correlation", () => ({ data: [], error: null }));
  mock.onRpc("retention_welcome_correlation", () => ({ data: [], error: null }));
}

// One component of the four, matching community_health_component()'s own
// shape: {value, sub_score, weight, weight_applied, detail}.
function healthComponent(value, subScore, weight, weightApplied) {
  return { value, sub_score: subScore, weight, weight_applied: weightApplied, detail: {} };
}
// All four components available, a reasonable healthy-week fixture, unless
// overridden per key (used to simulate a dropped, renormalised component).
function healthComponents(overrides) {
  return Object.assign({
    wcam_share: healthComponent(0.32, 0.32, 0.40, 0.40),
    engagement_per_post: healthComponent(2.1, 0.7, 0.25, 0.25),
    moderation_load: healthComponent(1.5, 0.85, 0.10, 0.10),
    retention: healthComponent(0.55, 0.55, 0.25, 0.25),
  }, overrides || {});
}
function healthWeek(weekStart, score, componentOverrides) {
  return { week_start: weekStart, score, components: healthComponents(componentOverrides) };
}

// --- loading / error / populated states -------------------------------------

test("Loading: the community health section shows its own skeleton while the RPC is in flight, then renders the score", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  let resolveHistory;
  mock.onRpc("community_health_history", () => new Promise((resolve) => { resolveHistory = resolve; }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-health-skeleton="1"]'), 3000);

  resolveHistory({ data: [healthWeek("2026-08-24", 78.4)], error: null });
  await waitFor(() => !!window.document.querySelector('[data-community-health-score-card="1"]'), 3000);
  assert.equal(window.document.querySelector('[data-community-health-skeleton="1"]'), null, "the skeleton is gone once populated");
  assert.ok(window.document.querySelector('[data-community-health-score="1"]'), "the community health section rendered");
});

test("Error: a failing RPC shows the ticket's own exact copy, and a working retry re-fetches", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  let calls = 0;
  mock.onRpc("community_health_history", () => {
    calls++;
    if (calls === 1) return { data: null, error: { message: "boom" } };
    return { data: [healthWeek("2026-08-24", 60)], error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את הציון."), 3000);
  window.document.querySelector('[data-community-action="community-health-retry"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-health-score-card="1"]') && calls === 2, 3000);
});

test("the real 'not authorized' refusal maps to its own short Hebrew message, and an unmapped error falls back to the ticket's own generic copy", async () => {
  const cases = [
    ["not authorized", "אין לך הרשאה לצפות בציון זה."],
    ["some_new_server_message", "לא ניתן היה לטעון את הציון."],
  ];
  for (const [serverMessage, expected] of cases) {
    const mock = seeded({}, "admin");
    registerSiblingRpcs(mock);
    mock.onRpc("community_health_history", () => ({ data: null, error: { message: serverMessage } }));
    const window = await bootCommunity(mock, { syncEnabled: false });
    await openAccountTab(window);
    try {
      await waitFor(() => window.document.body.textContent.includes(expected), 3000);
    } catch (e) {
      throw new Error(`expected "${expected}" for server message "${serverMessage}": ${e.message}`);
    }
  }
});

// --- 0-row / 1-row / 2+-row empty-state logic -------------------------------

test("Empty: 0 computed weeks shows a true empty state, no score card and no trend line", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  mock.onRpc("community_health_history", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-health-empty="1"]'), 3000);
  assert.equal(window.document.querySelector('[data-community-health-score-card="1"]'), null, "no score card with zero rows");
  assert.equal(window.document.querySelector('[data-community-health-trend="1"]'), null, "no trend line with zero rows");
});

test("Empty (fewer than 2 weeks): exactly 1 computed week shows the latest score, but no trend line, not a broken chart", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  mock.onRpc("community_health_history", () => ({ data: [healthWeek("2026-08-24", 71.2)], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-health-score-card="1"]'), 3000);
  assert.equal(window.document.querySelector('[data-community-health-score-value="1"]').textContent, "71.2");
  assert.equal(window.document.querySelector('[data-community-health-trend="1"]'), null, "one row is not enough for a trend line");
  assert.equal(window.document.querySelector('[data-community-health-empty="1"]'), null, "one row is not the empty state either");
});

test("Populated: 2+ computed weeks shows the latest score AND a trend line, drawn in the RPC's own oldest-first order with no re-sort", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  const weeks = [
    healthWeek("2026-08-10", 55.0),
    healthWeek("2026-08-17", 63.5),
    healthWeek("2026-08-24", 78.4),
  ];
  mock.onRpc("community_health_history", () => ({ data: weeks, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-health-trend="1"]'), 3000);

  // The score card shows the LATEST week - the last element, since the RPC's
  // own contract returns oldest-first.
  assert.equal(window.document.querySelector('[data-community-health-score-value="1"]').textContent, "78.4");
  assert.match(window.document.querySelector('[data-community-health-score-card="1"]').textContent, /2026-08-24/);

  // The trend line lists all three weeks in the array's own order (oldest to
  // newest), never re-sorted client-side.
  const trendRows = Array.from(window.document.querySelectorAll('[data-community-health-trend="1"] .log-row')).map((r) => ({
    label: r.children[0].textContent, value: r.children[1].textContent,
  }));
  assert.deepEqual(trendRows, [
    { label: "2026-08-10", value: "55" },
    { label: "2026-08-17", value: "63.5" },
    { label: "2026-08-24", value: "78.4" },
  ], "the trend line draws left to right in the order the RPC returned, with no re-sort");
});

// --- the weight_applied-zero caveat -----------------------------------------

test("a component fully available (weight_applied > 0) shows its weight, not the dropped caveat", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  mock.onRpc("community_health_history", () => ({ data: [healthWeek("2026-08-24", 70)], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-health-score-card="1"]'), 3000);
  const wcamRow = window.document.querySelector('[data-community-health-component="wcam_share"]');
  assert.ok(wcamRow, "the wcam_share row rendered");
  assert.match(wcamRow.textContent, /במשקל 40%/, "an available component shows its applied weight");
  assert.equal(wcamRow.querySelector('[data-community-health-dropped="1"]'), null, "and does not show the dropped caveat");
});

test("a component with weight_applied 0 (no data that week, renormalised away) shows a visible caveat instead of a misleading 0% weight", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  // engagement_per_post had no posts that week: sub_score null, weight_applied
  // 0 - community_health_component()'s own documented shape for "no data".
  const week = healthWeek("2026-08-24", 64, {
    engagement_per_post: healthComponent(null, null, 0.25, 0),
  });
  mock.onRpc("community_health_history", () => ({ data: [week], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-health-score-card="1"]'), 3000);
  const epRow = window.document.querySelector('[data-community-health-component="engagement_per_post"]');
  assert.ok(epRow, "the engagement_per_post row still rendered even though it dropped out");
  assert.ok(epRow.querySelector('[data-community-health-dropped="1"]'), "the dropped caveat is present");
  assert.match(epRow.textContent, /לא נכלל בציון השבוע/, "the caveat says this component was not included this week");
  assert.doesNotMatch(epRow.textContent, /במשקל 0%/, "a dropped component does not render as a misleading 0% weight line");

  // The other three, unaffected, still show their own real weight.
  const modRow = window.document.querySelector('[data-community-health-component="moderation_load"]');
  assert.match(modRow.textContent, /במשקל 10%/, "an unaffected component's weight is unchanged by a sibling dropping out");
});

test("all four components render, in the stored row's own key order", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  mock.onRpc("community_health_history", () => ({ data: [healthWeek("2026-08-24", 70)], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-health-score-card="1"]'), 3000);
  const keys = Array.from(window.document.querySelectorAll('[data-community-health-components="1"] [data-community-health-component]'))
    .map((el) => el.getAttribute("data-community-health-component"));
  assert.deepEqual(keys, ["wcam_share", "engagement_per_post", "moderation_load", "retention"]);
});

// --- the is_admin()-only gate: the genuinely different negative case -------

test("a community.analytics.view holder who is NOT an admin sees COMM-310's dashboard and COMM-313's retention section, but NOT this section at all, and community_health_history is never called", async () => {
  const mock = seeded({}, "coach", { analyticsViewOnly: true });
  const dashCalls = [];
  mock.onRpc("analytics_dashboard", (args) => { dashCalls.push(args); return { data: minimalDashboardFixture(), error: null }; });
  mock.onRpc("member_segments", () => ({ data: [], error: null }));
  mock.onRpc("retention_cohorts", () => ({ data: [], error: null }));
  mock.onRpc("retention_onboarding_correlation", () => ({ data: [], error: null }));
  mock.onRpc("retention_welcome_correlation", () => ({ data: [], error: null }));
  const healthCalls = [];
  mock.onRpc("community_health_history", (args) => { healthCalls.push(args); return { data: [healthWeek("2026-08-24", 70)], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  // The broader-gated dashboard DOES show for this holder, on Manage's
  // "analytics" sub-tab.
  await openManageAnalytics(window);
  await waitFor(() => !!window.document.querySelector('[data-admin-analytics-dashboard="1"]'), 3000);
  assert.ok(dashCalls.length >= 1, "analytics_dashboard() is called for a community.analytics.view holder");
  assert.equal(window.document.querySelector('[data-community-health-score="1"]'), null, "the community health section never renders on Analytics either");

  // Nor on the Dashboard sub-tab, where health now lives for an admin.
  await openAccountTab(window);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-community-health-score="1"]'), null, "the community health section never renders for this holder");
  assert.equal(window.document.body.textContent.includes("ציון בריאות הקהילה"), false, "not even the section header text is present");
  assert.equal(healthCalls.length, 0, "community_health_history() was never called");
});

test("a plain admin (real is_admin) sees the community health section and community_health_history is called", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  const calls = [];
  mock.onRpc("community_health_history", (args) => { calls.push(args); return { data: [healthWeek("2026-08-24", 70)], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-health-score="1"]'), 3000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { p_weeks: 12 }, "the client passes its own fixed default rather than relying on the RPC's own default");
});

test("a coach (is_staff, no community.analytics.view at all) never sees the community health section, and never triggers the RPC", async () => {
  const mock = seeded({}, "coach");
  registerSiblingRpcs(mock);
  const calls = [];
  mock.onRpc("community_health_history", () => { calls.push(1); return { data: [healthWeek("2026-08-24", 70)], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-community-health-score="1"]'), null);
  assert.equal(calls.length, 0);
});

test("a plain member (no staff role, no permission at all) never sees the community health section", async () => {
  const mock = seeded({}, "member");
  registerSiblingRpcs(mock);
  const calls = [];
  mock.onRpc("community_health_history", () => { calls.push(1); return { data: [healthWeek("2026-08-24", 70)], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  // Redesign, Phase 1: a plain member does not even get the Manage tab at
  // all (window.communityIsStaff() gates whether app.js emits it) -
  // stronger than the old assertion, which only checked the section was
  // absent from Account.
  assert.equal(window.document.getElementById("tabManageBtn"), null, "a plain member never gets the Manage tab at all");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-community-health-score="1"]'), null);
  assert.equal(calls.length, 0);
});

// --- placement: its own section, sibling to COMM-313's, not nested ---------

test("the community health section is its OWN top-level ach-section, not nested inside COMM-310's dashboard nor COMM-313's retention section, and vice versa - redesign, Phase 1: they are also on separate Manage sub-tabs entirely now, never in the same DOM at once", async () => {
  const mock = seeded({}, "admin");
  registerSiblingRpcs(mock);
  mock.onRpc("community_health_history", () => ({ data: [healthWeek("2026-08-24", 70)], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });

  await openManageAnalytics(window);
  await waitFor(() => !!window.document.querySelector('[data-admin-analytics-dashboard="1"]'), 3000);
  const dashboard = window.document.querySelector('[data-admin-analytics-dashboard="1"]');
  const retention = window.document.querySelector('[data-retention-correlations="1"]');
  assert.ok(dashboard && retention, "both analytics sections rendered on the analytics sub-tab");
  assert.equal(window.document.querySelector('[data-community-health-score="1"]'), null, "the health section is not nested inside the analytics sub-tab at all");

  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-health-score="1"]'), 3000);
  const health = window.document.querySelector('[data-community-health-score="1"]');
  assert.ok(health, "the health section rendered on the dashboard sub-tab");
  assert.equal(window.document.querySelector('[data-admin-analytics-dashboard="1"]'), null, "and neither analytics section is nested inside the dashboard sub-tab, the other way around");
  assert.equal(window.document.querySelector('[data-retention-correlations="1"]'), null);
});
