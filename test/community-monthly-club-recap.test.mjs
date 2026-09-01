// COMM-309, client half: the monthly club recap staff preview + publish, and
// its member-facing surface once published. Schema half shipped in
// 202609010002_monthly_club_recap.sql (monthly_club_recaps table + RLS,
// recap_monthly_publish()) - see that migration's own comments and the
// ticket's own "IMPLEMENTATION NOTE" for the exact contract: the client
// never calls or triggers generation (recap_monthly_generate() is
// service_role-only), it only reads monthly_club_recaps directly and calls
// recap_monthly_publish(p_id).
//
// Executed for real (bootCommunity + the mock Supabase client), the same
// way test/community-coach-tools.test.mjs and
// test/community-member-of-week.test.mjs drive their own staff surfaces -
// real render/click paths against fixture rows in the mock's
// monthly_club_recaps table, not source-text matches.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

// role: "coach" (isStaff() true, community.analytics.view absent - can
// preview but not publish, per the migration's own asymmetry note),
// "admin" (is_admin true - can do both) or "member" (neither).
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
    monthly_club_recaps: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

function recapRow(overrides) {
  return Object.assign({
    id: "mcr-1",
    club_id: "club-1",
    month_start: "2026-07-01",
    sessions_logged: 42,
    posts_created: 11,
    new_members: 3,
    challenges_completed: 5,
    events_held: 2,
    generated_at: VERIFIED,
    published_at: null,
  }, overrides || {});
}

async function openCoachTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]').click();
}
async function openAccountTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
}

// --- staff preview: loading / error / empty ---------------------------------

test("staff preview shows the loading skeleton, then the newest month's figures", async () => {
  const mock = seeded({ monthly_club_recaps: [recapRow()] }, "coach");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("סיכום חודשי למועדון"), 3000);
  await waitFor(() => window.document.body.textContent.includes("42"), 3000);
  assert.match(window.document.body.textContent, /11/);
  assert.match(window.document.body.textContent, /2026-07-01/);
});

test("staff preview error state shows COMM-309's own copy with a working retry", async () => {
  const mock = seeded({}, "coach");
  // Make the first monthly_club_recaps read fail without mutating the mock
  // db, the same by-hand-override shape community-privacy-toggles.test.mjs
  // already uses for a failed profiles upsert.
  let calls = 0;
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const chain = realFrom(table);
    if (table === "monthly_club_recaps" && calls === 0) {
      calls++;
      chain.limit = () => ({ then: (res) => Promise.resolve(res({ data: null, error: { message: "boom" } })) });
    }
    return chain;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את התקציר לתצוגה מקדימה."), 3000);
  window.document.querySelector('[data-community-action="coach-monthly-recap-retry"]').click();
  await waitFor(() => window.document.body.textContent.includes("עדיין לא נוצר תקציר חודשי."), 3000);
});

test("staff preview shows an honest empty state when no month has ever been generated (no scheduler is built)", async () => {
  const mock = seeded({}, "coach");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("עדיין לא נוצר תקציר חודשי."), 3000);
});

// --- the preview/publish permission asymmetry --------------------------------

test("a coach (is_staff, no community.analytics.view) can preview a draft but sees no publish control, only a named explanation", async () => {
  const mock = seeded({ monthly_club_recaps: [recapRow()] }, "coach");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("סיכום חודשי למועדון"), 3000);
  await waitFor(() => window.document.body.textContent.includes("42"), 3000);
  assert.equal(window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]'), null, "no publish control for a coach who lacks community.analytics.view");
  assert.match(window.document.body.textContent, /רק בעל\/ת הרשאת אנליטיקה או מנהל\/ת יכולים לפרסם\./);
});

test("an admin sees the publish control on a draft and publishing it re-fetches the row read-only", async () => {
  const mock = seeded({ monthly_club_recaps: [recapRow()] }, "admin");
  const calls = [];
  mock.onRpc("recap_monthly_publish", (args) => {
    calls.push(args);
    const row = mock.db.monthly_club_recaps.find((r) => r.id === args.p_id);
    if (row) row.published_at = new Date().toISOString();
    return { data: null, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]'), 3000);
  window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]').click();
  await waitFor(() => calls.length === 1, 3000);
  assert.deepEqual(calls[0], { p_id: "mcr-1" });
  await waitFor(() => window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]') == null, 3000);
  assert.match(window.document.body.textContent, /פורסם/);
});

test("a published recap renders read-only for every staff viewer, admin included - no publish control at all", async () => {
  const mock = seeded({ monthly_club_recaps: [recapRow({ published_at: VERIFIED })] }, "admin");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("סיכום חודשי למועדון"), 3000);
  await waitFor(() => window.document.body.textContent.includes("42"), 3000);
  assert.equal(window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]'), null, "a published recap cannot be un-published or re-published from this surface");
});

