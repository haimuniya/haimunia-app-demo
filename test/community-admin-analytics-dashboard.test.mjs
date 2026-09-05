// COMM-310, client half: the admin community analytics dashboard. Schema
// half shipped in 202609010006_analytics_dashboard.sql -
// analytics_dashboard(p_period_start, p_period_end) returns jsonb, ONE call
// answering every "Core metric" (5) and "Additional metric" (13)
// docs/community/metrics.md defines, gated on community.analytics.view or
// real is_admin() - NARROWER than is_staff(), so a plain coach is refused
// server-side (the migration's own AUTH note).
//
// Executed for real (bootCommunity + the mock Supabase client), the same
// way test/community-monthly-club-recap.test.mjs and
// test/community-member-of-week.test.mjs drive their own staff surfaces -
// real render/click paths against a hand-registered onRpc("analytics_dashboard", ...)
// fixture, not source-text matches. mockSupabase.mjs has no built-in stand-in
// for this RPC (it is new), so every test below registers its own handler,
// the same way the monthly recap tests register recap_monthly_publish.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

// role: "admin" (is_admin true - holds community.analytics.view via the
// mock's own role->permission table), "coach" (is_staff true, no
// community.analytics.view - the exact asymmetry COMM-310's own migration
// comment calls out), or "member" (neither).
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

// Redesign, Phase 1: the admin analytics dashboard moved from Community's
// "account" sub-tab to the Manage tab's own "analytics" sub-tab. Renamed
// call sites left alone (still "openAccountTab" throughout this file) -
// only the navigation itself changed.
async function openAccountTab(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="analytics"]').click();
}

