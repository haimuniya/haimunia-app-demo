// COMM-201..207. The Phase 2 challenges cluster: the generalized
// `challenges` model (individual_target, individual_performance,
// cooperative, team, consistency, coach), list + detail, join/leave, and
// each type's own progress math and panel.
//
// Executed for real (bootCommunity + the mock Supabase client), not
// source-text matches: these drive the real render path and the real
// chal_progress()/chal_record_progress() mock RPCs, which mirror the
// shipped Postgres functions' null-vs-zero and completion rules.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const iso = (deltaDays) => new Date(NOW + deltaDays * 86400000).toISOString();

function submit(window, id) {
  window.document.getElementById(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

// Launch-readiness audit item 2. Mirrors cloud.js's own isoWeekBounds():
// the Monday of the ISO week containing `when` (default now), so a fixture
// can seed attendance_log rows guaranteed to land inside whatever week the
// test actually runs in, day-offset only (never a fixed calendar date).
function isoWeekMonday(when) {
  const date = new Date(when || NOW);
  const truncated = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNr = (truncated.getUTCDay() + 6) % 7;
  truncated.setUTCDate(truncated.getUTCDate() - dayNr);
  return truncated;
}
function isoWeekDay(offset) {
  const d = new Date(isoWeekMonday());
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function attended(userId, offset) {
  return { id: `al-${userId}-${offset}`, user_id: userId, club_id: "club-1", occurred_on: isoWeekDay(offset), recorded_at: new Date(NOW).toISOString() };
}

function baseProfiles() {
  return [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
    { id: "coach1", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
  ];
}
function seeded(extra, asStaff) {
  const mock = createMockSupabase(Object.assign({
    profiles: baseProfiles(),
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: asStaff ? "coach" : "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "coach1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    challenges: [], challenge_participants: [], challenge_teams: [], challenge_progress: [],
    workout_posts: [], feed_page_rows: [], analytics_events: [],
    notifications: [], notification_preferences: [], attendance_log: [],
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

test("the Boards tab lists an active challenge with title, dates and a Join button when the member has not joined", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 12, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  const card = window.document.querySelector('[data-challenge-id="c1"]');
  assert.match(card.textContent, /12 אימונים החודש/);
  assert.ok(card.querySelector('[data-community-action="join-challenge"][data-id="c1"]'), "an unjoined active challenge offers Join");
});

test("no active challenges renders the documented empty state", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => window.document.querySelector(".ach-section").textContent.includes("אתגרי המועדון"), 3000);
  assert.match(window.document.body.textContent, /אין אתגרים פעילים כרגע/);
});

test("a draft challenge is hidden from a plain member's list and offers no Join button, but a staff holder sees and can publish it", async () => {
  const draft = { id: "cdraft", challenge_type: "individual_target", title: "טיוטת אתגר", description: "", metric_type: "session_count", target_value: 5, start_at: iso(1), end_at: iso(10), status: "draft", join_mode: "open", visibility: "club", created_by: "coach1", config: {} };
  const memberMock = seeded({ challenges: [draft] }, false);
  const memberWindow = await bootCommunity(memberMock, { syncEnabled: false });
  await openBoards(memberWindow);
  await waitFor(() => memberWindow.document.querySelector(".ach-section").textContent.includes("אתגרי המועדון"), 3000);
  assert.equal(memberWindow.document.querySelector('[data-challenge-id="cdraft"]'), null, "a plain member's list never renders a draft card");

  const staffMock = seeded({ challenges: [draft] }, true);
  const staffWindow = await bootCommunity(staffMock, { syncEnabled: false });
  await openBoards(staffWindow);
  await waitFor(() => !!staffWindow.document.querySelector('[data-challenge-id="cdraft"]'), 3000);
  const staffCard = staffWindow.document.querySelector('[data-challenge-id="cdraft"]');
  assert.equal(staffCard.querySelector('[data-community-action="join-challenge"]'), null, "a draft never offers Join, even to staff");
});

test("joining an individual_target challenge inserts a challenge_participants row and flips the card to Joined", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 12, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="join-challenge"]').click();
  await waitFor(() => mock.db.challenge_participants.some((p) => p.challenge_id === "c1" && p.user_id === "u1"), 3000);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"] [data-community-action="open-challenge"]') && window.document.querySelector('[data-challenge-id="c1"]').textContent.includes("נרשמת/ה"), 3000);
});

test("logging progress on an individual_target challenge bumps my progress and flips to completed at target, without removing the card", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 3, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 2, completed_at: null }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"]'), 3000);
  await waitFor(() => !!window.document.querySelector('[data-challenge-log-delta]'), 3000);

  let completed = 0;
  window.HaimuniaEvents.on(window.PRODUCT_EVENTS.CHALLENGE_COMPLETED, () => { completed++; });

  const input = window.document.querySelector('[data-challenge-log-delta]');
  input.value = "1";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="challenge-log-submit"]').click();

  await waitFor(() => {
    const part = mock.db.challenge_participants.find((p) => p.challenge_id === "c1" && p.user_id === "u1");
    return part && part.progress_value === 3 && part.status === "completed";
  }, 3000);
  await waitFor(() => completed === 1, 3000);
  assert.ok(window.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("האתגר הושלם"));

  // A second, unrelated positive delta must never re-fire CHALLENGE_COMPLETED.
  const input2 = window.document.querySelector('[data-challenge-log-delta]');
  if (input2) {
    input2.value = "1";
    input2.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
});

test("individual_performance: the number keeps counting past target while the bar caps visually at 100%, and a leaderboard renders", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_performance", title: "20 ק\"מ חתירה", description: "", metric_type: "km_rowing", target_value: 20, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 25, completed_at: null },
      { challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 10, completed_at: null },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"]'), 3000);
  await waitFor(() => window.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("25"), 3000);
  const dlg = window.document.querySelector('[data-cloud-dialog="challengeView"]');
  assert.match(dlg.textContent, /25 \/ 20/, "the number keeps counting past the target");
  const bar = dlg.querySelector(".progress-track > div");
  assert.equal(bar.getAttribute("style").includes("width:100%"), true, "the bar caps visually at 100%");
  assert.match(dlg.textContent, /נועם/, "the leaderboard lists the other participant");
});

