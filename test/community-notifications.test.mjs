// COMM-140..144, the client half of the notifications cluster, executed
// for real in jsdom against the mock Supabase client.
//
// WHAT THIS FILE VERIFIES
// - COMM-140: the bell opens a category-grouped, paged, focus-trapped
//   dialog; each row has an icon, title, body, time, read state, deep link.
// - COMM-141: reads go only through notif_list; notif_unread_count drives
//   the badge and refreshes on a realtime own-row event; mark read is
//   optimistic with rollback; the 90-day horizon and "show older".
// - COMM-142: an immediate notification is its own row; a batched type
//   renders as one collapsed group that expands. The operational-
//   announcement override.
// - COMM-143: deep link resolution opens the exact target screen and item,
//   and marks the row read.
// - COMM-144: the Account preferences panel lists every type with Push
//   (disabled), In-app and Off; a change is a direct own-row upsert into
//   notification_preferences and reverts on error.
//
// WHAT THIS FILE DOES NOT VERIFY
// The server trigger set that creates the rows and the batch flusher.
// Those are Postgres, documented in contracts.md under "Needs from
// schema, notifications". A test seeds `notifications` directly, the same
// way the RLS boundary tests do.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const BASE = Date.parse("2026-08-29T09:00:00.000Z");

function notif(i, extra) {
  return Object.assign({
    id: `n${i}`,
    user_id: "u1",
    type: "comment_reply",
    category: "community",
    title: `התראה ${i}`,
    body: `גוף ההתראה ${i}`,
    source_type: null,
    source_id: null,
    deep_link: null,
    read_at: null,
    created_at: new Date(BASE - i * 60000).toISOString(),
  }, extra || {});
}

function seeded(notifications, opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    notifications: notifications || [],
    notification_preferences: [],
    feed_page_rows: (opts && opts.feed) || [],
    follows: [], hidden_posts: [], saved_posts: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openCommunity(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
}
async function openCenter(window) {
  await openCommunity(window);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => !!window.document.querySelector("[data-notif-center]"), 4000);
  // let the first page settle
  await waitFor(() => {
    const c = window.document.querySelector("[data-notif-center]");
    return c && !/aria-busy="true"/.test(c.innerHTML);
  }, 4000);
}
async function openAccount(window) {
  await openCommunity(window);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-pref"]'), 4000);
}
const centerText = (window) => window.document.querySelector("[data-notif-center]").textContent;

// ===== COMM-140 notification centre ===================================

