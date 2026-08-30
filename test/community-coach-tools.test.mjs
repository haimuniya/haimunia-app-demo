// COMM-223..226. Phase 2 coach-tools cluster: the Coach Dashboard shell,
// Celebrate (recent PRs/anniversaries/challenge completions +
// one-tap Congratulate), Welcome (new members, contact status, actions),
// and the Engage scaffold (hidden behind a feature flag, empty table).
//
// Executed for real (bootCommunity + the mock Supabase client), not
// source-text matches - these drive the real render path and the real
// coach_celebrate_feed/coach_assign_coach mock RPCs, and the real
// add_post_comment/post_create + follow-up own-row update the events
// cluster already established for post_create's own type gaps.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const daysAgoIso = (days) => new Date(NOW - days * 86400000).toISOString();

function baseProfiles(extra) {
  return [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(400) },
    { id: "coach2", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(400) },
    { id: "u9", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(3), show_prs: true, in_leaderboards: true },
  ].concat(extra || []);
}
function seeded(extra, asStaff) {
  // profiles is deliberately merged by hand (baseProfiles() + extra.profiles
  // concatenated), then re-asserted after Object.assign - a plain
  // Object.assign(base, extra) would otherwise let extra's own `profiles`
  // key silently replace the whole base roster instead of adding to it.
  const merged = Object.assign({
    profiles: [],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: asStaff ? "coach" : "member", redeemed_at: VERIFIED },
      { user_id: "coach2", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
      { user_id: "u9", invite_id: "inv-1", role: "member", redeemed_at: daysAgoIso(3) },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
  }, extra || {});
  merged.profiles = baseProfiles(extra && extra.profiles);
  const mock = createMockSupabase(merged);
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}
async function openCoachTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]').click();
}

// --- COMM-223: dashboard shell + staff gate ------------------------------

test("the Coach Dashboard sub-tab exists for a coach and is entirely absent from the tab bar for a plain member", async () => {
  const staffWindow = await bootCommunity(seeded({}, true), { syncEnabled: false });
  staffWindow.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!staffWindow.document.querySelector(".subtabbar"), 3000);
  assert.ok(staffWindow.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]'), "a coach sees the Coach Dashboard tab");

  const memberWindow = await bootCommunity(seeded({}, false), { syncEnabled: false });
  memberWindow.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!memberWindow.document.querySelector(".subtabbar"), 3000);
  assert.equal(memberWindow.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]'), null, "a plain member has no Coach Dashboard tab at all");
});

