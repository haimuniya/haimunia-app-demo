// COMM-229, the client half of web push: subscription storage and the
// sw.js handlers, behind state.featureFlags.notifPush (localStorage-backed,
// same pattern as featureFlags.coachEngage - see community-coach-tools.test.mjs).
//
// WHAT THIS FILE VERIFIES
// - The flag stays off by default: Push renders "בקרוב"-disabled and no
//   browser Push API call happens, even when the browser would support it -
//   this is what "default off in production" actually means client-side.
// - With the flag on and the browser supporting push: choosing Push for a
//   type triggers Notification.requestPermission, then
//   pushManager.subscribe with the VAPID applicationServerKey, then a
//   push_subscriptions upsert, then the notification_preferences upsert -
//   in that order, and only once all of it succeeds.
// - Permission denied: the exact Hebrew copy, the stored preference is left
//   untouched (reads as In-app), nothing is written.
// - A device already subscribed does not re-prompt for a second type.
// - Unsupported browsers and iOS Safari without an installed PWA disable
//   the option with a real, visible Hebrew explanation, not a silent
//   failed prompt.
// - Revoking (explicit control, and detected on the next load after an
//   OS-level permission revoke) sets revoked_at - the row is never deleted.
// - sw.js's push and notificationclick handlers (source-level, the same
//   convention test/sw-precache.test.mjs uses - jsdom cannot execute a real
//   service worker).
// - Deep link resolution: window.communityHandlePushDeepLink (the
//   notificationclick/cold-start receiver) opens the exact target screen
//   and item, reusing resolveNotifTarget (COMM-143) - and app.js's own
//   serviceWorker "message" listener actually reaches it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    notifications: [],
    notification_preferences: [],
    push_subscriptions: [],
    follows: [], hidden_posts: [], saved_posts: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openAccount(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-pref"]'), 4000);
}

// A faithful-enough stand-in for the browser's Push API: one mutable
// subscription slot per stub, so a test can simulate "already subscribed"
// (seed opts.existingEndpoint) and "the browser dropped it" (setSub(null)).
function stubPushApis(window, opts = {}) {
  const calls = { requestPermission: 0, subscribe: 0, getSubscription: 0 };
  let sub = opts.existingEndpoint ? makeSub(opts.existingEndpoint) : null;
  function makeSub(endpoint) {
    return {
      endpoint,
      keys: { p256dh: "keyA", auth: "keyB" },
      toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
      unsubscribe: async () => { sub = null; return true; },
    };
  }
  const reg = {
    pushManager: {
      getSubscription: async () => { calls.getSubscription++; return sub; },
      subscribe: async (options) => {
        calls.subscribe++;
        calls.subscribeOptions = options;
        sub = makeSub(opts.newEndpoint || "https://push.example/ep-" + (calls.subscribe));
        return sub;
      },
    },
  };
  window.navigator.serviceWorker = Object.assign(window.navigator.serviceWorker || {}, { ready: Promise.resolve(reg) });
  window.PushManager = function () {};
  window.Notification = {
    permission: opts.permission || "default",
    requestPermission: async () => { calls.requestPermission++; return opts.deny ? "denied" : "granted"; },
  };
  return { calls, setSub: (s) => { sub = s; }, getSub: () => sub };
}

function stubIOSNonStandalone(window) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15",
    configurable: true,
  });
  Object.defineProperty(window.navigator, "standalone", { value: false, configurable: true });
}

// ===== the flag stays off by default ==================================

test("with the flag off (V1 default), Push stays disabled even on a browser that supports it, and no Push API call is ever made", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  stubPushApis(window);
  await openAccount(window);

  const push = window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"][data-channel="push"]');
  assert.ok(push.disabled, "Push is disabled while the flag is off");
  assert.match(window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"]').closest(".log-row").textContent, /בקרוב/);

  push.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mock.db.push_subscriptions.length, 0, "no subscription is written while the flag is off");
  assert.equal(mock.db.notification_preferences.length, 0, "no preference is written by a disabled control");
});

// ===== flag on, happy path =============================================

test("flag on: choosing Push asks permission, subscribes with the VAPID key, writes push_subscriptions, then the preference - in that order", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window);
  await openAccount(window);

  const btn = window.document.querySelector('[data-community-action="notif-pref"][data-type="mentions"][data-channel="push"]');
  assert.equal(btn.disabled, false, "Push is offered once the flag is on and the browser supports it");

  btn.click();
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);

  assert.equal(push.calls.requestPermission, 1, "the browser permission prompt was triggered");
  assert.equal(push.calls.subscribe, 1, "pushManager.subscribe was called");
  // instanceof would fail here even for a real Uint8Array: it was
  // constructed inside the jsdom window's own realm (a separate
  // Uint8Array constructor from this test file's Node-global one) - the
  // same cross-realm gap ArrayBuffer.isView() exists to paper over.
  assert.ok(ArrayBuffer.isView(push.calls.subscribeOptions.applicationServerKey), "the VAPID public key was passed as a byte array");
  assert.ok(push.calls.subscribeOptions.applicationServerKey.length === 65, "the decoded key is the uncompressed 65-byte EC point");

  const row = mock.db.push_subscriptions[0];
  assert.equal(row.user_id, "u1");
  assert.ok(row.endpoint);
  assert.deepEqual(row.keys, { p256dh: "keyA", auth: "keyB" });
  assert.equal(row.revoked_at, null, "a fresh subscription is not revoked");

  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "mentions" && r.channel === "push"), 4000);

  // Populated state: an active subscription shows "פעיל" next to the push option.
  await waitFor(() => /פעיל/.test(window.document.querySelector('[data-community-action="notif-pref"][data-type="mentions"]').closest(".log-row").textContent), 4000);
  // The device-level status/turn-off control appears once subscribed.
  assert.ok(window.document.querySelector('[data-community-action="notif-push-disable"]'), "a device-level turn-off control is offered");
});