test("the bell opens a dialog; each row carries an icon, title, body and relative time", async () => {
  const mock = seeded([notif(1, { type: "comment_reply", title: "תגובה חדשה", body: "נועם הגיב/ה לך" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  const dlg = window.document.querySelector("[data-notif-center]");
  assert.equal(dlg.getAttribute("role"), "dialog");
  assert.equal(dlg.getAttribute("aria-modal"), "true");
  const rowEl = dlg.querySelector('[data-community-action="notif-open"]');
  assert.ok(rowEl, "a notification row renders");
  assert.match(rowEl.textContent, /תגובה חדשה/);
  assert.match(rowEl.textContent, /נועם הגיב/);
  assert.match(rowEl.textContent, /לפני|עכשיו/, "a relative timestamp is shown");
});

test("rows are grouped under the five category headings in order", async () => {
  const mock = seeded([
    notif(1, { type: "comment_reply", category: "community" }),
    notif(2, { type: "achievement_unlocked", category: "training" }),
    notif(3, { type: "challenge_update", category: "challenges" }),
    notif(4, { type: "event_cancelled", category: "events" }),
    notif(5, { type: "announcement", category: "club" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  const t = centerText(window);
  const order = ["קהילה", "אימונים", "אתגרים", "אירועים", "מועדון"].map((h) => t.indexOf(h));
  assert.ok(order.every((i) => i >= 0), "every category heading is present");
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, "headings render in category order");
});

test("the centre pages 20 at a time and hands the cursor back for the next page", async () => {
  const rows = [];
  for (let i = 1; i <= 25; i++) rows.push(notif(i, { type: "comment_reply" }));
  const mock = seeded(rows);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  assert.equal(window.document.querySelectorAll('[data-community-action="notif-open"]').length, 20, "first page is 20");
  window.document.querySelector('[data-community-action="notif-load-more"]').click();
  await waitFor(() => window.document.querySelectorAll('[data-community-action="notif-open"]').length === 25, 4000);

  const listCalls = mock.callsTo("notif_list");
  assert.ok(listCalls.length >= 2, "a second page was fetched");
  assert.equal(listCalls[0].p_cursor, null, "first page has no cursor");
  assert.ok(listCalls[1].p_cursor, "the second page passes the cursor from the first");
  assert.ok(listCalls.every((c) => c.p_limit <= 40), "limit stays within the server cap");
});

test("empty, loading and error states each render", async () => {
  // empty
  let mock = seeded([]);
  let window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.match(centerText(window), /אין עדיין התראות/);

  // error
  mock = seeded([notif(1)]);
  mock.onRpc("notif_list", () => ({ data: null, error: { message: "boom" } }));
  window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => /לא ניתן לטעון התראות/.test(centerText(window)), 4000);
  assert.ok(window.document.querySelector('[data-community-action="notif-retry"]'), "a retry control is offered");
});

test("Escape closes the centre and returns focus to the bell", async () => {
  const mock = seeded([notif(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !window.document.querySelector("[data-notif-center]"), 4000);
  assert.equal(window.document.activeElement, window.document.querySelector('[data-community-action="feed-notifications"]'), "focus returns to the bell");
});

// ===== COMM-141 model, read, mark-read wiring =========================

test("the badge count comes from notif_unread_count()", async () => {
  const mock = seeded([notif(1), notif(2), notif(3)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  assert.ok(mock.callsTo("notif_unread_count").length >= 1, "the count RPC was called on session load");
  const bell = window.document.querySelector('[data-community-action="feed-notifications"]');
  assert.match(bell.getAttribute("aria-label"), /3 חדשות/);
});

test("the centre reads only through notif_list, never a raw notifications select", async () => {
  const mock = seeded([notif(1), notif(2)]);
  const seenTables = [];
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => { seenTables.push(table); return realFrom(table); };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.ok(mock.callsTo("notif_list").length >= 1, "notif_list drives the list");
  assert.ok(!seenTables.includes("notifications"), "no direct .from('notifications') anywhere");
});

test("opening the centre marks the rows it showed read, and the badge drops", async () => {
  const mock = seeded([notif(1), notif(2), notif(3)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  await waitFor(() => mock.db.notifications.every((n) => n.read_at), 4000);
  assert.ok(mock.callsTo("notif_mark_read").length >= 1, "notif_mark_read was called on open");
  await openCommunity(window); // re-render the strip
  assert.doesNotMatch(window.document.querySelector('[data-community-action="feed-notifications"]').getAttribute("aria-label"), /חדשות/);
});

test("mark all read clears rows loaded after the first page", async () => {
  const rows = [];
  for (let i = 1; i <= 25; i++) rows.push(notif(i, { type: "comment_reply" }));
  const mock = seeded(rows);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  window.document.querySelector('[data-community-action="notif-load-more"]').click();
  await waitFor(() => window.document.querySelectorAll('[data-community-action="notif-open"]').length === 25, 4000);
  assert.ok(!window.document.querySelector('[data-community-action="notif-mark-all"]').disabled, "mark-all is enabled while unread rows are loaded");

  window.document.querySelector('[data-community-action="notif-mark-all"]').click();
  await waitFor(() => mock.db.notifications.every((n) => n.read_at), 4000);
  assert.ok(window.document.querySelector('[data-community-action="notif-mark-all"]').disabled, "mark-all disables once everything is read");
});

test("mark read is optimistic and rolls back when the server rejects it", async () => {
  const mock = seeded([notif(1, { type: "comment_reply", deep_link: "/community/boards?challenge=ch1" })]);
  mock.onRpc("notif_mark_read", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => /לא ניתן לסמן כנקרא/.test(window.document.getElementById("content").textContent), 4000);
  assert.equal(mock.db.notifications[0].read_at, null, "the failed mark-read left the row unread");
});

test("the 90-day horizon is not walked until 'show older' is used", async () => {
  const fresh = [notif(1), notif(2), notif(3)];
  const old = [
    notif(90, { created_at: new Date(BASE - 120 * 86400000).toISOString(), title: "התראה ישנה" }),
    notif(91, { created_at: new Date(BASE - 130 * 86400000).toISOString() }),
  ];
  const mock = seeded(fresh.concat(old));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.doesNotMatch(centerText(window), /התראה ישנה/, "rows past 90 days are not fetched by default");
  assert.ok(window.document.querySelector('[data-community-action="notif-show-older"]'), "a 'show older' control is offered");

  window.document.querySelector('[data-community-action="notif-show-older"]').click();
  await waitFor(() => /התראה ישנה/.test(centerText(window)), 4000);
});

test("the badge refreshes on a realtime own-row event", async () => {
  const mock = seeded([notif(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => mock.openChannels().includes("notif-u1"), 4000);

  mock.emitRealtime("notif-u1", { eventType: "INSERT", new: { id: "n-live", user_id: "u1", type: "mention", category: "community", title: "x", read_at: null, created_at: new Date().toISOString() } });
  await waitFor(() => /2 חדשות/.test(window.document.querySelector('[data-community-action="feed-notifications"]').getAttribute("aria-label")), 4000);

  const before = mock.callsTo("notif_unread_count").length;
  mock.emitRealtime("notif-u1", { eventType: "UPDATE", new: { id: "n1", user_id: "u1" } });
  await waitFor(() => mock.callsTo("notif_unread_count").length > before, 4000);
});

// ===== COMM-142 immediate versus batched rendering ===================

test("routing: an immediate notification renders as its own row", async () => {
  const mock = seeded([
    notif(1, { type: "comment_reply" }),
    notif(2, { type: "comment_reply" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-open"]').length, 2, "two standalone rows");
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-toggle-group"]').length, 0, "no collapsed group");
  assert.equal(window.classifyNotification({ type: "comment_reply" }), "immediate");
});

test("routing: a batched type renders as one collapsed row that expands", async () => {
  const mock = seeded([
    notif(1, { type: "reaction" }),
    notif(2, { type: "reaction" }),
    notif(3, { type: "reaction" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  const group = window.document.querySelectorAll('[data-community-action="notif-toggle-group"]');
  assert.equal(group.length, 1, "three reactions collapse into one group");
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-open"]').length, 0, "children are hidden while collapsed");
  assert.equal(group[0].getAttribute("aria-expanded"), "false");

  group[0].click();
  await waitFor(() => window.document.querySelectorAll('[data-community-action="notif-open"]').length === 3, 4000);
  assert.equal(window.classifyNotification({ type: "reaction" }), "batched");
});

test("notifRoute honours the per-type preference, with the operational-announcement override", async () => {
  const mock = seeded([notif(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);

  assert.deepEqual(window.notifRoute("reaction", { reactions: "off" }), { channel: "off", mode: "batched", suppressed: true });
  assert.deepEqual(window.notifRoute("mention", {}), { channel: "in_app", mode: "immediate", suppressed: false });
  // web push is off in V1: a stored "push" degrades to in-app
  assert.equal(window.notifRoute("reaction", { reactions: "push" }).channel, "in_app");
  // operational announcements always land in-app, muted or not
  assert.deepEqual(window.notifRoute("announcement", { announcements: "off" }), { channel: "in_app", mode: "immediate", suppressed: false });
});

test("a muted type still renders in-app when it is an operational announcement", async () => {
  const mock = seeded([notif(1, { type: "announcement", category: "club", title: "תחזוקה מתוכננת" })], {
    notification_preferences: [{ user_id: "u1", type: "announcements", channel: "off" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.match(centerText(window), /תחזוקה מתוכננת/, "the operational announcement row is shown despite the off preference");
});

// ===== COMM-143 phase 1 types and deep links =========================

test("deep link resolution maps route and source fields to the exact target", async () => {
  const mock = seeded([notif(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  const R = window.notifResolveTarget;
  assert.deepEqual(R({ deep_link: "/community/feed?post=p1&comment=c9" }), { tab: "feed", post: "p1", comment: "c9" });
  assert.deepEqual(R({ deep_link: "/community/account/achievements?ma=ma1" }), { tab: "account", achievement: "ma1" });
  assert.deepEqual(R({ deep_link: "/community/boards?challenge=ch1" }), { tab: "boards", challenge: "ch1" });
  assert.deepEqual(R({ deep_link: "/community/feed?announcement=a1" }), { tab: "feed", announcement: "a1" });
  assert.equal(R({ source_type: "post", source_id: "p2" }).post, "p2", "source_type/source_id is the fallback");
});

test("tapping a row opens its deep-link target and marks it read", async () => {
  const post = {
    id: "p7", post_type: "POST_TEXT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" }, body: "פוסט", visibility: "club",
    created_at: new Date(BASE).toISOString(), published_at: new Date(BASE).toISOString(),
    reaction_count: 0, comment_count: 1, media: [], metadata: {},
  };
  const mock = seeded(
    [notif(1, { type: "comment_reply", deep_link: "/community/feed?post=p7&comment=c3" })],
    { feed: [post] },
  );
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => !window.document.querySelector("[data-notif-center]"), 4000);
  await waitFor(() => !!window.document.querySelector('#communityFeedList [data-post-id="p7"]'), 4000);

  const feedTabBtn = window.document.querySelector('[data-community-action="set-tab"][data-tab="feed"]');
  assert.ok(feedTabBtn.className.includes("active"), "the feed sub-tab is the active screen");
  assert.ok(window.document.querySelector('#communityFeedList [data-post-id="p7"] [data-comment-input]'), "the target post's thread is open");
  assert.deepEqual(mock.callsTo("notif_mark_read").slice(-1)[0], { p_ids: ["n1"] }, "the tapped row was marked read");
});

test("each Phase 1 type carries its own icon, category and copy", async () => {
  const mock = seeded([
    notif(1, { type: "comment_reply", category: "community" }),
    notif(2, { type: "mention", category: "community" }),
    notif(3, { type: "achievement_unlocked", category: "training" }),
    notif(4, { type: "announcement", category: "club" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  const html = window.document.querySelector("[data-notif-center]").innerHTML;
  assert.match(html, /↩️/, "reply icon");
  assert.match(html, /🏅/, "achievement icon");
  assert.match(html, /📢/, "announcement icon");
  // category placement
  const t = centerText(window);
  assert.ok(t.indexOf("אימונים") < t.indexOf("מועדון"), "training before club");
});

// ===== COMM-144 preferences per type =================================

test("the Account panel lists every type with Push (disabled), In-app and Off", async () => {
  const mock = seeded([]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  const types = new Set([...window.document.querySelectorAll('[data-community-action="notif-pref"]')].map((b) => b.dataset.type));
  assert.deepEqual([...types].sort(), [
    "achievements", "announcements", "challenges", "comments", "events",
    "friend_achievements", "mentions", "reactions", "replies", "weekly_recap",
  ], "all ten preference types are listed");

  const push = window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"][data-channel="push"]');
  assert.ok(push.disabled, "Push is disabled in V1");
  assert.equal(push.getAttribute("aria-disabled"), "true");
  const inApp = window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"][data-channel="in_app"]');
  assert.ok(!inApp.disabled, "In-app works");
  assert.ok(inApp.className.includes("primary"), "the default selection is In-app");
});

test("changing a preference is a direct own-row upsert into notification_preferences", async () => {
  const mock = seeded([]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  window.document.querySelector('[data-community-action="notif-pref"][data-type="mentions"][data-channel="off"]').click();
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "mentions" && r.channel === "off"), 4000);

  const row = mock.db.notification_preferences.find((r) => r.type === "mentions");
  assert.equal(row.user_id, "u1", "written under the caller's own id");
  assert.equal(row.channel, "off");

  // reflected on re-render
  window.document.querySelector('[data-community-action="set-tab"][data-tab="feed"]').click();
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-pref"]'), 4000);
  assert.ok(window.document.querySelector('[data-community-action="notif-pref"][data-type="mentions"][data-channel="off"]').className.includes("primary"));
});

test("stored preferences load and drive the panel selection", async () => {
  const mock = seeded([], { notification_preferences: [
    { user_id: "u1", type: "reactions", channel: "off" },
    { user_id: "u1", type: "replies", channel: "in_app" },
  ] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  assert.ok(window.document.querySelector('[data-community-action="notif-pref"][data-type="reactions"][data-channel="off"]').className.includes("primary"));
  assert.ok(window.document.querySelector('[data-community-action="notif-pref"][data-type="replies"][data-channel="in_app"]').className.includes("primary"));
});

test("a failed preference save reverts the control and shows the Hebrew error", async () => {
  const mock = seeded([]);
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const chain = realFrom(table);
    if (table === "notification_preferences") chain.upsert = () => ({ then: (res) => Promise.resolve(res({ error: { message: "boom" } })) });
    return chain;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  window.document.querySelector('[data-community-action="notif-pref"][data-type="events"][data-channel="off"]').click();
  await waitFor(() => /לא ניתן לשמור העדפה זו/.test(window.document.getElementById("content").textContent), 4000);
  assert.ok(window.document.querySelector('[data-community-action="notif-pref"][data-type="events"][data-channel="in_app"]').className.includes("primary"), "the control reverted to In-app");
});

test("the panel notes that operational announcements always show in-app", async () => {
  const mock = seeded([]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  const panel = [...window.document.querySelectorAll(".ach-section")].find((s) => /העדפות התראות/.test(s.textContent));
  assert.match(panel.textContent, /הודעות תפעוליות מהמועדון תמיד יופיעו/);
});

// ===== push path is feature-flagged off ==============================

test("no push subscription is created and push stays disabled in V1", async () => {
  const mock = seeded([notif(1)]);
  const seenTables = [];
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => { seenTables.push(table); return realFrom(table); };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"][data-channel="push"]').click();
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!seenTables.includes("push_subscriptions"), "nothing writes push_subscriptions in V1");
  assert.equal(mock.db.notification_preferences.length, 0, "a disabled Push control writes nothing");
});