// A full, plausible analytics_dashboard() response - every one of the 18
// metric.md keys present with real numbers, mirroring 202609010006's own
// jsonb shape key-for-key (see that migration's final `jsonb_build_object`).
function dashboardFixture(overrides) {
  const base = {
    period: { start: "2026-08-24", end: "2026-08-30", end_exclusive: "2026-08-31", days: 7, weeks: 1 },
    generated_at: VERIFIED,
    core: {
      wcam: {
        weeks: [{ week_start: "2026-08-24", partial: false, active_members: 37 }],
        average_weekly: 37, peak_weekly: 41, period_active_members: 40,
      },
      wcam_share: {
        weeks: [{ week_start: "2026-08-24", partial: false, club_members: 50, share: 0.74 }],
        average_share: 0.74,
      },
      posting_members: {
        weeks: [{ week_start: "2026-08-24", partial: false, posting_members: 12 }],
        average_weekly: 12, period_posting_members: 19,
      },
      engagement_per_post: {
        weeks: [{ week_start: "2026-08-24", partial: false, posts: 9, reactions: 40, comments: 15, engagement_per_post: 6.1111 }],
        period: { posts: 9, reactions: 40, comments: 15, engagement_per_post: 6.1111 },
        table_cross_check: { posts: 9, reactions: 38, comments: 14, engagement_per_post: 5.7778 },
      },
      feed_reach: {
        posts_published: 9, posts_with_impressions: 8, reach_share: 0.8889,
        impressions_total: 210, impressions_on_period_posts: 195, impressions_per_reached_post: 24.375,
      },
    },
    additional: {
      open_rate: {
        POST_WORKOUT: { impressions: 120, opens: 80, open_rate: 0.6667 },
        POST_PR: { impressions: 30, opens: 25, open_rate: 0.8333 },
      },
      filter_use: {
        by_scope: { for_you: 150, following: 40, achievements: 10 },
        by_source: { tab: 180, scope_change: 20 },
        sessions: { basis: "member_day", feed_sessions: 60, sessions_changing_scope: 9, scope_change_share: 0.15 },
      },
      sub_tab_split: { total: 95, by_tab: { feed: 50, boards: 30, directory: 15 } },
      notification_effectiveness: {
        weekly_recap: { delivered: 40, opened: 22, opened_unread: 18, opened_revisit: 4, open_rate: 0.45 },
        coach_congratulate: { delivered: 5, opened: 5, opened_unread: 5, opened_revisit: 0, open_rate: 1 },
      },
      social_graph_growth: {
        member_followed: { total: 11, per_week: 11 },
        profile_opened: { other: 60, self: 20 },
        follow_conversion: 0.1833,
        table_cross_check: { follow_edges_created: 10 },
      },
      challenge_leaderboard_pull: {
        challenge_viewed: { total: 70, per_week: 70, by_source: { boards: 50, post_card: 20 } },
        leaderboard_viewed: { total: 35, per_week: 35, by_board: { consistency: 35 } },
        challenge_joined: { total: 9, per_week: 9 },
        join_rate: 0.1286,
      },
      moderation_load: {
        reports_submitted: { total: 3, per_week: 3, by_reason: { spam: 2, harassment: 1 }, by_target_type: { post: 2, comment: 1 } },
        queue: { rows_created_in_period: 3, open_now: 5, by_reason: { spam: 3, harassment: 2 }, by_target_type: { post: 4, comment: 1 }, by_status: { open: 5 } },
      },
      share_intent_split: {
        workout_shared: { total: 14, by_visibility: { club: 10, followers: 4 } },
        achievement_shared: { total: 6, by_source: { auto: 4, manual: 2 } },
      },
      recap_pull_through: {
        opened: { total: 22, by_source: { notification: 18, account: 4 } },
        notifications_sent: 40, open_rate: 0.55,
        shared: { total: 5, by_figure: { sessions: 3, prs: 2 } }, share_rate: 0.2273,
      },
      discovery_split: {
        search_performed: { total: 25, by_source: { directory: 20, feed: 5 }, zero_member_result: 3, zero_member_rate: 0.12 },
        directory_opened: { total: 18, by_source: { tab: 18 } },
        search_vs_directory: 1.3889,
      },
      coach_reach: {
        congratulations: { total: 5, per_week: 5, by_kind: { pr: 3, tenure: 2 }, by_via: { comment: 4, dm: 1 } },
        celebrate_items_eligible: 14, coverage: 0.35,
      },
      push_adoption: {
        opt_in_events: { total: 6, per_week: 6, by_pref_type: { recap: 4, mention: 2 } },
        subscriptions: { created_in_period: 6, active_now: 30, revoked_now: 4, members_reachable_now: 28 },
      },
      trained_with_you_reach: {
        card_views: { total: 9, per_week: 9 },
        classmates_shown_total: 22, classmates_per_card: 2.4444,
        attendance_events: 50, card_rate: 0.18,
        table_cross_check: { attendance_days_logged: 52 },
        note: "card_rate is bounded by show_attendance adoption.",
      },
    },
  };
  return Object.assign(base, overrides || {});
}

// --- loading / error / populated states -------------------------------------

test("Loading: a distinct skeleton renders before the RPC resolves, then Populated: core and additional metrics render grouped as metrics.md groups them", async () => {
  const mock = seeded({}, "admin");
  let resolveRpc;
  const calls = [];
  mock.onRpc("analytics_dashboard", (args) => { calls.push(args); return new Promise((resolve) => { resolveRpc = resolve; }); });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-admin-analytics-skeleton="1"]'), 3000);
  resolveRpc({ data: dashboardFixture(), error: null });
  // "מדדי ליבה" (the Core group heading) only renders in the populated
  // branch - unlike the section's own title, which is outside the
  // loading/error/populated switch and so is already on screen during the
  // skeleton state too.
  await waitFor(() => window.document.body.textContent.includes("מדדי ליבה"), 3000);
  assert.equal(window.document.querySelector('[data-admin-analytics-skeleton="1"]'), null, "the skeleton is gone once populated");
  assert.equal(calls.length, 1);

  const section = window.document.querySelector('[data-admin-analytics-dashboard="1"]');
  assert.ok(section, "the dashboard section rendered");
  const text = section.textContent;
  // Grouped: "Core metrics" heading appears before "Additional metrics" -
  // metrics.md's own section order (## Core metrics, then ## Additional metrics).
  const coreAt = text.indexOf("מדדי ליבה");
  const additionalAt = text.indexOf("מדדים נוספים");
  assert.ok(coreAt >= 0 && additionalAt >= 0 && coreAt < additionalAt, "core group renders before the additional group");

  // A representative sample of Core metrics, real values from the fixture.
  // (Row labels and values are adjacent text nodes with no separating
  // whitespace, the same way every other log-row in this file renders, so
  // the label's own tail text is included to disambiguate the digits
  // rather than a bare \b-anchored number.)
  assert.match(text, /ממוצע שבועי37/, "WCAM average_weekly");
  assert.match(text, /שיא שבועי41/, "WCAM peak_weekly");
  assert.match(text, /ממוצע שבועי12/, "posting_members average_weekly");
  assert.match(text, /6\.1111/, "engagement_per_post period value");
  assert.match(text, /88\.9%/, "feed_reach reach_share, rendered as a percent");

  // A representative sample of Additional metrics, real values from the fixture.
  assert.match(text, /סה״כ צפיות95/, "sub_tab_split total");
  assert.match(text, /ברי-הגעה כרגע28/, "push_adoption members_reachable_now");
  assert.match(text, /תחתון\)35%/, "coach_reach coverage, rendered as a percent");
  assert.match(text, /feed/, "sub_tab_split by_tab breakdown key rendered verbatim");
});

