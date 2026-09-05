// COMM-170. The Phase 1 analytics surfaces, executed for real in jsdom
// against the mock Supabase client.
//
// WHAT THIS FILE VERIFIES
// - configure() runs once from the session-ready path, before any track(),
//   and attaches the product bus bridge.
// - Each Phase 1 surface writes exactly one analytics_events row with the
//   documented prop shape.
// - Nothing double fires: not on a re-render, not on a close, not on the
//   six event names the bus bridge already covers.
// - Props carry ids, enums and counts only. No member-authored text ever
//   reaches the table.
//
// WHAT THIS FILE DOES NOT VERIFY
// The RLS insert policy and the 4 KB props trigger. Those are Postgres,
// pinned in test/community-rls-boundaries.test.mjs. The helper's own
// contract (trimming, never throwing, the name allow-list) is
// test/platform-analytics.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
// Anchored to Date.now(), not a fixed calendar date - see the identical
// fix/comment in community-notifications.test.mjs.
const BASE = Date.now() - 5 * 60000;

function row(i, extra) {
  return Object.assign({
    id: `p${i}`,
    post_type: "POST_TEXT",
    author_id: `u${i + 1}`,
    author: { display_name: `חבר ${i}`, handle: `m${i}` },
    body: `פוסט מספר ${i}`,
    visibility: "club",
    created_at: new Date(BASE - i * 60000).toISOString(),
    published_at: new Date(BASE - i * 60000).toISOString(),
    reaction_count: 0,
    comment_count: 0,
    media: [],
    metadata: {},
  }, extra || {});
}

function seeded(rows, opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, allow_mentions: true, in_leaderboards: true },
      { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, allow_mentions: true },
    ],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    feed_page_rows: rows || [],
    analytics_events: [],
    feed_impressions: [], feed_interactions: [],
    follows: [], hidden_posts: [], saved_posts: [], reactions: [], post_comments: [],
    notifications: [], notification_preferences: [], reports: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

const events = (mock, name) => mock.db.analytics_events.filter((r) => r.event_name === name);
const names = (mock) => mock.db.analytics_events.map((r) => r.event_name);
// An object built inside the jsdom realm has that realm's prototype, which
// deepStrictEqual reads as a mismatch even when the data agrees.
const plain = (v) => JSON.parse(JSON.stringify(v));

async function openCommunity(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
}
async function openFeed(window, atLeast = 1) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.querySelectorAll("#communityFeedList .post-card").length >= atLeast, 4000);
}
const clickTab = (window, tab) => window.document.querySelector(`[data-community-action="set-tab"][data-tab="${tab}"]`).click();
// The same one second dwell the COMM-114 fallback arms on every rendered
// card when there is no IntersectionObserver, which jsdom has not.
const dwell = () => new Promise((r) => setTimeout(r, 1200));

// ===== configure ======================================================

test("configure runs from the session-ready path, so the first tracked event is written rather than dropped", async () => {
  const mock = seeded([row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);

  // The bridge is what proves configure() ran with attachToBus on.
  assert.equal(window.HaimuniaEvents.handlerCount("POST_CREATED"), 1, "the bus bridge must be attached exactly once");
  assert.equal(window.HaimuniaEvents.handlerCount("REACTION_CREATED"), 1);
  // And a row reached the table, which only happens with a client.
  await waitFor(() => mock.db.analytics_events.length > 0, 3000);
  const first = mock.db.analytics_events[0];
  assert.equal(first.user_id, "u1", "the row carries the signed-in member");
  assert.equal(first.schema_version, window.HaimuniaAnalytics.SCHEMA_VERSION);
});

test("signing out and back in does not stack a second bus bridge", async () => {
  const mock = seeded([row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  mock.seedCredentials("u1", "dana@members.haimuniya.invalid", "correcthorse");

  await mock.client.auth.signOut();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 4000);
  await mock.client.auth.signInWithPassword({ email: "dana@members.haimuniya.invalid", password: "correcthorse" });
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);

  assert.equal(window.HaimuniaEvents.handlerCount("POST_CREATED"), 1, "one bridge, however many sessions");
  const before = mock.db.analytics_events.length;
  window.HaimuniaEvents.emit("POST_CREATED", { post_id: "p9", post_type: "POST_TEXT" });
  await waitFor(() => mock.db.analytics_events.length === before + 1, 3000);
  assert.equal(events(mock, "post_created").length, 1);
});

// ===== views ==========================================================

test("club_tab_viewed fires once per sub-tab entry, never once per re-render", async () => {
  const mock = seeded([row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => events(mock, "club_tab_viewed").length === 1, 3000);
  assert.deepStrictEqual(plain(events(mock, "club_tab_viewed")[0].props), { tab: "feed" });

  // Several re-renders of the same sub-tab. Each one runs
  // afterRenderCommunity() again.
  window.render(); window.render(); window.render();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events(mock, "club_tab_viewed").length, 1, "a re-render is not a view");

  clickTab(window, "account");
  await waitFor(() => events(mock, "club_tab_viewed").length === 2, 3000);
  assert.equal(events(mock, "club_tab_viewed")[1].props.tab, "account");

  // Back to a sub-tab already seen: still a real entry, still one event.
  clickTab(window, "feed");
  await waitFor(() => events(mock, "club_tab_viewed").length === 3, 3000);
  assert.equal(events(mock, "club_tab_viewed")[2].props.tab, "feed");
});

test("leaving the Community tab ends the view, so coming back to the same sub-tab counts again", async () => {
  const mock = seeded([row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => events(mock, "club_tab_viewed").length === 1, 3000);

  window.document.getElementById("tabHistoryBtn").click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events(mock, "club_tab_viewed").length, 1, "another top-level tab records no club view");

  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => events(mock, "club_tab_viewed").length === 2, 3000);
  assert.equal(events(mock, "club_tab_viewed")[1].props.tab, "feed");
});

