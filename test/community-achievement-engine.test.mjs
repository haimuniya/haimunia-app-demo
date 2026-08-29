// COMM-130 / COMM-131 / COMM-134. The non-attendance achievement engine.
// The offline app computes session counts, PR counts and week streaks; when
// the member is in the community those crossings are recorded server-side
// through the ach_claim RPC (ach_evaluate is service-role only). A newly
// claimed unlock shows a celebration and offers an optional share through
// ach_share. Nothing here ever auto-posts. Seed content is in
// docs/community/achievement-seed.md.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERIFIED = new Date().toISOString();

function def(code, over = {}) {
  return Object.assign({
    id: "d-" + code, code, name: code, description: "", category: "consistency",
    trigger_type: "WORKOUT_COMPLETED", threshold: 1, repeatable: false,
    visibility: "club", icon: "🔥", enabled: true, config: { client_claimable: true },
  }, over);
}

function seededMock(defs, extra = {}) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_achievements: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
    achievement_definitions: defs,
    member_achievements: [],
  }, extra));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function bootReady(mock) {
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  return window;
}

test("ach_claim writes once per non-repeatable definition, honours repeatable, and ignores non-claimable and attendance codes", async () => {
  const mock = seededMock([
    def("first_workout"),
    def("rpt_streak", { repeatable: true }),
    def("first_cheer", { category: "community", trigger_type: "REACTION_CREATED", config: {} }),
    def("attendance_first_class", { trigger_type: "ATTENDANCE_RECORDED", enabled: false, config: { client_claimable: true } }),
  ]);
  const window = await bootReady(mock);

  const first = await window.claimCommunityAchievements(["first_workout", "first_workout", "rpt_streak", "first_cheer", "attendance_first_class"]);
  assert.deepEqual(first.map((r) => r.code).sort(), ["first_workout", "rpt_streak"],
    "only enabled, non-attendance, client_claimable codes are accepted");
  assert.equal(mock.db.member_achievements.filter((r) => r.code === "first_workout").length, 1);

  const second = await window.claimCommunityAchievements(["first_workout", "rpt_streak"]);
  assert.deepEqual(second.map((r) => r.code), ["rpt_streak"], "non-repeatable is idempotent, repeatable writes again");
  assert.equal(mock.db.member_achievements.filter((r) => r.code === "first_workout").length, 1, "still one row");
  assert.equal(mock.db.member_achievements.filter((r) => r.code === "rpt_streak").length, 2);
});

test("consistency tolerates a three-times-per-week schedule: four weeks at 3x per week reaches and claims the week-streak milestone", async () => {
  const mock = seededMock([
    def("first_workout"),
    def("sessions_10"),
    def("consistency_weeks_4", { threshold: 4, config: { client_claimable: true, metric: "week_streak" } }),
  ]);
  const window = await bootReady(mock);

  await window.addMovement("Consistency Accessory", "Other"); // "Other" stays out of PR-category counting

  const isoAgo = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); };
  // 3 sessions in each of 4 back-to-back weeks, never on consecutive days.
  const offsets = [3, 5, 7, 10, 12, 14, 17, 19, 21, 24, 26, 28];
  for (const off of offsets) {
    const input = window.document.getElementById("logDateInput");
    input.value = isoAgo(off);
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    window.applyFieldValue("step", "weight", 40);
    window.applyFieldValue("step", "reps", 8);
    window.applyFieldValue("step", "sets", 1);
    await window.saveSet();
  }

  const streak = window.longestWeekStreak();
  assert.ok(streak >= 4, `a member training 3x per week must still build a week streak, got ${streak}`);
  assert.ok(window.communityMilestoneCodes().includes("consistency_weeks_4"),
    "the client evaluates the streak milestone as reached");

  const claimCalls = mock.callsTo("ach_claim");
  assert.ok(claimCalls.some((a) => (a.p_codes || []).includes("consistency_weeks_4")),
    "the crossed week-streak milestone was sent to ach_claim");
  assert.ok(mock.db.member_achievements.some((r) => r.code === "consistency_weeks_4"),
    "and recorded in member_achievements");
});

