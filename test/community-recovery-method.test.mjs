// COMM-016 - required recovery method at invite redemption.
//
// Executing tests (bootCommunity + mock Supabase), not source-text
// matches: they drive the real gate cascade in renderCommunityApp() and
// the real verifyRecovery()/setCredentials()/saveProfile() paths.
//
// The decision locked 2026-08-28 is "recoverable and required": a member
// cannot contribute to the community until profiles.recovery_verified_at
// is stamped, and mark_recovery_verified() is the only client-reachable
// way to set it. The mock mirrors the real precondition - it stamps only
// when the current user has a credential pair on file.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

function submit(window, id) {
  window.document.getElementById(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

test("full signup stamps recovery_verified_at and lands the member in the community, no gate shown", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);

  window.document.querySelector('[data-community-action="start-signup"]').click();
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);
  window.document.querySelector('#communityInviteCode input[name="code"]').value = "CLUBCODE";
  submit(window, "communityInviteCode");
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 3000);

  window.document.querySelector('#communityCredentials input[name="username"]').value = "dana";
  window.document.querySelector('#communityCredentials input[name="password"]').value = "correcthorse";
  window.document.querySelector('#communityCredentials input[name="passwordConfirm"]').value = "correcthorse";
  submit(window, "communityCredentials");
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);

  window.document.querySelector('#communityProfile input[name="handle"]').value = "dana";
  submit(window, "communityProfile");
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);

  const prof = mock.db.profiles.find((p) => p.handle === "dana");
  assert.ok(prof, "profile row created");
  assert.ok(prof.recovery_verified_at, "mark_recovery_verified() ran after the profile insert, so the column is populated");
  assert.equal(window.document.querySelector('[data-community-action="verify-recovery"]'), null, "the recovery gate is not shown once the method is verified");
});

test("a member whose profile is still unverified sees the Hebrew recovery gate, then the auto verify call unlocks the app", async () => {
  // An existing anonymous account after the Phase 0 migration: redemption
  // and profile already exist, recovery_verified_at is null, and the
  // member has just set credentials (so is_anonymous is false).
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: null }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.seedCredentials("u1", "dana@members.haimuniya.invalid", "correcthorse");

  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();

  // The gate renders first (recovery_verified_at null), and its own
  // verifyRecovery() call then stamps the column and re-renders into the
  // unlocked app.
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.ok(mock.db.profiles[0].recovery_verified_at, "the gate's verifyRecovery() call stamped the column");
});

test("a failed verification keeps the gate, shows a retry message, and does not consume the invite", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: null }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  let failNext = true;
  mock.onRpc("mark_recovery_verified", (_args, ctx) => {
    if (failNext) return { data: null, error: { message: "recovery method not verified" } };
    const prof = ctx.db.profiles.find((p) => p.id === ctx.currentUser.id);
    prof.recovery_verified_at = new Date().toISOString();
    return { data: prof.recovery_verified_at, error: null };
  });

  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();

  await waitFor(() => /אימות החשבון נכשל/.test(window.document.getElementById("content").textContent), 3000);
  assert.ok(window.document.querySelector('[data-community-action="verify-recovery"]'), "still on the gate after a failed auto-verify");
  const gateText = window.document.getElementById("content").textContent;
  assert.match(gateText, /אבטחת החשבון/, "gate heading in Hebrew");
  assert.match(gateText, /חשבון שאפשר לשחזר/, "gate explains why the recovery method is required");
  assert.match(gateText, /עד להשלמת האימות אפשר לצפות בקהילה בלבד/, "gate states the read-only-until-verified rule");
  assert.equal(mock.db.profiles[0].recovery_verified_at, null, "column still unstamped");
  assert.equal(mock.db.invite_redemptions.length, 1, "the invite redemption is untouched by a verification failure");

  // The visible retry button forces another attempt; this time it works.
  failNext = false;
  window.document.querySelector('[data-community-action="verify-recovery"]').click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.ok(mock.db.profiles[0].recovery_verified_at, "manual retry stamped the column and unlocked the app");
});

test("recovery on a new device: signing in with the same credentials reaches the same profile, redemption and coach role, no recovery prompt", async () => {
  // Site-data deletion / reinstall / device change all reduce to the same
  // thing for this app: no local session, sign in with the same
  // username+password. The account is already verified (backfilled or
  // stamped on the original device), so the member lands straight in.
  const mock = createMockSupabase({
    profiles: [{ id: "coach-9", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: "2026-08-01T00:00:00.000Z" }],
    invite_redemptions: [{ user_id: "coach-9", invite_id: "inv-1", role: "coach", redeemed_at: "2026-08-01T00:00:00.000Z" }],
  });
  mock.seedCredentials("coach-9", "yael@members.haimuniya.invalid", "correcthorse");

  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);

  window.document.querySelector('#communityLogin input[name="username"]').value = "yael";
  window.document.querySelector('#communityLogin input[name="password"]').value = "correcthorse";
  submit(window, "communityLogin");

  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.equal(window.document.querySelector('[data-community-action="verify-recovery"]'), null, "a verified returning member is never asked to re-verify");
  assert.equal(window.document.getElementById("communityInviteCode"), null, "and is never asked to redeem the invite again");
  // Coach powers restored: the staff-only weekly-challenge setter renders.
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.getElementById("communityWeeklyChallenge"), 3000);
});

test("an existing username+password account with a backfilled timestamp is not forced to re-verify", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: "2026-07-01T00:00:00.000Z" }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: "2026-07-01T00:00:00.000Z" }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  let verifyCalls = 0;
  mock.onRpc("mark_recovery_verified", () => { verifyCalls++; return { data: "2026-07-01T00:00:00.000Z", error: null }; });

  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.equal(verifyCalls, 0, "no verify RPC fired for an already-verified account");
});
