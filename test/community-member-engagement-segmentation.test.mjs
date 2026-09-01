// COMM-311, client half: member engagement segmentation. Schema half shipped
// in supabase/migrations/202609010007_member_segments.sql -
// member_segments(p_as_of date default current_date) returns setof jsonb,
// one row per club member, {user_id, display_name, handle, segment}, gated
// on community.analytics.view or real is_admin() (the same pair
// analytics_dashboard() and COMM-310's own client half use, NOT is_staff()).
//
// Six segments, in the migration's own strict precedence order: new,
// declining, highly_active, steady, occasional, dormant - the fifth,
// `occasional`, is a bucket the schema half added because the ticket's own
// five are not exhaustive (see that migration's header comment).
//
// This section is built to extend COMM-310's dashboard shell, per COMM-311's
// own acceptance criterion ("reusing COMM-310's dashboard shell") and per
// COMM-310's own commit message ("a later ticket's own section is meant to
// be a new render function appended inside the same populated branch,
// reusing state.adminAnalytics.start/end and the same period selector").
// So every test here goes through the SAME account-tab surface
// test/community-admin-analytics-dashboard.test.mjs already exercises, and
// registers its own member_segments RPC fixture the same way that file
// registers its own analytics_dashboard fixture (mockSupabase.mjs has no
// built-in stand-in for either).
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

// role: "admin" (is_admin true - holds community.analytics.view via the
// mock's own role->permission table), "coach" (is_staff true, no
// community.analytics.view - the exact asymmetry the migration's own AUTH
// note calls out), or "member" (neither).
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
    monthly_club_recaps: [], reports: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openAccountTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
}

// renderAdminAnalyticsWcam/etc. all default every nested field with `|| {}`,
// so an empty core/additional object is a legitimate, minimal
// analytics_dashboard() fixture for tests that only care about the segments
// section appended after it - the section this file actually tests.
function minimalDashboardFixture() { return { core: {}, additional: {} }; }

// All six segments present, plus one visible_to_club = false member folded
// into `steady` - the migration's own "user_id, display_name AND handle all
// null together" redaction shape, counted but not nameable.
function segmentsFixture() {
  return [
    { user_id: "u-new1", display_name: "נועה חדשה", handle: "noa_new", segment: "new" },
    { user_id: "u-decl1", display_name: "דני בירידה", handle: "dani_d", segment: "declining" },
    { user_id: "u-decl2", display_name: "רותי בירידה", handle: "ruti_d", segment: "declining" },
    { user_id: "u-ha1", display_name: "הראל פעיל", handle: "harel_a", segment: "highly_active" },
    { user_id: "u-st1", display_name: "שירה יציבה", handle: "shira_s", segment: "steady" },
    { user_id: null, display_name: null, handle: null, segment: "steady" },
    { user_id: "u-oc1", display_name: "אופיר מזדמן", handle: "ofir_o", segment: "occasional" },
    { user_id: "u-do1", display_name: "דורון רדום", handle: "doron_d", segment: "dormant" },
  ];
}

// --- loading / error / populated states -------------------------------------

test("Loading: the segments section shows its own skeleton while member_segments is in flight, then renders all six segment cards with counts and shares", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  let resolveSeg;
  const segCalls = [];
  mock.onRpc("member_segments", (args) => { segCalls.push(args); return new Promise((resolve) => { resolveSeg = resolve; }); });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("פילוח מעורבות חברים"), 3000);
  await waitFor(() => !!window.document.querySelector('[data-member-segments-skeleton="1"]'), 3000);

  resolveSeg({ data: segmentsFixture(), error: null });
  await waitFor(() => window.document.body.textContent.includes("חדשים/ות"), 3000);
  assert.equal(window.document.querySelector('[data-member-segments-skeleton="1"]'), null, "the skeleton is gone once populated");
  assert.equal(segCalls.length, 1, "member_segments was called exactly once");

  const section = window.document.querySelector('[data-member-segments-section="1"]');
  assert.ok(section, "the segments section rendered");
  const text = section.textContent;

  // 8 total members: new=1, declining=2, highly_active=1, steady=2 (1 named
  // + 1 redacted), occasional=1, dormant=1.
  assert.match(text, /חדשים\/ות\s*1\s*·\s*12\.5%/, "new: count 1, share 12.5%");
  assert.match(text, /בירידה\s*2\s*·\s*25%/, "declining: count 2, share 25%");
  assert.match(text, /פעילים\/ות מאוד\s*1\s*·\s*12\.5%/, "highly_active: count 1, share 12.5%");
  assert.match(text, /יציבים\/ות\s*2\s*·\s*25%/, "steady: count 2 (including the redacted member), share 25%");
  assert.match(text, /מזדמנים\/ות\s*1\s*·\s*12\.5%/, "occasional: count 1, share 12.5%");
  assert.match(text, /רדומים\/ות\s*1\s*·\s*12\.5%/, "dormant: count 1, share 12.5%");
  assert.match(text, /סה״כ חברי מועדון:\s*8/, "the total member count is the whole club, redacted member included");
});

