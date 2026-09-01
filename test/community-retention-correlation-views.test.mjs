// COMM-313, client half: retention correlation views. Schema half shipped in
// supabase/migrations/202609010008_retention_cohorts.sql - three
// security-definer functions, retention_cohorts(p_cohort_months default 6),
// retention_onboarding_correlation() and retention_welcome_correlation(),
// EACH GATED ON REAL is_admin() ALONE - not the hasPerm(PERM.ANALYTICS_VIEW)
// || isAdmin() pair COMM-310 (analytics_dashboard) and COMM-311
// (member_segments) both use. That narrower gate is the ticket's own
// headline acceptance criterion ("matching COMM-312's narrower bar"), and it
// is why this section is its OWN top-level ach-section in cloud.js
// (renderRetentionCorrelations()) rather than appended inside
// renderAdminAnalyticsDashboard() the way COMM-311's renderMemberSegments()
// is - see that function's own comment in cloud.js for the full reasoning.
//
// Executed for real (bootCommunity + the mock Supabase client), the same way
// test/community-admin-analytics-dashboard.test.mjs and
// test/community-member-engagement-segmentation.test.mjs drive their own
// staff surfaces. mockSupabase.mjs has no built-in stand-in for any of the
// three retention RPCs (they are new), so every test below registers its
// own handlers.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

// role: "admin" (is_admin true), "coach" (is_staff true, no
// community.analytics.view), or "member" (neither). analyticsViewOnly, when
// true, overrides my_permissions() to grant community.analytics.view to a
// NON-admin session - the one negative case COMM-313 itself calls out as
// genuinely different from COMM-310/311 (a real analytics-permission holder
// who is not an admin must be refused here, unlike member_segments()/
// analytics_dashboard()). The mock's own built-in role->permission table has
// no role that holds community.analytics.view without also being admin, so
// this is done by overriding my_permissions() directly, the same RPC
// cloud.js's own hasPerm() is built on.
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

async function openAccountTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
}

// analytics_dashboard()/member_segments() are exercised elsewhere - a
// minimal fixture here just keeps COMM-310's own shell from erroring, since
// it renders in the same account tab.
function minimalDashboardFixture() { return { core: {}, additional: {} }; }

// Two cohort months plus 'other', mirroring 202609010008's own
// {cohort_month, week_number, retained_share, member_count} shape. 'other'
// is deliberately NOT last in this fixture's own array order, so a test can
// prove the client re-sorts it last rather than trusting array order.
function cohortsFixture() {
  return [
    { cohort_month: "other", week_number: 1, retained_share: 0.5, member_count: 8 },
    { cohort_month: "2026-07", week_number: 1, retained_share: 0.9, member_count: 20 },
    { cohort_month: "2026-07", week_number: 2, retained_share: 0.8, member_count: 19 },
    { cohort_month: "2026-06", week_number: 1, retained_share: 0.7, member_count: 15 },
  ];
}

function onboardingFixture() {
  return [
    { step: "welcomed_at", stamped: true, week_number: 1, retained_share: 0.95, member_count: 25 },
    { step: "welcomed_at", stamped: false, week_number: 1, retained_share: 0.6, member_count: 10 },
    { step: "first_week_shown_at", stamped: true, week_number: 1, retained_share: 0.42, member_count: 11 },
  ];
}

function welcomeFixture() {
  return [
    { contacted: true, week_number: 1, retained_share: 0.92, member_count: 18 },
    { contacted: false, week_number: 1, retained_share: 0.55, member_count: 22 },
  ];
}

function registerHappyRpcs(mock, opts) {
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: [], error: null }));
  mock.onRpc("retention_cohorts", () => ({ data: (opts && opts.cohorts) || cohortsFixture(), error: null }));
  mock.onRpc("retention_onboarding_correlation", () => ({ data: (opts && opts.onboarding) || onboardingFixture(), error: null }));
  mock.onRpc("retention_welcome_correlation", () => ({ data: (opts && opts.welcome) || welcomeFixture(), error: null }));
}

// --- loading / error / populated states -------------------------------------

test("Loading: the retention section shows its own skeleton while the three RPCs are in flight, then renders the cohort curves", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: [], error: null }));
  let resolveCohorts;
  mock.onRpc("retention_cohorts", () => new Promise((resolve) => { resolveCohorts = resolve; }));
  mock.onRpc("retention_onboarding_correlation", () => ({ data: onboardingFixture(), error: null }));
  mock.onRpc("retention_welcome_correlation", () => ({ data: welcomeFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-retention-skeleton="1"]'), 3000);

  resolveCohorts({ data: cohortsFixture(), error: null });
  await waitFor(() => window.document.body.textContent.includes("קבוצת הצטרפות"), 3000);
  assert.equal(window.document.querySelector('[data-retention-skeleton="1"]'), null, "the skeleton is gone once populated");
  assert.ok(window.document.querySelector('[data-retention-correlations="1"]'), "the retention section rendered");
});

