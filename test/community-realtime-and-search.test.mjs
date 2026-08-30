// COMM-209, COMM-227, COMM-228 - the client half of the realtime and
// search cluster, executed for real in jsdom against the mock Supabase
// client (test/helpers/mockSupabase.mjs), not regex-matched.
//
// WHAT THIS FILE VERIFIES
// - COMM-209: opening a challenge detail opens exactly two channels through
//   HaimuniaRealtime, filtered to that challenge id, on challenge_progress
//   INSERT and challenge_participants UPDATE; an event re-reads
//   chal_progress() (the server's aggregation) instead of applying the
//   delta client-side; a burst of rows costs one re-read, not one per row;
//   closing the detail and changing the sub-tab both close the channels.
// - COMM-227: one feed session opens two shared, unfiltered channels
//   (post_comments and reactions) rather than one per card, filters
//   incoming rows against the rendered post ids itself, re-reads through
//   the same load path the first render used (so a removed comment stays
//   a placeholder), and the own-row notifications channel COMM-140 shipped
//   now moves the badge.
// - COMM-228: one community_search() call per keystroke fills three
//   labeled groups; under two characters (after the same %_,() stripping
//   the RPC does) there is no request at all; a failed search clears
//   rather than showing a broken state.
//
// WHAT THIS FILE DOES NOT VERIFY
// The publication membership and the community_search() body themselves -
// those are Postgres (202608290007, 202608290008), covered by
// test/community-realtime-search-rls.test.mjs and the pgTAP suite. The
// mock's community_search mirrors the shipped function's sanitization,
// threshold, per-group cap and visibility rules.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const iso = (deltaDays) => new Date(NOW + deltaDays * 86400000).toISOString();

