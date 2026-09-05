// COMM-110 to COMM-115, the client half of the feed cluster, executed for
// real in jsdom against the mock Supabase client.
//
// WHAT THIS FILE VERIFIES
// That cloud.js consumes public.feed_page() the way the contract says:
// renders the returned order untouched, asks for 20 at a time, hands the
// opaque cursor straight back, passes the chosen scope through, batches
// impressions once per feed session, and records an interaction on open,
// react, comment, hide, save and profile open.
//
// WHAT THIS FILE DOES NOT VERIFY
// The ranking itself, the diversity reorder, or the keyset. Those are the
// Postgres function's, they are asserted structurally in
// test/community-feed-ranking.test.mjs and behaviourally in
// supabase/tests/0019_feed_page_test.sql. The mock's feed_page stand-in
// deliberately does not rank: a JS re-implementation of the scoring here
// would only ever be asserting itself.
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
    author_id: `u${(i % 5) + 2}`,
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
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    feed_page_rows: rows,
    feed_impressions: [],
    feed_interactions: [],
    follows: [],
    hidden_posts: [],
    saved_posts: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openFeed(window, atLeast = 1) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.querySelectorAll("#communityFeedList .post-card").length >= atLeast, 4000);
}

// cloud.js counts a card as seen after FEED_IMPRESSION_DWELL_MS. jsdom has
// no IntersectionObserver, so the fallback arms the same timer on every
// rendered card and this is the wait for it.
function dwell() { return new Promise((r) => setTimeout(r, 1200)); }

function renderedIds(window) {
  return Array.prototype.slice
    .call(window.document.querySelectorAll("#communityFeedList [data-post-id]"))
    .map((el) => el.getAttribute("data-post-id"));
}

// --- COMM-110 ranked consumption -----------------------------------------