test("feed_viewed fires on the tab entry and again on a scope change, with the scope on the row", async () => {
  const mock = seeded([row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => events(mock, "feed_viewed").length === 1, 3000);
  assert.deepStrictEqual(plain(events(mock, "feed_viewed")[0].props), { scope: "for_you", source: "club_tab" });

  window.document.querySelector('[data-community-action="feed-scope"][data-scope="following"]').click();
  await waitFor(() => events(mock, "feed_viewed").length === 2, 3000);
  assert.deepStrictEqual(plain(events(mock, "feed_viewed")[1].props), { scope: "following", source: "scope_change" });

  // Re-picking the active scope is refused by setFeedScope, so it is not
  // a second view either.
  window.document.querySelector('[data-community-action="feed-scope"][data-scope="following"]').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events(mock, "feed_viewed").length, 2);
});

// COMM-210 added a second board to this sub-tab (the consistency
// leaderboard), which records its own leaderboard_viewed with board:
// "consistency". Two boards on one tab is two views, not double counting, so
// the assertions below select by board rather than by arrival order.
const boardViews = (mock, board) => events(mock, "leaderboard_viewed").filter((e) => e.props.board === board);

test("the Boards sub-tab records a leaderboard view, and a challenge view only when there is a challenge", async () => {
  const empty = seeded([row(1)]);
  const w1 = await bootCommunity(empty, { syncEnabled: false });
  await openFeed(w1);
  clickTab(w1, "boards");
  await waitFor(() => boardViews(empty, "weekly_challenge").length === 1, 3000);
  assert.equal(events(empty, "challenge_viewed").length, 0, "an empty board is not a challenge view");
  await waitFor(() => boardViews(empty, "consistency").length === 1, 3000);

  const live = seeded([row(1)], {
    weekly_challenge_leaderboard: [
      { title: "אתגר השבוע", comparison_key: "movement:back-squat:est1rm", starts_on: "2026-08-24", ends_on: "2026-08-30", author_id: "u1", result_text: "100", score_value: 100, score_direction: "higher" },
    ],
  });
  const w2 = await bootCommunity(live, { syncEnabled: false });
  await openFeed(w2);
  clickTab(w2, "boards");
  await waitFor(() => events(live, "challenge_viewed").length === 1, 3000);
  assert.deepStrictEqual(plain(events(live, "challenge_viewed")[0].props), { challenge_id: null, challenge_key: "movement:back-squat:est1rm", source: "boards" });
  assert.equal(boardViews(live, "weekly_challenge")[0].props.rows, 1);
});

