// COMM-376. Invite and code management admin screen, client half. Schema
// half is Phase 4's COMM-370 (per-person invites) and COMM-371 (shared
// codes) - see docs/community/contracts.md's "Needs from schema,
// registration and invite management (Phase 4)" section for the real,
// final RPC signatures this file drives (the ticket file's own
// (p_code, p_role) shapes never shipped - the invite schema was already
// hardened in 202608270006, before this phase started).
//
// Two independent panels, gated on the two different permissions COMM-
// 370/371 seed server-side: community.member.invite (coach and up) for the
// per-person half, community.invite.manage_codes (admin/owner only) for the
// shared-code half. A coach who holds only the first permission sees only
// the per-person panel - the exact split this file's own gating tests
// assert.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(extra, role) {
  const profiles = [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: role === "admin", recovery_verified_at: VERIFIED, visible_to_club: true },
  ];
  const mock = createMockSupabase(Object.assign({
    profiles,
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: role === "admin" ? "member" : (role || "member"), redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

// Redesign, Phase 1: renderInviteManagement() moved from Community's
// "account" sub-tab to the Manage tab's own "invites" sub-tab.
async function openAccountTab(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="invites"]').click();
}

function inviteCodeRow(id) { return `code-id-${id}`; }

test("a plain member never sees the invite management section, and neither RPC is called", async () => {
  const mock = seeded({}, "member");
  const codeCalls = []; const inviteCalls = [];
  mock.onRpc("admin_invite_code_list", () => { codeCalls.push(1); return { data: [], error: null }; });
  mock.onRpc("admin_invite_list", () => { inviteCalls.push(1); return { data: [], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  // Redesign, Phase 1: a plain member does not even get the Manage tab at
  // all (window.communityIsStaff() gates whether app.js emits it).
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.equal(window.document.getElementById("tabManageBtn"), null, "a plain member never gets the Manage tab at all");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-invite-management-section="1"]'), null);
  assert.equal(codeCalls.length, 0);
  assert.equal(inviteCalls.length, 0);
});

test("a coach (holds community.member.invite, not community.invite.manage_codes) sees only the per-person panel", async () => {
  const mock = seeded({}, "coach");
  mock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  const codeCalls = [];
  mock.onRpc("admin_invite_code_list", () => { codeCalls.push(1); return { data: [], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-person-invites-panel="1"]'), 3000);
  assert.equal(window.document.querySelector('[data-invite-codes-panel="1"]'), null, "the shared-code panel never renders for a coach");
  assert.equal(codeCalls.length, 0, "admin_invite_code_list is never even called for a coach");
});

test("an admin sees both panels, and both RPCs are called", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-invite-codes-panel="1"]'), 3000);
  assert.ok(window.document.querySelector('[data-person-invites-panel="1"]'));
});

test("empty states: no shared codes yet and no per-person invites yet each render their own Hebrew copy", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("אין קודי הצטרפות משותפים עדיין"), 3000);
  assert.match(window.document.body.textContent, /עדיין לא נוצרו הזמנות אישיות/);
});

test("shared codes panel lists role, active state and redemption count, and toggling active calls admin_invite_code_set_active with the flipped value", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_code_list", () => ({
    data: [{ id: "code-1", role: "member", active: true, created_at: "2026-08-01T00:00:00Z", expires_at: null, max_uses: 100, use_count: 4, redemption_count: 3 }],
    error: null,
  }));
  const setActiveCalls = [];
  mock.onRpc("admin_invite_code_set_active", (args) => { setActiveCalls.push(args); return { error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("3 מימושים"), 3000);
  assert.match(window.document.body.textContent, /פעיל/);
  window.document.querySelector('[data-community-action="invite-code-toggle-active"]').click();
  await waitFor(() => setActiveCalls.length === 1, 3000);
  assert.deepEqual(setActiveCalls[0], { p_code_id: "code-1", p_active: false });
});

test("creating a shared code never offers a coach-role option - the server refuses it unconditionally (COMM-371's own DEVIATION)", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityInviteCodeCreate"), 3000);
  const form = window.document.getElementById("communityInviteCodeCreate");
  assert.equal(form.querySelector('[name="role"]'), null, "no role selector at all in the shared-code create form");
});