test("loadFeed calls feed_page, not the chronological community_feed view", async () => {
  const mock = seeded([row(1), row(2)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);
  const calls = mock.callsTo("feed_page");
  assert.ok(calls.length >= 1, "feed_page was called");
  assert.equal(calls[0].p_limit, 20, "first load asks for 20");
  assert.equal(calls[0].p_cursor, null, "the top of the feed has no cursor");
  assert.equal(calls[0].p_scope, "for_you", "the default scope is for_you");
});

test("the client renders feed_page's order untouched, even when it is not chronological", async () => {
  // Deliberately handed back oldest-first, which no chronological read would
  // ever produce. If cloud.js re-sorted by any timestamp this order flips.
  const mock = seeded([row(9), row(3), row(7), row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 4);
  assert.deepEqual(renderedIds(window), ["p9", "p3", "p7", "p1"]);
});

test("cloud.js contains no sort of the feed rows", async () => {
  const fs = await import("node:fs");
  const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
  assert.doesNotMatch(cloudJs, /state\.feed\.items\s*(=|\.)\s*[^;]*\.sort\(/);
  assert.doesNotMatch(cloudJs, /state\.feed\.items\.sort\(/);
});

// --- COMM-111 filters -----------------------------------------------------

test("the four live filter chips are rendered and My Classes is disabled", async () => {
  const window = await bootCommunity(seeded([row(1)]), { syncEnabled: false });
  await openFeed(window);
  const chips = window.document.querySelectorAll('[data-community-action="feed-scope"]');
  const scopes = Array.prototype.slice.call(chips).map((c) => c.dataset.scope);
  assert.deepEqual(scopes, ["for_you", "following", "achievements", "coach", "my_classes"]);
  const parked = window.document.querySelector('[data-community-action="feed-scope"][data-scope="my_classes"]');
  assert.ok(parked.disabled, "My Classes is present but disabled, COMM-P01");
  assert.match(parked.getAttribute("title") || "", /בקרוב/);
});

test("choosing a filter sends the scope to feed_page and restarts the feed", async () => {
  const mock = seeded([
    row(1, { post_type: "POST_TEXT" }),
    row(2, { post_type: "POST_ACHIEVEMENT", metadata: { title: "הישג" } }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);
  window.document.querySelector('[data-community-action="feed-scope"][data-scope="achievements"]').click();
  await waitFor(() => mock.callsTo("feed_page").some((a) => a.p_scope === "achievements"), 3000);
  await waitFor(() => renderedIds(window).length === 1, 3000);
  assert.deepEqual(renderedIds(window), ["p2"], "only the achievement post survives the scope");
  const call = mock.callsTo("feed_page").filter((a) => a.p_scope === "achievements")[0];
  assert.equal(call.p_cursor, null, "a scope change starts a fresh feed session at the top");
});

test("the disabled My Classes chip cannot start a feed session", async () => {
  const mock = seeded([row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  const before = mock.callsTo("feed_page").length;
  window.document.querySelector('[data-scope="my_classes"]').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.callsTo("feed_page").length, before, "no call was made for the parked scope");
});

// --- COMM-113 cursor pagination ------------------------------------------

test("the first page is 20 items and load more asks for the next 20 with the cursor", async () => {
  const rows = [];
  for (let i = 1; i <= 45; i++) rows.push(row(i));
  const mock = seeded(rows);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 20);
  assert.equal(renderedIds(window).length, 20, "first load is exactly 20");

  window.document.querySelector('[data-community-action="feed-load-more"]').click();
  await waitFor(() => renderedIds(window).length === 40, 4000);
  const calls = mock.callsTo("feed_page");
  assert.equal(calls[1].p_limit, 20);
  assert.ok(calls[1].p_cursor, "the second page carries the cursor the first page returned");
  assert.notEqual(calls[1].p_cursor, calls[0].p_cursor);
  assert.deepEqual(renderedIds(window).slice(0, 20), rows.slice(0, 20).map((r) => r.id));
  assert.deepEqual(renderedIds(window).slice(20), rows.slice(20, 40).map((r) => r.id));
});

test("the cursor is opaque: the client never builds one and never uses an offset", async () => {
  const fs = await import("node:fs");
  const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
  const start = cloudJs.indexOf("async function fetchFeedPage()");
  const body = cloudJs.slice(start, cloudJs.indexOf("\n  }", start));
  assert.match(body, /p_cursor: state\.feed\.cursor/);
  assert.match(body, /rows\[rows\.length - 1\]\.next_cursor/);
  assert.doesNotMatch(body, /offset|p_offset|\.range\(/i);
});

test("a post inserted while paginating does not duplicate or skip a later page", async () => {
  const rows = [];
  for (let i = 1; i <= 45; i++) rows.push(row(i));
  const mock = seeded(rows);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 20);
  const firstPage = renderedIds(window).slice();
  // Snapshot before the insert: mock.db.feed_page_rows IS this array.
  const expectedSecondPage = rows.slice(20, 40).map((r) => r.id);

  // Somebody posts. The row lands at the top of the pool, exactly where a
  // newly published post would.
  mock.db.feed_page_rows.unshift(row(0, { id: "brand-new" }));

  window.document.querySelector('[data-community-action="feed-load-more"]').click();
  await waitFor(() => renderedIds(window).length === 40, 4000);
  const all = renderedIds(window);
  assert.deepEqual(all.slice(0, 20), firstPage, "page one is untouched");
  assert.equal(new Set(all).size, all.length, "no row appears twice");
  assert.ok(!all.includes("brand-new"), "a post created mid-session does not sneak into a later page");
  assert.deepEqual(all.slice(20), expectedSecondPage, "and nothing was skipped either");
});

test("reaching the end shows the caught-up marker and no load more control", async () => {
  const window = await bootCommunity(seeded([row(1), row(2)]), { syncEnabled: false });
  await openFeed(window, 2);
  assert.equal(window.document.querySelector('[data-community-action="feed-load-more"]'), null);
  assert.match(window.document.getElementById("content").textContent, /הגעתם לסוף/);
});

// --- COMM-110 frontend states --------------------------------------------

test("an empty feed shows the scope's own empty line, not an error", async () => {
  const window = await bootCommunity(seeded([]), { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => /פעילות המועדון תופיע כאן/.test(window.document.getElementById("content").textContent), 4000);
  assert.equal(window.document.querySelector('[data-community-action="feed-retry"]'), null);
});

test("a failed feed_page shows the error state with a retry that reloads", async () => {
  const mock = seeded([row(1)]);
  let fail = true;
  mock.onRpc("feed_page", () => (fail ? { data: null, error: { message: "boom" } } : { data: [row(1)], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="feed-retry"]'), 4000);
  assert.match(window.document.getElementById("content").textContent, /לא ניתן לטעון את פיד המועדון/);
  fail = false;
  window.document.querySelector('[data-community-action="feed-retry"]').click();
  await waitFor(() => renderedIds(window).length === 1, 4000);
});

// --- COMM-114 impressions and interactions --------------------------------

test("impressions are batched into one call per feed session and de-duped", async () => {
  const mock = seeded([row(1), row(2), row(3)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 3);
  // jsdom has no IntersectionObserver, so cloud.js falls back to the same
  // one second dwell on every rendered card.
  await dwell();
  assert.equal(mock.callsTo("feed_record_impressions").length, 0, "nothing is written while the session is open");

  // Leaving the Feed sub-tab is a view change, which flushes.
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => mock.callsTo("feed_record_impressions").length === 1, 3000);
  const batch = mock.callsTo("feed_record_impressions")[0].p_rows;
  assert.equal(batch.length, 3, "one call carried every row of the session");
  assert.equal(new Set(batch.map((r) => r.feed_session_id)).size, 1, "one session id for the whole page");
  assert.deepEqual(batch.map((r) => r.post_id), ["p1", "p2", "p3"]);
  assert.deepEqual(batch.map((r) => r.position), [0, 1, 2]);
  assert.equal(mock.db.feed_impressions.length, 3);
});

test("opening comments records an open interaction and flips opened", async () => {
  const mock = seeded([row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await dwell();
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => mock.db.feed_impressions.length === 1, 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="feed"]').click();
  await waitFor(() => renderedIds(window).length === 1, 3000);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  await waitFor(() => mock.db.feed_interactions.some((i) => i.kind === "open" && i.post_id === "p1"), 3000);
  assert.equal(mock.db.feed_impressions[0].opened, true);
});

test("react, hide, save and profile open each record their own interaction kind", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="cheer"]').click();
  await waitFor(() => mock.db.feed_interactions.some((i) => i.kind === "react"), 3000);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="view-profile"]').click();
  await waitFor(() => mock.db.feed_interactions.some((i) => i.kind === "profile_open"), 3000);
  window.document.querySelector('[data-community-action="close-profile"]').click();
  await waitFor(() => renderedIds(window).length === 1, 3000);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"] .post-menu'), 3000);
  window.document.querySelector('[data-post-id="p1"] [data-community-action="post-save"]').click();
  await waitFor(() => mock.db.feed_interactions.some((i) => i.kind === "save"), 3000);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"] .post-menu'), 3000);
  window.document.querySelector('[data-post-id="p1"] [data-community-action="post-hide"]').click();
  await waitFor(() => mock.db.feed_interactions.some((i) => i.kind === "hide"), 3000);

  const kinds = mock.db.feed_interactions.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["hide", "profile_open", "react", "save"]);
});

test("posting a comment records a comment interaction and flips engaged", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  mock.onRpc("add_post_comment", () => ({ data: "c1", error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await dwell();
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => mock.db.feed_impressions.length === 1, 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="feed"]').click();
  await waitFor(() => renderedIds(window).length === 1, 3000);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  await waitFor(() => !!window.document.querySelector('[data-comment-post-id="p1"]'), 3000);
  const form = window.document.querySelector('[data-comment-post-id="p1"]');
  form.elements.body.value = "כל הכבוד";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => mock.db.feed_interactions.some((i) => i.kind === "comment"), 3000);
  assert.equal(mock.db.feed_impressions[0].engaged, true);
});

test("a profile opened from member search records nothing, it is not a feed card", async () => {
  const mock = seeded([row(1)], { profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u9", handle: "ron", display_name: "רון", visible_to_club: true },
  ] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.getElementById("communityPeopleSearch"), 3000);
  const input = window.document.getElementById("communityPeopleSearch");
  input.value = "רון";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => !!window.document.querySelector('[data-community-action="view-profile"][data-id="u9"]'), 3000);
  const before = mock.db.feed_interactions.length;
  window.document.querySelector('[data-community-action="view-profile"][data-id="u9"]').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.db.feed_interactions.length, before);
});

// --- COMM-115 club top area ----------------------------------------------

test("the club strip shows name, member count, the challenge shortcut and the bell", async () => {
  const mock = seeded([row(1)], {
    clubs: [{ id: "club-1", name: "חיימוניה", active_challenge: { id: "ch-1", title: "אתגר השבוע", source: "weekly" } }],
    notifications: [{ user_id: "u1", read_at: null }, { user_id: "u1", read_at: null }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  const top = window.document.getElementById("communityClubTop");
  assert.ok(top, "the club strip renders");
  assert.match(top.textContent, /חיימוניה/);
  assert.match(top.textContent, /1 חברי מועדון/, "member count comes from club_summary");
  assert.ok(top.querySelector('[data-community-action="open-active-challenge"][data-id="ch-1"]'));
  const bell = top.querySelector('[data-community-action="feed-notifications"]');
  assert.ok(bell, "the notification icon is present");
  assert.match(bell.getAttribute("aria-label"), /2 חדשות/);
});

test("the top area degrades to the compose button when club_summary fails", async () => {
  const mock = seeded([row(1)]);
  mock.onRpc("club_summary", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  assert.equal(window.document.getElementById("communityClubTop"), null);
  assert.ok(window.document.querySelector('[data-community-action="open-composer"]'), "the composer is still reachable");
});
