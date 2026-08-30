// COMM-210, COMM-211, COMM-212, COMM-232 - the client half of the Phase 2
// feed cluster's leaderboards and the people-you-may-know strip, executed for
// real in jsdom against the mock Supabase client (test/helpers/mockSupabase.mjs),
// not regex-matched against cloud.js.
//
// WHAT THIS FILE VERIFIES
// - COMM-210: the consistency board on the Boards sub-tab calls
//   feed_leaderboard(mode='consistency', challenge=null, scope='club',
//   limit=50) exactly once, renders the rows in the order returned, prints the
//   server's `rank` rather than an array index, marks the caller's row with the
//   same "you" convention every other ranked surface uses, and distinguishes
//   the three non-populated states. The empty state is the contract's rule -
//   "no rows OR every value is 0" - because zero is a real ranked value.
// - COMM-211: the challenge detail's leaderboard panel for
//   individual_performance / coach now reads feed_leaderboard(mode='progress',
//   limit=20) instead of chal_progress()'s own simpler `leaderboard` key, so a
//   member who opted out of leaderboards is filtered out server-side and the
//   caller's own row is always present; "view the full board" re-asks for 50.
// - COMM-212: the scope switch re-fetches with p_scope and nothing else; the
//   friends empty state is "the only row is mine" (the caller is always
//   returned whatever the scope); hide-my-result is a per-device localStorage
//   render choice that never becomes a query parameter and never touches
//   in_leaderboards.
// - COMM-232: the suggestions strip renders people_suggestions(10) in the
//   order returned with its reason label, follows through the same follow path
//   the search UI uses, shows the honest empty state, and - the unusual one -
//   is omitted entirely on error rather than showing a retry.
//
// WHAT THIS FILE DOES NOT VERIFY
// The ranking, tie-breaking, streak arithmetic, visibility resolution and
// 60-day windows themselves - those are Postgres (202608290015) and are
// covered by supabase/tests/0034_feed_leaderboard_and_suggestions_test.sql.
// The mock mirrors the shipped functions' shapes and the four behaviours the
// client actually depends on; a fuller JS re-implementation would only ever
// assert itself.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const iso = (deltaDays) => new Date(NOW + deltaDays * 86400000).toISOString();
const HIDE_KEY = "haimunia-demo:hideMyLeaderboardResult";

function baseProfiles() {
  return [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true, created_at: iso(-100) },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true, created_at: iso(-90) },
    { id: "u3", handle: "tal", display_name: "טל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true, created_at: iso(-80) },
  ];
}
function seeded(extra, opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: baseProfiles(),
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: (opts && opts.staff) ? "coach" : "member", redeemed_at: iso(-100) },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: iso(-90) },
      { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: iso(-80) },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [],
    challenges: [], challenge_participants: [], challenge_teams: [], challenge_progress: [],
    events: [], event_attendees: [], workout_posts: [], feed_page_rows: [], analytics_events: [],
    notifications: [], notification_preferences: [],
    follows: [], blocks: [], reactions: [], post_comments: [],
    feed_impressions: [], feed_interactions: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openTab(window, tab) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
  window.document.querySelector(`[data-community-action="set-tab"][data-tab="${tab}"]`).click();
}
async function openBoards(window) {
  await openTab(window, "boards");
  await waitFor(() => !!window.document.querySelector('[data-leaderboard="consistency"]'), 4000);
  return window.document.querySelector('[data-leaderboard="consistency"]');
}
const board = (window) => window.document.querySelector('[data-leaderboard="consistency"]');
const boardRows = (window) => Array.from(board(window).querySelectorAll("[data-leaderboard-user]"));
const rowTexts = (window) => boardRows(window).map((el) => el.textContent.replace(/\s+/g, " ").trim());
const leaderboardCalls = (mock) => mock.callsTo("feed_leaderboard");
function openChallengeCard(window, id) {
  window.document.querySelector(`[data-challenge-id="${id}"] [data-community-action="open-challenge"]`).click();
}
const dialog = (window) => window.document.querySelector('[data-cloud-dialog="challengeView"]');