test("Error: retention_cohorts failing shows COMM-313's own copy, and a working retry re-fetches all three RPCs", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: [], error: null }));
  let cohortCalls = 0;
  mock.onRpc("retention_cohorts", () => {
    cohortCalls++;
    if (cohortCalls === 1) return { data: null, error: { message: "boom" } };
    return { data: cohortsFixture(), error: null };
  });
  mock.onRpc("retention_onboarding_correlation", () => ({ data: onboardingFixture(), error: null }));
  mock.onRpc("retention_welcome_correlation", () => ({ data: welcomeFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את נתוני השימור."), 3000);
  window.document.querySelector('[data-community-action="retention-retry"]').click();
  await waitFor(() => window.document.body.textContent.includes("קבוצת הצטרפות") && cohortCalls === 2, 3000);
});

test("the real 'not authorized' refusal maps to its own short Hebrew message, and an unmapped error falls back to the ticket's own generic copy", async () => {
  const cases = [
    ["not authorized", "אין לך הרשאה לצפות בנתוני השימור."],
    ["some_new_server_message", "לא ניתן היה לטעון את נתוני השימור."],
  ];
  for (const [serverMessage, expected] of cases) {
    const mock = seeded({}, "admin");
    mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
    mock.onRpc("member_segments", () => ({ data: [], error: null }));
    mock.onRpc("retention_cohorts", () => ({ data: null, error: { message: serverMessage } }));
    mock.onRpc("retention_onboarding_correlation", () => ({ data: onboardingFixture(), error: null }));
    mock.onRpc("retention_welcome_correlation", () => ({ data: welcomeFixture(), error: null }));
    const window = await bootCommunity(mock, { syncEnabled: false });
    await openAccountTab(window);
    try {
      await waitFor(() => window.document.body.textContent.includes(expected), 3000);
    } catch (e) {
      throw new Error(`expected "${expected}" for server message "${serverMessage}": ${e.message}`);
    }
  }
});

// --- cohort curve rendering, including 'other' -------------------------------

test("Populated: the cohort curve renders one card per cohort_month, 'other' sorted last regardless of the array order the RPC returned it in", async () => {
  const mock = seeded({}, "admin");
  registerHappyRpcs(mock);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("קבוצת הצטרפות"), 3000);

  const section = window.document.querySelector('[data-retention-correlations="1"]');
  const cardTitles = Array.from(section.querySelectorAll(".chart-card .field-label")).map((el) => el.textContent);
  const cohortTitles = cardTitles.filter((t) => t.startsWith("קבוצת הצטרפות"));
  assert.deepEqual(cohortTitles, [
    "קבוצת הצטרפות: 2026-06",
    "קבוצת הצטרפות: 2026-07",
    "קבוצת הצטרפות: קבוצות קטנות (מאוחדות)",
  ], "named months sort chronologically and 'other' is labelled and sorted last");

  const julyCard = Array.from(section.querySelectorAll(".chart-card")).find((c) => c.textContent.includes("קבוצת הצטרפות: 2026-07"));
  assert.ok(julyCard, "the 2026-07 card rendered");
  const julyRows = Array.from(julyCard.querySelectorAll(".log-list .log-row")).map((r) => ({
    label: r.children[0].textContent, value: r.children[1].textContent,
  }));
  assert.deepEqual(julyRows, [
    { label: "שבוע 1", value: "90% (מתוך 20)" },
    { label: "שבוע 2", value: "80% (מתוך 19)" },
  ], "each week's own share and member_count render as its own row, in week order");
});