test("permission denied: the exact Hebrew copy is shown, the toggle reverts to In-app, and nothing is written", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window, { deny: true });
  await openAccount(window);

  window.document.querySelector('[data-community-action="notif-pref"][data-type="events"][data-channel="push"]').click();
  await waitFor(() => /לא אושרה הרשאת התראות/.test(window.document.getElementById("content").textContent), 4000);

  assert.equal(push.calls.subscribe, 0, "subscribe is never called once permission is denied");
  assert.equal(mock.db.push_subscriptions.length, 0);
  assert.equal(mock.db.notification_preferences.length, 0, "the preference write never happens");
  assert.ok(window.document.querySelector('[data-community-action="notif-pref"][data-type="events"][data-channel="in_app"]').className.includes("selected"), "the control reads In-app, not Push");
});

test("a device that is already subscribed does not re-prompt when a second type also switches to push", async () => {
  const mock = seeded({ push_subscriptions: [{ id: "ps1", user_id: "u1", endpoint: "https://push.example/existing", keys: { p256dh: "a", auth: "b" }, revoked_at: null }] });
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window, { existingEndpoint: "https://push.example/existing" });
  await openAccount(window);

  // First switch loads this device's existing subscription status.
  window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"][data-channel="push"]').click();
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "comments" && r.channel === "push"), 4000);
  const promptsAfterFirst = push.calls.requestPermission;
  const subscribesAfterFirst = push.calls.subscribe;

  window.document.querySelector('[data-community-action="notif-pref"][data-type="reactions"][data-channel="push"]').click();
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "reactions" && r.channel === "push"), 4000);

  assert.equal(push.calls.requestPermission, promptsAfterFirst, "no new permission prompt for the second type");
  assert.equal(push.calls.subscribe, subscribesAfterFirst, "no new subscribe call for the second type");
  assert.equal(mock.db.push_subscriptions.length, 1, "still exactly one row for this device");
});

// ===== unsupported browsers and iOS ====================================

test("flag on, a browser with no Push API: the option is disabled with a real explanation, not בקרוב", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  // No stubPushApis() call: this browser has neither serviceWorker nor
  // PushManager nor Notification.
  await openAccount(window);

  const btn = window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"][data-channel="push"]');
  assert.ok(btn.disabled);
  const row = btn.closest(".log-row");
  assert.match(row.textContent, /לא תומך בהתראות דחיפה/);
  assert.doesNotMatch(row.textContent, /בקרוב/, "the flag-on reason replaces the flag-off placeholder copy");
});

test("flag on, iOS Safari without an installed PWA: the option is disabled with the install explanation, not a silent failed prompt", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  stubPushApis(window); // the browser APIs exist - iOS non-standalone is still blocked ahead of them
  stubIOSNonStandalone(window);
  await openAccount(window);

  const btn = window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"][data-channel="push"]');
  assert.ok(btn.disabled);
  assert.match(btn.closest(".log-row").textContent, /להוסיף את האפליקציה למסך הבית/);
});

// ===== revoke: never deletes the row ===================================

test("the explicit device control revokes: sets revoked_at, never deletes the row", async () => {
  const mock = seeded({ push_subscriptions: [{ id: "ps1", user_id: "u1", endpoint: "https://push.example/existing", keys: { p256dh: "a", auth: "b" }, revoked_at: null }] });
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  stubPushApis(window, { existingEndpoint: "https://push.example/existing" });
  await openAccount(window);

  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-push-disable"]'), 4000);
  window.document.querySelector('[data-community-action="notif-push-disable"]').click();

  await waitFor(() => mock.db.push_subscriptions[0].revoked_at, 4000);
  assert.equal(mock.db.push_subscriptions.length, 1, "the row is never deleted");
  assert.ok(mock.db.push_subscriptions[0].revoked_at, "revoked_at is set instead");
  assert.equal(window.document.querySelector('[data-community-action="notif-push-disable"]'), null, "the control disappears once there is no active subscription");
});