// ===== Launch-readiness audit item 1: onPrCreatedForChallenges ===========
// Real end-to-end regression, through the real app.js PR-detection path
// (window.saveSet -> emitCommunityPrCreated -> the real product event bus)
// into the real cloud.js listener and a real challenge_progress insert
// (executed against the mock client's applyChallengeProgressInserts, not a
// source-text match). Before this fix, emitCommunityPrCreated only ever
// carried formatted display strings, onPrCreatedForChallenges' Number(value)
// was NaN on every real PR, and this whole path had never fired once.
test("a real PR, end to end: an individual_performance challenge whose free-text metric_type matches the movement case/whitespace-insensitively gets the raw numeric PR value as progress", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_performance", title: "הכי כבד בסקוואט אחורי", description: "", metric_type: "  Back Squat PR  ", target_value: 500, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);

  await window.addMovement("back squat pr", "Squat");
  window.applyFieldValue("step", "weight", 120);
  window.applyFieldValue("step", "reps", 5);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();

  await waitFor(() => mock.db.challenge_progress.some((p) => p.challenge_id === "c1" && p.source_type === "pr_created"), 3000);
  const row = mock.db.challenge_progress.find((p) => p.challenge_id === "c1" && p.source_type === "pr_created");
  assert.equal(row.delta, 120, "the raw weight drives the delta, not the formatted display string previously read (and always NaN)");
  await waitFor(() => {
    const part = mock.db.challenge_participants.find((p) => p.challenge_id === "c1" && p.user_id === "u1");
    return part && part.progress_value === 120;
  }, 3000);
});