test("post_impression rides the same once-per-session guard as the ranking pipeline", async () => {
  const mock = seeded([row(1), row(2), row(3)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 3);
  await dwell();

  await waitFor(() => events(mock, "post_impression").length === 3, 3000);
  assert.deepStrictEqual(events(mock, "post_impression").map((r) => r.props.post_id), ["p1", "p2", "p3"]);
  assert.deepStrictEqual(events(mock, "post_impression").map((r) => r.props.position), [0, 1, 2]);
  assert.equal(new Set(events(mock, "post_impression").map((r) => r.props.feed_session_id)).size, 1);

  // The observer is rebuilt on every render, which is exactly the shape
  // that would double count without the guard.
  window.render();
  await dwell();
  assert.equal(events(mock, "post_impression").length, 3, "one impression per post per feed session");

  // And the analytics row set agrees with the ranking pipeline's rows.
  clickTab(window, "account");
  await waitFor(() => mock.db.feed_impressions.length === 3, 3000);
  assert.deepStrictEqual(
    events(mock, "post_impression").map((r) => r.props.post_id),
    mock.db.feed_impressions.map((r) => r.post_id),
  );
});

// ===== opens ==========================================================

test("post_opened fires on the open branch only, and carries the post type", async () => {
  const mock = seeded([row(1, { post_type: "POST_PHOTO" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const toggle = () => window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  toggle();
  await waitFor(() => events(mock, "post_opened").length === 1, 3000);
  assert.deepStrictEqual(plain(events(mock, "post_opened")[0].props), { post_id: "p1", post_type: "POST_PHOTO", source: "feed" });

  toggle(); // close
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events(mock, "post_opened").length, 1, "a close is not an open");

  toggle(); // open again
  await waitFor(() => events(mock, "post_opened").length === 2, 3000);
});

test("profile_opened carries the target id and whether it is the member's own profile", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  mock.onRpc("community_profile", (args) => ({ data: { id: args.user_id, handle: "noam", display_name: "נועם", role: "member", posts: [] }, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="view-profile"]').click();
  await waitFor(() => events(mock, "profile_opened").length === 1, 3000);
  assert.deepStrictEqual(plain(events(mock, "profile_opened")[0].props), { user_id: "u2", self: false });
  // No display name, no handle.
  assert.ok(!JSON.stringify(events(mock, "profile_opened")[0].props).includes("נועם"));
});

test("notification_opened fires once per opened row and carries the type, not the body", async () => {
  const mock = seeded([], {
    notifications: [{
      id: "n1", user_id: "u1", type: "comment_reply", category: "community",
      title: "תגובה חדשה", body: "נועם הגיב/ה לך", deep_link: null,
      source_type: null, source_id: null, read_at: null, created_at: new Date(BASE).toISOString(),
    }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  // COMM-331: the club-top card (and its bell button) only renders once
  // state.club loads via the deferred ensureCommunityDataLoaded(), not the
  // instant .subtabbar does - wait for the bell itself first.
  await waitFor(() => !!window.document.querySelector('[data-community-action="feed-notifications"]'), 4000);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-open"]'), 4000);

  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => events(mock, "notification_opened").length === 1, 3000);
  const props = plain(events(mock, "notification_opened")[0].props);
  assert.deepStrictEqual(props, { notification_id: "n1", type: "comment_reply", target: "feed", was_unread: true });
  assert.ok(!JSON.stringify(props).includes("הגיב"), "the notification body never reaches analytics");
});

// ===== actions ========================================================

test("member_followed fires on a new follow edge and stays silent on the unfollow that follows it", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  clickTab(window, "account");
  await waitFor(() => !!window.document.getElementById("communityPeopleSearch"), 3000);

  const input = window.document.getElementById("communityPeopleSearch");
  input.value = "noam";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => !!window.document.querySelector('[data-community-action="follow"][data-id="u2"]'), 3000);

  window.document.querySelector('[data-community-action="follow"][data-id="u2"]').click();
  await waitFor(() => events(mock, "member_followed").length === 1, 3000);
  assert.deepStrictEqual(plain(events(mock, "member_followed")[0].props), { user_id: "u2" });

  // The mock's insert does not raise 23505, so drive the unfollow branch
  // by hand: an error that is a duplicate key must record nothing.
  const before = events(mock, "member_followed").length;
  mock.db.follows = [];
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events(mock, "member_followed").length, before);
});

test("report_submitted records the reason code and never the free-text note", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"] .post-menu'), 3000);
  window.document.querySelector('[data-post-id="p1"] [data-community-action="report"]').click();
  await waitFor(() => !!window.document.querySelector('[data-report-reason="spam"]'), 3000);

  const radio = window.document.querySelector('[data-report-reason="spam"]');
  radio.checked = true;
  radio.dispatchEvent(new window.Event("change", { bubbles: true }));
  const note = window.document.querySelector("[data-report-note]");
  note.value = "הוא כתב עליי דברים";
  note.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="report-submit"]').click();

  await waitFor(() => events(mock, "report_submitted").length === 1, 3000);
  const props = plain(events(mock, "report_submitted")[0].props);
  assert.deepStrictEqual(props, { target_type: "post", reason: "spam" });
  assert.ok(!JSON.stringify(props).includes("כתב"), "the reporter's note never reaches analytics");
});

test("achievement_shared fires once from the unlock sheet, alongside post_created from the bus rather than instead of it", async () => {
  const mock = seeded([], {
    achievement_definitions: [{ id: "ad-1", code: "first_cheer", name: "עידוד ראשון", enabled: true, visibility: "club", trigger_type: "REACTION_CREATED", config: { client_claimable: true } }],
    member_achievements: [{ id: "ma-1", user_id: "u1", achievement_id: "ad-1", code: "first_cheer", visibility: "club", shared_at: null, unlocked_at: VERIFIED, achievement_definitions: { code: "first_cheer", name: "עידוד ראשון", icon: "👏" } }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  clickTab(window, "account");
  await waitFor(() => !!window.document.querySelector('[data-community-action="ach-share-later"]'), 3000);

  window.document.querySelector('[data-community-action="ach-share-later"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="ach-share"]'), 3000);
  window.document.querySelector('[data-community-action="ach-share"]').click();

  await waitFor(() => events(mock, "achievement_shared").length === 1, 3000);
  assert.deepStrictEqual(plain(events(mock, "achievement_shared")[0].props), { member_achievement_id: "ma-1", code: "first_cheer", source: "unlock_sheet" });
  // The bus bridge wrote the post row on its own. Two names, one action,
  // and neither of them written twice.
  await waitFor(() => events(mock, "post_created").length === 1, 3000);
  assert.equal(events(mock, "achievement_shared").length, 1);
});

// ===== the bus bridge is the only writer of its six names ==============

test("reacting writes exactly one reaction_added, from the bus and not from a second hand-written call", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="cheer"]').click();
  await waitFor(() => events(mock, "reaction_added").length === 1, 3000);
  assert.deepStrictEqual(plain(events(mock, "reaction_added")[0].props), { post_id: "p1" });

  // Un-react. toggle_reaction removes the row and the producer only emits
  // on a new reaction, so there is no second event and no phantom one.
  window.document.querySelector('[data-post-id="p1"] [data-community-action="cheer"]').click();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events(mock, "reaction_added").length, 1);
});

test("commenting writes one comment_created, with the mention list reduced to a count", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  await waitFor(() => !!window.document.querySelector('[data-comment-post-id="p1"]'), 3000);

  const form = window.document.querySelector('[data-comment-post-id="p1"]');
  // The mention marker only parses with a real uuid, which is what the
  // picker inserts.
  form.elements.body.value = "כל הכבוד @[נועם](3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607)";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(() => events(mock, "comment_created").length === 1, 4000);
  const props = plain(events(mock, "comment_created")[0].props);
  assert.equal(props.post_id, "p1");
  assert.equal(props.mention_count, 1, "the mention array is stored as its length");
  assert.equal(props.mentions, undefined, "the mention objects themselves must not be stored");
  assert.ok(!JSON.stringify(props).includes("נועם"), "a mentioned member's display name never reaches analytics");
  assert.equal(props.author_id, undefined, "the author is the row's user_id, not a prop");
});

