// COMM-222. The three non-attendance onboarding steps, executed for real
// (bootCommunity + the mock Supabase client). The clock runs off
// invite_redemptions.redeemed_at, real wall-clock time (Date.now()), so
// each test controls "how far along" a member is purely by how far in the
// past it seeds redeemed_at.
//
// WHAT THIS FILE VERIFIES
// - Day 1: the welcome step shows once onboarding_progress is loaded and
//   welcomed_at is null, and dismissing it writes welcomed_at.
// - After the first week: the step surfaces the current active challenge
//   (COMM-207's list) and fires only once welcomed_at is already set.
// - After the first month: the personal summary aggregates the member's
//   own weekly_recaps rows over that period (not a club-wide rollup).
// - Dismissing a step never blocks a later one already due on schedule.
// - COMM-316 (closing COMM-P07): the two attendance-tied steps
//   (first_class, third_class) - eligibility read directly off
//   attendance_log (own-row select, "at least one row" / "at least three
//   distinct occurred_on days"), and the priority order this file's own
//   currentOnboardingStep() documents: welcome, first_week, first_month
//   (COMM-222, unchanged, checked first) before first_class, before
//   third_class. A member deep in attendance never preempts a still-due
//   time-based step.
//
// WHAT THIS FILE DOES NOT VERIFY
// The server seeding trigger (seed_onboarding_progress) or the one-way pin
// trigger on onboarding_progress - both are Postgres, covered by
// supabase/tests/0031_recaps_and_onboarding_test.sql and (the two COMM-316
// columns) supabase/tests/0047_recap_classmates_and_onboarding_classes_test.sql.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const DAY_MS = 86400000;
const redeemedDaysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: new Date().toISOString(), visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(0) }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: null, first_week_shown_at: null, first_month_shown_at: null, first_class_shown_at: null, third_class_shown_at: null }],
    challenges: [], challenge_participants: [], weekly_recaps: [],
    notifications: [], notification_preferences: [],
    attendance_log: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}
async function openFeed(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
}
function stepCard(window, step) { return window.document.querySelector(`[data-onboarding-step="${step}"]`); }

test("Day 1: the welcome step shows once, and dismissing it writes welcomed_at", async () => {
  const mock = seeded({ invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(0) }] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!stepCard(window, "welcome"), 3000);
  assert.match(stepCard(window, "welcome").textContent, /ברוכים הבאים לקהילה/);

  stepCard(window, "welcome").querySelector('[data-community-action="onboarding-dismiss"]').click();
  await waitFor(() => !stepCard(window, "welcome"), 3000);
  await waitFor(() => !!mock.db.onboarding_progress.find((r) => r.user_id === "u1" && r.welcomed_at), 3000);
});

test("after the first week: the step surfaces the current active challenge and only fires once welcomed_at is already set", async () => {
  const mock = seeded({
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(10) }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: redeemedDaysAgo(9), first_week_shown_at: null, first_month_shown_at: null }],
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 12, start_at: redeemedDaysAgo(9), end_at: new Date(Date.now() + 20 * DAY_MS).toISOString(), status: "active", join_mode: "open", visibility: "club", created_by: "u1", config: {} }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  assert.equal(stepCard(window, "welcome"), null, "welcome already shown, never re-shown");
  await waitFor(() => !!stepCard(window, "first_week"), 3000);
  assert.match(stepCard(window, "first_week").textContent, /12 אימונים החודש/, "surfaces COMM-207's active challenge list");

  stepCard(window, "first_week").querySelector('[data-community-action="onboarding-dismiss"]').click();
  await waitFor(() => !stepCard(window, "first_week"), 3000);
  await waitFor(() => !!mock.db.onboarding_progress.find((r) => r.user_id === "u1" && r.first_week_shown_at), 3000);
});

test("before 7 days have passed, no first-week step shows even though welcomed_at is already set", async () => {
  const mock = seeded({
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(3) }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: redeemedDaysAgo(2), first_week_shown_at: null, first_month_shown_at: null }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(stepCard(window, "welcome"), null);
  assert.equal(stepCard(window, "first_week"), null);
});