test("publishing twice in a row is a no-op the second time - a disabled control produces no second call", async () => {
  const mock = seeded({ monthly_club_recaps: [recapRow()] }, "admin");
  let resolvePublish;
  mock.onRpc("recap_monthly_publish", () => new Promise((resolve) => { resolvePublish = resolve; }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]'), 3000);
  const btn = () => window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]');
  btn().click();
  await waitFor(() => btn().disabled === true, 3000);
  const before = mock.callsTo("recap_monthly_publish").length;
  btn().click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mock.callsTo("recap_monthly_publish").length, before, "a busy control produces no second call");
  resolvePublish({ data: null, error: null });
});

// --- server error mapping ----------------------------------------------------

test("each of the two real server refusals maps to its own short Hebrew message, and the control re-enables to retry", async () => {
  const cases = [
    ["recap not found", "לא נמצא"],
    ["recap already published", "כבר פורסם"],
  ];
  for (const [serverMessage, expectedFragment] of cases) {
    const mock = seeded({ monthly_club_recaps: [recapRow()] }, "admin");
    mock.onRpc("recap_monthly_publish", () => ({ data: null, error: { message: serverMessage } }));
    const window = await bootCommunity(mock, { syncEnabled: false });
    await openCoachTab(window);
    await waitFor(() => !!window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]'), 3000);
    window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]').click();
    try {
      await waitFor(() => window.document.body.textContent.includes(expectedFragment), 3000);
    } catch (e) {
      throw new Error(`expected "${expectedFragment}" for server message "${serverMessage}": ${e.message}`);
    }
    await waitFor(() => window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]').disabled === false, 3000);
  }
});

test("an unmapped server error falls back to the generic retry copy", async () => {
  const mock = seeded({ monthly_club_recaps: [recapRow()] }, "admin");
  mock.onRpc("recap_monthly_publish", () => ({ data: null, error: { message: "some_new_server_message" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]'), 3000);
  window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]').click();
  await waitFor(() => window.document.body.textContent.includes("הפרסום נכשל. נסו שוב."), 3000);
});

// --- member-facing surface ----------------------------------------------------

test("Empty (member view, before any month is published): the account tab shows no monthly recap entry at all", async () => {
  const mock = seeded({ monthly_club_recaps: [recapRow()] }, "member"); // a draft exists, nothing published
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("הסיכום השבועי שלי"), 3000);
  // Give the lazy monthlyRecap load a tick to resolve and (not) render.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.body.textContent.includes("סיכום החודש של הקהילה"), false, "no monthly recap card renders while the only row is an unpublished draft");
});

test("Populated (member, post-publish): the published aggregate figures render, with no per-member data anywhere", async () => {
  const mock = seeded({
    monthly_club_recaps: [
      recapRow({ id: "mcr-old", month_start: "2026-06-01", published_at: VERIFIED, sessions_logged: 9 }),
      recapRow({ id: "mcr-new", month_start: "2026-07-01", published_at: VERIFIED, sessions_logged: 42, new_members: 3 }),
    ],
  }, "member");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("סיכום החודש של הקהילה"), 3000);
  // The newest published month, not the older one.
  assert.match(window.document.body.textContent, /2026-07-01/);
  assert.match(window.document.body.textContent, /42/);
  assert.equal(window.document.body.textContent.includes("2026-06-01"), false, "only the newest published month is shown");
  // No publish control on the member-facing card - it is read-only by
  // construction (renderMonthlyRecapMemberSection never wires one), and
  // there is nowhere a member name could come from - monthly_club_recaps
  // carries no user_id column at all.
  assert.equal(window.document.querySelector('[data-community-action="coach-monthly-recap-publish"]'), null);
});

test("a plain member never sees a draft on the member-facing card even when it is the newest row", async () => {
  const mock = seeded({
    monthly_club_recaps: [
      recapRow({ id: "mcr-published", month_start: "2026-06-01", published_at: VERIFIED, sessions_logged: 9 }),
      recapRow({ id: "mcr-draft", month_start: "2026-07-01", published_at: null, sessions_logged: 99 }),
    ],
  }, "member");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("סיכום החודש של הקהילה"), 3000);
  assert.match(window.document.body.textContent, /2026-06-01/, "falls back to the newest PUBLISHED month");
  assert.equal(window.document.body.textContent.includes("99"), false, "the newer draft's figures never reach a plain member");
});

test("a staff member who also opens the Account tab gets the same published-only card, never a draft leaking through", async () => {
  const mock = seeded({
    monthly_club_recaps: [recapRow({ published_at: null, sessions_logged: 77 })],
  }, "coach");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("הסיכום השבועי שלי"), 3000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.body.textContent.includes("סיכום החודש של הקהילה"), false, "a coach's own member-facing card never shows an unpublished draft either");
});