test("a permission revoked outside the app is detected on the next load and marks revoked_at, without deleting the row", async () => {
  const mock = seeded();
  mock.seedCredentials("u1", "dana@members.haimuniya.invalid", "correcthorse");
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window);
  await openAccount(window);

  window.document.querySelector('[data-community-action="notif-pref"][data-type="comments"][data-channel="push"]').click();
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);
  assert.equal(mock.db.push_subscriptions[0].revoked_at, null);

  // Simulate the OS/browser silently dropping the subscription (permission
  // revoked from outside the app) - the object the browser hands back is
  // just gone, the same way a real PushSubscription would be.
  push.setSub(null);

  // A full sign-out/sign-in cycle is what actually resets the lazy
  // notifPushChecked guard (the same guard the ordinary once-per-session
  // load uses) - there is no other externally-observable way to force a
  // recheck, which is itself consistent with "checked once per session".
  // (Re-triggers the exact same onAuthStateChange path
  // community-live-sync-and-auth.test.mjs uses for its own sign-out/back-in
  // cycle.)
  window.document.querySelector('[data-community-action="sign-out"]').click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 4000);
  await mock.client.auth.signInWithPassword({ email: "dana@members.haimuniya.invalid", password: "correcthorse" });
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-pref"]'), 4000);

  await waitFor(() => mock.db.push_subscriptions[0].revoked_at, 5000);
  assert.equal(mock.db.push_subscriptions.length, 1, "the row is never deleted, only marked");
});

// ===== sw.js source-level handlers (jsdom cannot run a real SW) =========

const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");

test("sw.js registers a push handler that renders the payload's title, body, and deep link", () => {
  const block = sw.slice(sw.indexOf('self.addEventListener("push"'), sw.indexOf('self.addEventListener("notificationclick"'));
  assert.match(block, /payload\.title/);
  assert.match(block, /payload\.body/);
  assert.match(block, /payload\.deep_link/);
  assert.match(block, /showNotification/);
  assert.match(block, /waitUntil/);
});

test("sw.js registers a notificationclick handler that focuses an open window or opens one at the deep link", () => {
  const block = sw.slice(sw.indexOf('self.addEventListener("notificationclick"'));
  assert.match(block, /clients\.matchAll/);
  assert.match(block, /\.focus\(\)/);
  assert.match(block, /clients\.openWindow/);
  assert.match(block, /deepLink/);
});

// ===== deep link resolution (COMM-143's mechanism, reused here) =======

test("window.communityHandlePushDeepLink opens the exact target screen and item, reusing resolveNotifTarget", async () => {
  const post = {
    id: "p7", post_type: "POST_TEXT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" }, body: "פוסט", visibility: "club",
    created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 1, media: [], metadata: {},
  };
  const mock = seeded({ feed_page_rows: [post] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabAddBtn").click(); // start off the community tab entirely

  window.communityHandlePushDeepLink("/community/feed?post=p7&comment=c3");
  await waitFor(() => !!window.document.querySelector('#communityFeedList [data-post-id="p7"]'), 4000);

  const communityBtn = window.document.getElementById("tabCommunityBtn");
  assert.ok(communityBtn.className.includes("active"), "the top-level Community tab was switched to");
  const feedTabBtn = window.document.querySelector('[data-community-action="set-tab"][data-tab="feed"]');
  assert.ok(feedTabBtn.className.includes("active"), "the feed sub-tab is active");
  assert.ok(window.document.querySelector('#communityFeedList [data-post-id="p7"] [data-comment-input]'), "the target post's thread is open");
});

test("a ?notif= cold start (sw.js's own-window fallback) is captured by app.js and consumed once the session is ready", async () => {
  const post = {
    id: "p9", post_type: "POST_TEXT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" }, body: "פוסט", visibility: "club",
    created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 0, media: [], metadata: {},
  };
  const mock = seeded({ feed_page_rows: [post] });
  const deepLink = encodeURIComponent("/community/feed?post=p9");
  const window = await bootCommunity(mock, {
    syncEnabled: false,
    url: "https://example.test/index.html?tab=community&notif=" + deepLink,
  });

  await waitFor(() => !!window.document.querySelector('#communityFeedList [data-post-id="p9"]'), 4000);
  // The query param is stripped so a reload can't re-fire it.
  assert.doesNotMatch(window.location.search, /notif=/);
});

test("app.js's own serviceWorker message listener reaches communityHandlePushDeepLink", async () => {
  const post = {
    id: "p11", post_type: "POST_TEXT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" }, body: "פוסט", visibility: "club",
    created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 0, media: [], metadata: {},
  };
  const mock = seeded({ feed_page_rows: [post] });
  const messageHandlers = [];
  const serviceWorkerStub = {
    register: () => Promise.resolve({ addEventListener() {}, waiting: null }),
    controller: null,
    addEventListener(type, cb) { if (type === "message") messageHandlers.push(cb); },
  };
  const window = await bootCommunity(mock, { syncEnabled: false, serviceWorkerStub });
  window.document.getElementById("tabAddBtn").click();

  assert.ok(messageHandlers.length > 0, "app.js registered its own serviceWorker message listener");
  for (const cb of messageHandlers) cb({ data: { type: "PUSH_NOTIFICATION_CLICK", deepLink: "/community/feed?post=p11" } });

  await waitFor(() => !!window.document.querySelector('#communityFeedList [data-post-id="p11"]'), 4000);
  assert.ok(window.document.getElementById("tabCommunityBtn").className.includes("active"));
});