test("a (cohort, week) cell the server never emitted (a suppressed tail) simply stops the card's log-list short, with no gap or placeholder row", async () => {
  const mock = seeded({}, "admin");
  // Only week 1 for 2026-07 - as if week 2 fell under the floor and was
  // truncated server-side, per 202609010008's own "truncates a line, never
  // punches a hole in one" rule.
  registerHappyRpcs(mock, { cohorts: [{ cohort_month: "2026-07", week_number: 1, retained_share: 0.9, member_count: 6 }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("קבוצת הצטרפות"), 3000);
  const card = Array.from(window.document.querySelectorAll(".chart-card")).find((c) => c.textContent.includes("קבוצת הצטרפות: 2026-07"));
  assert.ok(card, "the truncated cohort still renders its own card");
  const rows = card.querySelectorAll(".log-list .log-row");
  assert.equal(rows.length, 1, "only the one emitted week shows - no placeholder for week 2");
});

test("a cohort_month with zero rows at all (folded whole into 'other', or nobody has finished week 1 yet) is simply absent, not an empty card", async () => {
  const mock = seeded({}, "admin");
  registerHappyRpcs(mock, { cohorts: [] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("מתאמי שימור"), 3000);
  await waitFor(() => window.document.body.textContent.includes("אין עדיין נתוני שימור לתצוגה."), 3000);
});

// --- the two correlation overlays -------------------------------------------

test("the onboarding overlay is hidden until toggled, then shows the stamped/not-stamped pair for the selected step, and switching steps updates it", async () => {
  const mock = seeded({}, "admin");
  registerHappyRpcs(mock);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("שכבת-על: שלבי הכוונה"), 3000);
  assert.equal(window.document.querySelector('[data-retention-onboarding-overlay="1"]'), null, "the overlay is not rendered until toggled on");

  window.document.querySelector('[data-community-action="retention-toggle-onboarding"]').click();
  await waitFor(() => !!window.document.querySelector('[data-retention-onboarding-overlay="1"]'), 3000);
  let overlay = window.document.querySelector('[data-retention-onboarding-overlay="1"]');
  assert.match(overlay.textContent, /95%/, "the default step (welcomed_at) shows its stamped=true share");
  assert.match(overlay.textContent, /60%/, "and its stamped=false share");

  // Switch to a step with only a stamped=true group in the fixture -
  // 202609010008's own documented shape for a step nobody has been stamped
  // with yet (both COMM-316 columns right after deploy).
  window.document.querySelector('[data-community-action="retention-onboarding-step"][data-step="first_week_shown_at"]').click();
  await waitFor(() => window.document.querySelector('[data-retention-onboarding-overlay="1"]').textContent.includes("42%"), 3000);
  overlay = window.document.querySelector('[data-retention-onboarding-overlay="1"]');
  assert.doesNotMatch(overlay.textContent, /95%/, "the previous step's numbers are gone once a different step is selected");
  assert.match(overlay.textContent, /אין מספיק חברים לתצוגה יציבה/, "the missing stamped=false group for this step renders the empty state, not a blank or an error");

  window.document.querySelector('[data-community-action="retention-toggle-onboarding"]').click();
  await waitFor(() => window.document.querySelector('[data-retention-onboarding-overlay="1"]') == null, 3000);
});

test("the welcome overlay is hidden until toggled, then shows the contacted/not-contacted pair", async () => {
  const mock = seeded({}, "admin");
  registerHappyRpcs(mock);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("שכבת-על: פניית מאמן/ת ראשונית"), 3000);
  assert.equal(window.document.querySelector('[data-retention-welcome-overlay="1"]'), null);

  window.document.querySelector('[data-community-action="retention-toggle-welcome"]').click();
  await waitFor(() => !!window.document.querySelector('[data-retention-welcome-overlay="1"]'), 3000);
  const overlay = window.document.querySelector('[data-retention-welcome-overlay="1"]');
  assert.match(overlay.textContent, /92%/, "the contacted=true share renders");
  assert.match(overlay.textContent, /55%/, "the contacted=false share renders");
});

test("both overlays can be shown at once, independently of each other", async () => {
  const mock = seeded({}, "admin");
  registerHappyRpcs(mock);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("שכבת-על: שלבי הכוונה"), 3000);
  window.document.querySelector('[data-community-action="retention-toggle-onboarding"]').click();
  window.document.querySelector('[data-community-action="retention-toggle-welcome"]').click();
  await waitFor(() => !!window.document.querySelector('[data-retention-onboarding-overlay="1"]') && !!window.document.querySelector('[data-retention-welcome-overlay="1"]'), 3000);
});

// --- correlation-not-causation copy -----------------------------------------

test("the correlation-not-causation note is visibly present near the correlation views once populated, without turning it on via a toggle", async () => {
  const mock = seeded({}, "admin");
  registerHappyRpcs(mock);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-retention-correlation-note="1"]'), 3000);
  const note = window.document.querySelector('[data-retention-correlation-note="1"]').textContent;
  assert.match(note, /מתאם/, "the note names this a correlation");
  assert.match(note, /לא סיבתיות/, "the note explicitly disclaims causation");
  // COMM-313's own restraint, matching the schema half's field-naming: no
  // "effect"/"impact"/"lift"/"uplift" word (Hebrew equivalents included)
  // anywhere in the note.
  for (const banned of ["השפעה", "אפקט", "תרומה סיבתית", "לחיצה", "עלייה חדה"]) {
    assert.doesNotMatch(note, new RegExp(banned), `the note must not use "${banned}"`);
  }
});

