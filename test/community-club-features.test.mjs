// COMM-321, client half. Schema half (club_features, club_feature_enabled(),
// admin_set_club_feature(), the six gated RLS policies/feed_leaderboard
// gate) shipped in 202609010012_club_features.sql, verified by pgTAP
// (supabase/tests/0055_club_features_test.sql). This covers the resolver
// (isModuleEnabled()), the admin toggle panel, and the real UI gates that
// read it - real bootCommunity render/click paths against
// createMockSupabase({ club_features: [...] }), a normal table fixture,
// not source-text regex (the regex exception in this repo is Storage
// bucket/RLS SQL only, per COMM-318's own resolution note).
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const MODULE_KEYS = ["announcements", "events", "challenges", "achievements", "feed", "leaderboards"];
// A fresh set of row objects every call - tests must never share mutable
// fixture objects, since a registered onRpc() handler in one test can
// mutate ctx.db rows in place and a shared reference would leak that
// mutation into every other test using the same "constant".
function allModulesOn(disabledKey) {
  return MODULE_KEYS.map((module_key) => ({ club_id: "club-1", module_key, enabled: module_key !== disabledKey, config: {} }));
}

function seeded(extra, role) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: role === "admin", recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: role === "admin" ? "member" : (role || "member"), redeemed_at: VERIFIED }],
    club_features: allModulesOn(),
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openAccountTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
}

test("a plain member never sees the club modules panel", async () => {
  const window = await bootCommunity(seeded(null, "member"), { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  assert.ok(!window.document.querySelector('[data-club-feature]'), "no toggle row renders for a non-admin");
});

test("an admin sees one toggle row per module, all checked when every module is on", async () => {
  const window = await bootCommunity(seeded(null, "admin"), { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-club-feature="feed"]'), 3000);
  const rows = window.document.querySelectorAll('[data-club-feature]');
  assert.equal(rows.length, 6, "one row per v1 module");
  rows.forEach((el) => assert.equal(el.checked, true, `${el.dataset.clubFeature} starts checked`));
});

test("toggling a checkbox calls admin_set_club_feature and optimistically flips the row", async () => {
  const mock = seeded(null, "admin");
  let called = null;
  mock.onRpc("admin_set_club_feature", (args, ctx) => {
    called = args;
    const row = ctx.db.club_features.find((r) => r.module_key === args.p_module_key);
    if (row) row.enabled = args.p_enabled;
    return { data: null, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-club-feature="events"]'), 3000);

  const checkbox = window.document.querySelector('[data-club-feature="events"]');
  checkbox.checked = false;
  checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => called !== null, 3000);

  assert.deepEqual(called, { p_module_key: "events", p_enabled: false });
  assert.equal(window.document.querySelector('[data-club-feature="events"]').checked, false);
});

test("a failed toggle rolls back to the previous checked state", async () => {
  const mock = seeded(null, "admin");
  mock.onRpc("admin_set_club_feature", () => ({ data: null, error: { message: "not authorized" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-club-feature="feed"]'), 3000);

  const checkbox = window.document.querySelector('[data-club-feature="feed"]');
  checkbox.checked = false;
  checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => window.document.querySelector('[data-club-feature="feed"]').checked === true, 3000);
});

test("with challenges off, the boards tab shows no challenges section at all - not an empty list", async () => {
  const mock = seeded({ club_features: allModulesOn("challenges"), challenges: [{ id: "c1", title: "Test challenge", status: "active", challenge_type: "individual_target" }] }, "member");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.ok(!window.document.querySelector('[data-community-action="open-challenge-form"]'), "no create-challenge affordance");
  assert.ok(!window.document.body.textContent.includes("Test challenge"), "the seeded challenge never renders, module-off client gate matches the RLS gate");
});

test("achievements on: the account tab shows the my-achievements section shell even with an empty list; off: the whole section is gone", async () => {
  const onWindow = await bootCommunity(seeded(null, "member"), { syncEnabled: false });
  await openAccountTab(onWindow);
  await waitFor(() => !!onWindow.document.getElementById("communityProfile"), 3000);
  assert.ok(onWindow.document.body.textContent.includes("אין עדיין הישגים במועדון"), "module on: the empty-state shell renders, even with zero unlocks");

  const offMock = seeded({ club_features: allModulesOn("achievements") }, "member");
  const offWindow = await bootCommunity(offMock, { syncEnabled: false });
  await openAccountTab(offWindow);
  await waitFor(() => !!offWindow.document.getElementById("communityProfile"), 3000);
  assert.ok(!offWindow.document.body.textContent.includes("אין עדיין הישגים במועדון"), "module off: no section at all, not an empty one");
});

test("club feature state resets on sign-out so the next member's fresh load isn't polluted", async () => {
  const window = await bootCommunity(seeded(null, "admin"), { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-club-feature]'), 3000);
  window.document.querySelector('[data-community-action="sign-out"]').click();
  await waitFor(() => !window.document.querySelector('[data-club-feature]'), 3000);
});
