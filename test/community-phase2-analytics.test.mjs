// COMM-233. The Phase 2 analytics surfaces, executed for real in jsdom
// against the mock Supabase client.
//
// WHAT THIS FILE VERIFIES
// - The three bridged names this ticket was asked to confirm rather than
//   wire (`challenge_joined`, `challenge_completed`, `event_rsvp`) actually
//   land, from the real Phase 2 producers (COMM-207's join and completion,
//   COMM-214's RSVP), exactly once each and with the documented props.
// - Each newly wired hand-tracked event fires from its real trigger surface
//   with its documented props: the recap open and share, both search boxes,
//   the push opt-in, the coach's congratulate, and the roster.
// - No new event carries free text: not a challenge title, not a recap
//   sentence, not what the member typed into the search box.
// - The Boards list cards record `source: "boards"`. They used to record
//   `source: "post_card"`, because the handler's default was written for
//   the link card inside a feed post and the list cards carried no
//   data-source of their own.
//
// WHAT THIS FILE DOES NOT VERIFY
// The helper's own contract (the name allow-list, trimming, the
// HAND_PROP_KEYS projection, the WCAM set) is
// test/platform-analytics.test.mjs. The Phase 1 surfaces are
// test/community-analytics-surfaces.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const isoDays = (d) => new Date(NOW + d * 86400000).toISOString();
const isoHours = (h) => new Date(NOW + h * 3600000).toISOString();

function seeded(extra, asStaff) {
  const merged = Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true, created_at: isoDays(-400) },
      { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true, created_at: isoDays(-400) },
      { id: "coach1", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, created_at: isoDays(-400) },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: asStaff ? "coach" : "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "coach1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    analytics_events: [],
    challenges: [], challenge_participants: [], challenge_teams: [], challenge_progress: [],
    events: [], event_attendees: [],
    weekly_recaps: [], onboarding_progress: [{ user_id: "u1", welcomed_at: VERIFIED, first_week_shown_at: VERIFIED, first_month_shown_at: VERIFIED }],
    workout_posts: [], post_comments: [], feed_page_rows: [], follows: [], blocks: [],
    community_streaks: [], member_contact_log: [], coach_engagement_flags: [],
    notifications: [], notification_preferences: [], push_subscriptions: [],
  }, extra || {});
  const mock = createMockSupabase(merged);
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

const events = (mock, name) => (mock.db.analytics_events || []).filter((r) => r.event_name === name);
// An object built inside the jsdom realm carries that realm's prototype,
// which deepStrictEqual reads as a mismatch even when the data agrees.
const plain = (v) => JSON.parse(JSON.stringify(v));
const allProps = (mock) => JSON.stringify((mock.db.analytics_events || []).map((r) => r.props));

async function openCommunity(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
}
const clickTab = (window, tab) => window.document.querySelector(`[data-community-action="set-tab"][data-tab="${tab}"]`).click();
async function openBoards(window) {
  await openCommunity(window);
  clickTab(window, "boards");
  await waitFor(() => window.document.body.textContent.includes("אתגרי המועדון"), 4000);
}
async function openAccount(window) {
  await openCommunity(window);
  clickTab(window, "account");
  await waitFor(() => window.document.body.textContent.includes("הסיכום השבועי שלי"), 4000);
}
function activeChallenge(overrides) {
  return Object.assign({
    id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "",
    metric_type: "session_count", target_value: 12, start_at: isoDays(-5), end_at: isoDays(20),
    status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {},
  }, overrides || {});
}
function publishedEvent(overrides) {
  return Object.assign({
    id: "e1", event_type: "social_night", title: "ערב פיצה", description: "", status: "published",
    start_at: isoHours(24), end_at: null, location: null, capacity: null,
    registration_deadline: null, created_by: "coach1",
  }, overrides || {});
}
function recapRow(overrides) {
  return Object.assign({
    id: "wr-1", user_id: "u1", week_start: "2026-08-17",
    sessions_completed: 5, streak: 2, prs: [], achievements: [],
    challenge_progress: [], club_challenge_progress: {}, upcoming_event: null,
    generated_at: VERIFIED,
  }, overrides || {});
}

// ===== the bridged names, end to end from the Phase 2 producers ========
//
// COMM-233 adds no wiring for these three. What it has to prove is that the
// bridge agreed in Phase 1 (BUS_EVENT_MAP + BUS_PROP_KEYS, settled before
// any of these surfaces existed) is actually exercised by the producers that
// landed since.