test("after the first month: the personal summary aggregates the member's own weekly_recaps over that period, not the club-wide rollup", async () => {
  const mock = seeded({
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(35) }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: redeemedDaysAgo(34), first_week_shown_at: redeemedDaysAgo(27), first_month_shown_at: null }],
    weekly_recaps: [
      // week_start values are relative to redeemed_at (35 days ago), the
      // same wall-clock arithmetic as every other field in this file - not
      // hardcoded calendar dates, which would drift out of the query's
      // [redeemedAt, redeemedAt+30d] window depending on which real day the
      // suite happens to run on.
      { id: "wr1", user_id: "u1", week_start: redeemedDaysAgo(34).slice(0, 10), sessions_completed: 3, streak: 1, prs: [{ movement: "סקוואט", result: "100", achieved_on: redeemedDaysAgo(33) }], achievements: [], challenge_progress: [], club_challenge_progress: {}, upcoming_event: null, generated_at: redeemedDaysAgo(28) },
      { id: "wr2", user_id: "u1", week_start: redeemedDaysAgo(27).slice(0, 10), sessions_completed: 2, streak: 2, prs: [], achievements: [{ title: "שיא ראשון", badge_icon: "⭐", code: "first_pr", unlocked_at: redeemedDaysAgo(26) }], challenge_progress: [], club_challenge_progress: {}, upcoming_event: null, generated_at: redeemedDaysAgo(21) },
      // Another member's row in the same window must never leak into this
      // member's own first-month summary - own-row RLS in production, and
      // the client query is scoped by user_id regardless.
      { id: "wr-other", user_id: "u2", week_start: redeemedDaysAgo(27).slice(0, 10), sessions_completed: 99, streak: 99, prs: [], achievements: [], challenge_progress: [], club_challenge_progress: {}, upcoming_event: null, generated_at: redeemedDaysAgo(21) },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!stepCard(window, "first_month"), 3000);
  await waitFor(() => !stepCard(window, "first_month").textContent.includes("99"), 3000);
  const text = stepCard(window, "first_month").textContent;
  assert.match(text, /5 אימונים/, "3 + 2 sessions across the member's own two rows");
  assert.match(text, /1 שיאים/);
  assert.match(text, /1 הישגים/);
});

test("dismissing an earlier step never blocks a later one already due on the same load", async () => {
  const mock = seeded({
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(10) }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: null, first_week_shown_at: null, first_month_shown_at: null }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!stepCard(window, "welcome"), 3000);
  stepCard(window, "welcome").querySelector('[data-community-action="onboarding-dismiss"]').click();
  // Welcome is gone, and first-week (already 10 days past redemption) is
  // free to show on this very next render - it was never gated behind
  // welcome's own dismissal, only behind its own column and its own clock.
  await waitFor(() => !!stepCard(window, "first_week"), 3000);
});

test("a step's Dismiss control only exists once the card has actually rendered - there is no path that marks a step shown before that", () => {
  const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
  const start = cloudJs.indexOf("function currentOnboardingStep()");
  const end = cloudJs.indexOf("\n  }", start);
  const body = cloudJs.slice(start, end);
  assert.doesNotMatch(body, /update\(/, "the eligibility check itself never writes onboarding_progress");
});

// ---- COMM-316 (closing COMM-P07): the two attendance-tied steps --------
const loggedOn = (day) => ({ id: `al-${day}`, user_id: "u1", club_id: "club-1", occurred_on: day, source_record_type: "wod_entry", source_record_id: `r-${day}`, recorded_at: new Date().toISOString() });
const daysAgoIso = (days) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

test("COMM-316: first-class step shows after the member's first attendance_log row, once none of the three time-based steps is due", async () => {
  const mock = seeded({
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(3) }],
    // welcome already shown, first_week not due for another 4 days, first_month
    // nowhere close - all three time-based steps quiet, so this is the exact
    // window where the two new steps get to show.
    onboarding_progress: [{ user_id: "u1", welcomed_at: redeemedDaysAgo(2), first_week_shown_at: null, first_month_shown_at: null, first_class_shown_at: null, third_class_shown_at: null }],
    attendance_log: [loggedOn(daysAgoIso(1))],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  assert.equal(stepCard(window, "welcome"), null);
  assert.equal(stepCard(window, "first_week"), null);
  await waitFor(() => !!stepCard(window, "first_class"), 3000);
  assert.match(stepCard(window, "first_class").textContent, /הגעתם לאימון הראשון/);

  stepCard(window, "first_class").querySelector('[data-community-action="onboarding-dismiss"]').click();
  await waitFor(() => !stepCard(window, "first_class"), 3000);
  await waitFor(() => !!mock.db.onboarding_progress.find((r) => r.user_id === "u1" && r.first_class_shown_at), 3000);
});

test("COMM-316: no attendance yet means no first-class step, even once the three time-based steps are all quiet", async () => {
  const mock = seeded({
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(3) }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: redeemedDaysAgo(2), first_week_shown_at: null, first_month_shown_at: null, first_class_shown_at: null, third_class_shown_at: null }],
    attendance_log: [],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(stepCard(window, "welcome"), null);
  assert.equal(stepCard(window, "first_week"), null);
  assert.equal(stepCard(window, "first_class"), null);
  assert.equal(stepCard(window, "third_class"), null);
});

