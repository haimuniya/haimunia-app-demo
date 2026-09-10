// Fresh-eyes audit: the one always-visible header control (every screen,
// not just Community) was wired only to the offline "what's new" release
// notes. A member could have unread reactions/comments/achievement
// notifications sitting behind the Community tab's own small bell chip and
// never see any signal for it anywhere else. Real community notifications
// now take priority on the header; release notes moved into Settings as
// their own permanent row. This file covers both halves of that fix: the
// cloud.js bridge (window.communityUnreadCount / window.openCommunityNotifCenter)
// and app.js's header routing (updateNotificationsBadge / openHeaderNotifications),
// plus that Settings' own "מה חדש" row is unaffected by social unread state.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp, bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function baseSeed(extra) {
  return Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  }, extra || {});
}

test("no community configured: header badge falls back to release notes, no bridge functions exist", async () => {
  const window = await bootApp();
  assert.equal(typeof window.communityUnreadCount, "undefined", "cloud.js never loaded in this boot");
  // Must not throw with the bridge absent.
  window.updateNotificationsBadge();
  const badge = window.document.getElementById("notificationsBadge");
  assert.ok(badge, "badge element exists regardless of community state");
});

test("signed into community with unread notifications: header badge shows the social count and aria-label names it", async () => {
  const mock = createMockSupabase(baseSeed({
    notifications: [
      { id: "n1", user_id: "u1", type: "reaction", read_at: null, created_at: VERIFIED },
      { id: "n2", user_id: "u1", type: "comment", read_at: null, created_at: VERIFIED },
    ],
  }));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => window.communityUnreadCount && window.communityUnreadCount() === 2, 3000);

  window.updateNotificationsBadge();
  const badge = window.document.getElementById("notificationsBadge");
  assert.equal(badge.style.display, "flex");
  assert.equal(badge.textContent, "2");
  const btn = window.document.getElementById("notificationsBellBtn");
  assert.match(btn.getAttribute("aria-label"), /2 חדשות/);
});

test("tapping the header bell with unread community notifications opens the notification center, not the changelog", async () => {
  const mock = createMockSupabase(baseSeed({
    notifications: [{ id: "n1", user_id: "u1", type: "reaction", read_at: null, created_at: VERIFIED }],
  }));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => window.communityUnreadCount && window.communityUnreadCount() === 1, 3000);

  window.document.getElementById("notificationsBellBtn").click();
  await waitFor(() => !!window.document.querySelector("[data-notif-center]"), 3000);
  assert.ok(window.document.querySelector("[data-notif-center]"), "the real notification center opened");
  // The offline release-notes overlay must specifically NOT be the one that opened.
  assert.equal(window.document.getElementById("notificationsOverlay").classList.contains("open"), false,
    "the changelog overlay must not open when there is real community unread");
});

test("no unread community notifications: header bell falls back to the offline release-notes overlay", async () => {
  const mock = createMockSupabase(baseSeed({ notifications: [] }));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => typeof window.communityUnreadCount === "function" && window.communityUnreadCount() === 0, 3000);

  window.document.getElementById("notificationsBellBtn").click();
  assert.equal(window.document.getElementById("notificationsOverlay").classList.contains("open"), true,
    "with nothing unread in Community, the header bell still serves release notes");
});

test("Settings' own 'מה חדש' row always opens release notes, even with unread community notifications pending", async () => {
  const mock = createMockSupabase(baseSeed({
    notifications: [{ id: "n1", user_id: "u1", type: "reaction", read_at: null, created_at: VERIFIED }],
  }));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => window.communityUnreadCount && window.communityUnreadCount() === 1, 3000);

  window.document.getElementById("navMenuBtn").click();
  window.document.querySelector("[data-action='open-settings']").click();
  const row = window.document.querySelector("[data-action='open-release-notes']");
  assert.ok(row, "Settings renders a dedicated release-notes row");
  row.click();
  assert.equal(window.document.getElementById("notificationsOverlay").classList.contains("open"), true,
    "Settings' changelog row must always mean release notes, never Community's notification center");
});