test("joining a challenge writes exactly one challenge_joined, from the bus and not from a second hand-written call", async () => {
  const mock = seeded({ challenges: [activeChallenge()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);

  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="join-challenge"]').click();
  await waitFor(() => events(mock, "challenge_joined").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "challenge_joined")[0].props), { challenge_id: "c1", challenge_type: "individual_target" });
  assert.equal(events(mock, "challenge_joined")[0].user_id, "u1");

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events(mock, "challenge_joined").length, 1, "the bridge is the only writer of this name");
  assert.ok(!allProps(mock).includes("12 אימונים"), "the challenge title never reaches analytics");
});

test("reaching a challenge's target writes one challenge_completed off the same bridge", async () => {
  const mock = seeded({
    challenges: [activeChallenge({ target_value: 3 })],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: isoDays(-1), status: "active", progress_value: 2, completed_at: null }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="open-challenge"]').click();
  await waitFor(() => !!window.document.querySelector("[data-challenge-log-delta]"), 4000);

  const input = window.document.querySelector("[data-challenge-log-delta]");
  input.value = "1";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="challenge-log-submit"]').click();

  await waitFor(() => events(mock, "challenge_completed").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "challenge_completed")[0].props), { challenge_id: "c1", challenge_type: "individual_target" });
  assert.equal(events(mock, "challenge_joined").length, 0, "logging progress is not joining");
});

test("an RSVP writes exactly one event_rsvp with the response, from the bus", async () => {
  const mock = seeded({ events: [publishedEvent()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 4000);
  window.document.querySelector('[data-event-id="e1"] [data-community-action="open-event"]').click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="eventView"] [data-community-action="event-rsvp"][data-response="going"]'), 4000);
  window.document.querySelector('[data-cloud-dialog="eventView"] [data-community-action="event-rsvp"][data-response="going"]').click();

  await waitFor(() => events(mock, "event_rsvp").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "event_rsvp")[0].props), { event_id: "e1", rsvp_status: "going" });
  assert.ok(!allProps(mock).includes("ערב פיצה"), "the event title never reaches analytics");
});

// ===== the Boards source mislabel =====================================

test("a challenge or event opened from the Boards list records source boards, not post_card", async () => {
  const mock = seeded({ challenges: [activeChallenge()], events: [publishedEvent()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);

  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="open-challenge"]').click();
  await waitFor(() => events(mock, "challenge_viewed").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "challenge_viewed")[0].props), { challenge_id: "c1", challenge_key: null, source: "boards" });
  window.document.querySelector('[data-community-action="close-challenge-view"]').click();

  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 4000);
  window.document.querySelector('[data-event-id="e1"] [data-community-action="open-event"]').click();
  await waitFor(() => events(mock, "event_viewed").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "event_viewed")[0].props), { event_id: "e1", source: "boards" });

  assert.equal(
    (mock.db.analytics_events || []).filter((r) => r.props && r.props.source === "post_card").length, 0,
    "nothing opened from the Boards sub-tab may be recorded as a post card open",
  );
});

// ===== the roster =====================================================

test("directory_opened fires once per entry into the roster, with where the member came from", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  clickTab(window, "directory");
  await waitFor(() => events(mock, "directory_opened").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "directory_opened")[0].props), { source: "club_tab" });

  // A re-render of the roster (a page arriving, a follow toggling) is not a
  // second view of it.
  window.render(); window.render();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(events(mock, "directory_opened").length, 1);

  clickTab(window, "feed");
  clickTab(window, "directory");
  await waitFor(() => events(mock, "directory_opened").length === 2, 4000);
  assert.equal(events(mock, "directory_opened")[1].props.source, "club_tab");
});

test("the leaderboard's find-people call to action is attributed to the leaderboard, and only for that one entry", async () => {
  const mock = seeded({ community_streaks: [{ user_id: "u1", current_streak: 3 }, { user_id: "u2", current_streak: 5 }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="leaderboard-scope"][data-scope="friends"]'), 4000);
  window.document.querySelector('[data-community-action="leaderboard-scope"][data-scope="friends"]').click();
  await waitFor(() => !!window.document.querySelector('[data-leaderboard-empty="friends"]'), 4000);

  window.document.querySelector('[data-community-action="leaderboard-find-people"]').click();
  await waitFor(() => events(mock, "directory_opened").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "directory_opened")[0].props), { source: "leaderboard" });

  // The attribution is consumed by that one view, not sticky.
  clickTab(window, "feed");
  clickTab(window, "directory");
  await waitFor(() => events(mock, "directory_opened").length === 2, 4000);
  assert.equal(events(mock, "directory_opened")[1].props.source, "club_tab");
});

// ===== the recap surface ==============================================

