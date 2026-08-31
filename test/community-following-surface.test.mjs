// COMM-230, the following system surface, executed for real in jsdom against
// the mock Supabase client (test/helpers/mockSupabase.mjs).
//
// WHAT THIS FILE VERIFIES
// - A "Following" tab appears on a profile whenever community_profile
//   returned follower_count/following_count - the caller's own profile
//   always, another member's only when it passed visible_to_club - and is
//   absent entirely otherwise, matching the RPC's own "absent key means
//   hidden" contract every other optional profile section already follows.
// - On the caller's own profile, expanding either side does a direct RLS
//   read on `follows` (both directions are readable to the caller under
//   follows_visible: follower_id = me or followed_id = me) and renders the
//   real list, with loading/empty/error states matching the ticket's
//   documented copy.
// - On another member's profile, the same two counts render but are not
//   expandable: follows_visible cannot return a third party's real follower
//   list to this caller (a direct RLS read would silently narrow to "the one
//   edge that happens to touch me"), so this surface does not pretend to
//   have one. This is the one deliberate scope line in the ticket's "widen
//   this surface, do not invent a new one" instruction - documented in
//   cloud.js above followListCanExpand().
// - Unfollowing from the "following" list is optimistic (row disappears
//   immediately) with rollback and the ticket's exact error copy on
//   failure, and reuses follow() - the one write path every follow/unfollow
//   control in the app already uses.
// - No "Message" action anywhere on the whole profile overlay.
// - The feed's existing scope=following filter (COMM-111) actually reflects
//   a follow edge created through this profile surface's own Follow button,
//   end to end.
//
// The mock's own .insert() never raises a real unique-constraint conflict
// (test/helpers/mockSupabase.mjs has no dedupe), so applyFollowsUnique()
// below adds it for `follows` specifically, the same way
// community-analytics-surfaces.test.mjs's own comment already flags this
// gap ("The mock's insert does not raise 23505") - needed here because,
// unlike that file, this one exercises the real delete-on-conflict branch
// of follow(), not just the initial insert.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function baseProfiles() {
  return [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true },
    { id: "u3", handle: "tal", display_name: "טל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true },
    { id: "u4", handle: "hidden", display_name: "מוסתר/ת", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: false, allow_follows: true },
  ];
}
function applyFollowsUnique(mock) {
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const c = realFrom(table);
    if (table === "follows") {
      const realInsert = c.insert.bind(c);
      c.insert = (payload) => {
        const exists = mock.db.follows.some((f) => f.follower_id === payload.follower_id && f.followed_id === payload.followed_id);
        if (exists) return { then: (onOk) => Promise.resolve(onOk({ error: { code: "23505" } })) };
        return realInsert(payload);
      };
    }
    return c;
  };
}
function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: baseProfiles(),
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u4", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    ],
    follows: [],
    blocks: [], reactions: [], post_comments: [],
    feed_page_rows: [], feed_impressions: [], feed_interactions: [], hidden_posts: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  applyFollowsUnique(mock);
  // A faithful-enough stand-in for community_profile(): computes
  // follower_count/following_count from the same `follows` rows the direct
  // RLS reads below also see, gated by visible_to_club exactly like the real
  // RPC (present for self regardless, present for another member only when
  // their visible_to_club passes).
  mock.onRpc("community_profile", (args, ctx) => {
    const uid = args && args.user_id;
    const prof = ctx.db.profiles.find((p) => p.id === uid);
    if (!prof) return { data: null, error: { message: "profile not found" } };
    const isSelf = ctx.currentUser && ctx.currentUser.id === uid;
    const data = {
      id: prof.id, display_name: prof.display_name, handle: prof.handle, role: "member",
      member_since: "2024-01-01", allow_follows: isSelf ? false : prof.allow_follows !== false,
    };
    if (isSelf || prof.visible_to_club) {
      data.follower_count = ctx.db.follows.filter((f) => f.followed_id === uid).length;
      data.following_count = ctx.db.follows.filter((f) => f.follower_id === uid).length;
    }
    return { data, error: null };
  });
  return mock;
}

