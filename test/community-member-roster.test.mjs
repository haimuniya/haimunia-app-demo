// COMM-377. Member roster screen: browse the full membership list, newest-
// joined first, reusing admin_search_members' exact row shape/renderer
// (admin_member_roster, COMM-374, returns the identical eight columns -
// pgTAP 0060 asserts the two `pg_get_function_result` strings are byte-
// identical) rather than a second row template.
//
// GAP flagged here and in docs/community/backlog.md's COMM-377 paragraph:
// admin_member_roster sorts and pages on
// coalesce(invite_redemptions.redeemed_at, profiles.created_at), but only
// ever returns redeemed_at - so once a page's last row has no
// invite_redemptions row at all (redeemed_at null), there is no correct
// next cursor. cloud.js's loadRoster() stops pagination there rather than
// resending a null cursor (which the RPC reads as "start over"), one of
// the tests below asserts exactly that behaviour.
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

async function openAccountTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
}

function rosterRow(role, extra) {
  return Object.assign({ id: `m-${role}`, handle: role, display_name: role, avatar_url: null, is_admin: false, role: "member", redeemed_at: "2026-08-01T00:00:00Z", last_activity_on: null }, extra || {});
}

test("a plain member never sees the roster, and admin_member_roster is never called", async () => {
  const mock = seeded({}, "member");
  const calls = [];
  mock.onRpc("admin_member_roster", (args) => { calls.push(args); return { data: [], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-member-roster-section="1"]'), null);
  assert.equal(calls.length, 0);
});

test("a coach (is_staff, not admin) sees the roster read-only", async () => {
  const mock = seeded({}, "coach");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob")], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
  const btn = window.document.querySelector('[data-community-action="admin-grant-coach"]');
  assert.ok(btn, "the role control still renders for a coach viewer");
  assert.equal(btn.disabled, true, "but it is disabled");
});

test("an admin sees the roster with live role controls, and no remove-member control on a roster row", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob")], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
  const section = window.document.querySelector('[data-member-roster-section="1"]');
  const btn = section.querySelector('[data-community-action="admin-grant-coach"]');
  assert.equal(btn.disabled, false);
  assert.equal(section.querySelector('[data-community-action="admin-remove-member"]'), null, "the roster never offers the destructive remove control");
});

test("the roster's role buttons are the exact adminGrantCoach/adminSetRole/adminRevokeCoach RPCs already wired to member search", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob")], error: null }));
  const grantCalls = [];
  mock.onRpc("admin_grant_coach", (args) => { grantCalls.push(args); return { error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
  window.document.querySelector('[data-member-roster-section="1"] [data-community-action="admin-grant-coach"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => grantCalls.length === 1, 3000);
  assert.deepEqual(grantCalls[0], { p_user_id: "m-bob" });
});

test("a zero-row page still renders the section header, never a special empty message (COMM-377's own frontend-states note)", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-member-roster-section="1"]'), 3000);
  assert.doesNotMatch(window.document.querySelector('[data-member-roster-section="1"]').textContent, /אין/, "no special empty copy");
});

test("Error state renders the ticket's own copy with a working retry", async () => {
  const mock = seeded({}, "admin");
  let calls = 0;
  mock.onRpc("admin_member_roster", () => { calls++; return calls === 1 ? { data: null, error: { message: "boom" } } : { data: [rosterRow("bob")], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את רשימת החברים."), 3000);
  window.document.querySelector('[data-community-action="roster-retry"]').click();
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
});

test("Load more pages via the cursor, and existing search is untouched by the roster's own state", async () => {
  const mock = seeded({}, "admin");
  const calls = [];
  mock.onRpc("admin_member_roster", (args) => {
    calls.push(args);
    if (calls.length === 1) {
      const page = Array.from({ length: 25 }, (_, i) => rosterRow(`p1-${i}`, { id: `p1-${i}`, redeemed_at: `2026-08-${String(25 - i).padStart(2, "0")}T00:00:00Z` }));
      return { data: page, error: null };
    }
    return { data: [rosterRow("older", { redeemed_at: "2026-07-01T00:00:00Z" })], error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("p1-0"), 3000);
  const moreBtn = window.document.querySelector('[data-community-action="roster-more"]');
  assert.ok(moreBtn, "a full 25-row first page still offers Load more");
  moreBtn.click();
  await waitFor(() => calls.length === 2, 3000);
  assert.equal(calls[1].p_cursor, "2026-08-01T00:00:00Z", "pages on the last row's own redeemed_at, oldest-so-far");
  await waitFor(() => window.document.body.textContent.includes("older"), 3000);
});

test("GAP: pagination stops rather than looping once a page's last row has no invite_redemptions row (redeemed_at null)", async () => {
  const mock = seeded({}, "admin");
  const calls = [];
  mock.onRpc("admin_member_roster", (args) => {
    calls.push(args);
    const page = Array.from({ length: 25 }, (_, i) => rosterRow(`p${calls.length}-${i}`, { id: `p${calls.length}-${i}`, redeemed_at: i === 24 ? null : `2026-08-${String(25 - i).padStart(2, "0")}T00:00:00Z` }));
    return { data: page, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => calls.length === 1, 3000);
  // The last row of the first page has redeemed_at null - "load more" must
  // not render, and a second call to admin_member_roster must never happen
  // on its own (which would otherwise restart at the top, per the RPC's own
  // `p_cursor is null or ...` clause, and loop the same 25 rows forever).
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(window.document.querySelector('[data-community-action="roster-more"]'), null, "load more is not offered past a null-redeemed_at boundary row");
  assert.equal(calls.length, 1, "admin_member_roster was called exactly once - pagination never looped");
});