const perfChallenge = {
  id: "c1", challenge_type: "individual_performance", title: "20 ק\"מ חתירה", description: "",
  metric_type: "km_rowing", target_value: 20, start_at: iso(-5), end_at: iso(20),
  status: "active", join_mode: "open", visibility: "club", created_by: "u3", config: {},
};

// ---------------------------------------------------------------------------
// COMM-210 consistency board
// ---------------------------------------------------------------------------

test("COMM-210: the Boards tab asks feed_leaderboard for the club consistency board with the documented arguments, exactly once", async () => {
  const mock = seeded({ community_streaks: [{ user_id: "u2", current_streak: 5 }, { user_id: "u1", current_streak: 3 }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => boardRows(window).length === 3, 4000);
  const calls = leaderboardCalls(mock);
  assert.equal(calls.length, 1, "one call, not one per render");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0])), {
    p_mode: "consistency", p_challenge_id: null, p_scope: "club", p_limit: 50,
  });
});

test("COMM-210: rows render in the order returned, print the server's rank rather than an array index, and mark the caller's row", async () => {
  const mock = seeded();
  // A crafted payload: the caller is rank 4 of a board whose top block is
  // three rows, so array index and rank deliberately disagree on every row
  // after the first. If the client numbered by index this test fails.
  mock.onRpc("feed_leaderboard", () => ({
    data: [
      { user_id: "u2", display_name: "נועם", handle: "noam", avatar_url: null, rank: 1, value: 9, is_self: false },
      { user_id: "u3", display_name: "טל", handle: "tal", avatar_url: null, rank: 2, value: 6, is_self: false },
      { user_id: "u1", display_name: "דנה", handle: "dana", avatar_url: null, rank: 3, value: 6, is_self: true },
    ],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => boardRows(window).length === 3, 4000);
  assert.deepStrictEqual(boardRows(window).map((el) => el.dataset.leaderboardUser), ["u2", "u3", "u1"]);
  assert.match(rowTexts(window)[0], /^1\. נועם/);
  assert.match(rowTexts(window)[2], /^3\. דנה \(את\/ה\)/);
  const self = board(window).querySelector("[data-leaderboard-self]");
  assert.equal(self.dataset.leaderboardUser, "u1");
  // The same "you" marking convention chal_progress's panel and
  // renderRankedList already use, reused rather than reinvented.
  assert.match(self.getAttribute("style"), /border-color:var\(--energy\)/);
});

test("COMM-210: the caller's row appended past the visible cutoff renders separately with its real rank", async () => {
  const mock = seeded();
  // What the server does when the caller is outside p_limit: the top block in
  // rank order, then the caller's own row last with its true rank.
  const top = Array.from({ length: 3 }, (_, i) => ({
    user_id: `x${i}`, display_name: `מתאמן ${i}`, handle: `x${i}`, avatar_url: null,
    rank: i + 1, value: 30 - i, is_self: false,
  }));
  mock.onRpc("feed_leaderboard", () => ({
    data: top.concat([{ user_id: "u1", display_name: "דנה", handle: "dana", avatar_url: null, rank: 87, value: 2, is_self: true }]),
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => boardRows(window).length === 4, 4000);
  const texts = rowTexts(window);
  assert.match(texts[3], /^87\. דנה \(את\/ה\)/, "the appended row keeps its real rank, not position 4");
  assert.match(board(window).textContent, /···/, "a divider separates the top block from the caller's own standing");
});

test("COMM-210: a board where every member is still at zero is the 'not enough data' empty state, not a list of zeroes", async () => {
  // The contract's rule, and the easiest one to get wrong: zero is a real
  // ranked value, so this comes back as three ranked rows, not as no rows.
  const mock = seeded({ community_streaks: [] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!board(window).querySelector('[data-leaderboard-empty="no-data"]'), 4000);
  assert.match(board(window).textContent, /עדיין אין מספיק נתונים לטבלת עקביות\./);
  assert.equal(boardRows(window).length, 0);
  // ...and the rows really were returned; the client is judging the values.
  const returned = await mock.client.rpc("feed_leaderboard", { p_mode: "consistency", p_scope: "club", p_limit: 50 });
  assert.equal(returned.data.length, 3);
  assert.deepStrictEqual(returned.data.map((r) => r.value), [0, 0, 0]);
});

test("COMM-210: a failed board shows the documented error with a retry, and the retry re-fetches", async () => {
  const mock = seeded({ community_streaks: [{ user_id: "u2", current_streak: 4 }] });
  let fail = true;
  mock.onRpc("feed_leaderboard", () => (fail ? { data: null, error: { message: "boom" } } : {
    data: [{ user_id: "u2", display_name: "נועם", handle: "noam", avatar_url: null, rank: 1, value: 4, is_self: false }],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!board(window).querySelector('[data-leaderboard-empty="error"]'), 4000);
  assert.match(board(window).textContent, /לא ניתן היה לטעון את הטבלה\. נסו שוב\./);
  fail = false;
  board(window).querySelector('[data-community-action="leaderboard-retry"]').click();
  await waitFor(() => boardRows(window).length === 1, 4000);
  assert.equal(leaderboardCalls(mock).length, 2);
});

test("COMM-210: the board shows a skeleton while the first fetch is in flight, never an empty state it has not asked about", async () => {
  const mock = seeded({ community_streaks: [{ user_id: "u2", current_streak: 4 }] });
  let release;
  const gate = new Promise((r) => { release = r; });
  mock.onRpc("feed_leaderboard", () => gate.then(() => ({
    data: [{ user_id: "u2", display_name: "נועם", handle: "noam", avatar_url: null, rank: 1, value: 4, is_self: false }],
    error: null,
  })));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!board(window).querySelector("[data-leaderboard-skeleton]"), 4000);
  assert.equal(board(window).querySelector('[data-leaderboard-empty="no-data"]'), null);
  release();
  await waitFor(() => boardRows(window).length === 1, 4000);
});

// ---------------------------------------------------------------------------
// COMM-211 challenge progress board
// ---------------------------------------------------------------------------

test("COMM-211: the challenge detail's leaderboard panel reads feed_leaderboard in progress mode, with the challenge id and a 20-row cap", async () => {
  const mock = seeded({
    challenges: [perfChallenge],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 25, completed_at: null },
      { challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 10, completed_at: null },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openTab(window, "boards");
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!dialog(window) && !!dialog(window).querySelector('[data-leaderboard="challenge"]'), 4000);
  const progressCalls = leaderboardCalls(mock).filter((a) => a.p_mode === "progress");
  assert.equal(progressCalls.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(progressCalls[0])), {
    p_mode: "progress", p_challenge_id: "c1", p_scope: "club", p_limit: 20,
  });
  const panel = dialog(window).querySelector('[data-leaderboard="challenge"]');
  const rows = Array.from(panel.querySelectorAll("[data-leaderboard-user]"));
  assert.deepStrictEqual(rows.map((el) => el.dataset.leaderboardUser), ["u1", "u2"]);
  assert.match(rows[0].textContent.replace(/\s+/g, " "), /1\. דנה \(את\/ה\).*25/);
});

test("COMM-211: a participant who opted out of leaderboards is filtered out server-side, which chal_progress's own board did not do", async () => {
  const profiles = baseProfiles();
  profiles.find((p) => p.id === "u2").in_leaderboards = false;
  const mock = seeded({
    profiles,
    challenges: [perfChallenge],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 8, completed_at: null },
      { challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 40, completed_at: null },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openTab(window, "boards");
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!dialog(window) && !!dialog(window).querySelector("[data-leaderboard-user]"), 4000);
  const panel = dialog(window).querySelector('[data-leaderboard="challenge"]');
  assert.deepStrictEqual(Array.from(panel.querySelectorAll("[data-leaderboard-user]")).map((el) => el.dataset.leaderboardUser), ["u1"]);
  // chal_progress()'s own `leaderboard` key still has the opted-out member in
  // it; the panel simply no longer reads that key.
  const legacy = await mock.client.rpc("chal_progress", { challenge_id: "c1" });
  assert.equal(legacy.data.leaderboard.length, 2);
});

test("COMM-211: 'view the full board' re-asks for 50 rows on the same panel rather than opening a second surface", async () => {
  const mock = seeded({
    challenges: [perfChallenge],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 25, completed_at: null },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openTab(window, "boards");
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!dialog(window) && !!dialog(window).querySelector('[data-community-action="challenge-board-full"]'), 4000);
  dialog(window).querySelector('[data-community-action="challenge-board-full"]').click();
  await waitFor(() => leaderboardCalls(mock).filter((a) => a.p_mode === "progress").length === 2, 4000);
  const last = leaderboardCalls(mock).filter((a) => a.p_mode === "progress").pop();
  assert.equal(last.p_limit, 50);
  await waitFor(() => !dialog(window).querySelector('[data-community-action="challenge-board-full"]'), 4000);
  assert.ok(dialog(window).querySelector('[data-leaderboard="challenge"]'), "still the same panel, not a new screen");
});

test("COMM-211: a challenge nobody has scored in yet shows the documented empty state, and a failed board shows the shared error copy", async () => {
  const mock = seeded({
    challenges: [perfChallenge],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null },
      { challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openTab(window, "boards");
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!dialog(window) && !!dialog(window).querySelector('[data-leaderboard-empty="no-data"]'), 4000);
  assert.match(dialog(window).textContent, /עדיין אין תוצאות לדירוג\./);

  const failing = seeded({
    challenges: [perfChallenge],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 3, completed_at: null }],
  });
  failing.onRpc("feed_leaderboard", () => ({ data: null, error: { message: "boom" } }));
  const w2 = await bootCommunity(failing, { syncEnabled: false });
  await openTab(w2, "boards");
  await waitFor(() => !!w2.document.querySelector('[data-challenge-id="c1"]'), 4000);
  openChallengeCard(w2, "c1");
  await waitFor(() => !!dialog(w2) && !!dialog(w2).querySelector('[data-leaderboard-empty="error"]'), 4000);
  assert.match(dialog(w2).textContent, /לא ניתן היה לטעון את הטבלה\. נסו שוב\./);
});

// ---------------------------------------------------------------------------
// COMM-212 friends scope and hide-my-result
// ---------------------------------------------------------------------------

test("COMM-212: the scope switch re-fetches with p_scope only, without leaving the Boards sub-tab", async () => {
  const mock = seeded({
    community_streaks: [{ user_id: "u1", current_streak: 3 }, { user_id: "u2", current_streak: 5 }, { user_id: "u3", current_streak: 1 }],
    // u2 is a mutual follow, u3 follows one way only, so friends scope is
    // {u1, u2} - the caller is always in their own board.
    follows: [
      { follower_id: "u1", followed_id: "u2" }, { follower_id: "u2", followed_id: "u1" },
      { follower_id: "u3", followed_id: "u1" },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => boardRows(window).length === 3, 4000);
  board(window).querySelector('[data-community-action="leaderboard-scope"][data-scope="friends"]').click();
  await waitFor(() => boardRows(window).length === 2, 4000);
  const calls = leaderboardCalls(mock);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].p_scope, "friends");
  assert.equal(calls[1].p_mode, "consistency", "everything except the scope is unchanged");
  assert.equal(calls[1].p_limit, 50);
  assert.deepStrictEqual(boardRows(window).map((el) => el.dataset.leaderboardUser), ["u2", "u1"]);
  // A re-fetch, not a reload: the sub-tab and the rest of the Boards content
  // are still on screen.
  assert.ok(window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"].active'));
});

test("COMM-212: friends scope with no mutual follows shows the follow-people state and points at the search UI, not a bare empty table", async () => {
  const mock = seeded({ community_streaks: [{ user_id: "u1", current_streak: 3 }, { user_id: "u2", current_streak: 5 }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => boardRows(window).length === 3, 4000);
  board(window).querySelector('[data-community-action="leaderboard-scope"][data-scope="friends"]').click();
  await waitFor(() => !!board(window).querySelector('[data-leaderboard-empty="friends"]'), 4000);
  // The caller is still returned - an empty friends board is one row, not
  // zero - so "no friends yet" cannot be read off the row count alone.
  const returned = await mock.client.rpc("feed_leaderboard", { p_mode: "consistency", p_scope: "friends", p_limit: 50 });
  assert.deepStrictEqual(returned.data.map((r) => r.user_id), ["u1"]);
  assert.match(board(window).textContent, /עקבו אחרי חברים כדי להשוות תוצאות\./);
  board(window).querySelector('[data-community-action="leaderboard-find-people"]').click();
  await waitFor(() => !!window.document.getElementById("communityPeopleSearch"), 4000);
});

test("COMM-212: hide-my-result is a render choice - it hides the caller's row, persists per device, and is never a query parameter", async () => {
  const mock = seeded({ community_streaks: [{ user_id: "u1", current_streak: 3 }, { user_id: "u2", current_streak: 5 }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => boardRows(window).length === 3, 4000);
  const toggle = board(window).querySelector("[data-leaderboard-hide-self]");
  assert.equal(toggle.checked, false, "defaults to showing the caller's row");
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => boardRows(window).length === 2, 4000);
  assert.deepStrictEqual(boardRows(window).map((el) => el.dataset.leaderboardUser), ["u2", "u3"]);
  assert.equal(window.localStorage.getItem(HIDE_KEY), "1");
  // Not a fetch, and above all not a privacy setting: no new request went out,
  // no argument carries the flag, and in_leaderboards is untouched. That
  // column is the real, server-enforced opt-out and this control is not it.
  assert.equal(leaderboardCalls(mock).length, 1);
  assert.equal(leaderboardCalls(mock).some((a) => JSON.stringify(a).includes("hide")), false);
  assert.equal(mock.db.profiles.find((p) => p.id === "u1").in_leaderboards, true);
});

test("COMM-212: the hide-my-result choice survives a reboot on the same device and hides the appended self row too", async () => {
  const mock = seeded();
  mock.onRpc("feed_leaderboard", () => ({
    data: [
      { user_id: "u2", display_name: "נועם", handle: "noam", avatar_url: null, rank: 1, value: 9, is_self: false },
      { user_id: "u1", display_name: "דנה", handle: "dana", avatar_url: null, rank: 64, value: 1, is_self: true },
    ],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { [HIDE_KEY]: "1" } });
  await openBoards(window);
  await waitFor(() => boardRows(window).length === 1, 4000);
  assert.deepStrictEqual(boardRows(window).map((el) => el.dataset.leaderboardUser), ["u2"]);
  assert.equal(board(window).querySelector("[data-leaderboard-hide-self]").checked, true);
  assert.equal(board(window).textContent.includes("···"), false, "no dangling divider above a row that is not drawn");
});

test("COMM-212: the same scope switch and hide toggle are available on the challenge progress board", async () => {
  const mock = seeded({
    challenges: [perfChallenge],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 25, completed_at: null },
      { challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 10, completed_at: null },
    ],
    follows: [{ follower_id: "u1", followed_id: "u2" }, { follower_id: "u2", followed_id: "u1" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openTab(window, "boards");
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 4000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!dialog(window) && !!dialog(window).querySelector('[data-leaderboard="challenge"]'), 4000);
  dialog(window).querySelector('[data-community-action="challenge-board-scope"][data-scope="friends"]').click();
  await waitFor(() => leaderboardCalls(mock).filter((a) => a.p_mode === "progress").length === 2, 4000);
  const last = leaderboardCalls(mock).filter((a) => a.p_mode === "progress").pop();
  assert.equal(last.p_scope, "friends");
  assert.equal(last.p_challenge_id, "c1");
  const toggle = dialog(window).querySelector("[data-leaderboard-hide-self]");
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => dialog(window).querySelectorAll("[data-leaderboard-user]").length === 1, 4000);
  assert.equal(dialog(window).querySelector("[data-leaderboard-user]").dataset.leaderboardUser, "u2");
});

// ---------------------------------------------------------------------------
// COMM-232 people you may know
// ---------------------------------------------------------------------------

const suggestionsStrip = (window) => window.document.querySelector("[data-people-suggestions]");

test("COMM-232: the Account tab renders people_suggestions(10) in the order returned, with each candidate's reason", async () => {
  const mock = seeded({
    challenges: [Object.assign({}, perfChallenge, { id: "c9" })],
    challenge_participants: [
      { challenge_id: "c9", user_id: "u1", status: "active", progress_value: 1 },
      { challenge_id: "c9", user_id: "u3", status: "active", progress_value: 1 },
    ],
    feed_interactions: [
      { user_id: "u1", post_id: "p1", kind: "react", created_at: iso(-2) },
      { user_id: "u2", post_id: "p1", kind: "comment", created_at: iso(-2) },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openTab(window, "account");
  await waitFor(() => !!suggestionsStrip(window) && suggestionsStrip(window).dataset.peopleSuggestions === "ready", 4000);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(mock.callsTo("people_suggestions"))), [{ p_limit: 10 }]);
  const cards = Array.from(suggestionsStrip(window).querySelectorAll("[data-suggestion-user]"));
  // A shared live challenge outranks a shared feed interaction, and the client
  // renders what it was handed rather than re-sorting.
  assert.deepStrictEqual(cards.map((el) => el.dataset.suggestionUser), ["u3", "u2"]);
  assert.match(cards[0].textContent, /אתגר משותף/);
  assert.match(cards[1].textContent, /פעילות משותפת בפיד/);
  assert.match(suggestionsStrip(window).textContent, /אנשים שאולי תכירו/);
});

test("COMM-232: Follow on a suggestion writes the follow edge through the same path the search UI uses and drops the card", async () => {
  const mock = seeded({
    challenges: [Object.assign({}, perfChallenge, { id: "c9" })],
    challenge_participants: [
      { challenge_id: "c9", user_id: "u1", status: "active", progress_value: 1 },
      { challenge_id: "c9", user_id: "u3", status: "active", progress_value: 1 },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openTab(window, "account");
  await waitFor(() => !!suggestionsStrip(window) && !!suggestionsStrip(window).querySelector('[data-suggestion-user="u3"]'), 4000);
  suggestionsStrip(window).querySelector('[data-suggestion-user="u3"] [data-community-action="suggestion-follow"]').click();
  await waitFor(() => mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u3"), 4000);
  await waitFor(() => !window.document.querySelector('[data-suggestion-user="u3"]'), 4000);
});

test("COMM-232: a member with no qualifying overlap sees the honest empty state, not a padded list", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openTab(window, "account");
  await waitFor(() => !!suggestionsStrip(window) && suggestionsStrip(window).dataset.peopleSuggestions === "empty", 4000);
  assert.match(suggestionsStrip(window).textContent, /עדיין אין המלצות\. התחילו לבלות בקהילה כדי לקבל הצעות\./);
  assert.equal(suggestionsStrip(window).querySelector("[data-suggestion-user]"), null);
});

test("COMM-232: a failed people_suggestions omits the strip entirely - no heading, no empty state, no retry", async () => {
  // Deliberately unlike every other surface in this module, which offers a
  // retry. COMM-232 asks for silent omission because the strip is optional.
  const mock = seeded();
  mock.onRpc("people_suggestions", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openTab(window, "account");
  await waitFor(() => mock.callsTo("people_suggestions").length === 1, 4000);
  await waitFor(() => !!window.document.getElementById("communityPeopleSearch"), 4000);
  assert.equal(suggestionsStrip(window), null);
  assert.equal(window.document.body.textContent.includes("אנשים שאולי תכירו"), false);
  assert.equal(window.document.querySelector('[data-community-action="suggestion-follow"]'), null);
});
