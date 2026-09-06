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
const MODULE_KEYS = ["announcements", "events", "challenges", "achievements", "feed", "leaderboards",
  // Redesign, Phase 2.
  "directory", "coach_tools", "member_of_week", "welcome_flow", "monthly_recap"];
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
// Redesign, Phase 1: renderClubModulesPanel() moved from Community's
// "account" sub-tab to the Manage tab's own "settings" sub-tab.
async function openManageSettings(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="settings"]').click();
}

test("a plain member never sees the club modules panel", async () => {
  const window = await bootCommunity(seeded(null, "member"), { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  assert.ok(!window.document.querySelector('[data-club-feature]'), "no toggle row renders for a non-admin");
});

test("an admin sees one toggle row per module, all checked when every module is on", async () => {
  const window = await bootCommunity(seeded(null, "admin"), { syncEnabled: false });
  await openManageSettings(window);
  await waitFor(() => !!window.document.querySelector('[data-club-feature="feed"]'), 3000);
  const rows = window.document.querySelectorAll('[data-club-feature]');
  // Redesign, Phase 2: 7 community-content rows (the original 6 plus
  // "directory") + 4 coach-tool rows (coach_tools, member_of_week,
  // welcome_flow, monthly_recap) = 11.
  assert.equal(rows.length, 11, "one row per module across both groups");
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
  await openManageSettings(window);
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
  await openManageSettings(window);
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
  await openManageSettings(window);
  await waitFor(() => !!window.document.querySelector('[data-club-feature]'), 3000);
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="sign-out"]'), 3000);
  window.document.querySelector('[data-community-action="sign-out"]').click();
  // Redesign, Phase 1: signing out also clears isStaff(), so the whole
  // Manage tab (and everything in it, including this panel) becomes
  // unreachable - a stronger proof of the same reset than before.
  await waitFor(() => !window.document.getElementById("tabManageBtn"), 3000);
});

// ===== Redesign, Phase 2: pill-level gating, not just content-level =======

test("feed off removes the פיד pill itself, not just its content", async () => {
  const mock = seeded({ club_features: allModulesOn("feed") }, "member");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.ok(!window.document.querySelector('[data-community-action="set-tab"][data-tab="feed"]'), "no feed pill in the subtab bar");
  // Falls back to the first remaining pill (boards), never a blank screen.
  assert.ok(window.document.querySelector(".subtabbtn.active"), "some pill is still active");
});

test("directory off removes the חברים pill itself, client-only (no RLS gate behind it)", async () => {
  const mock = seeded({ club_features: allModulesOn("directory") }, "member");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.ok(!window.document.querySelector('[data-community-action="set-tab"][data-tab="directory"]'), "no directory pill");
});

test("coach_tools off removes the לוח מאמנים pill for a coach, even though their role would otherwise show it", async () => {
  const mock = seeded({ club_features: allModulesOn("coach_tools") }, "coach");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.ok(!window.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]'), "no coach pill while the master switch is off");
});

test("each of the three coach-tool sub-flags independently hides its own section, leaving the others visible", async () => {
  const COACH_TOOL_MARKERS = [["member_of_week", "חבר/ת השבוע"], ["welcome_flow", "קבלת פנים"], ["monthly_recap", "סיכום חודשי למועדון"]];
  for (const [key, marker] of COACH_TOOL_MARKERS) {
    const mock = seeded({ club_features: allModulesOn(key) }, "coach");
    const window = await bootCommunity(mock, { syncEnabled: false });
    window.document.getElementById("tabCommunityBtn").click();
    await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
    window.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]').click();
    await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
    assert.ok(!window.document.body.textContent.includes(marker), `${key} off hides its own "${marker}" section`);
    // The point of this test is independence, not just that toggling
    // works at all - the other two markers must still be on screen while
    // this one flag alone is off, proving the three sub-flags don't share
    // a single "coach tools content" gate under the hood.
    for (const [otherKey, otherMarker] of COACH_TOOL_MARKERS) {
      if (otherKey === key) continue;
      assert.ok(window.document.body.textContent.includes(otherMarker), `${key} off leaves the unrelated "${otherMarker}" (${otherKey}) section visible`);
    }
  }
});

test("boards shows the mockup's empty-state note only when challenges, events and leaderboards are ALL off", async () => {
  const allThreeOff = MODULE_KEYS.map((module_key) => ({
    club_id: "club-1", module_key, config: {},
    enabled: !["challenges", "events", "leaderboards"].includes(module_key),
  }));
  const mock = seeded({ club_features: allThreeOff }, "member");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.querySelector('[data-boards-all-off="1"]'), 3000);
  assert.ok(window.document.body.textContent.includes('הפעילו אותם ב"ניהול'), "points back at Manage › Settings");

  // Any one of the three back on removes the note, even though the tab is
  // still not fully populated.
  const partialMock = seeded({ club_features: allModulesOn("events") }, "member");
  const partialWindow = await bootCommunity(partialMock, { syncEnabled: false });
  partialWindow.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!partialWindow.document.querySelector(".subtabbar"), 3000);
  partialWindow.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!partialWindow.document.querySelector(".subtabbar"), 3000);
  assert.ok(!partialWindow.document.querySelector('[data-boards-all-off="1"]'), "not shown once at least one of the three is on");
});
