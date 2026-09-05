// Executing tests for cloud.js, not just source-text regex matches - an
// independent architecture review flagged directly that every prior
// cloud.js test could prove a string exists in the source but not that
// the code actually runs correctly, and that this exact gap is why the
// refreshSession()-doesn't-flush-before-pulling regression (fixed in
// Submission 1, see community-sync-ordering.test.mjs) could ship
// undetected. bootCommunity() (test/helpers/boot.mjs) boots cloud.js
// alongside the real app.js in jsdom, wired to a mock Supabase client
// (test/helpers/mockSupabase.mjs) instead of a real project, so this
// file exercises the real state machine: real IndexedDB, real render
// gates, real async auth handlers.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

test("a queued local edit reaches the mock server before a stale remote copy would be pulled back - the exact scenario the sync-ordering bug corrupted", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: new Date().toISOString() }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });

  const window = await bootCommunity(mock, { syncEnabled: true });
  window.document.getElementById("tabCommunityBtn").click();
  // Confirms the initial load (real refreshSession(), triggered
  // automatically the moment cloud.js boots with an existing session)
  // correctly reached the main app - i.e. redemption/profile loaded.
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);

  // Simulate: this device queued a real edit (weight 999) while the
  // "server" still only has an older, stale copy (weight 1).
  mock.seedCredentials("u1", "dana@members.haimuniya.invalid", "correcthorse");
  mock.db.private_records = [{ user_id: "u1", record_type: "strength_entry", record_id: "e1", payload: { id: "e1", exerciseId: "back-squat", weight: 1, reps: 5, sets: 1, date: "2026-01-01", type: "reps" }, deleted_at: null, updated_at: "2020-01-01T00:00:00.000Z" }];
  await window.queueSyncRecord("strength_entry", { id: "e1", exerciseId: "back-squat", weight: 999, reps: 5, sets: 1, date: "2026-01-01", type: "reps" });

  // Re-triggers the exact same onAuthStateChange flush-then-pull chain
  // refreshSession() also runs on every normal app reopen.
  await mock.client.auth.signInWithPassword({ email: "dana@members.haimuniya.invalid", password: "correcthorse" });

  await waitFor(() => {
    const row = mock.db.private_records.find((r) => r.record_id === "e1");
    return !!row && row.payload.weight === 999;
  }, 3000);
  const row = mock.db.private_records.find((r) => r.record_id === "e1");
  assert.equal(row.payload.weight, 999, "the queued local edit must have reached the mock server - if flush ran after pull instead of before, this would still read the stale seeded value");
});

test("full signup lifecycle executes for real: bootstrap -> redeem code -> set credentials -> profile -> main app -> sign out -> log back in reaches the same account", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);

  window.document.querySelector('[data-community-action="start-signup"]').click();
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);

  window.document.querySelector('#communityInviteCode input[name="code"]').value = "CLUBCODE";
  window.document.getElementById("communityInviteCode").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 3000);

  window.document.querySelector('#communityCredentials input[name="username"]').value = "dana";
  window.document.querySelector('#communityCredentials input[name="password"]').value = "correcthorse";
  window.document.querySelector('#communityCredentials input[name="passwordConfirm"]').value = "correcthorse";
  window.document.getElementById("communityCredentials").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);

  window.document.querySelector('#communityProfile input[name="handle"]').value = "dana";
  window.document.getElementById("communityProfile").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);

  assert.ok(mock.db.profiles.find((p) => p.handle === "dana"), "the profile must actually exist server-side after the real saveProfile() ran");
  assert.equal(mock.getUser().is_anonymous, false, "the account must be permanent (not anonymous) after setCredentials()");

  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  window.document.querySelector('[data-community-action="sign-out"]').click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);

  // A "different device" logging in with the same credentials - the
  // thing plain anonymous-only sign-in structurally could not do.
  window.document.querySelector('#communityLogin input[name="username"]').value = "dana";
  window.document.querySelector('#communityLogin input[name="password"]').value = "correcthorse";
  window.document.getElementById("communityLogin").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  // Only the pre-auth gates render without a subtabbar - the main app
  // (any sub-tab, including Account, which happens to reuse the
  // communityProfile form id for its own profile-edit form) always has
  // one, so this alone distinguishes "reached the app" from "stuck on
  // a gate" without being tripped up by that id reuse.
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);

  assert.equal(window.document.getElementById("communityInviteCode"), null, "a returning member must not be asked to redeem the invite code again");
  assert.equal(window.document.getElementById("communityCredentials"), null, "a returning member must not be asked to set credentials again");
  // The Account tab's own profile-edit form legitimately reuses the
  // communityProfile id, so presence alone doesn't distinguish it from
  // the completion gate - the pre-filled handle does, since only the
  // real account-tab edit form pre-fills it from the saved profile.
  const handleField = window.document.querySelector('#communityProfile input[name="handle"]');
  assert.equal(handleField && handleField.value, "dana", "landed on the account tab's profile editor pre-filled with the saved handle, not an empty completion-gate form");
});

test("an admin can search for a member and grant coach, executing for real through the confirm dialog", async () => {
  const mock = createMockSupabase({
    profiles: [
      { id: "admin-1", handle: "coach_admin", display_name: "מנהל", is_admin: true, recovery_verified_at: new Date().toISOString() },
      { id: "member-1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: new Date().toISOString() },
    ],
    invite_redemptions: [
      { user_id: "admin-1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() },
      { user_id: "member-1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() },
    ],
  });
  mock.setUser({ id: "admin-1", is_anonymous: false, email: "coach_admin@members.haimuniya.invalid" });
  mock.onRpc("admin_search_members", (args, ctx) => ({
    data: ctx.db.profiles
      .filter((p) => p.id === args.p_query || p.handle.includes(args.p_query))
      .map((p) => {
        const ir = ctx.db.invite_redemptions.find((r) => r.user_id === p.id);
        return { id: p.id, handle: p.handle, display_name: p.display_name, is_admin: p.is_admin, role: ir && ir.role, redeemed_at: ir && ir.redeemed_at, last_activity_on: null };
      }),
    error: null,
  }));
  mock.onRpc("admin_grant_coach", (args, ctx) => {
    const row = ctx.db.invite_redemptions.find((r) => r.user_id === args.p_user_id);
    if (row) row.role = "coach";
    return { data: null, error: null };
  });

  const window = await bootCommunity(mock, { syncEnabled: false });
  // Redesign, Phase 1: renderMemberManagement() moved from Community's
  // "account" sub-tab to the Manage tab's own "members" sub-tab.
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="members"]').click();

  const search = window.document.getElementById("adminMemberSearch");
  search.value = "dana";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => !!window.document.querySelector('[data-community-action="admin-grant-coach"]'), 3000);

  window.document.querySelector('[data-community-action="admin-grant-coach"]').click();
  await waitFor(() => !!window.document.getElementById("communityConfirmTitle"), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();

  await waitFor(() => {
    const row = mock.db.invite_redemptions.find((r) => r.user_id === "member-1");
    return !!row && row.role === "coach";
  }, 3000);
  assert.equal(mock.db.invite_redemptions.find((r) => r.user_id === "member-1").role, "coach", "the real admin_grant_coach RPC must have actually run, server-side role changed from the confirm click");
});