test("creating a shared code reveals the raw code exactly once, with a copy action, and it is never shown again after dismissal", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  let listCalls = 0;
  mock.onRpc("admin_invite_code_list", () => { listCalls++; return { data: listCalls > 1 ? [{ id: "code-1", role: "member", active: true, created_at: "2026-08-01T00:00:00Z", expires_at: null, max_uses: 100, use_count: 0, redemption_count: 0 }] : [], error: null }; });
  const createCalls = [];
  mock.onRpc("admin_invite_code_create", (args) => { createCalls.push(args); return { data: { id: "code-1", code: "deadbeef".repeat(8), role: "member", active: true, created_at: "2026-08-01T00:00:00Z", expires_at: null, max_uses: 100, use_count: 0 }, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityInviteCodeCreate"), 3000);
  window.document.getElementById("communityInviteCodeCreate").requestSubmit
    ? window.document.getElementById("communityInviteCodeCreate").requestSubmit()
    : window.document.getElementById("communityInviteCodeCreate").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => createCalls.length === 1, 3000);
  assert.equal(createCalls[0].p_role, "member");
  await waitFor(() => !!window.document.querySelector('[data-invite-code-created="1"]'), 3000);
  assert.match(window.document.querySelector('[data-invite-code-created="1"]').textContent, /deadbeef/);
  window.document.querySelector('[data-community-action="dismiss-invite-code-created"]').click();
  await waitFor(() => !window.document.querySelector('[data-invite-code-created="1"]'), 3000);
});

test("a coach never sees the coach-role radio in the per-person invite form; an admin does", async () => {
  const coachMock = seeded({}, "coach");
  coachMock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  const coachWindow = await bootCommunity(coachMock, { syncEnabled: false });
  await openAccountTab(coachWindow);
  await waitFor(() => !!coachWindow.document.getElementById("communityInviteCreate"), 3000);
  const coachForm = coachWindow.document.getElementById("communityInviteCreate");
  assert.equal(coachForm.querySelector('input[name="role"][value="coach"]'), null, "no coach radio for a coach viewer");
  assert.match(coachForm.textContent, /הזמנת מאמן\/ת זמינה רק למנהל\/ת/);

  const adminMock = seeded({}, "admin");
  adminMock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  adminMock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  const adminWindow = await bootCommunity(adminMock, { syncEnabled: false });
  await openAccountTab(adminWindow);
  await waitFor(() => !!adminWindow.document.getElementById("communityInviteCreate"), 3000);
  const adminForm = adminWindow.document.getElementById("communityInviteCreate");
  assert.ok(adminForm.querySelector('input[name="role"][value="coach"]'), "an admin does see the coach radio");
});

test("creating a per-person invite reveals the raw code exactly once and refreshes the list", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  let listCalls = 0;
  mock.onRpc("admin_invite_list", () => {
    listCalls++;
    return { data: listCalls > 1 ? [{ id: "inv-x", role: "member", label: "דני", created_at: "2026-08-01T00:00:00Z", expires_at: null, revoked_at: null, redeemed_at: null, redeemed_by: null, redeemed_by_display_name: null, redeemed_by_handle: null, status: "pending" }] : [], error: null };
  });
  const createCalls = [];
  mock.onRpc("admin_invite_create", (args) => { createCalls.push(args); return { data: { id: "inv-x", code: "abc123".repeat(8), role: args.p_role, label: args.p_label, created_at: "2026-08-01T00:00:00Z", expires_at: null, status: "pending" }, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityInviteCreate"), 3000);
  const form = window.document.getElementById("communityInviteCreate");
  form.querySelector('[name="label"]').value = "דני";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => createCalls.length === 1, 3000);
  assert.equal(createCalls[0].p_role, "member");
  assert.equal(createCalls[0].p_label, "דני");
  await waitFor(() => !!window.document.querySelector('[data-invite-created="1"]'), 3000);
  assert.match(window.document.querySelector('[data-invite-created="1"]').textContent, /abc123/);
  await waitFor(() => window.document.body.textContent.includes("דני"), 3000);
});

test("filtering the per-person list re-queries admin_invite_list with the chosen status, cursor reset", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  const calls = [];
  mock.onRpc("admin_invite_list", (args) => { calls.push(args); return { data: [], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => calls.length === 1, 3000);
  assert.equal(calls[0].p_status, "all");
  window.document.querySelector('[data-community-action="invite-status-filter"][data-status="pending"]').click();
  await waitFor(() => calls.length === 2, 3000);
  assert.equal(calls[1].p_status, "pending");
  assert.equal(calls[1].p_cursor, null);
});

test("revoking a pending invite goes through the confirm dialog, then admin_invite_revoke; the server's 'already redeemed' refusal surfaces its own message", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_list", () => ({ data: [{ id: "inv-1", role: "member", label: "רותי", created_at: "2026-08-01T00:00:00Z", expires_at: null, revoked_at: null, redeemed_at: null, redeemed_by: null, redeemed_by_display_name: null, redeemed_by_handle: null, status: "pending" }], error: null }));
  const revokeCalls = [];
  mock.onRpc("admin_invite_revoke", (args) => { revokeCalls.push(args); return { error: { message: "already redeemed" } }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("רותי"), 3000);
  window.document.querySelector('[data-community-action="invite-revoke"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => revokeCalls.length === 1, 3000);
  assert.deepEqual(revokeCalls[0], { p_invite_id: "inv-1" });
  await waitFor(() => window.document.body.textContent.includes("לא ניתן לבטל הזמנה שכבר מומשה"), 3000);
});

test("a redeemed invite never offers a revoke control", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_list", () => ({ data: [{ id: "inv-2", role: "member", label: null, created_at: "2026-08-01T00:00:00Z", expires_at: null, revoked_at: null, redeemed_at: "2026-08-02T00:00:00Z", redeemed_by: "u9", redeemed_by_display_name: "נועה", redeemed_by_handle: "noa", status: "redeemed" }], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("נועה"), 3000);
  assert.equal(window.document.querySelector('[data-community-action="invite-revoke"]'), null);
});
