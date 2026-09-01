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
// - The two attendance-tied steps (first/third class) are not built here.
//
// WHAT THIS FILE DOES NOT VERIFY
// The server seeding trigger (seed_onboarding_progress) or the one-way pin
// trigger on onboarding_progress - both are Postgres, covered by
// supabase/tests/0031_recaps_and_onboarding_test.sql.
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
    onboarding_progress: [{ user_id: "u1", welcomed_at: null, first_week_shown_at: null, first_month_shown_at: null }],
    challenges: [], challenge_participants: [], weekly_recaps: [],
    notifications: [], notification_preferences: [],
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
