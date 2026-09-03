// COMM-362. Auth coverage was otherwise strong (anonymous bootstrap,
// credential upgrade, sign-out/sign-in, realtime teardown/reconnect from a
// dropped socket) but nothing simulated a Supabase JWT actually expiring or
// a refresh-token failure mid-session - a plausible scenario for a gym-use
// PWA that spends most of its life backgrounded on a phone.
//
// Two real code paths, matching this ticket's own two acceptance criteria:
//
// 1. Sync/write path - a write's RPC call itself comes back with the
//    401/"JWT expired" shape a real expired-and-unrefreshable access token
//    produces. publishComposer() already has explicit error handling
//    (cloud.js, `if (error || !data)`), so the assertion here is that this
//    specific 401 shape flows through that same branch rather than being
//    swallowed - the post must not be silently dropped.
//
// 2. Realtime-subscribe path - gotrue-js fires the exact same SIGNED_OUT
//    event both when a caller calls signOut() and when its own background
//    access-token refresh fails outright (expired/revoked refresh token,
//    the case an app backgrounded past its refresh window hits). cloud.js's
//    onAuthStateChange handler (the same one every existing sign-out test
//    already exercises via the UI button) makes no distinction between the
//    two triggers, by design - see mockSupabase.mjs's expireSession(),
//    added for this ticket, which fires that event without going through
//    signOut() so a reader does not mistake this for a user action. The
//    assertion is that a session dying out from under the app, mid-session,
//    still closes every open realtime channel (the "own-row notifications"
//    channel COMM-141 arms) and drops the app back to a clear signed-out
//    gate, not a half-alive state with dead subscriptions and stale UI.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openComposer(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="open-composer"]').click();
  await waitFor(() => !!window.document.getElementById("postComposer"), 3000);
}

function typeBody(window, text) {
  const ta = window.document.querySelector("[data-composer-body]");
  ta.value = text;
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  return ta;
}

test("sync path: a write RPC failing with an expired-JWT 401 keeps the composer open with a retryable error, never a silently dropped post", async () => {
  const mock = seeded();
  mock.onRpc("post_create", () => ({ data: null, error: { message: "JWT expired", status: 401 } }));

  const window = await bootCommunity(mock, { syncEnabled: false });
  await openComposer(window);
  typeBody(window, "אימון של הבוקר");
  window.document.querySelector('[data-community-action="composer-publish"]').click();

  await waitFor(() => /פרסום הפוסט נכשל/.test(window.document.getElementById("postComposer").textContent), 3000);
  assert.ok(window.document.getElementById("postComposer"), "the composer must stay open for a retry, not disappear as if it had succeeded");
  assert.equal((mock.db.workout_posts || []).length, 0, "no post must have actually been created against the expired-session error");
  // The app itself must not have crashed handling the failure - the rest
  // of the Community surface (feed/subtabbar) is still there underneath.
  assert.ok(window.document.querySelector(".subtabbar"), "the app keeps rendering normally after the failed write, not a blank/broken screen");
});

test("realtime-subscribe path: a session that dies mid-session (refresh failure, not a user sign-out) tears down every open channel and drops back to the signed-out gate", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: true });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);

  // COMM-141's own-row notification channel arms once community data has
  // loaded for a verified member - confirms this test reached a genuinely
  // "live" session with an open realtime subscription before killing it.
  await waitFor(() => mock.openChannels().includes("notif-u1"), 3000);
  assert.ok(mock.openChannels().includes("notif-u1"), "sanity check: a real channel must be open before the expiry, or teardown below proves nothing");

  mock.expireSession();

  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);
  assert.deepEqual(mock.openChannels(), [], "every realtime channel must close when the session dies, not just on an explicit sign-out click");
  assert.equal(window.document.querySelector(".subtabbar"), null, "the main app must not still be showing as if the session were live");
  assert.ok(window.document.getElementById("communityLogin"), "the app must degrade to a clear signed-out gate, not a half-alive state with a dead session");
});