test("Empty: a segment with nobody in it still renders its own card with 0, not an omitted row", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  // No `occasional` or `dormant` member at all in this fixture.
  const rows = segmentsFixture().filter((r) => r.segment !== "occasional" && r.segment !== "dormant");
  mock.onRpc("member_segments", () => ({ data: rows, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("פילוח מעורבות חברים"), 3000);
  await waitFor(() => window.document.body.textContent.includes("מזדמנים/ות"), 3000);
  const text = window.document.querySelector('[data-member-segments-section="1"]').textContent;
  assert.match(text, /מזדמנים\/ות\s*0\s*·\s*0%/, "occasional renders as an explicit 0, not omitted");
  assert.match(text, /רדומים\/ות\s*0\s*·\s*0%/, "dormant renders as an explicit 0, not omitted");
  // Both zero-count cards still exist as elements, not just absent text.
  assert.ok(window.document.querySelector('[data-member-segment-card="occasional"]'));
  assert.ok(window.document.querySelector('[data-member-segment-card="dormant"]'));
});

test("Error: member_segments failing shows COMM-311's own copy, independent of COMM-310's dashboard which loaded fine, with a working retry that does not re-call analytics_dashboard", async () => {
  const mock = seeded({}, "admin");
  const dashCalls = [];
  mock.onRpc("analytics_dashboard", () => { dashCalls.push(1); return { data: minimalDashboardFixture(), error: null }; });
  let segCalls = 0;
  mock.onRpc("member_segments", () => {
    segCalls++;
    if (segCalls === 1) return { data: null, error: { message: "boom" } };
    return { data: segmentsFixture(), error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את הפילוח."), 3000);
  // COMM-310's own dashboard is fine and rendered - the error is scoped to
  // the segments section alone.
  assert.doesNotMatch(window.document.body.textContent, /לא ניתן היה לטעון את הנתונים\./, "COMM-310's own dashboard did not error");
  window.document.querySelector('[data-community-action="member-segments-retry"]').click();
  await waitFor(() => window.document.body.textContent.includes("חדשים/ות") && segCalls === 2, 3000);
  assert.equal(dashCalls.length, 1, "retrying the segments section alone never re-calls analytics_dashboard");
});

test("both real server refusals map to their own short Hebrew message, and an unmapped error falls back to the ticket's own generic copy", async () => {
  const cases = [
    ["not authorized", "אין לך הרשאה לצפות בפילוח זה."],
    ["as-of date is in the future", "לא ניתן להציג פילוח לתאריך עתידי."],
    ["some_new_server_message", "לא ניתן היה לטעון את הפילוח."],
  ];
  for (const [serverMessage, expected] of cases) {
    const mock = seeded({}, "admin");
    mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
    mock.onRpc("member_segments", () => ({ data: null, error: { message: serverMessage } }));
    const window = await bootCommunity(mock, { syncEnabled: false });
    await openAccountTab(window);
    try {
      await waitFor(() => window.document.body.textContent.includes(expected), 3000);
    } catch (e) {
      throw new Error(`expected "${expected}" for server message "${serverMessage}": ${e.message}`);
    }
  }
});

// --- drill-down, including the redacted (null-triple) member ---------------

test("Populated: drilling into a segment lists its members by name, and a redacted member renders as an uncounted-but-unnamed placeholder, still present in the list", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: segmentsFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("יציבים/ות"), 3000);

  const card = window.document.querySelector('[data-member-segment-card="steady"]');
  assert.ok(card, "the steady segment card rendered");
  // Not expanded yet - no member names on screen.
  assert.doesNotMatch(card.textContent, /שירה יציבה/);

  card.querySelector('[data-community-action="member-segments-toggle"]').click();
  await waitFor(() => window.document.querySelector('[data-member-segment-card="steady"]').textContent.includes("שירה יציבה"), 3000);
  const expandedText = window.document.querySelector('[data-member-segment-card="steady"]').textContent;
  assert.match(expandedText, /שירה יציבה/, "the named member appears in the drill-down");
  assert.match(expandedText, /חבר\/ה \(פרופיל מוסתר\)/, "the redacted member appears as an unnamed placeholder, not omitted");
  // The drill-down list's own row count matches the card's own count (2):
  // one named row, one redacted placeholder row - never a 3rd, never a 1st.
  const rows = window.document.querySelector('[data-member-segment-card="steady"] .log-list').children;
  assert.equal(rows.length, 2, "the drill-down count matches the card's own count of 2");

  // Collapsing hides the names again.
  window.document.querySelector('[data-member-segment-card="steady"] [data-community-action="member-segments-toggle"]').click();
  await waitFor(() => !window.document.querySelector('[data-member-segment-card="steady"]').textContent.includes("שירה יציבה"), 3000);
});

test("a segment with nobody in it, when drilled into, shows an explicit empty state rather than a blank list", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  const rows = segmentsFixture().filter((r) => r.segment !== "dormant");
  mock.onRpc("member_segments", () => ({ data: rows, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("רדומים/ות"), 3000);
  window.document.querySelector('[data-member-segment-card="dormant"] [data-community-action="member-segments-toggle"]').click();
  await waitFor(() => window.document.querySelector('[data-member-segment-card="dormant"]').textContent.includes("אין חברים בפילוח זה"), 3000);
});

// --- p_as_of derivation: reuses COMM-310's own period, capped at today -----

test("member_segments is called with today's date when COMM-310's own selected period end is in the future (the current week is not over)", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  const segArgs = [];
  mock.onRpc("member_segments", (args) => { segArgs.push(args); return { data: segmentsFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => segArgs.length === 1, 3000);
  const todayIso = new Date().toISOString().slice(0, 10);
  assert.equal(segArgs[0].p_as_of, todayIso, "a future/ongoing period end is capped at today rather than sent as-is");
});

test("switching to month mode and paging to a past month re-queries member_segments with that period's own end date (already in the past, so not capped)", async () => {
  const mock = seeded({}, "admin");
  const dashArgs = [];
  mock.onRpc("analytics_dashboard", (args) => { dashArgs.push(args); return { data: minimalDashboardFixture(), error: null }; });
  const segArgs = [];
  mock.onRpc("member_segments", (args) => { segArgs.push(args); return { data: segmentsFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => segArgs.length === 1, 3000);

  window.document.querySelector('[data-community-action="admin-analytics-mode"][data-mode="month"]').click();
  await waitFor(() => segArgs.length === 2, 3000);
  window.document.querySelector('[data-community-action="admin-analytics-shift"][data-dir="-1"]').click();
  await waitFor(() => segArgs.length === 3, 3000);

  const lastDashArgs = dashArgs[dashArgs.length - 1];
  assert.equal(segArgs[2].p_as_of, lastDashArgs.p_period_end, "a past month's own end date is reused verbatim as p_as_of, not capped");
});

// --- integration with COMM-310's shell: no duplicated period-selector/load machinery ---

test("the segments section reuses COMM-310's own single period selector rather than opening a second one", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: segmentsFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("פילוח מעורבות חברים"), 3000);
  assert.equal(window.document.querySelectorAll('[data-community-action="admin-analytics-mode"]').length, 2, "still exactly one week/month toggle pair - the segments section added no second one");
  assert.equal(window.document.querySelectorAll('[data-community-action="admin-analytics-shift"]').length, 2, "still exactly one prev/next pager - the segments section added no second one");
  // The segments section lives inside the SAME outer dashboard container
  // COMM-310 built, not a second top-level section.
  const dashboard = window.document.querySelector('[data-admin-analytics-dashboard="1"]');
  assert.ok(dashboard.querySelector('[data-member-segments-section="1"]'), "the segments section is nested inside COMM-310's own dashboard container");
});

test("member_segments is never called on its own before analytics_dashboard resolves", async () => {
  const mock = seeded({}, "admin");
  let resolveDash;
  mock.onRpc("analytics_dashboard", () => new Promise((resolve) => { resolveDash = resolve; }));
  const segCalls = [];
  mock.onRpc("member_segments", (args) => { segCalls.push(args); return { data: segmentsFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-admin-analytics-skeleton="1"]'), 3000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(segCalls.length, 0, "member_segments has not been called while analytics_dashboard is still in flight");
  resolveDash({ data: minimalDashboardFixture(), error: null });
  await waitFor(() => segCalls.length === 1, 3000);
});

// --- the permission gate: community.analytics.view or real is_admin, NOT isStaff ---

test("a coach (is_staff, no community.analytics.view) never sees the segments section, and member_segments is never called", async () => {
  const mock = seeded({}, "coach");
  const dashCalls = [];
  mock.onRpc("analytics_dashboard", (args) => { dashCalls.push(args); return { data: minimalDashboardFixture(), error: null }; });
  const segCalls = [];
  mock.onRpc("member_segments", (args) => { segCalls.push(args); return { data: segmentsFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.body.textContent.includes("פילוח מעורבות חברים"), false, "the section text never renders for a coach");
  assert.equal(window.document.querySelector('[data-member-segments-section="1"]'), null);
  assert.equal(dashCalls.length, 0, "a coach never even triggers analytics_dashboard (COMM-310's own gate)");
  assert.equal(segCalls.length, 0, "a coach's session never calls member_segments at all");
});

test("a plain member (no staff role at all) never sees the segments section either", async () => {
  const mock = seeded({}, "member");
  const segCalls = [];
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", (args) => { segCalls.push(args); return { data: segmentsFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-member-segments-section="1"]'), null);
  assert.equal(segCalls.length, 0);
});

test("an admin (real is_admin, holds community.analytics.view) sees the segments section", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: segmentsFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-member-segments-section="1"]'), 3000);
});