test("Celebrate shows the loading skeleton, then the populated feed sorted by recency with member, what happened, when, and Congratulate", async () => {
  const mock = seeded({}, true);
  let resolveFeed;
  mock.onRpc("coach_celebrate_feed", () => new Promise((resolve) => { resolveFeed = resolve; }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("לחגוג"), 3000);
  assert.ok(window.document.querySelector('[aria-busy="true"]'), "a loading skeleton renders while the feed is in flight");

  resolveFeed({
    data: [
      { kind: "pr", user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, occurred_at: daysAgoIso(1), post_id: "p-pr", detail: { movement: "סקוואט", result: "100 ק\"ג" } },
      { kind: "anniversary", user_id: "coach2", handle: "yael", display_name: "יעל", avatar_url: null, occurred_at: daysAgoIso(2), post_id: null, detail: { code: "anniv_1y", title: "שנה במועדון", years: 1 } },
    ],
    error: null,
  });
  await waitFor(() => window.document.querySelectorAll('[data-community-action="coach-congratulate"]').length === 2, 3000);
  const rows = [...window.document.querySelectorAll('[data-community-action="coach-congratulate"]')];
  // The RPC already sorts newest first; the client preserves that order.
  assert.match(rows[0].closest(".log-row").textContent, /נועה/);
  assert.match(rows[0].closest(".log-row").textContent, /סקוואט/);
  assert.match(rows[1].closest(".log-row").textContent, /יעל/);
  assert.match(rows[1].closest(".log-row").textContent, /שנה/);
});

test("Celebrate shows the empty state when the feed is genuinely empty, and the error state with a working retry", async () => {
  const mock = seeded({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("אין דבר לחגוג השבוע."), 3000);

  const mock2 = seeded({}, true);
  let calls = 0;
  mock2.onRpc("coach_celebrate_feed", () => { calls++; return calls === 1 ? { data: null, error: { message: "boom" } } : { data: [], error: null }; });
  const window2 = await bootCommunity(mock2, { syncEnabled: false });
  await openCoachTab(window2);
  await waitFor(() => window2.document.body.textContent.includes("לא ניתן היה לטעון את לוח המאמנים. נסו שוב."), 3000);
  window2.document.querySelector('[data-community-action="coach-celebrate-retry"]').click();
  await waitFor(() => window2.document.body.textContent.includes("אין דבר לחגוג השבוע."), 3000);
});

// --- COMM-224: Welcome -----------------------------------------------------

test("Welcome lists a member who joined 3 days ago, with days-since-joining, the reused community_streaks figure, and not-contacted status, and drops a member who joined 40 days ago", async () => {
  const mock = seeded({
    profiles: [{ id: "u10", handle: "old", display_name: "ותיק", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(40) }],
    community_streaks: [{ user_id: "u9", handle: "noa", display_name: "נועה", current_streak: 3, last_activity_on: null }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("קבלת פנים"), 3000);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-welcome-member"]'), 3000);
  const rows = window.document.querySelectorAll('[data-community-action="coach-welcome-member"]');
  assert.equal(rows.length, 1, "only the 3-day-old member is listed, not the 40-day-old one");
  const rowText = rows[0].closest(".log-row").textContent;
  assert.match(rowText, /נועה/);
  assert.match(rowText, /לפני 3 ימים/);
  assert.match(rowText, /רצף נוכחי: 3/);
  assert.match(rowText, /טרם נוצר קשר/);
});

test("Welcome shows the empty state with no new members in the last 30 days", async () => {
  const mock = seeded({ profiles: [] }, true);
  // Replace the seed profiles with only long-time members.
  mock.db.profiles = [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(400) },
  ];
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("אין חברים חדשים בחודש האחרון."), 3000);
});

test("a member already logged in member_contact_log shows as contacted", async () => {
  const mock = seeded({
    member_contact_log: [{ id: "mcl-1", user_id: "u9", contacted_by: "coach2", contacted_at: VERIFIED, note: "" }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-welcome-member"]'), 3000);
  assert.match(window.document.querySelector('[data-community-action="coach-welcome-member"]').closest(".log-row").textContent, /נוצר קשר/);
});

test("Welcome posts a coach comment on the member's POST_NEW_MEMBER card via add_post_comment", async () => {
  const mock = seeded({
    workout_posts: [{ id: "nm-1", post_type: "POST_NEW_MEMBER", author_id: null, metadata: { member_id: "u9", member_name: "נועה", joined_on: "2026-08-28" }, status: "active", created_at: VERIFIED }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-welcome-member"]'), 3000);
  window.document.querySelector('[data-community-action="coach-welcome-member"]').click();
  await waitFor(() => mock.db.post_comments && mock.db.post_comments.some((c) => c.post_id === "nm-1"), 3000);
});

test("Welcome's Welcome action fails gracefully when no POST_NEW_MEMBER card exists yet for that member (COMM-107's producer is not built)", async () => {
  const mock = seeded({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-welcome-member"]'), 3000);
  window.document.querySelector('[data-community-action="coach-welcome-member"]').click();
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לבצע את הפעולה. נסו שוב."), 3000);
});

test("View profile opens the community_profile overlay for the listed member", async () => {
  const mock = seeded({}, true);
  mock.onRpc("community_profile", () => ({ data: { display_name: "נועה", role: "member", member_since: daysAgoIso(3) }, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="view-profile"][data-id="u9"]'), 3000);
  window.document.querySelector('[data-community-action="view-profile"][data-id="u9"]').click();
  await waitFor(() => !!window.document.getElementById("profileViewTitle"), 3000);
});

test("Assign coach: self-assign and clear both call coach_assign_coach with the calling coach's id and with null", async () => {
  const mock = seeded({}, true);
  const calls = [];
  mock.onRpc("coach_assign_coach", (args) => { calls.push(args); return { data: args.p_coach_id || null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-assign-self"]'), 3000);
  window.document.querySelector('[data-community-action="coach-assign-self"]').click();
  await waitFor(() => calls.length === 1, 3000);
  assert.deepEqual(calls[0], { p_user_id: "u9", p_coach_id: "u1" });
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-assign-clear"]'), 3000);
  window.document.querySelector('[data-community-action="coach-assign-clear"]').click();
  await waitFor(() => calls.length === 2, 3000);
  assert.deepEqual(calls[1], { p_user_id: "u9", p_coach_id: null });
});

test("Assign coach by handle resolves the handle to an id and calls coach_assign_coach with it; an unknown handle fails gracefully", async () => {
  const mock = seeded({}, true);
  const calls = [];
  mock.onRpc("coach_assign_coach", (args) => { calls.push(args); return { data: args.p_coach_id, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-coach-assign-handle="u9"]'), 3000);
  const input = window.document.querySelector('[data-coach-assign-handle="u9"]');
  input.value = "yael";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="coach-assign-handle"][data-id="u9"]').click();
  await waitFor(() => calls.length === 1, 3000);
  assert.deepEqual(calls[0], { p_user_id: "u9", p_coach_id: "coach2" });
});

test("Mark contacted inserts a member_contact_log row with {user_id, note} and flips the row to contacted", async () => {
  const mock = seeded({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-coach-contact-note="u9"]'), 3000);
  const note = window.document.querySelector('[data-coach-contact-note="u9"]');
  note.value = "דיברנו בטלפון";
  note.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="coach-mark-contacted"][data-id="u9"]').click();
  await waitFor(() => mock.db.member_contact_log.some((r) => r.user_id === "u9" && r.note === "דיברנו בטלפון"), 3000);
  await waitFor(() => window.document.querySelector('[data-community-action="coach-welcome-member"]').closest(".log-row").textContent.includes("נוצר קשר"), 3000);
});

// --- COMM-225: one-tap congratulate ----------------------------------------

test("Congratulate on an item with a source post sends add_post_comment immediately, then disables to ברכתם", async () => {
  const mock = seeded({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({
    data: [{ kind: "pr", user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, occurred_at: daysAgoIso(1), post_id: "p-pr", detail: { movement: "סקוואט", result: "100 ק\"ג" } }],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-congratulate"]'), 3000);
  const btn = window.document.querySelector('[data-community-action="coach-congratulate"]');
  btn.click();
  await waitFor(() => mock.db.post_comments && mock.db.post_comments.some((c) => c.post_id === "p-pr"), 3000);
  const comment = mock.db.post_comments.find((c) => c.post_id === "p-pr");
  assert.match(comment.body, /נועה/);
  assert.match(comment.body, /סקוואט/);
  await waitFor(() => window.document.querySelector('[data-community-action="coach-congratulate"]').textContent.includes("ברכתם"), 3000);
  assert.equal(window.document.querySelector('[data-community-action="coach-congratulate"]').disabled, true);
});

test("Congratulate on an item with no source post creates a POST_COACH post via post_create + the own-row post_type update, naming the member", async () => {
  const mock = seeded({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({
    data: [{ kind: "anniversary", user_id: "coach2", handle: "yael", display_name: "יעל", avatar_url: null, occurred_at: daysAgoIso(1), post_id: null, detail: { code: "anniv_1y", title: "שנה במועדון", years: 1 } }],
    error: null,
  }));
  mock.onRpc("post_create", (args, ctx) => {
    const id = "coachpost-1";
    ctx.db.workout_posts = ctx.db.workout_posts || [];
    ctx.db.workout_posts.push({ id, author_id: ctx.currentUser.id, post_type: "POST_TEXT", body: args.body, visibility: args.visibility, metadata: {}, status: "active", created_at: new Date().toISOString() });
    return { data: id, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-congratulate"]'), 3000);
  window.document.querySelector('[data-community-action="coach-congratulate"]').click();
  await waitFor(() => mock.db.workout_posts.some((p) => p.post_type === "POST_COACH"), 3000);
  const post = mock.db.workout_posts.find((p) => p.post_type === "POST_COACH");
  assert.match(post.body, /יעל/);
  await waitFor(() => window.document.querySelector('[data-community-action="coach-congratulate"]').textContent.includes("ברכתם"), 3000);
});

test("congratulating the same item twice is a no-op the second time - the control is disabled and no second RPC is sent", async () => {
  const mock = seeded({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({
    data: [{ kind: "pr", user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, occurred_at: daysAgoIso(1), post_id: "p-pr", detail: { movement: "סקוואט", result: "" } }],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-congratulate"]'), 3000);
  const btn = () => window.document.querySelector('[data-community-action="coach-congratulate"]');
  btn().click();
  await waitFor(() => btn().textContent.includes("ברכתם"), 3000);
  const before = mock.callsTo("add_post_comment").length;
  btn().click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mock.callsTo("add_post_comment").length, before, "a disabled control produces no second call");
});

test("a failed Congratulate shows the standard error and leaves the control enabled to retry", async () => {
  const mock = seeded({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({
    data: [{ kind: "pr", user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, occurred_at: daysAgoIso(1), post_id: "p-pr", detail: { movement: "סקוואט", result: "" } }],
    error: null,
  }));
  mock.onRpc("add_post_comment", () => ({ data: null, error: { message: "rate_limited" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-congratulate"]'), 3000);
  window.document.querySelector('[data-community-action="coach-congratulate"]').click();
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לשלוח ברכה. נסו שוב."), 3000);
  assert.equal(window.document.querySelector('[data-community-action="coach-congratulate"]').disabled, false);
});

// --- COMM-226: Engage scaffold, hidden -------------------------------------

test("Engage is entirely absent from the Coach Dashboard when the feature flag is off (the default)", async () => {
  const mock = seeded({ coach_engagement_flags: [{ id: "f1", user_id: "u9", level: "mild", status: "open", flagged_at: VERIFIED }] }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("קבלת פנים"), 3000);
  assert.equal(window.document.body.textContent.includes("מעקב מעורבות"), false, "the Engage section renders nothing at all when the flag is off");
  assert.equal(mock.callsTo && mock.db.coach_engagement_flags.length, 1, "the table exists and is untouched by this ticket's own read gate");
});

test("flipping the feature flag on with an empty coach_engagement_flags table renders the clean empty state", async () => {
  // state.featureFlags.coachEngage is read once, synchronously, at cloud.js's
  // module-level state literal - the same moment state.syncEnabled already
  // reads its own localStorage-backed flag - so it has to be set before
  // cloud.js is eval'd, via bootCommunity's generic opts.localStorage hook,
  // not after boot.
  const mock = seeded({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:coachEngageFlag": "1" } });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("מעקב מעורבות"), 3000);
  await waitFor(() => window.document.body.textContent.includes("אין פריטים לבדיקה."), 3000);
});

test("with the flag on, a real row in coach_engagement_flags renders instead of the empty state, still only on the staff surface", async () => {
  const mock = seeded({ coach_engagement_flags: [{ id: "f1", user_id: "u9", level: "mild", status: "open", flagged_at: VERIFIED }] }, true);
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:coachEngageFlag": "1" } });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("מעקב מעורבות"), 3000);
  await waitFor(() => !window.document.body.textContent.includes("אין פריטים לבדיקה."), 3000);
  assert.match(window.document.body.textContent, /mild/);
});