test("weekly_recap_opened fires on the open with its entry point, and browsing weeks is not a second open", async () => {
  const mock = seeded({ weekly_recaps: [recapRow({ id: "wr-old", week_start: "2026-08-10" }), recapRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();

  await waitFor(() => events(mock, "weekly_recap_opened").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "weekly_recap_opened")[0].props), { source: "account" });
  await waitFor(() => !!window.document.querySelector('[data-community-action="recap-older"]:not([disabled])'), 4000);

  window.document.querySelector('[data-community-action="recap-older"]').click();
  await waitFor(() => window.document.querySelector('[data-cloud-dialog="recapView"]').textContent.includes("2026-08-10"), 4000);
  assert.equal(events(mock, "weekly_recap_opened").length, 1, "the previous week refreshes the open surface, it does not re-open it");
});

test("the weekly_recap notification's deep link records the recap open as coming from the notification", async () => {
  const mock = seeded({
    weekly_recaps: [recapRow({ week_start: "2026-08-17" })],
    notifications: [{
      id: "n1", user_id: "u1", type: "weekly_recap", category: "club",
      title: "הסיכום השבועי שלך", body: "5 אימונים השבוע", deep_link: "/community/recap?week=2026-08-17",
      source_type: null, source_id: null, read_at: null, created_at: VERIFIED,
    }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  // COMM-331: the bell only renders once state.club loads via the deferred
  // ensureCommunityDataLoaded().
  await waitFor(() => !!window.document.querySelector('[data-community-action="feed-notifications"]'), 4000);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  // weekly_recap is a batched type (contracts.md's routing table), so even a
  // single row renders as a collapsed group that has to be expanded first.
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-toggle-group"]'), 4000);
  window.document.querySelector('[data-community-action="notif-toggle-group"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-open"]'), 4000);
  window.document.querySelector('[data-community-action="notif-open"]').click();

  await waitFor(() => events(mock, "weekly_recap_opened").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "weekly_recap_opened")[0].props), { source: "notification" });
});

test("weekly_recap_shared records which figure was shared, after the post is written, and never the sentence", async () => {
  const mock = seeded({ weekly_recaps: [recapRow({ sessions_completed: 5, streak: 2 })] });
  // Same stub the COMM-221 tests use: the share writes through post_create,
  // whose own rate-limit and club plumbing this file is not re-testing.
  mock.onRpc("post_create", () => ({ data: "post-1", error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="share-recap"][data-figure="streak"]'), 4000);
  window.document.querySelector('[data-community-action="share-recap"][data-figure="streak"]').click();

  await waitFor(() => events(mock, "weekly_recap_shared").length === 1, 4000);
  const props = plain(events(mock, "weekly_recap_shared")[0].props);
  assert.equal(props.figure, "streak");
  assert.ok(props.post_id, "the created post is identified by id");
  assert.ok(!JSON.stringify(props).includes("הרצף"), "the generated share sentence never reaches analytics");
  // The bus wrote the post's own row off the same action. Two names, one
  // action, neither of them written twice.
  await waitFor(() => events(mock, "post_created").length === 1, 4000);
  assert.equal(events(mock, "weekly_recap_shared").length, 1);
});

// ===== search =========================================================

test("search_performed records one settled search rather than one row per keystroke, with the shape of the result and never the query", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  const input = window.document.getElementById("communityPeopleSearch");

  for (const value of ["no", "noa", "noam"]) {
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
  }
  await waitFor(() => events(mock, "search_performed").length === 1, 4000);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(events(mock, "search_performed").length, 1, "three keystrokes are one search");
  const props = plain(events(mock, "search_performed")[0].props);
  assert.deepStrictEqual(props, { source: "community_search", query_length: 4, member_count: 1, event_count: 0, challenge_count: 0 });
  assert.ok(!JSON.stringify(props).includes("noam"), "what the member typed is never a prop, only how long it was");
});

test("backspacing under the two-character floor cancels the pending row - an abandoned search was not a search", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  const input = window.document.getElementById("communityPeopleSearch");

  input.value = "noam";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  input.value = "n";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));

  assert.equal(events(mock, "search_performed").length, 0);
});

test("the roster's own search box records its own source, and only the group it asked for", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  clickTab(window, "directory");
  await waitFor(() => !!window.document.getElementById("communityDirectorySearch"), 4000);

  const input = window.document.getElementById("communityDirectorySearch");
  input.value = "noam";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));

  await waitFor(() => events(mock, "search_performed").length === 1, 4000);
  const props = plain(events(mock, "search_performed")[0].props);
  assert.deepStrictEqual(props, { source: "directory", query_length: 4, member_count: 1 });
  assert.equal(props.event_count, undefined, "the roster's box asks for members only - absent is not zero");
});

// ===== the coach's congratulate =======================================