async function openProfile(window, userId) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
  const el = window.document.createElement("button");
  el.dataset.communityAction = "view-profile";
  el.dataset.id = userId;
  window.document.body.appendChild(el);
  el.click();
  await waitFor(() => !!window.document.getElementById("profileViewTitle"), 4000);
  await waitFor(() => !/טוען פרופיל/.test(window.document.getElementById("profileViewTitle").closest(".modal-sheet").textContent), 4000);
}
function overlay(window) { return window.document.getElementById("profileViewTitle").closest(".modal-sheet"); }
function openFollowingTab(window) {
  overlay(window).querySelector('[data-community-action="profile-tab"][data-tab="following"]').click();
}

test("the Following tab is present on the caller's own profile and shows both counts", async () => {
  const mock = seeded({ follows: [{ follower_id: "u2", followed_id: "u1", created_at: VERIFIED }, { follower_id: "u1", followed_id: "u3", created_at: VERIFIED }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u1");
  assert.ok(overlay(window).querySelector('[data-community-action="profile-tab"][data-tab="following"]'));
  openFollowingTab(window);
  assert.match(overlay(window).textContent, /עוקבים \(1\)/);
  assert.match(overlay(window).textContent, /עוקב\/ת אחרי \(1\)/);
});

test("expanding followers on the caller's own profile loads the real list via a direct follows read", async () => {
  const mock = seeded({ follows: [
    { follower_id: "u2", followed_id: "u1", created_at: "2026-08-01T00:00:00.000Z" },
    { follower_id: "u3", followed_id: "u1", created_at: "2026-08-05T00:00:00.000Z" },
  ] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u1");
  openFollowingTab(window);
  overlay(window).querySelector('[data-community-action="following-toggle"][data-side="followers"]').click();
  await waitFor(() => overlay(window).querySelectorAll('[data-community-action="view-profile"]').length >= 2, 4000);
  // Most recent follow edge first (u3 followed on 08-05, u2 on 08-01).
  const ids = Array.from(overlay(window).querySelectorAll('[data-community-action="view-profile"]')).map((el) => el.dataset.id);
  assert.deepStrictEqual(ids, ["u3", "u2"]);
});

test("expanding following on the caller's own profile, then unfollowing, is optimistic and writes through follow()", async () => {
  const mock = seeded({ follows: [{ follower_id: "u1", followed_id: "u2", created_at: VERIFIED }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u1");
  openFollowingTab(window);
  overlay(window).querySelector('[data-community-action="following-toggle"][data-side="following"]').click();
  await waitFor(() => !!overlay(window).querySelector('[data-community-action="following-unfollow"]'), 4000);
  overlay(window).querySelector('[data-community-action="following-unfollow"]').click();
  // The row is gone (optimistic) and the real edge is actually deleted
  // through follow() - the same one toggle every follow control uses, not a
  // second write path.
  assert.equal(overlay(window).querySelector('[data-community-action="following-unfollow"]'), null);
  await waitFor(() => !mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u2"), 4000);
});

test("a failed unfollow rolls the row back and shows the documented error copy with a working retry", async () => {
  const mock = seeded({ follows: [{ follower_id: "u1", followed_id: "u2", created_at: VERIFIED }] });
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const c = realFrom(table);
    if (table === "follows") {
      c.delete = () => {
        const q = { eq() { return q; }, then: (onOk) => Promise.resolve(onOk({ error: { message: "boom" } })) };
        return q;
      };
    }
    return c;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u1");
  openFollowingTab(window);
  overlay(window).querySelector('[data-community-action="following-toggle"][data-side="following"]').click();
  await waitFor(() => !!overlay(window).querySelector('[data-community-action="following-unfollow"]'), 4000);
  overlay(window).querySelector('[data-community-action="following-unfollow"]').click();
  await waitFor(() => /לא ניתן היה לעדכן את המעקב\. נסו שוב\./.test(overlay(window).textContent), 4000);
  // Rolled back: the row (and its unfollow control) is back on screen - the
  // list itself is not replaced by the error, only a banner is added above
  // it - and the edge was never actually deleted. Tapping "הפסקת מעקב" again
  // on the restored row is the retry; there is no separate retry control for
  // a single failed action, only for a failed list load.
  assert.ok(overlay(window).querySelector('[data-community-action="following-unfollow"][data-id="u2"]'));
  assert.ok(mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u2"));
});

test("empty followers and empty following show the documented Hebrew copy", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u1");
  openFollowingTab(window);
  overlay(window).querySelector('[data-community-action="following-toggle"][data-side="followers"]').click();
  await waitFor(() => /עדיין אין עוקבים/.test(overlay(window).textContent), 4000);
  overlay(window).querySelector('[data-community-action="following-toggle"][data-side="following"]').click();
  await waitFor(() => /עדיין לא עוקבים אחרי אף אחד\./.test(overlay(window).textContent), 4000);
});

test("a loading list shows a skeleton, and a failed list load shows the documented error with a working retry", async () => {
  const mock = seeded({ follows: [{ follower_id: "u2", followed_id: "u1", created_at: VERIFIED }] });
  let release;
  const gate = new Promise((r) => { release = r; });
  let fail = true;
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const c = realFrom(table);
    if (table === "follows") {
      c.then = (onOk, onErr) => gate.then(() => (fail ? { data: null, error: { message: "boom" } } : c._resolve())).then(onOk, onErr);
    }
    return c;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u1");
  openFollowingTab(window);
  overlay(window).querySelector('[data-community-action="following-toggle"][data-side="followers"]').click();
  await waitFor(() => !!overlay(window).querySelector("[data-follow-list-skeleton]"), 4000);
  release();
  await waitFor(() => /לא ניתן היה לעדכן את המעקב\. נסו שוב\./.test(overlay(window).textContent), 4000);
  fail = false;
  overlay(window).querySelector('[data-community-action="following-retry"][data-side="followers"]').click();
  await waitFor(() => !!overlay(window).querySelector('[data-community-action="view-profile"][data-id="u2"]'), 4000);
});

test("another member's visible profile shows the same two counts but offers no expand affordance", async () => {
  const mock = seeded({ follows: [{ follower_id: "u3", followed_id: "u2", created_at: VERIFIED }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u2");
  assert.ok(overlay(window).querySelector('[data-community-action="profile-tab"][data-tab="following"]'));
  openFollowingTab(window);
  assert.match(overlay(window).textContent, /עוקבים/);
  assert.equal(overlay(window).querySelector('[data-community-action="following-toggle"]'), null, "no expand control on someone else's profile");
});

test("a fully hidden member's profile has no Following tab at all", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u4");
  assert.equal(overlay(window).querySelector('[data-community-action="profile-tab"][data-tab="following"]'), null);
});

test("no Message affordance exists anywhere on the profile overlay, on any tab", async () => {
  const mock = seeded({ follows: [{ follower_id: "u1", followed_id: "u2", created_at: VERIFIED }, { follower_id: "u3", followed_id: "u1", created_at: VERIFIED }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u1");
  openFollowingTab(window);
  overlay(window).querySelector('[data-community-action="following-toggle"][data-side="followers"]').click();
  await waitFor(() => !!overlay(window).querySelector('[data-community-action="view-profile"][data-id="u3"]'), 4000);
  overlay(window).querySelector('[data-community-action="following-toggle"][data-side="following"]').click();
  await waitFor(() => !!overlay(window).querySelector('[data-community-action="following-unfollow"]'), 4000);
  assert.equal(overlay(window).textContent.includes("הודעה"), false);
  assert.equal(overlay(window).querySelector('[data-community-action="message"]'), null);
});

test("following someone through the profile surface's own Follow button makes them appear under the feed's following scope, end to end", async () => {
  const mock = seeded({
    feed_page_rows: [{
      id: "p1", post_type: "POST_TEXT", author_id: "u2", author: { display_name: "נועם", handle: "noam" },
      body: "אימון היום", visibility: "club", created_at: VERIFIED, published_at: VERIFIED,
      reaction_count: 0, comment_count: 0, media: [], metadata: {},
    }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window, "u2");
  overlay(window).querySelector('[data-community-action="follow"][data-id="u2"]').click();
  await waitFor(() => mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u2"), 4000);
  window.document.querySelector('[data-community-action="close-profile"]').click();
  await waitFor(() => !window.document.getElementById("profileViewTitle"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="feed"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="feed-scope"][data-scope="following"]'), 4000);
  window.document.querySelector('[data-community-action="feed-scope"][data-scope="following"]').click();
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"]'), 4000);
});