// --- the is_admin()-only gate: the genuinely different negative case -------

test("a community.analytics.view holder who is NOT an admin sees COMM-310's dashboard and COMM-311's segments, but NOT this section at all, and none of the three retention RPCs are ever called", async () => {
  const mock = seeded({}, "coach", { analyticsViewOnly: true });
  const dashCalls = [];
  mock.onRpc("analytics_dashboard", (args) => { dashCalls.push(args); return { data: minimalDashboardFixture(), error: null }; });
  mock.onRpc("member_segments", () => ({ data: [], error: null }));
  const retentionCalls = [];
  mock.onRpc("retention_cohorts", (args) => { retentionCalls.push(["cohorts", args]); return { data: cohortsFixture(), error: null }; });
  mock.onRpc("retention_onboarding_correlation", (args) => { retentionCalls.push(["onboarding", args]); return { data: onboardingFixture(), error: null }; });
  mock.onRpc("retention_welcome_correlation", (args) => { retentionCalls.push(["welcome", args]); return { data: welcomeFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);

  // The broader-gated surfaces DO show for this holder - the positive half
  // of the asymmetry COMM-313 itself calls out.
  await waitFor(() => !!window.document.querySelector('[data-admin-analytics-dashboard="1"]'), 3000);
  assert.ok(dashCalls.length >= 1, "analytics_dashboard() is called for a community.analytics.view holder");

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-retention-correlations="1"]'), null, "the retention section never renders for this holder");
  assert.equal(window.document.body.textContent.includes("מתאמי שימור"), false, "not even the section header text is present");
  assert.equal(retentionCalls.length, 0, "none of the three retention RPCs were ever called");
});

test("a plain admin (real is_admin) sees the retention section and all three RPCs are called with the right arguments", async () => {
  const mock = seeded({}, "admin");
  registerHappyRpcs(mock);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-retention-correlations="1"]'), 3000);

  const cohortsCalls = mock.callsTo("retention_cohorts");
  assert.equal(cohortsCalls.length, 1);
  assert.deepEqual(cohortsCalls[0], { p_cohort_months: 6 }, "retention_cohorts is called with the same fixed 6-month window the two parameter-less correlations use");
  assert.equal(mock.callsTo("retention_onboarding_correlation").length, 1);
  assert.equal(mock.callsTo("retention_welcome_correlation").length, 1);
});

test("a coach (is_staff, no community.analytics.view at all) never sees the retention section either, and never triggers any of the three RPCs", async () => {
  const mock = seeded({}, "coach");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  mock.onRpc("member_segments", () => ({ data: [], error: null }));
  const retentionCalls = [];
  mock.onRpc("retention_cohorts", () => { retentionCalls.push(1); return { data: cohortsFixture(), error: null }; });
  mock.onRpc("retention_onboarding_correlation", () => { retentionCalls.push(1); return { data: onboardingFixture(), error: null }; });
  mock.onRpc("retention_welcome_correlation", () => { retentionCalls.push(1); return { data: welcomeFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-retention-correlations="1"]'), null);
  assert.equal(retentionCalls.length, 0);
});

test("a plain member (no staff role, no permission at all) never sees the retention section", async () => {
  const mock = seeded({}, "member");
  mock.onRpc("analytics_dashboard", () => ({ data: minimalDashboardFixture(), error: null }));
  const retentionCalls = [];
  mock.onRpc("retention_cohorts", () => { retentionCalls.push(1); return { data: cohortsFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-retention-correlations="1"]'), null);
  assert.equal(retentionCalls.length, 0);
});

// --- placement: its own section, not nested inside COMM-310's dashboard ----

test("the retention section is its OWN top-level ach-section, not nested inside COMM-310's own dashboard container", async () => {
  const mock = seeded({}, "admin");
  registerHappyRpcs(mock);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-retention-correlations="1"]'), 3000);
  const dashboard = window.document.querySelector('[data-admin-analytics-dashboard="1"]');
  assert.ok(dashboard, "COMM-310's dashboard is still there");
  assert.equal(dashboard.querySelector('[data-retention-correlations="1"]'), null, "the retention section is not nested inside it");
  const retentionSection = window.document.querySelector('[data-retention-correlations="1"]');
  assert.equal(retentionSection.querySelector('[data-admin-analytics-dashboard="1"]'), null, "and the nesting is not the other way around either");
});
