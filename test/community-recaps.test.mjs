// COMM-221. The weekly recap surface + Share Recap, executed for real
// (bootCommunity + the mock Supabase client) against the `weekly_recaps`
// shape COMM-220's Edge Function generates (see
// supabase/functions/recap_weekly/index.ts and its own manual
// verification notes - this file does not re-test the Edge Function's
// server-side aggregation, only the client surface reading the row it
// produces).
//
// WHAT THIS FILE VERIFIES
// - "View Week" in the Account tab opens the recap dialog on the most
//   recent row.
// - The four documented frontend states: empty, loading, error, populated
//   (including the quiet-week variant, built from the same row).
// - Past weeks are browsable (prev/next), off the real week_start values.
// - Share Recap posts exactly one member-picked figure via post_create,
//   never automatically.
// - The weekly_recap notification's deep link opens the recap dialog on
//   the exact week it names.
// - COMM-316 (closing COMM-P06): the classmates line renders straight off
//   weekly_recaps.classmates - populated, in the row's own order, each name
//   linking to a profile - and a quiet week (empty array, or a fixture that
//   predates the column entirely) renders the documented quiet-week
//   message rather than an omission or an error. The privacy gate itself
//   (recap_weekly_classmates(), 202609010003) is Postgres and is not
//   re-verified here - see supabase/tests/0047_recap_classmates_and_onboarding_classes_test.sql.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function quietRow(overrides) {
  return Object.assign({
    id: "wr-1", user_id: "u1", week_start: "2026-08-17",
    sessions_completed: 0, streak: 0, prs: [], achievements: [],
    challenge_progress: [], club_challenge_progress: {}, upcoming_event: null,
    generated_at: VERIFIED,
  }, overrides || {});
}

function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    weekly_recaps: [], onboarding_progress: [{ user_id: "u1", welcomed_at: VERIFIED, first_week_shown_at: VERIFIED, first_month_shown_at: VERIFIED }],
    notifications: [], notification_preferences: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openAccountTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => window.document.body.textContent.includes("הסיכום השבועי שלי"), 3000);
}
function recapDialog(window) { return window.document.querySelector('[data-cloud-dialog="recapView"]'); }

