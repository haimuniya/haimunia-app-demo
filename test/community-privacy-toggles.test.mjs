// COMM-018 - privacy toggle model and RLS enforcement (client half).
//
// The Privacy panel in the Account tab exposes the COMM-010 columns,
// each persisted by a direct own-row upsert into profiles. These tests
// drive the real renderCommunityApp() Account tab and the real
// savePrivacyField()/canViewProfileField() paths. RLS itself is proven
// by the schema boundary tests (COMM-019); here we prove the client
// writes the right column, reflects stored values, reverts on error, and
// routes cross-member reads through can_view_profile_field.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

// Migration 202608280003 defaults: private-leaning for anything that
// exposes numbers, on for anything that only makes a member reachable
// inside the invited club.
const DEFAULTS = {
  visible_to_club: true, show_workout_results: false, show_prs: false, show_achievements: true,
  show_attendance: false, show_upcoming_booking: false, show_in_attendee_lists: true,
  in_leaderboards: true, allow_follows: true, allow_mentions: true, allow_messages: false,
};

function seededMember(overrides = {}) {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: new Date().toISOString(), ...DEFAULTS, ...overrides }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openAccountTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.querySelector('[data-privacy-field]'), 3000);
}

test("the panel renders one checkbox per privacy column, each reflecting the stored value", async () => {
  const mock = seededMember({ show_prs: true, allow_messages: true, in_leaderboards: false });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);

  const boxes = [...window.document.querySelectorAll('[data-privacy-field]')];
  const byField = Object.fromEntries(boxes.map((b) => [b.dataset.privacyField, b]));
  assert.deepEqual(boxes.map((b) => b.dataset.privacyField).sort(), Object.keys(DEFAULTS).sort(), "all 11 columns present, no show_birthday");
  assert.equal(byField.show_prs.checked, true);
  assert.equal(byField.allow_messages.checked, true);
  assert.equal(byField.in_leaderboards.checked, false);
  assert.equal(byField.visible_to_club.checked, true);
});

test("first load with migration defaults shows the private-leaning pattern", async () => {
  const mock = seededMember();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  const byField = Object.fromEntries([...window.document.querySelectorAll('[data-privacy-field]')].map((b) => [b.dataset.privacyField, b.checked]));
  assert.deepEqual(byField, DEFAULTS, "checkbox states match the COMM-010 defaults exactly");
});

test("toggling a checkbox upserts that one column into profiles and round-trips", async () => {
  const mock = seededMember();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);

  const box = window.document.querySelector('[data-privacy-field="show_workout_results"]');
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));

  await waitFor(() => mock.db.profiles[0].show_workout_results === true, 3000);
  assert.equal(mock.db.profiles[0].show_workout_results, true, "the column was written server-side");
  // Untouched columns are unchanged.
  assert.equal(mock.db.profiles[0].visible_to_club, true);
  assert.equal(mock.db.profiles[0].is_admin, false);

  // Re-render reflects the new stored value.
  window.document.querySelector('[data-community-action="set-tab"][data-tab="feed"]').click();
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.querySelector('[data-privacy-field]'), 3000);
  assert.equal(window.document.querySelector('[data-privacy-field="show_workout_results"]').checked, true);
});

test("a failed save reverts the toggle and shows the Hebrew error", async () => {
  const mock = seededMember();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);

  // Make a profiles upsert fail without mutating the mock db.
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const chain = realFrom(table);
    if (table === "profiles") chain.upsert = () => ({ then: (res) => Promise.resolve(res({ error: { message: "boom" } })) });
    return chain;
  };

  const box = window.document.querySelector('[data-privacy-field="allow_messages"]');
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));

  await waitFor(() => /לא ניתן לשמור הגדרה זו/.test(window.document.getElementById("content").textContent), 3000);
  assert.equal(mock.db.profiles[0].allow_messages, false, "the failed write did not change the stored value");
  assert.equal(window.document.querySelector('[data-privacy-field="allow_messages"]').checked, false, "the checkbox reverted");
});

test("allow_follows=false on another member hides the follow button but keeps block", async () => {
  const mock = seededMember();
  mock.db.profiles.push({ id: "u2", handle: "noam", display_name: "נועם", is_admin: false, allow_follows: false, recovery_verified_at: new Date().toISOString() });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);

  const search = window.document.getElementById("communityPeopleSearch");
  search.value = "noam";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => !!window.document.querySelector('[data-community-action="block"]'), 3000);

  assert.equal(window.document.querySelector('[data-community-action="follow"]'), null, "no follow button for a member who disallows follows");
  assert.ok(window.document.querySelector('[data-community-action="block"]'), "block is still offered");
});

test("canViewProfileField forwards target and field to the RPC and returns its boolean", async () => {
  const mock = seededMember();
  const seen = [];
  mock.onRpc("can_view_profile_field", (args) => {
    seen.push(args);
    return { data: args.p_field === "show_prs", error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);

  assert.equal(await window.canViewProfileField("u2", "show_prs"), true);
  assert.equal(await window.canViewProfileField("u2", "show_attendance"), false);
  assert.deepEqual(seen[0], { p_target: "u2", p_field: "show_prs" });
});

test("cross-member round-trip: a hidden field reads false for another member, a shared one reads true", async () => {
  const mock = seededMember({ show_prs: false });
  mock.db.profiles.push({ id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: new Date().toISOString(), ...DEFAULTS });
  // A faithful stand-in for the real resolver: self true, block false,
  // admin true, then visible_to_club, then the field - reading db state
  // for the real caller (ctx.currentUser).
  mock.onRpc("can_view_profile_field", (args, ctx) => {
    const me = ctx.currentUser.id;
    if (args.p_target === me) return { data: true, error: null };
    const blocked = (ctx.db.blocks || []).some((b) => (b.blocker_id === me && b.blocked_id === args.p_target) || (b.blocker_id === args.p_target && b.blocked_id === me));
    if (blocked) return { data: false, error: null };
    const row = ctx.db.profiles.find((p) => p.id === args.p_target);
    if (!row) return { data: false, error: null };
    if (!row.visible_to_club) return { data: false, error: null };
    return { data: row[args.p_field] === true, error: null };
  });

  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);

  // Member u1 turns PRs visible.
  const box = window.document.querySelector('[data-privacy-field="show_prs"]');
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => mock.db.profiles[0].show_prs === true, 3000);

  // Now resolve as member u2.
  mock.setUser({ id: "u2", is_anonymous: false, email: "noam@members.haimuniya.invalid" });
  assert.equal(await window.canViewProfileField("u1", "show_prs"), true, "u2 sees u1's PRs once u1 shared them");
  assert.equal(await window.canViewProfileField("u1", "show_attendance"), false, "a still-hidden field stays hidden from u2");

  // u1 hides PRs again -> u2's view flips back.
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const box2 = window.document.querySelector('[data-privacy-field="show_prs"]');
  box2.checked = false;
  box2.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => mock.db.profiles[0].show_prs === false, 3000);
  mock.setUser({ id: "u2", is_anonymous: false, email: "noam@members.haimuniya.invalid" });
  assert.equal(await window.canViewProfileField("u1", "show_prs"), false, "u2's view flips back when u1 hides PRs");
});

test("the boards 'hide my result' link flips in_leaderboards off via upsert", async () => {
  const mock = seededMember({ in_leaderboards: true });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="hide-my-leaderboard-result"]'), 3000);

  window.document.querySelector('[data-community-action="hide-my-leaderboard-result"]').click();
  await waitFor(() => mock.db.profiles[0].in_leaderboards === false, 3000);
  assert.equal(mock.db.profiles[0].in_leaderboards, false);
});