function seeded(extra, opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
      { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: (opts && opts.staff) ? "coach" : "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    challenges: [], challenge_participants: [], challenge_teams: [], challenge_progress: [],
    events: [], workout_posts: [], feed_page_rows: [], analytics_events: [],
    notifications: [], notification_preferences: [],
    follows: [], hidden_posts: [], saved_posts: [], blocks: [], reactions: [], post_comments: [],
    feed_impressions: [], feed_interactions: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

function feedRow(extra) {
  return Object.assign({
    id: "p1",
    post_type: "POST_TEXT",
    author_id: "u2",
    author: { display_name: "נועם", handle: "noam" },
    body: "הפוסט הראשון",
    visibility: "club",
    created_at: new Date(NOW - 3600000).toISOString(),
    published_at: new Date(NOW - 3600000).toISOString(),
    reaction_count: 0,
    comment_count: 0,
    media: [],
    metadata: {},
  }, extra || {});
}

const coopChallenge = {
  id: "c1", challenge_type: "cooperative", title: "אתגר משותף", description: "",
  metric_type: "reps", target_value: 100, start_at: iso(-3), end_at: iso(10),
  status: "active", join_mode: "open", visibility: "club", created_by: "u2", config: {},
};

async function openCommunity(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
}
async function openBoards(window) {
  await openCommunity(window);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => window.document.body.textContent.includes("אתגרי המועדון"), 4000);
}
async function openCoopDetail(window) {
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="open-challenge"]').click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"]'), 4000);
  await waitFor(() => /התקדמות המועדון/.test(window.document.querySelector('[data-cloud-dialog="challengeView"]').textContent), 4000);
}
function dialogText(window) {
  const el = window.document.querySelector('[data-cloud-dialog="challengeView"]');
  return el ? el.textContent : "";
}
// jsdom objects come from another realm, so deepStrictEqual would fail on
// prototype identity alone; every structural comparison below goes through
// this first, matching the convention in community-analytics-surfaces.
const plain = (value) => JSON.parse(JSON.stringify(value));
function bindingFor(mock, name) {
  const ch = mock.channels.find((c) => c.topic === name && !c.removed);
  return plain(ch && ch.bindings[0].filter);
}
async function openAccount(window) {
  await openCommunity(window);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.getElementById("communityPeopleSearch"), 4000);
}
function typeSearch(window, value) {
  const input = window.document.getElementById("communityPeopleSearch");
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function groupRows(window, group) {
  const el = window.document.querySelector(`[data-search-group="${group}"]`);
  return el ? [...el.querySelectorAll(".log-row")] : [];
}

// ===== COMM-209 challenge realtime progress ============================

test("COMM-209: opening a challenge detail opens exactly two channels, filtered to that challenge, on challenge_progress INSERT and challenge_participants UPDATE", async () => {
  const mock = seeded({
    challenges: [coopChallenge],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", status: "active", progress_value: 40, joined_at: iso(-2), team_id: null }],
    challenge_progress: [{ id: "cp1", challenge_id: "c1", user_id: "u1", delta: 40, created_at: iso(-1) }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoopDetail(window);

  const open = mock.openChannels();
  assert.ok(open.includes("chal-progress-c1"), "a challenge_progress channel is open for the challenge on screen");
  assert.ok(open.includes("chal-participants-c1"), "a challenge_participants channel is open for the same challenge");
  assert.deepStrictEqual(bindingFor(mock, "chal-progress-c1"), {
    event: "INSERT", schema: "public", table: "challenge_progress", filter: "challenge_id=eq.c1",
  });
  assert.deepStrictEqual(bindingFor(mock, "chal-participants-c1"), {
    event: "UPDATE", schema: "public", table: "challenge_participants", filter: "challenge_id=eq.c1",
  });
  // One detail screen stays far under the harness cap.
  assert.ok(window.HaimuniaRealtime.count() <= window.HaimuniaRealtime.MAX_SUBSCRIPTIONS);
});

test("COMM-209: a contribution from another member moves the club total live, re-read from chal_progress rather than summed client-side", async () => {
  const mock = seeded({
    challenges: [coopChallenge],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", status: "active", progress_value: 40, joined_at: iso(-2), team_id: null },
      { challenge_id: "c1", user_id: "u2", status: "active", progress_value: 0, joined_at: iso(-2), team_id: null },
    ],
    challenge_progress: [{ id: "cp1", challenge_id: "c1", user_id: "u1", delta: 40, created_at: iso(-1) }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoopDetail(window);
  assert.match(dialogText(window), /40 \/ 100/);

  // Another member contributes: the row lands server-side, then the
  // channel pushes it. The payload itself is never applied - the client
  // re-reads the server's aggregate.
  mock.db.challenge_progress.push({ id: "cp2", challenge_id: "c1", user_id: "u2", delta: 20, created_at: new Date().toISOString() });
  assert.strictEqual(mock.emitRealtime("chal-progress-c1", { eventType: "INSERT", new: { id: "cp2", challenge_id: "c1" } }), 1);

  await waitFor(() => /60 \/ 100/.test(dialogText(window)), 4000);
  assert.match(dialogText(window), /60% מהיעד/);
});

test("COMM-209: a burst of contributions is debounced into one re-read, not one per row", async () => {
  const mock = seeded({
    challenges: [coopChallenge],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", status: "active", progress_value: 40, joined_at: iso(-2), team_id: null }],
    challenge_progress: [{ id: "cp1", challenge_id: "c1", user_id: "u1", delta: 40, created_at: iso(-1) }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoopDetail(window);
  const before = mock.callsTo("chal_progress").length;

  for (let i = 0; i < 5; i++) {
    mock.db.challenge_progress.push({ id: `burst-${i}`, challenge_id: "c1", user_id: "u2", delta: 2, created_at: new Date().toISOString() });
    mock.emitRealtime("chal-progress-c1", { eventType: "INSERT", new: { id: `burst-${i}`, challenge_id: "c1" } });
  }
  // A participants UPDATE rides the same debounce key, since both mean
  // "this challenge moved".
  mock.emitRealtime("chal-participants-c1", { eventType: "UPDATE", new: { challenge_id: "c1", user_id: "u2" } });

  await waitFor(() => /50 \/ 100/.test(dialogText(window)), 4000);
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(mock.callsTo("chal_progress").length - before, 1, "six events, one re-read");
});

test("COMM-209: closing the detail closes its channels, and so does leaving the sub-tab", async () => {
  const mock = seeded({
    challenges: [coopChallenge],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", status: "active", progress_value: 40, joined_at: iso(-2), team_id: null }],
    challenge_progress: [{ id: "cp1", challenge_id: "c1", user_id: "u1", delta: 40, created_at: iso(-1) }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoopDetail(window);
  assert.ok(mock.openChannels().includes("chal-progress-c1"));

  window.document.querySelector('[data-community-action="close-challenge-view"]').click();
  await waitFor(() => !window.document.querySelector('[data-cloud-dialog="challengeView"]'), 4000);
  assert.deepStrictEqual(mock.openChannels().filter((n) => n.startsWith("chal-")), [], "closing the detail closed both channels");
  // A closed channel delivers nothing, which is what makes the teardown
  // real rather than the registry only forgetting about it.
  assert.strictEqual(mock.emitRealtime("chal-progress-c1", { eventType: "INSERT", new: { challenge_id: "c1" } }), 0);

  // Re-open, then change the sub-tab: teardownAll() in setCommunityTab is
  // the one place a view change closes everything.
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="open-challenge"]').click();
  await waitFor(() => mock.openChannels().includes("chal-progress-c1"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.getElementById("communityPeopleSearch"), 4000);
  assert.deepStrictEqual(mock.openChannels().filter((n) => n.startsWith("chal-")), [], "leaving the sub-tab closed the challenge channels");
});

test("COMM-209: an unreachable realtime service leaves the detail on its existing poll-on-open behavior, with no visible error", async () => {
  const mock = seeded({
    challenges: [coopChallenge],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", status: "active", progress_value: 40, joined_at: iso(-2), team_id: null }],
    challenge_progress: [{ id: "cp1", challenge_id: "c1", user_id: "u1", delta: 40, created_at: iso(-1) }],
  });
  // Every channel open fails, the way an unreachable socket behaves.
  mock.client.channel = () => { throw new Error("realtime unreachable"); };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoopDetail(window);

  assert.match(dialogText(window), /40 \/ 100/, "the screen still renders its polled data");
  assert.strictEqual(window.HaimuniaRealtime.count(), 0);
  assert.doesNotMatch(window.document.getElementById("content").textContent, /נכשל|שגיאה/, "no error is shown for a missing live channel");
});

// ===== COMM-227 comments, reaction counts, notification badge ===========

test("COMM-227: a feed session opens two shared table channels, not one per card", async () => {
  const mock = seeded({ feed_page_rows: [feedRow(), feedRow({ id: "p2", body: "פוסט שני" })] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => mock.openChannels().includes("feed-reactions"), 4000);

  const open = mock.openChannels();
  assert.ok(open.includes("feed-comments"));
  assert.ok(open.includes("feed-reactions"));
  assert.strictEqual(open.filter((n) => n.startsWith("feed-")).length, 2, "two channels for the whole feed, however many cards are rendered");
  // Shared channels are unfiltered on purpose: postgres_changes filters
  // are eq-only, so a per-post filter would need one channel per card.
  assert.deepStrictEqual(bindingFor(mock, "feed-comments"), { event: "INSERT", schema: "public", table: "post_comments" });
  assert.deepStrictEqual(bindingFor(mock, "feed-reactions"), { event: "*", schema: "public", table: "reactions" });
  assert.ok(window.HaimuniaRealtime.count() <= window.HaimuniaRealtime.MAX_SUBSCRIPTIONS);
});

test("COMM-227: a new comment appears in an open thread without a reload, and a removed one stays a placeholder", async () => {
  const mock = seeded({
    feed_page_rows: [feedRow()],
    post_comments: [{ id: "c-seed", post_id: "p1", author_id: "u2", body: "התגובה הראשונה", parent_comment_id: null, created_at: new Date(NOW - 1800000).toISOString(), edited_at: null, deleted_at: null, status: "active", profiles: { handle: "noam", display_name: "נועם", avatar_url: null } }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]'), 4000);
  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  await waitFor(() => /התגובה הראשונה/.test(window.document.querySelector('[data-post-id="p1"]').textContent), 4000);

  // Another member comments, and a moderator removes a second one. Both
  // rows arrive over the same shared channel.
  mock.db.post_comments.push({ id: "c-live", post_id: "p1", author_id: "u2", body: "תגובה חיה", parent_comment_id: null, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, status: "active", profiles: { handle: "noam", display_name: "נועם", avatar_url: null } });
  mock.db.post_comments.push({ id: "c-removed", post_id: "p1", author_id: "u2", body: "תוכן שהוסר", parent_comment_id: null, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, status: "removed", profiles: { handle: "noam", display_name: "נועם", avatar_url: null } });
  mock.emitRealtime("feed-comments", { eventType: "INSERT", new: { id: "c-live", post_id: "p1" } });

  await waitFor(() => /תגובה חיה/.test(window.document.querySelector('[data-post-id="p1"]').textContent), 4000);
  const cardText = window.document.querySelector('[data-post-id="p1"]').textContent;
  assert.match(cardText, /התגובה נמחקה/, "the moderated row goes through the same status handling the first load applies");
  assert.doesNotMatch(cardText, /תוכן שהוסר/, "a removed comment's body is never rendered, live or on load");
});

test("COMM-227: a comment on a post that is not on screen is ignored by the shared channel", async () => {
  const mock = seeded({
    feed_page_rows: [feedRow()],
    post_comments: [{ id: "c-other", post_id: "p-not-rendered", author_id: "u2", body: "תגובה לפוסט אחר", parent_comment_id: null, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, status: "active", profiles: { handle: "noam", display_name: "נועם", avatar_url: null } }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]'), 4000);
  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  await waitFor(() => !!window.document.querySelector('[data-comment-post-id="p1"]'), 4000);

  mock.emitRealtime("feed-comments", { eventType: "INSERT", new: { id: "c-other", post_id: "p-not-rendered" } });
  await new Promise((r) => setTimeout(r, 700));
  assert.doesNotMatch(window.document.getElementById("content").textContent, /תגובה לפוסט אחר/);
});

test("COMM-227: a reaction by another member moves the count on a visible card without a reload", async () => {
  const mock = seeded({ feed_page_rows: [feedRow({ reaction_count: 1 })], reactions: [{ post_id: "p1", user_id: "u2", kind: "cheer", created_at: new Date(NOW - 600000).toISOString(), profiles: { handle: "noam", display_name: "נועם", avatar_url: null } }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => /1 הגבות/.test(window.document.querySelector('[data-post-id="p1"]').textContent), 4000);

  mock.db.reactions.push({ post_id: "p1", user_id: "u3", kind: "cheer", created_at: new Date().toISOString(), profiles: { handle: "gil", display_name: "גיל", avatar_url: null } });
  mock.emitRealtime("feed-reactions", { eventType: "INSERT", new: { post_id: "p1", user_id: "u3", kind: "cheer" } });

  await waitFor(() => /2 הגבות/.test(window.document.querySelector('[data-post-id="p1"]').textContent), 4000);
});

test("COMM-227: a removed reaction (a DELETE payload, which carries only `old`) also moves the count", async () => {
  const mock = seeded({
    feed_page_rows: [feedRow({ reaction_count: 2 })],
    reactions: [
      { post_id: "p1", user_id: "u2", kind: "cheer", created_at: new Date(NOW - 600000).toISOString(), profiles: { handle: "noam", display_name: "נועם", avatar_url: null } },
      { post_id: "p1", user_id: "u3", kind: "cheer", created_at: new Date(NOW - 500000).toISOString(), profiles: { handle: "gil", display_name: "גיל", avatar_url: null } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => /2 הגבות/.test(window.document.querySelector('[data-post-id="p1"]').textContent), 4000);

  mock.db.reactions = mock.db.reactions.filter((r) => r.user_id !== "u3");
  mock.emitRealtime("feed-reactions", { eventType: "DELETE", old: { post_id: "p1", user_id: "u3", kind: "cheer" } });

  await waitFor(() => /1 הגבות/.test(window.document.querySelector('[data-post-id="p1"]').textContent), 4000);
});

test("COMM-227: the own-row notifications channel COMM-140 shipped now moves the badge live", async () => {
  const mock = seeded({ feed_page_rows: [feedRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => mock.openChannels().includes("notif-u1"), 4000);
  assert.deepStrictEqual(bindingFor(mock, "notif-u1"), { event: "*", schema: "public", table: "notifications", filter: "user_id=eq.u1" });

  const bell = () => window.document.querySelector('[data-community-action="feed-notifications"]');
  assert.equal(bell().querySelector(".tab-badge"), null, "no badge before anything arrives");

  mock.emitRealtime("notif-u1", { eventType: "INSERT", new: { id: "n1", user_id: "u1", type: "comment_reply", title: "תגובה חדשה", body: "", read_at: null, created_at: new Date().toISOString() } });
  await waitFor(() => !!bell().querySelector(".tab-badge"), 4000);
  assert.strictEqual(bell().querySelector(".tab-badge").textContent, "1");
});

test("COMM-227: leaving the feed sub-tab closes the shared channels and cannot deliver into a view that is gone", async () => {
  const mock = seeded({ feed_page_rows: [feedRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => mock.openChannels().includes("feed-reactions"), 4000);

  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.getElementById("communityPeopleSearch"), 4000);
  assert.deepStrictEqual(mock.openChannels().filter((n) => n.startsWith("feed-")), []);
  assert.strictEqual(mock.emitRealtime("feed-comments", { eventType: "INSERT", new: { post_id: "p1" } }), 0);

  // Coming back re-arms, so the teardown is not a one-way door.
  window.document.querySelector('[data-community-action="set-tab"][data-tab="feed"]').click();
  await waitFor(() => mock.openChannels().includes("feed-comments"), 4000);
});

// ===== COMM-228 grouped search =========================================

test("COMM-228: one search fills three labeled groups - members, events and challenges - each rendered separately", async () => {
  const mock = seeded({
    events: [{ id: "e1", title: "ריצת בוקר", event_type: "social", status: "published", start_at: iso(4), created_by: "u2" }],
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "ריצת 50 קילומטר", status: "active", start_at: iso(-2), end_at: iso(9), created_by: "u2", target_value: 50, metric_type: "distance", join_mode: "open", visibility: "club", config: {} }],
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true },
      { id: "u2", handle: "ritz", display_name: "ריצה נועם", visible_to_club: true, allow_follows: true },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  typeSearch(window, "ריצ");

  await waitFor(() => groupRows(window, "members").length === 1, 4000);
  assert.strictEqual(mock.callsTo("community_search").length, 1, "one round trip, not three");
  assert.deepStrictEqual(plain(mock.callsTo("community_search")[0]), { p_query: "ריצ", p_limit: 10 });

  const groups = [...window.document.querySelectorAll("[data-search-group]")].map((el) => el.dataset.searchGroup);
  assert.deepStrictEqual(groups, ["members", "events", "challenges"], "results are grouped per type, never interleaved");
  assert.match(groupRows(window, "members")[0].textContent, /ריצה נועם/);
  assert.ok(groupRows(window, "members")[0].querySelector('[data-community-action="follow"][data-id="u2"]'), "the members group keeps the shape the existing caller renders");
  assert.match(groupRows(window, "events")[0].textContent, /ריצת בוקר/);
  assert.match(groupRows(window, "challenges")[0].textContent, /ריצת 50 קילומטר/);
});

test("COMM-228: a query under two characters clears results with no request at all", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "ריצת 50 קילומטר", status: "active", start_at: iso(-2), end_at: iso(9), created_by: "u2", target_value: 50, metric_type: "distance", join_mode: "open", visibility: "club", config: {} }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  typeSearch(window, "ר");
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(mock.callsTo("community_search").length, 0, "under the threshold nothing is asked of the server");
  assert.strictEqual(window.document.querySelector("[data-search-group]"), null, "and no group is claimed to be empty");

  // Only %_,() - the characters the client and the RPC both strip - is an
  // empty query, not a wildcard that would match everything.
  typeSearch(window, "%_,()");
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(mock.callsTo("community_search").length, 0);

  typeSearch(window, "ריצ");
  await waitFor(() => groupRows(window, "challenges").length === 1, 4000);
  assert.strictEqual(mock.callsTo("community_search").length, 1);
});

test("COMM-228: a search that matches nothing shows three empty groups, and a failed search clears instead of breaking", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  typeSearch(window, "זזזז");
  await waitFor(() => window.document.querySelectorAll("[data-search-group]").length === 3, 4000);
  assert.strictEqual(groupRows(window, "members").length, 0);
  assert.match(window.document.querySelector('[data-search-group="events"]').textContent, /אין תוצאות/);

  mock.onRpc("community_search", () => ({ data: null, error: { message: "boom" } }));
  typeSearch(window, "נועם");
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(groupRows(window, "members").length, 0, "a failure clears rather than showing a broken state");
  assert.doesNotMatch(window.document.getElementById("content").textContent, /נכשל|שגיאה/);
});

test("COMM-228: a draft challenge the caller may not see is absent from the results, and its creator's search finds it", async () => {
  const draft = { id: "cd", challenge_type: "individual_target", title: "טיוטת ריצה", status: "draft", start_at: iso(1), end_at: iso(9), created_by: "u2", target_value: 10, metric_type: "distance", join_mode: "open", visibility: "club", config: {} };
  const memberMock = seeded({ challenges: [draft] });
  const memberWindow = await bootCommunity(memberMock, { syncEnabled: false });
  await openAccount(memberWindow);
  typeSearch(memberWindow, "ריצ");
  await waitFor(() => memberWindow.document.querySelectorAll("[data-search-group]").length === 3, 4000);
  assert.strictEqual(groupRows(memberWindow, "challenges").length, 0, "challenges_read's draft rule holds inside search");

  const staffMock = seeded({ challenges: [draft] }, { staff: true });
  const staffWindow = await bootCommunity(staffMock, { syncEnabled: false });
  await openAccount(staffWindow);
  typeSearch(staffWindow, "ריצ");
  await waitFor(() => groupRows(staffWindow, "challenges").length === 1, 4000);
  assert.match(groupRows(staffWindow, "challenges")[0].textContent, /טיוטת ריצה/);
});

test("COMM-228: the box keeps the typed text and the caret across the renders the search itself triggers", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  window.document.getElementById("communityPeopleSearch").focus();
  typeSearch(window, "נועם");

  await waitFor(() => groupRows(window, "members").length === 1, 4000);
  const input = window.document.getElementById("communityPeopleSearch");
  assert.strictEqual(input.value, "נועם", "the render that shows the results does not wipe the query");
  assert.strictEqual(window.document.activeElement, input, "and does not drop focus mid-typing");
});

test("COMM-228: a challenge result opens the real challenge detail and records where it came from", async () => {
  const mock = seeded({
    challenges: [coopChallenge],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", status: "active", progress_value: 40, joined_at: iso(-2), team_id: null }],
    challenge_progress: [{ id: "cp1", challenge_id: "c1", user_id: "u1", delta: 40, created_at: iso(-1) }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  typeSearch(window, "אתגר");
  await waitFor(() => groupRows(window, "challenges").length === 1, 4000);

  groupRows(window, "challenges")[0].querySelector('[data-community-action="open-challenge"]').click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"]'), 4000);
  const viewed = mock.db.analytics_events.filter((e) => e.event_name === "challenge_viewed");
  assert.strictEqual(viewed.length, 1);
  assert.strictEqual(viewed[0].props.source, "search");
});