test("coach_congratulate_sent is recorded for the coach after the write succeeds, with the item kind and which write path ran", async () => {
  const mock = seeded({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({
    data: [{ kind: "pr", user_id: "u2", handle: "noam", display_name: "נועם", avatar_url: null, occurred_at: isoDays(-1), post_id: "p-pr", detail: { movement: "סקוואט", result: "100 ק\"ג" } }],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  clickTab(window, "coach");
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-congratulate"]'), 4000);
  window.document.querySelector('[data-community-action="coach-congratulate"]').click();

  await waitFor(() => events(mock, "coach_congratulate_sent").length === 1, 4000);
  const row = events(mock, "coach_congratulate_sent")[0];
  assert.deepStrictEqual(plain(row.props), { kind: "pr", via: "comment" });
  assert.equal(row.user_id, "u1", "the row belongs to the coach who sent it, never the celebrated member");
  assert.ok(!JSON.stringify(plain(row.props)).includes("נועם"), "the celebrated member is not a prop");
  assert.ok(!JSON.stringify(plain(row.props)).includes("סקוואט"), "the generated greeting is not a prop");
});

test("a failed congratulate records nothing", async () => {
  const mock = seeded({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({
    data: [{ kind: "pr", user_id: "u2", handle: "noam", display_name: "נועם", avatar_url: null, occurred_at: isoDays(-1), post_id: "p-pr", detail: { movement: "סקוואט", result: "100 ק\"ג" } }],
    error: null,
  }));
  mock.onRpc("add_post_comment", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  clickTab(window, "coach");
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-congratulate"]'), 4000);
  window.document.querySelector('[data-community-action="coach-congratulate"]').click();

  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לשלוח ברכה"), 4000);
  assert.equal(events(mock, "coach_congratulate_sent").length, 0);
});

// ===== the push opt-in ================================================

function stubPushApis(window) {
  let sub = null;
  const reg = {
    pushManager: {
      getSubscription: async () => sub,
      subscribe: async () => {
        sub = {
          endpoint: "https://push.example/ep-1",
          keys: { p256dh: "keyA", auth: "keyB" },
          toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
          unsubscribe: async () => { sub = null; return true; },
        };
        return sub;
      },
    },
  };
  window.navigator.serviceWorker = Object.assign(window.navigator.serviceWorker || {}, { ready: Promise.resolve(reg) });
  window.PushManager = function () {};
  window.Notification = { permission: "default", requestPermission: async () => "granted" };
}

test("push_opt_in is recorded once the subscription row is written, with the control that asked and never the endpoint", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  stubPushApis(window);
  await openCommunity(window);
  clickTab(window, "account");
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-pref"][data-type="mentions"][data-channel="push"]'), 4000);

  window.document.querySelector('[data-community-action="notif-pref"][data-type="mentions"][data-channel="push"]').click();
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);
  await waitFor(() => events(mock, "push_opt_in").length === 1, 4000);

  const props = plain(events(mock, "push_opt_in")[0].props);
  assert.deepStrictEqual(props, { source: "notif_pref", pref_type: "mentions" });
  assert.ok(!JSON.stringify(props).includes("push.example"), "the device endpoint is a secret, not a prop");

  // A device has one subscription however many types route through it, so
  // a second type switched to Push is not a second opt-in.
  window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"][data-channel="push"]').click();
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "comments" && r.channel === "push"), 4000);
  assert.equal(events(mock, "push_opt_in").length, 1);
});

test("a denied permission records no opt-in", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  stubPushApis(window);
  window.Notification = { permission: "default", requestPermission: async () => "denied" };
  await openCommunity(window);
  clickTab(window, "account");
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-pref"][data-type="mentions"][data-channel="push"]'), 4000);

  window.document.querySelector('[data-community-action="notif-pref"][data-type="mentions"][data-channel="push"]').click();
  await waitFor(() => window.document.body.textContent.includes("לא אושרה הרשאת התראות"), 4000);
  assert.equal(events(mock, "push_opt_in").length, 0);
  assert.equal(mock.db.push_subscriptions.length, 0);
});

// ===== the props budget, for the Phase 2 surfaces =====================

test("every prop payload the Phase 2 surfaces write stays well under the client budget and carries a defined name", async () => {
  const mock = seeded({ challenges: [activeChallenge()], events: [publishedEvent()], weekly_recaps: [recapRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="join-challenge"]').click();
  clickTab(window, "directory");
  clickTab(window, "account");
  await waitFor(() => !!window.document.querySelector('[data-community-action="open-recap"]'), 4000);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => events(mock, "weekly_recap_opened").length === 1, 4000);

  const budget = window.HaimuniaAnalytics.PROPS_BUDGET_BYTES;
  for (const r of mock.db.analytics_events) {
    const size = JSON.stringify(r.props).length;
    assert.ok(size <= budget, `${r.event_name} props are ${size} bytes, over the ${budget} budget`);
    assert.equal(r.props._truncated, undefined, `${r.event_name} should never need trimming`);
    assert.ok(window.HaimuniaAnalytics.isKnown(r.event_name), `${r.event_name} is not a defined constant`);
  }
});