test("Empty: a genuinely quiet period renders honest zeros and a dash for a null ratio, not an error", async () => {
  const mock = seeded({}, "admin");
  const quiet = dashboardFixture();
  quiet.core.wcam.average_weekly = 0;
  quiet.core.wcam.peak_weekly = 0;
  quiet.core.wcam.weeks = [{ week_start: "2026-08-24", partial: false, active_members: 0 }];
  quiet.core.engagement_per_post.period = { posts: 0, reactions: 0, comments: 0, engagement_per_post: null };
  mock.onRpc("analytics_dashboard", () => ({ data: quiet, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("לוח בקרה: אנליטיקת קהילה"), 3000);
  const text = window.document.querySelector('[data-admin-analytics-dashboard="1"]').textContent;
  assert.match(text, /—/, "a null ratio (zero denominator) renders as an em dash, never a false 0");
  assert.doesNotMatch(text, /לא ניתן היה לטעון את הנתונים\./, "a quiet period is not the error state");
});

test("Error: an unmapped server failure shows COMM-310's own copy, with a working retry", async () => {
  const mock = seeded({}, "admin");
  let calls = 0;
  mock.onRpc("analytics_dashboard", () => {
    calls++;
    if (calls === 1) return { data: null, error: { message: "boom" } };
    return { data: dashboardFixture(), error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את הנתונים."), 3000);
  window.document.querySelector('[data-community-action="admin-analytics-retry"]').click();
  await waitFor(() => window.document.body.textContent.includes("לוח בקרה: אנליטיקת קהילה") && calls === 2, 3000);
});

// --- the four real server error messages ------------------------------------

test("each of the four real server refusals maps to its own short Hebrew message", async () => {
  const cases = [
    ["not authorized", "אין לך הרשאה"],
    ["period required", "יש לבחור טווח תאריכים"],
    ["period end before start", "תאריך הסיום קודם לתאריך ההתחלה"],
    ["period exceeds 366 days", "טווח התאריכים ארוך מדי"],
  ];
  for (const [serverMessage, expectedFragment] of cases) {
    const mock = seeded({}, "admin");
    mock.onRpc("analytics_dashboard", () => ({ data: null, error: { message: serverMessage } }));
    const window = await bootCommunity(mock, { syncEnabled: false });
    await openAccountTab(window);
    try {
      await waitFor(() => window.document.body.textContent.includes(expectedFragment), 3000);
    } catch (e) {
      throw new Error(`expected "${expectedFragment}" for server message "${serverMessage}": ${e.message}`);
    }
  }
});

test("an unmapped server error falls back to the ticket's own generic copy, not one of the four specific messages", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: null, error: { message: "some_new_server_message" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את הנתונים."), 3000);
});

// --- the permission gate: community.analytics.view or real is_admin, NOT isStaff ---

test("a coach (is_staff, no community.analytics.view) never sees the dashboard section at all, and the RPC is never called", async () => {
  const mock = seeded({}, "coach");
  const calls = [];
  mock.onRpc("analytics_dashboard", (args) => { calls.push(args); return { data: dashboardFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  // Give the account tab's lazy-load gate a tick to (not) fire.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.body.textContent.includes("לוח בקרה: אנליטיקת קהילה"), false, "the section text never renders for a coach");
  assert.equal(window.document.querySelector('[data-admin-analytics-dashboard="1"]'), null);
  assert.equal(calls.length, 0, "a coach's session never calls analytics_dashboard at all");
});

test("a plain member (no staff role at all) never sees the dashboard section either", async () => {
  const mock = seeded({}, "member");
  const calls = [];
  mock.onRpc("analytics_dashboard", (args) => { calls.push(args); return { data: dashboardFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  // Redesign, Phase 1: a plain member does not even get the Manage tab
  // (window.communityIsStaff() gates whether app.js emits it at all) -
  // stronger than the old assertion, which only checked the section was
  // absent from Account. Nothing to click through to any more.
  assert.equal(window.document.getElementById("tabManageBtn"), null, "a plain member never gets the Manage tab at all");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-admin-analytics-dashboard="1"]'), null);
  assert.equal(calls.length, 0);
});

test("an admin (real is_admin, holds community.analytics.view) sees the dashboard section", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("analytics_dashboard", () => ({ data: dashboardFixture(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-admin-analytics-dashboard="1"]'), 3000);
});

// --- the period selector actually re-queries the RPC ------------------------

test("switching the period selector to month, then paging with prev/next, re-queries analytics_dashboard with a new period each time", async () => {
  const mock = seeded({}, "admin");
  const calls = [];
  mock.onRpc("analytics_dashboard", (args) => { calls.push(args); return { data: dashboardFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => calls.length === 1, 3000);
  const weekArgs = calls[0];
  assert.ok(weekArgs.p_period_start && weekArgs.p_period_end, "the default week period is sent");

  window.document.querySelector('[data-community-action="admin-analytics-mode"][data-mode="month"]').click();
  await waitFor(() => calls.length === 2, 3000);
  const monthArgs = calls[1];
  assert.notDeepEqual(monthArgs, weekArgs, "switching to month re-queries with a different period");
  // A calendar month always starts on the 1st.
  assert.match(monthArgs.p_period_start, /-01$/);

  window.document.querySelector('[data-community-action="admin-analytics-shift"][data-dir="-1"]').click();
  await waitFor(() => calls.length === 3, 3000);
  assert.notDeepEqual(calls[2], monthArgs, "paging to the previous month re-queries with yet another period");

  window.document.querySelector('[data-community-action="admin-analytics-shift"][data-dir="1"]').click();
  await waitFor(() => calls.length === 4, 3000);
  assert.deepEqual(calls[3], monthArgs, "paging forward one month from the previous month lands back on the original month");
});

test("the period selector's own display shows the exact dates the RPC was called with", async () => {
  const mock = seeded({}, "admin");
  const calls = [];
  mock.onRpc("analytics_dashboard", (args) => { calls.push(args); return { data: dashboardFixture(), error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => calls.length === 1, 3000);
  const section = window.document.querySelector('[data-admin-analytics-dashboard="1"]');
  assert.match(section.textContent, new RegExp(calls[0].p_period_start));
  assert.match(section.textContent, new RegExp(calls[0].p_period_end));
  // The month toggle itself gets the "selected" highlight once selected.
  window.document.querySelector('[data-community-action="admin-analytics-mode"][data-mode="month"]').click();
  await waitFor(() => calls.length === 2, 3000);
  const monthBtn = () => window.document.querySelector('[data-community-action="admin-analytics-mode"][data-mode="month"]');
  assert.ok(monthBtn().classList.contains("selected"));
  const section2 = window.document.querySelector('[data-admin-analytics-dashboard="1"]');
  assert.match(section2.textContent, new RegExp(calls[1].p_period_start));
});