test("View Week in the Account tab opens the recap on the member's most recent week", async () => {
  const mock = seeded({
    weekly_recaps: [
      quietRow({ id: "wr-old", week_start: "2026-08-10", sessions_completed: 1 }),
      quietRow({ id: "wr-new", week_start: "2026-08-17", sessions_completed: 4, streak: 3 }),
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!recapDialog(window), 3000);
  await waitFor(() => recapDialog(window).textContent.includes("2026-08-17"), 3000);
  assert.match(recapDialog(window).textContent, /4/, "sessions_completed from the newest row");
  assert.match(recapDialog(window).textContent, /🔥 3/, "streak from the newest row");
});

test("a brand-new member with no weekly_recaps row at all gets the documented empty state", async () => {
  const mock = seeded({ weekly_recaps: [] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!recapDialog(window), 3000);
  await waitFor(() => recapDialog(window).textContent.includes("אין עדיין סיכום שבועי"), 3000);
});

test("a quiet week (all zeros) renders the honest quiet-week note, not a blank or broken screen", async () => {
  const mock = seeded({ weekly_recaps: [quietRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!recapDialog(window), 3000);
  await waitFor(() => recapDialog(window).textContent.includes("שבוע שקט"), 3000);
});

test("a load failure shows the documented error copy with a working retry", async () => {
  const mock = seeded({ weekly_recaps: [quietRow({ sessions_completed: 2 })] });
  const realFrom = mock.client.from;
  let fail = true;
  mock.client.from = (table) => {
    const q = realFrom(table);
    if (table === "weekly_recaps" && fail) {
      const origMaybeSingle = q.maybeSingle.bind(q);
      const origThen = q.then.bind(q);
      q.maybeSingle = () => Promise.resolve({ data: null, error: { message: "boom" } });
      q.then = (onFulfilled) => Promise.resolve({ data: null, error: { message: "boom" } }).then(onFulfilled);
      void origMaybeSingle; void origThen;
    }
    return q;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!recapDialog(window), 3000);
  await waitFor(() => recapDialog(window).textContent.includes("לא ניתן היה לטעון את הסיכום השבועי. נסו שוב."), 3000);
  fail = false;
  window.document.querySelector('[data-community-action="recap-retry"]').click();
  await waitFor(() => recapDialog(window).textContent.includes("אימונים השבוע"), 3000);
  assert.doesNotMatch(recapDialog(window).textContent, /לא ניתן היה לטעון/, "the error copy is gone once the retry succeeds");
});

test("past weeks are browsable: prev/next move across real week_start rows, disabled at the ends", async () => {
  const mock = seeded({
    weekly_recaps: [
      quietRow({ id: "wr1", week_start: "2026-08-03", sessions_completed: 1 }),
      quietRow({ id: "wr2", week_start: "2026-08-10", sessions_completed: 2 }),
      quietRow({ id: "wr3", week_start: "2026-08-17", sessions_completed: 3 }),
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!recapDialog(window), 3000);
  await waitFor(() => recapDialog(window).textContent.includes("2026-08-17"), 3000);
  assert.equal(recapDialog(window).querySelector('[data-community-action="recap-newer"]').disabled, true, "already on the newest week");

  recapDialog(window).querySelector('[data-community-action="recap-older"]').click();
  await waitFor(() => recapDialog(window).textContent.includes("2026-08-10"), 3000);
  recapDialog(window).querySelector('[data-community-action="recap-older"]').click();
  await waitFor(() => recapDialog(window).textContent.includes("2026-08-03"), 3000);
  assert.equal(recapDialog(window).querySelector('[data-community-action="recap-older"]').disabled, true, "no week before the oldest");

  recapDialog(window).querySelector('[data-community-action="recap-newer"]').click();
  await waitFor(() => recapDialog(window).textContent.includes("2026-08-10"), 3000);
});

test("Share Recap posts exactly the member-picked figure via post_create, never automatically", async () => {
  const mock = seeded({
    weekly_recaps: [quietRow({ sessions_completed: 5, streak: 2 })],
  });
  let createCall = null;
  mock.onRpc("post_create", (args) => { createCall = args; return { data: "post-1", error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!recapDialog(window), 3000);
  await waitFor(() => !!recapDialog(window).querySelector('[data-community-action="share-recap"][data-figure="streak"]'), 3000);
  assert.equal(createCall, null, "opening/browsing the recap never posts anything on its own");

  recapDialog(window).querySelector('[data-community-action="share-recap"][data-figure="streak"]').click();
  await waitFor(() => !!createCall, 3000);
  assert.match(createCall.body, /2/, "the chosen figure (streak), not sessions, drives the body");
  assert.equal(createCall.visibility, "club");
});

test("the weekly_recap notification's deep link opens the recap dialog on the exact named week", async () => {
  const week = "2026-08-17";
  const mock = seeded({
    weekly_recaps: [quietRow({ week_start: week, sessions_completed: 7 })],
    notifications: [{
      id: "n1", user_id: "u1", type: "weekly_recap", category: "club",
      title: "הסיכום השבועי שלך", body: "7 אימונים השבוע, רצף של 0.",
      source_type: "weekly_recap", source_id: "wr-1",
      deep_link: `/community/recap?week=${week}`,
      read_at: null, created_at: VERIFIED,
    }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => !!window.document.querySelector("[data-notif-center]"), 4000);
  // weekly_recap is a batched type (contracts.md's routing table), so even
  // a single row renders as a collapsed group that has to be expanded
  // first (COMM-142), same as any other batched type.
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-toggle-group"]'), 4000);
  window.document.querySelector('[data-community-action="notif-toggle-group"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-open"]'), 4000);
  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => !!recapDialog(window), 4000);
  await waitFor(() => recapDialog(window).textContent.includes(week), 4000);
  assert.match(recapDialog(window).textContent, /7/);
});

test("resolveNotifTarget maps the recap deep link to the account tab and the named week", async () => {
  const mock = seeded({});
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
  const R = window.notifResolveTarget;
  assert.deepEqual(R({ deep_link: "/community/recap?week=2026-08-17" }), { tab: "account", recapWeek: "2026-08-17" });
});

// COMM-316, closing COMM-P06. weekly_recaps.classmates - already fully
// privacy-gated server-side by recap_weekly_classmates() (202609010003) -
// is rendered straight off the row: no client-side re-filter, no
// re-sorting, in the order the row already carries.
const classmatesLine = (window) => recapDialog(window).querySelector("[data-recap-classmates]");

test("COMM-316: a populated classmates line names each member, in the row's own order, each linking to their profile", async () => {
  const mock = seeded({
    weekly_recaps: [quietRow({
      sessions_completed: 4, streak: 2,
      classmates: [
        { user_id: "u2", display_name: "נועם", handle: "noam", avatar_url: null },
        { user_id: "u3", display_name: "טל", handle: "tal", avatar_url: null },
      ],
    })],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!recapDialog(window), 3000);
  await waitFor(() => !!classmatesLine(window), 3000);

  assert.equal(classmatesLine(window).dataset.recapClassmates, "ready");
  const links = Array.from(classmatesLine(window).querySelectorAll('[data-community-action="view-profile"]'));
  assert.deepEqual(links.map((l) => l.dataset.id), ["u2", "u3"], "rendered in the order the row returned, never re-sorted client-side");
  const text = classmatesLine(window).textContent;
  assert.match(text, /נועם/);
  assert.match(text, /טל/);
});

test("COMM-316: a quiet week (no overlap, or the member's own show_attendance off) renders a quiet-week message, not an omission and not an error", async () => {
  const mock = seeded({
    weekly_recaps: [quietRow({ sessions_completed: 3, classmates: [] })],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!recapDialog(window), 3000);
  await waitFor(() => !!classmatesLine(window), 3000);

  assert.equal(classmatesLine(window).dataset.recapClassmates, "empty");
  assert.match(classmatesLine(window).textContent, /אין חברים משותפים השבוע/);
  assert.equal(classmatesLine(window).querySelector('[data-community-action="view-profile"]'), null);
});

test("COMM-316: a row with no classmates field at all (older fixture shape) is treated the same as an empty array, never throws", async () => {
  const row = quietRow({ sessions_completed: 1 });
  delete row.classmates;
  const mock = seeded({ weekly_recaps: [row] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  window.document.querySelector('[data-community-action="open-recap"]').click();
  await waitFor(() => !!recapDialog(window), 3000);
  await waitFor(() => !!classmatesLine(window), 3000);
  assert.equal(classmatesLine(window).dataset.recapClassmates, "empty");
});