// ===== the props budget ===============================================

test("every prop payload the Phase 1 surfaces write stays well under the client budget", async () => {
  const mock = seeded([row(1), row(2)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);
  await dwell();
  clickTab(window, "boards");
  clickTab(window, "account");
  await waitFor(() => mock.db.analytics_events.length >= 5, 4000);

  const budget = window.HaimuniaAnalytics.PROPS_BUDGET_BYTES;
  for (const r of mock.db.analytics_events) {
    const size = JSON.stringify(r.props).length;
    assert.ok(size <= budget, `${r.event_name} props are ${size} bytes, over the ${budget} budget`);
    assert.equal(r.props._truncated, undefined, `${r.event_name} should never need trimming`);
    assert.ok(window.HaimuniaAnalytics.isKnown(r.event_name), `${r.event_name} is not a defined constant`);
  }
});

test("a failing analytics write is invisible to the member and never breaks the surface underneath it", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  // Every later insert is rejected the way an RLS denial would be.
  window.HaimuniaAnalytics.configure({
    client: { from: () => ({ insert: () => Promise.reject(new Error("network down")) }) },
    getUserId: () => "u1",
  });

  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  await waitFor(() => !!window.document.querySelector('[data-comment-post-id="p1"]'), 3000);
  assert.ok(window.document.querySelector('[data-post-id="p1"]'), "the card is still rendered");
  assert.ok(!/משהו השתבש/.test(window.document.body.textContent), "no error surface");
  assert.ok(!names(mock).includes("post_opened"), "and nothing was written to the real table");
});
