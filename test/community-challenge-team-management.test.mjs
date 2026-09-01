// COMM-308. Advanced challenge team management: a community.challenge.create
// holder can create/rename/delete challenge_teams rows, move a participant
// between teams (chal_reassign_team), and set/clear a team captain
// (chal_set_captain) - all layered onto COMM-204's `team` panel without
// changing what a plain member sees there.
//
// Executed for real (bootCommunity + the mock Supabase client), not
// source-text matches: these drive the real render path and the real
// chal_reassign_team/chal_set_captain mock RPCs (test/helpers/mockSupabase.mjs),
// which mirror the shipped Postgres functions' error catalog and their one
// rule this ticket is built around - a reassignment never touches
// challenge_progress, so a departed member's historical team_id snapshot
// stays with the team they actually contributed to.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const iso = (deltaDays) => new Date(NOW + deltaDays * 86400000).toISOString();

function baseProfiles() {
  return [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
    { id: "u3", handle: "tal", display_name: "טל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
    { id: "coach1", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
  ];
}
function seeded(extra, asStaff) {
  const mock = createMockSupabase(Object.assign({
    profiles: baseProfiles(),
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: asStaff ? "coach" : "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "coach1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    challenges: [], challenge_participants: [], challenge_teams: [], challenge_progress: [],
    workout_posts: [], feed_page_rows: [], analytics_events: [],
    notifications: [], notification_preferences: [], admin_actions: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}
async function openBoards(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => window.document.body.textContent.includes("אתגרי המועדון"), 3000);
}
function openChallengeCard(window, id) {
  const card = window.document.querySelector(`[data-challenge-id="${id}"]`);
  card.querySelector('[data-community-action="open-challenge"]').click();
}
function teamChallenge(overrides) {
  return Object.assign({
    id: "c1", challenge_type: "team", title: "בוקר נגד ערב", description: "",
    metric_type: "session_count", target_value: null, start_at: iso(-5), end_at: iso(20),
    status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {},
  }, overrides || {});
}

test("a plain member's team panel is unchanged - no team-management block anywhere, even with teams and a coach viewer sees it", async () => {
  const base = {
    challenges: [teamChallenge()],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר", captain_id: null }, { id: "t-evening", challenge_id: "c1", name: "קבוצת ערב", captain_id: null }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null }],
  };
  const memberWindow = await bootCommunity(seeded(base, false), { syncEnabled: false });
  await openBoards(memberWindow);
  await waitFor(() => !!memberWindow.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(memberWindow, "c1");
  await waitFor(() => memberWindow.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("קבוצת בוקר"), 3000);
  const memberDlg = memberWindow.document.querySelector('[data-cloud-dialog="challengeView"]');
  assert.equal(memberDlg.querySelector('[data-team-mgmt]'), null, "a plain member never sees the team-management block");
  assert.doesNotMatch(memberDlg.textContent, /ניהול קבוצות/, "not even the section heading leaks to a plain member");

  const staffWindow = await bootCommunity(seeded({
    challenges: [teamChallenge()],
    challenge_teams: base.challenge_teams.map((t) => ({ ...t })),
    challenge_participants: base.challenge_participants.map((p) => ({ ...p })),
  }, true), { syncEnabled: false });
  await openBoards(staffWindow);
  await waitFor(() => !!staffWindow.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(staffWindow, "c1");
  await waitFor(() => !!staffWindow.document.querySelector('[data-team-mgmt]'), 3000);
  assert.match(staffWindow.document.querySelector('[data-team-mgmt]').textContent, /ניהול קבוצות/);
});

test("a team challenge with no teams shows COMM-204's empty state, with a 'צור קבוצה' control for a holder only, and creating a team inserts a row", async () => {
  const memberWindow = await bootCommunity(seeded({ challenges: [teamChallenge()] }, false), { syncEnabled: false });
  await openBoards(memberWindow);
  await waitFor(() => !!memberWindow.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(memberWindow, "c1");
  await waitFor(() => memberWindow.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("המאמן/ת עדיין לא הגדיר/ה קבוצות"), 3000);
  assert.equal(memberWindow.document.querySelector('[data-challenge-team-create-name]'), null, "a plain member gets no create-team control");

  const mock = seeded({ challenges: [teamChallenge()] }, true);
  const staffWindow = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(staffWindow);
  await waitFor(() => !!staffWindow.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(staffWindow, "c1");
  await waitFor(() => staffWindow.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("המאמן/ת עדיין לא הגדיר/ה קבוצות"), 3000);
  const createInput = staffWindow.document.querySelector('[data-challenge-team-create-name]');
  assert.ok(createInput, "a holder gets a create-team control on the empty state");
  createInput.value = "קבוצת צהריים";
  createInput.dispatchEvent(new staffWindow.Event("input", { bubbles: true }));
  staffWindow.document.querySelector('[data-community-action="challenge-team-create"]').click();
  await waitFor(() => mock.db.challenge_teams.some((t) => t.challenge_id === "c1" && t.name === "קבוצת צהריים"), 3000);
  await waitFor(() => staffWindow.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("קבוצת צהריים"), 3000);
});

test("a holder can rename an existing team", async () => {
  const mock = seeded({
    challenges: [teamChallenge()],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר", captain_id: null }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-challenge-team-rename-name="t-morning"]'), 3000);
  const input = window.document.querySelector('[data-challenge-team-rename-name="t-morning"]');
  input.value = "קבוצת שחר";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="challenge-team-rename"][data-id="t-morning"]').click();
  await waitFor(() => mock.db.challenge_teams.find((t) => t.id === "t-morning").name === "קבוצת שחר", 3000);
  await waitFor(() => window.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("קבוצת שחר"), 3000);
});

test("delete is disabled for a team with an active participant and works once the team is empty", async () => {
  const mock = seeded({
    challenges: [teamChallenge()],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר", captain_id: null }, { id: "t-evening", challenge_id: "c1", name: "קבוצת ערב", captain_id: null }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-team-delete"][data-id="t-morning"]'), 3000);
  const occupiedDelete = window.document.querySelector('[data-community-action="challenge-team-delete"][data-id="t-morning"]');
  assert.equal(occupiedDelete.disabled, true, "a team with an active participant cannot be deleted from the client");
  const emptyDelete = window.document.querySelector('[data-community-action="challenge-team-delete"][data-id="t-evening"]');
  assert.equal(emptyDelete.disabled, false, "an empty team's delete control stays enabled");
  emptyDelete.click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => !mock.db.challenge_teams.some((t) => t.id === "t-evening"), 3000);
});

test("a withdrawn participant does not block a team's deletion", async () => {
  const mock = seeded({
    challenges: [teamChallenge()],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר", captain_id: null }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "withdrawn", progress_value: 0, completed_at: null }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-team-delete"][data-id="t-morning"]'), 3000);
  assert.equal(window.document.querySelector('[data-community-action="challenge-team-delete"][data-id="t-morning"]').disabled, false, "a withdrawn member does not count toward the delete guard");
});

test("a holder can reassign an active participant to another team, and the reassignment never rewrites their already-stamped challenge_progress rows", async () => {
  const mock = seeded({
    challenges: [teamChallenge()],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר", captain_id: null }, { id: "t-evening", challenge_id: "c1", name: "קבוצת ערב", captain_id: null }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 7, completed_at: null }],
    challenge_progress: [{ id: "p1", challenge_id: "c1", user_id: "u2", team_id: "t-morning", delta: 7, source_type: "manual", created_at: iso(-1) }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-challenge-team-reassign-select="u2"]'), 3000);
  const select = window.document.querySelector('[data-challenge-team-reassign-select="u2"]');
  select.value = "t-evening";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => {
    const p = mock.db.challenge_participants.find((x) => x.challenge_id === "c1" && x.user_id === "u2");
    return p && p.team_id === "t-evening";
  }, 3000);
  // The historical progress row keeps pointing at the team it was actually
  // contributed to - chal_reassign_team's central rule.
  assert.equal(mock.db.challenge_progress.find((p) => p.id === "p1").team_id, "t-morning");
  const { data } = await mock.client.rpc("chal_progress", { challenge_id: "c1" });
  const morning = data.team_totals.find((t) => t.team_id === "t-morning");
  const evening = data.team_totals.find((t) => t.team_id === "t-evening");
  assert.equal(morning.total, 7, "the old team keeps the historical contribution");
  assert.equal(evening.total, 0, "the new team has no history yet, only the live member");
  const auditRow = mock.db.admin_actions.find((a) => a.action_type === "challenge_edit" && a.target_type === "challenge_participant" && a.target_id === "u2");
  assert.ok(auditRow, "the reassignment writes an admin_actions row");
});

test("a holder can set and clear a team's captain, shown as a badge, offering only that team's active participants", async () => {
  const mock = seeded({
    challenges: [teamChallenge()],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר", captain_id: null }],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null, profiles: { display_name: "נועם", handle: "noam", avatar_url: null, visible_to_club: true } },
      { challenge_id: "c1", user_id: "u3", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null, profiles: { display_name: "טל", handle: "tal", avatar_url: null, visible_to_club: true } },
    ],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-challenge-team-captain-select="t-morning"]'), 3000);
  const select = window.document.querySelector('[data-challenge-team-captain-select="t-morning"]');
  const optionValues = [...select.querySelectorAll("option")].map((o) => o.value);
  assert.ok(optionValues.includes("u2"), "the team's own active participant is offered as a captain candidate");
  assert.ok(!optionValues.includes("u3"), "a member not on this team is never offered as its captain");
  select.value = "u2";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => mock.db.challenge_teams.find((t) => t.id === "t-morning").captain_id === "u2", 3000);
  await waitFor(() => window.document.querySelector('[data-team-mgmt]').textContent.includes("👑"), 3000);
  assert.match(window.document.querySelector('[data-team-mgmt]').textContent, /נועם/, "the captain badge names the captain");

  const select2 = window.document.querySelector('[data-challenge-team-captain-select="t-morning"]');
  select2.value = "";
  select2.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => mock.db.challenge_teams.find((t) => t.id === "t-morning").captain_id === null, 3000);
  await waitFor(() => !window.document.querySelector('[data-team-mgmt]').textContent.includes("👑"), 3000);
});

test("a failed reassignment shows the documented generic error copy, and a mapped server error shows its own short Hebrew", async () => {
  const mock = seeded({
    challenges: [teamChallenge()],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר", captain_id: null }, { id: "t-evening", challenge_id: "c1", name: "קבוצת ערב", captain_id: null }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null }],
  }, true);
  mock.onRpc("chal_reassign_team", () => ({ data: null, error: { message: "a network hiccup" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-challenge-team-reassign-select="u2"]'), 3000);
  const select = window.document.querySelector('[data-challenge-team-reassign-select="u2"]');
  select.value = "t-evening";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => window.document.querySelector('[data-team-mgmt]').textContent.includes("הפעולה נכשלה. נסו שוב."), 3000);

  mock.onRpc("chal_reassign_team", () => ({ data: null, error: { message: "not an active participant" } }));
  const select2 = window.document.querySelector('[data-challenge-team-reassign-select="u2"]');
  select2.value = "t-morning";
  select2.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => window.document.querySelector('[data-team-mgmt]').textContent.includes("המשתתפ/ת אינו/ה פעיל/ה באתגר."), 3000);
});

test("a team-management mutation shows its own skeleton while the detail re-reads, distinct from the dialog's first-open loading text", async () => {
  const mock = seeded({
    challenges: [teamChallenge()],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר", captain_id: null }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-challenge-team-captain-select="t-morning"]'), 3000);

  // Gate the NEXT challenge_teams read (the one refreshAfterTeamMgmt
  // triggers after chal_set_captain succeeds - the first one this override
  // ever sees, since it is installed after the dialog's own first open
  // already completed) behind a manually-released promise - the same
  // "override realFrom, only touch what one test needs" shape
  // community-monthly-club-recap.test.mjs already uses, applied here to a
  // .then() gate rather than a terminal method since the app's own call
  // chain is select().eq().order() before the await.
  const realFrom = mock.client.from.bind(mock.client);
  let teamsCalls = 0;
  let release;
  mock.client.from = (table) => {
    const c = realFrom(table);
    if (table === "challenge_teams") {
      teamsCalls++;
      if (teamsCalls === 1) {
        const realResolve = c._resolve.bind(c);
        const gate = new Promise((resolve) => { release = resolve; });
        c.then = (onFulfilled, onRejected) => gate.then(() => realResolve()).then(onFulfilled, onRejected);
      }
    }
    return c;
  };

  const select = window.document.querySelector('[data-challenge-team-captain-select="t-morning"]');
  select.value = "u2";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => !!window.document.querySelector('[data-team-mgmt-skeleton]'), 3000);
  // The rest of the dialog (title, actions) stays on screen - this is not
  // the dialog's own first-open "טוען את האתגר…" loading text.
  assert.doesNotMatch(window.document.querySelector('[data-cloud-dialog="challengeView"]').textContent, /טוען את האתגר/);
  release();
  await waitFor(() => !window.document.querySelector('[data-team-mgmt-skeleton]'), 3000);
  await waitFor(() => mock.db.challenge_teams.find((t) => t.id === "t-morning").captain_id === "u2", 3000);
});

test("deleting a team refused server-side ('team not empty') maps to its own short Hebrew - the defensive path behind the proactive client-side disable", async () => {
  const mock = seeded({
    challenges: [teamChallenge()],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר", captain_id: null }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null }],
  }, true);
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const c = realFrom(table);
    if (table === "challenge_teams") {
      const realDelete = c.delete.bind(c);
      c.delete = () => { realDelete(); return { eq: () => ({ then: (res) => Promise.resolve(res({ error: { message: "team not empty" } })) }) }; };
    }
    return c;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-team-delete"][data-id="t-morning"]'), 3000);
  const btn = window.document.querySelector('[data-community-action="challenge-team-delete"][data-id="t-morning"]');
  // Simulating the race a second coach's tab can create: the control is
  // disabled by this client's own knowledge of the roster, so a real user
  // can never click it - only a bypass proves the server error still maps
  // to real copy rather than an unhandled rejection.
  btn.removeAttribute("disabled");
  btn.click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => window.document.querySelector('[data-team-mgmt]').textContent.includes("יש לפנות את הקבוצה מחברים לפני מחיקתה."), 3000);
  assert.ok(mock.db.challenge_teams.some((t) => t.id === "t-morning"), "the team was not actually removed");
});