test("a real PR on a movement that does not match the challenge's metric_type logs no progress at all", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_performance", title: "כמה שיותר בלחיצת חזה", description: "", metric_type: "Bench Press", target_value: 200, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);

  await window.addMovement("Deadlift Metric Mismatch", "Deadlift");
  window.applyFieldValue("step", "weight", 150);
  window.applyFieldValue("step", "reps", 3);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();

  // Give any (wrongly-firing) async progress insert a tick to land before
  // asserting its absence.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(mock.db.challenge_progress.filter((p) => p.challenge_id === "c1").length, 0, "a mismatched movement never counts toward this challenge");
});

test("leaving a challenge deletes the participant row but keeps prior challenge_progress rows", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 12, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 4, completed_at: null }],
    challenge_progress: [{ id: "p1", challenge_id: "c1", user_id: "u1", delta: 4, source_type: "manual", created_at: iso(-1) }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="leave-challenge"]'), 3000);
  window.document.querySelector('[data-community-action="leave-challenge"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => !mock.db.challenge_participants.some((p) => p.challenge_id === "c1" && p.user_id === "u1"), 3000);
  assert.equal(mock.db.challenge_progress.length, 1, "the append-only progress log is not touched by leaving");
});

// Launch-readiness audit item 5. challenge_progress has no FK to
// challenge_participants (only to challenges and profiles), so a leave's
// delete of the participant row never touches it - confirmed against
// 202608280009 directly. A rejoin's fresh challenge_participants insert
// used to rely on the table's own default progress_value of 0, silently
// losing every prior contribution from the member's own point of view even
// though it was never actually deleted.
test("rejoining after leaving re-sums prior challenge_progress into the new participant row instead of starting back at 0", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 12, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    // No challenge_participants row - this member already left - but the
    // append-only log from before that leave is still real, live data.
    challenge_progress: [
      { id: "p1", challenge_id: "c1", user_id: "u1", delta: 4, source_type: "manual", created_at: iso(-3) },
      { id: "p2", challenge_id: "c1", user_id: "u1", delta: 3, source_type: "manual", created_at: iso(-1) },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="join-challenge"]').click();
  await waitFor(() => mock.db.challenge_participants.some((p) => p.challenge_id === "c1" && p.user_id === "u1"), 3000);
  const part = mock.db.challenge_participants.find((p) => p.challenge_id === "c1" && p.user_id === "u1");
  assert.equal(part.progress_value, 7, "the rejoin seeds progress from the real, still-existing append-only log, not the table default of 0");
  assert.equal(part.status, "active");
});

test("rejoining an individual_target challenge whose prior total already reached the target lands the new row as completed, not active at zero", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 5, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_progress: [{ id: "p1", challenge_id: "c1", user_id: "u1", delta: 6, source_type: "manual", created_at: iso(-1) }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="join-challenge"]').click();
  await waitFor(() => mock.db.challenge_participants.some((p) => p.challenge_id === "c1" && p.user_id === "u1"), 3000);
  const part = mock.db.challenge_participants.find((p) => p.challenge_id === "c1" && p.user_id === "u1");
  assert.equal(part.progress_value, 6);
  assert.equal(part.status, "completed", "a rejoin that already cleared the target does not silently reset to active");
});

test("cooperative: the club aggregate, percent, days remaining and a recent-contributors list render, omitting a member who turned visible_to_club off", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "cooperative", title: "1000 סשנים למועדון", description: "", metric_type: "session_count", target_value: 1000, start_at: iso(-10), end_at: iso(10), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-9), status: "active", progress_value: 300, completed_at: null },
      { challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: null, joined_at: iso(-9), status: "active", progress_value: 200, completed_at: null },
    ],
    challenge_progress: [
      { id: "p1", challenge_id: "c1", user_id: "u1", delta: 300, source_type: "manual", created_at: iso(-2), profiles: { display_name: "דנה", handle: "dana", visible_to_club: true } },
      { id: "p2", challenge_id: "c1", user_id: "u2", delta: 200, source_type: "manual", created_at: iso(-1), profiles: { display_name: "נועם", handle: "noam", visible_to_club: false } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"]'), 3000);
  await waitFor(() => window.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("500"), 3000);
  const dlg = window.document.querySelector('[data-cloud-dialog="challengeView"]');
  assert.match(dlg.textContent, /500 \/ 1000/, "club_total sums every participant's delta");
  assert.match(dlg.textContent, /50% מהיעד/);
  assert.match(dlg.textContent, /ימים נותרו/);
  assert.match(dlg.textContent, /דנה/, "a visible contributor is named");
  assert.doesNotMatch(dlg.textContent, /נועם/, "a contributor with visible_to_club off is omitted from the named list, even though their delta still counted");
});