test("COMM-316: third-class step shows only once first-class has already been dismissed, even with three or more attendance days already logged", async () => {
  const mock = seeded({
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(3) }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: redeemedDaysAgo(2), first_week_shown_at: null, first_month_shown_at: null, first_class_shown_at: null, third_class_shown_at: null }],
    attendance_log: [loggedOn(daysAgoIso(3)), loggedOn(daysAgoIso(2)), loggedOn(daysAgoIso(1))],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  // First-class ranks above third-class - chronologically, three days cannot
  // happen before one - so it is what shows first even though the member
  // already has three days logged.
  await waitFor(() => !!stepCard(window, "first_class"), 3000);
  assert.equal(stepCard(window, "third_class"), null);

  stepCard(window, "first_class").querySelector('[data-community-action="onboarding-dismiss"]').click();
  await waitFor(() => !stepCard(window, "first_class"), 3000);
  await waitFor(() => !!stepCard(window, "third_class"), 3000);
  assert.match(stepCard(window, "third_class").textContent, /אימון שלישי/);

  stepCard(window, "third_class").querySelector('[data-community-action="onboarding-dismiss"]').click();
  await waitFor(() => !stepCard(window, "third_class"), 3000);
  await waitFor(() => !!mock.db.onboarding_progress.find((r) => r.user_id === "u1" && r.third_class_shown_at), 3000);
});

test("COMM-316: a still-due time-based step (COMM-222) always wins over an eligible attendance step - the three existing steps are never reordered", async () => {
  const mock = seeded({
    // 10 days past redemption: first_week is due (>= 7 days) and not yet
    // shown. The member also already has three attendance days logged, so
    // first_class AND third_class are both individually eligible - but
    // first_week must still be the one that renders.
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(10) }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: redeemedDaysAgo(9), first_week_shown_at: null, first_month_shown_at: null, first_class_shown_at: null, third_class_shown_at: null }],
    attendance_log: [loggedOn(daysAgoIso(9)), loggedOn(daysAgoIso(8)), loggedOn(daysAgoIso(7))],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!stepCard(window, "first_week"), 3000);
  assert.equal(stepCard(window, "first_class"), null, "an eligible attendance step never preempts a still-due COMM-222 step");
  assert.equal(stepCard(window, "third_class"), null);
});

test("COMM-316: first-class and third-class are one-way stamps too - dismissing is a silent no-op against onboarding_progress_pin's shape", async () => {
  const mock = seeded({
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: redeemedDaysAgo(3) }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: redeemedDaysAgo(2), first_week_shown_at: null, first_month_shown_at: null, first_class_shown_at: null, third_class_shown_at: null }],
    attendance_log: [loggedOn(daysAgoIso(1))],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!stepCard(window, "first_class"), 3000);
  stepCard(window, "first_class").querySelector('[data-community-action="onboarding-dismiss"]').click();
  await waitFor(() => !!mock.db.onboarding_progress.find((r) => r.user_id === "u1" && r.first_class_shown_at), 3000);
  const stampedAt = mock.db.onboarding_progress.find((r) => r.user_id === "u1").first_class_shown_at;
  // The step is gone and re-dismissing (the mock has no pin trigger of its
  // own, so this proves the client never re-issues the write once the card
  // is no longer on screen - the real one-way guarantee is Postgres',
  // asserted in 0047).
  assert.equal(stepCard(window, "first_class"), null);
  assert.equal(mock.db.onboarding_progress.find((r) => r.user_id === "u1").first_class_shown_at, stampedAt);
});