test("a claimed unlock shows a celebration and Share creates a POST_ACHIEVEMENT via ach_share, never before", async () => {
  const mock = seededMock([def("first_pr", { category: "performance", trigger_type: "PR_CREATED", name: "השיא הראשון" })]);
  const window = await bootReady(mock);

  await window.claimCommunityAchievements(["first_pr"]);
  await waitFor(() => !!window.document.getElementById("achUnlock"), 3000);
  const modal = window.document.getElementById("achUnlock");
  assert.match(modal.textContent, /עיטור חדש נפתח/);
  assert.match(modal.textContent, /השיא הראשון/);
  assert.ok(modal.querySelector('[data-community-action="ach-share"]'), "Share to Club offered");
  assert.ok(modal.querySelector('[data-community-action="ach-not-now"]'), "Not now offered");
  assert.equal(mock.callsTo("ach_share").length, 0, "nothing shared just from the unlock");

  window.document.querySelector('[data-community-action="ach-add-note"]').click();
  await waitFor(() => !!window.document.querySelector("[data-ach-note]"), 3000);
  const note = window.document.querySelector("[data-ach-note]");
  note.value = "סוף סוף";
  note.dispatchEvent(new window.Event("input", { bubbles: true }));

  window.document.querySelector('[data-community-action="ach-share"]').click();
  await waitFor(() => mock.callsTo("ach_share").length === 1, 3000);
  const args = mock.callsTo("ach_share")[0];
  assert.ok(args.member_achievement_id, "the member_achievement id from the claim is passed through");
  assert.equal(args.caption, "סוף סוף");
  assert.deepEqual(args.media, []);
  await waitFor(() => !window.document.getElementById("achUnlock"), 3000);
  assert.ok(mock.db.workout_posts.some((p) => p.post_type === "POST_ACHIEVEMENT"), "a POST_ACHIEVEMENT now exists");
});

test("Not now leaves the achievement earned and unshared", async () => {
  const mock = seededMock([def("sessions_10", { name: "10 אימונים" })]);
  const window = await bootReady(mock);

  await window.claimCommunityAchievements(["sessions_10"]);
  await waitFor(() => !!window.document.getElementById("achUnlock"), 3000);
  window.document.querySelector('[data-community-action="ach-not-now"]').click();
  await waitFor(() => !window.document.getElementById("achUnlock"), 3000);

  assert.equal(mock.callsTo("ach_share").length, 0);
  const row = mock.db.member_achievements.find((r) => r.code === "sessions_10");
  assert.ok(row && !row.shared_at, "row is present and unshared");
});

test("a private-visibility achievement offers no Share", async () => {
  const mock = seededMock([def("sessions_10", { visibility: "only_me" })]);
  const window = await bootReady(mock);

  await window.claimCommunityAchievements(["sessions_10"]);
  await waitFor(() => !!window.document.getElementById("achUnlock"), 3000);
  const modal = window.document.getElementById("achUnlock");
  assert.equal(modal.querySelector('[data-community-action="ach-share"]'), null, "no share for an only_me unlock");
  assert.ok(modal.querySelector('[data-community-action="ach-not-now"]'));
});

test("the Account tab lists an earned badge and offers a later Share for one not yet shared", async () => {
  const mock = seededMock(
    [def("first_pr", { category: "performance", trigger_type: "PR_CREATED", name: "השיא הראשון" })],
    { member_achievements: [{ id: "ma-old", user_id: "u1", achievement_id: "d-first_pr", code: "first_pr", visibility: "club", shared_at: null, unlocked_at: VERIFIED, achievement_definitions: { code: "first_pr" } }] },
  );
  const window = await bootReady(mock);
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="ach-share-later"]'), 3000);

  window.document.querySelector('[data-community-action="ach-share-later"]').click();
  await waitFor(() => !!window.document.getElementById("achUnlock"), 3000);
  window.document.querySelector('[data-community-action="ach-share"]').click();
  await waitFor(() => mock.callsTo("ach_share").length === 1, 3000);
  assert.equal(mock.callsTo("ach_share")[0].member_achievement_id, "ma-old");
});

test("seed doc covers all six categories, keeps codes snake case, is idempotent, and leaves attendance rows to the earlier migration", () => {
  const seed = readFileSync(path.join(ROOT, "docs", "community", "achievement-seed.md"), "utf8");
  for (const cat of ["consistency", "performance", "progress", "community", "challenge", "club"]) {
    assert.ok(seed.includes(`'${cat}'`), `category ${cat} is represented in the seed`);
  }
  assert.match(seed, /on conflict \(code\) do update/, "re-run is idempotent");
  assert.match(seed, /week[_ ]streak/i, "consistency rows are week-streak based");
  assert.match(seed, /שלוש פעמים|three-times-per-week|3x/i, "the 3x per week tolerance is documented");
  assert.ok(!/attendance_first_class|attendance_weekly_streak/.test(seed),
    "the disabled attendance rows stay owned by 202608280007, not this seed");
  // every quoted code literal is lower snake case
  for (const m of seed.matchAll(/\('([a-z0-9_]+)',/g)) {
    assert.match(m[1], /^[a-z][a-z0-9_]{2,63}$/, `${m[1]} is a valid code`);
  }
});

test("contracts.md documents ach_claim as a needed schema function", () => {
  const contracts = readFileSync(path.join(ROOT, "docs", "community", "contracts.md"), "utf8");
  assert.match(contracts, /ach_claim\(p_codes text\[\]\)/);
  assert.match(contracts, /Needs from schema, achievements/);
  assert.match(contracts, /client_claimable/);
});