test("crossing a cooperative milestone posts an authorless POST_CHALLENGE update, rendered by the real challenge card in the feed", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "cooperative", title: "1000 סשנים למועדון", description: "", metric_type: "session_count", target_value: 100, start_at: iso(-10), end_at: iso(10), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="join-challenge"]').click();
  await waitFor(() => mock.db.challenge_participants.some((p) => p.challenge_id === "c1" && p.user_id === "u1"), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-challenge-log-delta]'), 3000);
  const input = window.document.querySelector('[data-challenge-log-delta]');
  input.value = "60";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="challenge-log-submit"]').click();
  await waitFor(() => mock.db.workout_posts.some((p) => p.post_type === "POST_CHALLENGE" && p.metadata && p.metadata.milestone === 50), 3000);
  // A single 60-point contribution against a target of 100 crosses both the
  // 25% and the 50% threshold in the same transaction (challenge_progress_
  // apply posts once per newly-crossed threshold, not just the highest) -
  // pick the 50% one specifically rather than "whichever came first".
  const post = mock.db.workout_posts.find((p) => p.post_type === "POST_CHALLENGE" && p.metadata && p.metadata.milestone === 50);
  assert.equal(post.author_id, null, "the milestone post is authorless");
  const html = window.renderPostCard(post);
  assert.match(html, /50% מהיעד הושלמו/, "the upgraded POST_CHALLENGE card shows the milestone, not just a bare link");
  assert.ok(html.includes('data-community-action="open-challenge"'), "the card still offers the open-challenge action");
});

test("team: per-team totals render, and a joined member with no team yet can pick one", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "team", title: "בוקר נגד ערב", description: "", metric_type: "session_count", target_value: null, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר" }, { id: "t-evening", challenge_id: "c1", name: "קבוצת ערב" }],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null },
      { challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 7, completed_at: null },
    ],
    challenge_progress: [{ id: "p1", challenge_id: "c1", user_id: "u2", team_id: "t-morning", delta: 7, source_type: "manual", created_at: iso(-1) }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"]'), 3000);
  await waitFor(() => window.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("קבוצת בוקר"), 3000);
  const dlg = window.document.querySelector('[data-cloud-dialog="challengeView"]');
  assert.match(dlg.textContent, /קבוצת בוקר/);
  assert.match(dlg.textContent, /קבוצת ערב/);
  const pickBtn = dlg.querySelector('[data-community-action="challenge-pick-team"][data-team="t-evening"]');
  assert.ok(pickBtn, "a joined, teamless member is offered a team pick");
  pickBtn.click();
  await waitFor(() => {
    const part = mock.db.challenge_participants.find((p) => p.challenge_id === "c1" && p.user_id === "u1");
    return part && part.team_id === "t-evening";
  }, 3000);
});

test("team: leaving clears team_id but the departed member's prior contribution stays in their team's total", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "team", title: "בוקר נגד ערב", description: "", metric_type: "session_count", target_value: null, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר" }, { id: "t-evening", challenge_id: "c1", name: "קבוצת ערב" }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 5, completed_at: null }],
    challenge_progress: [{ id: "p1", challenge_id: "c1", user_id: "u1", team_id: "t-morning", delta: 5, source_type: "manual", created_at: iso(-1) }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="leave-challenge"]'), 3000);
  window.document.querySelector('[data-community-action="leave-challenge"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => !mock.db.challenge_participants.some((p) => p.challenge_id === "c1" && p.user_id === "u1"), 3000);
  const { data } = await mock.client.rpc("chal_progress", { challenge_id: "c1" });
  const morning = data.team_totals.find((t) => t.team_id === "t-morning");
  assert.equal(morning.total, 5, "a departed member's team total contribution stays counted");
});

test("auto-assign join_mode balances the joiner onto whichever team has fewer active participants", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "team", title: "בוקר נגד ערב", description: "", metric_type: "session_count", target_value: null, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "auto", visibility: "club", created_by: "coach1", config: {} }],
    challenge_teams: [{ id: "t-morning", challenge_id: "c1", name: "קבוצת בוקר" }, { id: "t-evening", challenge_id: "c1", name: "קבוצת ערב" }],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null },
      { challenge_id: "c1", user_id: "coach1", club_id: "club-1", team_id: "t-morning", joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="join-challenge"]').click();
  await waitFor(() => mock.db.challenge_participants.some((p) => p.challenge_id === "c1" && p.user_id === "u1"), 3000);
  await waitFor(() => {
    const me = mock.db.challenge_participants.find((p) => p.challenge_id === "c1" && p.user_id === "u1");
    return me && me.team_id === "t-evening";
  }, 3000);
});

// Launch-readiness audit item 2. This tap used to just call
// submitChallengeLog() with a hardcoded delta of 1 on every click, no read
// of anything real - a member could log as many "weeks hit" as they liked
// regardless of whether they had actually trained. It now reads the
// member's own attendance_log rows for the current ISO week (real,
// server-recorded, per-day) and only logs a delta once that count reaches
// config.times_per_week.
test("consistency: with enough real attendance_log rows this week, the tap logs a week hit and completes at the full count", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "consistency", title: "3 בשבוע, 4 שבועות", description: "", metric_type: "session_count", target_value: null, start_at: iso(-1), end_at: iso(27), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: { times_per_week: 3, weeks: 4 } }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 3, completed_at: null }],
    attendance_log: [attended("u1", 0), attended("u1", 1), attended("u1", 2)],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-log-week-hit"]'), 3000);
  const dlg = window.document.querySelector('[data-cloud-dialog="challengeView"]');
  assert.match(dlg.textContent, /3 מתוך 4 שבועות/);
  window.document.querySelector('[data-community-action="challenge-log-week-hit"]').click();
  await waitFor(() => {
    const part = mock.db.challenge_participants.find((p) => p.challenge_id === "c1" && p.user_id === "u1");
    return part && part.progress_value === 4 && part.status === "completed";
  }, 3000);
  const row = mock.db.challenge_progress.find((p) => p.challenge_id === "c1" && p.user_id === "u1" && p.source_type === "attendance_week_hit");
  assert.ok(row, "the logged progress row is attributed to real attendance, not a manual entry");
});

test("consistency: without enough real attendance this week, the tap logs nothing and shows an error instead of silently accepting the click", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "consistency", title: "3 בשבוע, 4 שבועות", description: "", metric_type: "session_count", target_value: null, start_at: iso(-1), end_at: iso(27), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: { times_per_week: 3, weeks: 4 } }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 3, completed_at: null }],
    // Only one real attendance day this week - short of the times_per_week: 3 target.
    attendance_log: [attended("u1", 0)],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-log-week-hit"]'), 3000);
  window.document.querySelector('[data-community-action="challenge-log-week-hit"]').click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"] .field-error'), 3000);
  const dlg = window.document.querySelector('[data-cloud-dialog="challengeView"]');
  assert.match(dlg.textContent, /1 מתוך 3/, "the error names the real shortfall");
  const part = mock.db.challenge_participants.find((p) => p.challenge_id === "c1" && p.user_id === "u1");
  assert.equal(part.progress_value, 3, "no unearned progress is logged");
  assert.equal(part.status, "active");
  assert.equal(mock.db.challenge_progress.filter((p) => p.challenge_id === "c1").length, 0, "no challenge_progress row is written for a week that was not actually earned");
});

test("consistency: a second tap in the same already-logged week is refused, even though the append-only table has no server constraint stopping the insert", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "consistency", title: "3 בשבוע, 4 שבועות", description: "", metric_type: "session_count", target_value: null, start_at: iso(-1), end_at: iso(27), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: { times_per_week: 3, weeks: 4 } }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 1, completed_at: null }],
    attendance_log: [attended("u1", 0), attended("u1", 1), attended("u1", 2)],
    // A week hit already logged for this same ISO week (today), the same
    // real signal a first successful tap would have written.
    challenge_progress: [{ id: "p-already", challenge_id: "c1", user_id: "u1", delta: 1, source_type: "attendance_week_hit", created_at: new Date().toISOString() }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-log-week-hit"]'), 3000);
  window.document.querySelector('[data-community-action="challenge-log-week-hit"]').click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"] .field-error'), 3000);
  assert.equal(mock.db.challenge_progress.filter((p) => p.challenge_id === "c1").length, 1, "the repeat tap inserts no second row for the same week");
});

test("consistency: a joined member with no progress yet sees the first-week empty state", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "consistency", title: "3 בשבוע, 4 שבועות", description: "", metric_type: "session_count", target_value: null, start_at: iso(-1), end_at: iso(27), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: { times_per_week: 3, weeks: 4 } }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 0, completed_at: null }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"]'), 3000);
  await waitFor(() => window.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("השבוע הראשון בעיצומו"), 3000);
});

test("coach challenge: a plain member never sees the manual entry roster, a challenge.create holder does and chal_record_progress updates standing", async () => {
  const challenge = { id: "c1", challenge_type: "coach", title: "הכי הרבה בורפיז", description: "", metric_type: "custom", target_value: null, start_at: iso(-3), end_at: iso(10), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: { rules_text: "100 בורפיז בשבוע, ספירה עצמית", metric_label: "בורפיז" } };
  const participants = [{ challenge_id: "c1", user_id: "u2", club_id: "club-1", team_id: null, joined_at: iso(-2), status: "active", progress_value: 40, completed_at: null }];

  const memberMock = seeded({ challenges: [challenge], challenge_participants: participants }, false);
  const memberWindow = await bootCommunity(memberMock, { syncEnabled: false });
  await openBoards(memberWindow);
  await waitFor(() => !!memberWindow.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(memberWindow, "c1");
  await waitFor(() => !!memberWindow.document.querySelector('[data-cloud-dialog="challengeView"]'), 3000);
  await waitFor(() => memberWindow.document.querySelector('[data-cloud-dialog="challengeView"]').textContent.includes("הכי הרבה בורפיז"), 3000);
  assert.equal(memberWindow.document.querySelector('[data-community-action="challenge-coach-submit"]'), null, "a plain member never sees the coach entry control");

  const staffMock = seeded({ challenges: [challenge], challenge_participants: participants.map((p) => ({ ...p })) }, true);
  const staffWindow = await bootCommunity(staffMock, { syncEnabled: false });
  await openBoards(staffWindow);
  await waitFor(() => !!staffWindow.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(staffWindow, "c1");
  await waitFor(() => !!staffWindow.document.querySelector('[data-challenge-coach-delta="u2"]'), 3000);
  const deltaInput = staffWindow.document.querySelector('[data-challenge-coach-delta="u2"]');
  deltaInput.value = "15";
  deltaInput.dispatchEvent(new staffWindow.Event("input", { bubbles: true }));
  staffWindow.document.querySelector('[data-community-action="challenge-coach-submit"][data-id="u2"]').click();
  await waitFor(() => {
    const p = staffMock.db.challenge_participants.find((x) => x.challenge_id === "c1" && x.user_id === "u2");
    return p && p.progress_value === 55;
  }, 3000);
  const entry = staffMock.db.challenge_progress.find((p) => p.user_id === "u2" && p.entered_by === "u1");
  assert.equal(entry.source_type, "coach_entry");
});

test("a coach can create an individual_target challenge through the form, and it appears in the list as a draft until published", async () => {
  const window = await bootCommunity(seeded({}, true), { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="open-challenge-form"]'), 3000);
  window.document.querySelector('[data-community-action="open-challenge-form"]').click();
  await waitFor(() => !!window.document.getElementById("communityChallengeForm"), 3000);
  const form = window.document.getElementById("communityChallengeForm");
  form.querySelector('input[name="title"]').value = "10 אימונים בספטמבר";
  form.querySelector('textarea[name="description"]').value = "יעד חודשי";
  form.querySelector('input[name="metricType"]').value = "session_count";
  form.querySelector('input[name="targetValue"]').value = "10";
  form.querySelector('input[name="startAt"]').value = "2026-09-01";
  form.querySelector('input[name="endAt"]').value = "2026-09-30";
  submit(window, "communityChallengeForm");
  await waitFor(() => !!window.document.querySelector('[data-challenge-status="draft"]'), 3000);
  const created = window.document.querySelector('[data-challenge-status="draft"]');
  assert.match(created.textContent, /10 אימונים בספטמבר/);
});

test("the same form edits an existing challenge (title, target) and can publish a draft or archive an active one", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "טיוטה ראשונית", description: "", metric_type: "session_count", target_value: 8, start_at: iso(1), end_at: iso(20), status: "draft", join_mode: "open", visibility: "club", created_by: "u1", config: {} }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-edit"]'), 3000);
  window.document.querySelector('[data-community-action="challenge-edit"]').click();
  await waitFor(() => !!window.document.getElementById("communityChallengeForm"), 3000);
  const form = window.document.getElementById("communityChallengeForm");
  form.querySelector('input[name="title"]').value = "יעד עודכן";
  form.querySelector('input[name="targetValue"]').value = "10";
  submit(window, "communityChallengeForm");
  await waitFor(() => mock.db.challenges.find((c) => c.id === "c1").title === "יעד עודכן", 3000);
  assert.equal(mock.db.challenges.find((c) => c.id === "c1").target_value, 10);

  window.document.querySelector('[data-community-action="challenge-edit"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-publish"]'), 3000);
  window.document.querySelector('[data-community-action="challenge-publish"]').click();
  await waitFor(() => mock.db.challenges.find((c) => c.id === "c1").status === "active", 3000);

  window.document.querySelector('[data-community-action="challenge-edit"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-archive"]'), 3000);
  window.document.querySelector('[data-community-action="challenge-archive"]').click();
  await waitFor(() => mock.db.challenges.find((c) => c.id === "c1").status === "archived", 3000);
});

// Launch-readiness audit item 4. submitChallengeForm's edit path used to
// write `config` built fresh from only the CURRENT form type's fields
// straight over the whole config column, so any key that form does not
// manage silently vanished on every edit save - even a save that only
// touched the title.
test("editing a coach challenge through the form preserves a config key the form itself never shows (e.g. image_url), while still saving the fields it does show", async () => {
  const mock = seeded({
    challenges: [{
      id: "c1", challenge_type: "coach", title: "הכי הרבה בורפיז", description: "", metric_type: "custom",
      target_value: null, start_at: iso(1), end_at: iso(20), status: "draft", join_mode: "open", visibility: "club",
      created_by: "u1",
      // image_url is not one of the two keys the coach-type form manages
      // (rules_text, metric_label) - a stand-in for "any key not on the
      // currently-shown form".
      config: { rules_text: "100 בורפיז בשבוע", metric_label: "בורפיז", image_url: "https://example.test/banner.jpg" },
    }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-edit"]'), 3000);
  window.document.querySelector('[data-community-action="challenge-edit"]').click();
  await waitFor(() => !!window.document.getElementById("communityChallengeForm"), 3000);
  const form = window.document.getElementById("communityChallengeForm");
  form.querySelector('input[name="title"]').value = "הכי הרבה בורפיז - עודכן";
  submit(window, "communityChallengeForm");
  await waitFor(() => mock.db.challenges.find((c) => c.id === "c1").title === "הכי הרבה בורפיז - עודכן", 3000);
  const saved = mock.db.challenges.find((c) => c.id === "c1");
  assert.equal(saved.config.image_url, "https://example.test/banner.jpg", "a config key the form never displayed survives an unrelated edit");
  assert.equal(saved.config.rules_text, "100 בורפיז בשבוע", "the field the form does manage still round-trips");
  assert.equal(saved.config.metric_label, "בורפיז");
});

test("editing a coach challenge and blanking out the metric_label field actually clears it, rather than the merge reviving the old value", async () => {
  const mock = seeded({
    challenges: [{
      id: "c1", challenge_type: "coach", title: "הכי הרבה בורפיז", description: "", metric_type: "custom",
      target_value: null, start_at: iso(1), end_at: iso(20), status: "draft", join_mode: "open", visibility: "club",
      created_by: "u1", config: { rules_text: "100 בורפיז בשבוע", metric_label: "בורפיז" },
    }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="challenge-edit"]'), 3000);
  window.document.querySelector('[data-community-action="challenge-edit"]').click();
  await waitFor(() => !!window.document.getElementById("communityChallengeForm"), 3000);
  const form = window.document.getElementById("communityChallengeForm");
  form.querySelector('input[name="metricLabel"]').value = "";
  submit(window, "communityChallengeForm");
  await waitFor(() => !window.document.getElementById("communityChallengeForm"), 3000);
  const saved = mock.db.challenges.find((c) => c.id === "c1");
  assert.equal(saved.config.metric_label, undefined, "a field the member intentionally blanked stays cleared rather than being merged back in");
  assert.equal(saved.config.rules_text, "100 בורפיז בשבוע");
});

test("the challenge create form rejects an end date before the start date and a team challenge with fewer than two team names", async () => {
  const window = await bootCommunity(seeded({}, true), { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="open-challenge-form"]'), 3000);
  window.document.querySelector('[data-community-action="open-challenge-form"]').click();
  await waitFor(() => !!window.document.getElementById("communityChallengeForm"), 3000);
  const form = window.document.getElementById("communityChallengeForm");
  form.querySelector('input[name="title"]').value = "אתגר";
  form.querySelector('input[name="metricType"]').value = "session_count";
  form.querySelector('input[name="startAt"]').value = "2026-09-30";
  form.querySelector('input[name="endAt"]').value = "2026-09-01";
  submit(window, "communityChallengeForm");
  await waitFor(() => !!window.document.querySelector(".field-error"), 3000);
  assert.match(window.document.body.textContent, /תאריך הסיום חייב להיות אחרי ההתחלה/);
});

test("Share Progress calls post_create with the challenge context in the body", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 12, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 5, completed_at: null }],
  });
  let createCall = null;
  mock.onRpc("post_create", (args) => { createCall = args; return { data: "post-1", error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  openChallengeCard(window, "c1");
  await waitFor(() => !!window.document.querySelector('[data-community-action="share-challenge-progress"]'), 3000);
  window.document.querySelector('[data-community-action="share-challenge-progress"]').click();
  await waitFor(() => !!createCall, 3000);
  assert.match(createCall.body, /12 אימונים החודש/);
  assert.match(createCall.body, /5 \/ 12/);
  assert.equal(createCall.links.challenge_id, "c1");
});

test("the challenge detail dialog closes on Escape and returns focus to the opener", async () => {
  const mock = seeded({
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 12, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  const opener = window.document.querySelector('[data-challenge-id="c1"] [data-community-action="open-challenge"]');
  opener.click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="challengeView"]'), 3000);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !window.document.querySelector('[data-cloud-dialog="challengeView"]'), 3000);
});
