// Covers the smaller additive features from the "look at every tab" roadmap
// round: update notifications, onboarding, streak, recent-history-at-entry,
// and per-day session notes. Drives the real app the same way the rest of
// this suite does — window.<exposedFunction>(...), never a re-implementation
// of the logic under test.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("compareVersions orders semver-like strings numerically, not lexicographically", async () => {
  const window = await bootApp();
  assert.ok(window.compareVersions("2.1.0", "2.0.9") > 0);
  assert.equal(window.compareVersions("2.0.0", "2.0.0"), 0);
  assert.ok(window.compareVersions("1.9.9", "2.0.0") < 0);
  assert.ok(window.compareVersions("2.10.0", "2.9.0") > 0, "10 > 9 numerically, not as strings");
});

test("a fresh install skips the what's-new popup and shows onboarding only after the first welcome", async () => {
  const window = await bootApp();
  // bootApp() starts from a genuinely empty IndexedDB, so this is exactly
  // the fresh-install path init() is meant to special-case.
  assert.equal(window.document.getElementById("welcomeOverlay").classList.contains("open"), true, "welcome modal should be showing");
  assert.equal(window.document.getElementById("notificationsOverlay").classList.contains("open"), false, "no changelog for someone who's never used the app");
  assert.equal(window.document.getElementById("onboardingOverlay").classList.contains("open"), false, "onboarding waits for the welcome form, not shown yet");

  window.saveWelcomeForm("בודק");

  assert.equal(window.document.getElementById("onboardingOverlay").classList.contains("open"), true, "onboarding should appear right after the first-ever welcome");
});

test("editing the profile later (not the first-time welcome) does not re-trigger onboarding", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("בודק"); // first time — opens onboarding
  window.closeOnboarding();
  assert.equal(window.document.getElementById("onboardingOverlay").classList.contains("open"), false);

  window.openWelcomeModal(true); // "edit profile" flow
  window.saveWelcomeForm("שם חדש");
  assert.equal(window.document.getElementById("onboardingOverlay").classList.contains("open"), false, "editing the profile afterward must not show onboarding again");
});

test("computeCurrentStreak counts consecutive logged days backward; today unlogged doesn't break it", async () => {
  const window = await bootApp();
  const iso = (daysAgo) => window.localISODate(new Date(Date.now() - daysAgo * 86400000));

  assert.equal(window.computeCurrentStreak(), 0, "nothing logged yet");

  await window.addMovement("Test Streak Squat", "Squat");
  const movement = window.allMovements().find((m) => m.name === "Test Streak Squat");

  // Seed entries directly via the DB (bypasses needing to drive the date
  // picker through the UI) for today, yesterday, and 2 days ago.
  for (const daysAgo of [0, 1, 2]) {
    await window.dbPut({
      id: `seed-streak-${daysAgo}`, exerciseId: movement.id, date: iso(daysAgo),
      weight: 50, reps: 5, sets: 1, ts: Date.now() - daysAgo * 86400000, isPR: false, est1RM: 50, groupId: null,
    });
  }
  await window.reloadFromDb();
  assert.equal(window.computeCurrentStreak(), 3, "today + yesterday + 2 days ago logged");

  // Now seed 4 days ago too but leave 3 days ago empty — the gap should
  // cap the streak at the 3 unbroken days, not count through the gap.
  await window.dbPut({
    id: "seed-streak-4", exerciseId: movement.id, date: iso(4),
    weight: 50, reps: 5, sets: 1, ts: Date.now() - 4 * 86400000, isPR: false, est1RM: 50, groupId: null,
  });
  await window.reloadFromDb();
  assert.equal(window.computeCurrentStreak(), 3, "a gap at day 3 should stop the count, not skip over it");
});

test("computeCurrentStreak: today not logged yet doesn't break a streak that's otherwise unbroken", async () => {
  const window = await bootApp();
  const iso = (daysAgo) => window.localISODate(new Date(Date.now() - daysAgo * 86400000));
  await window.addMovement("Test Streak Deadlift", "Deadlift");
  const movement = window.allMovements().find((m) => m.name === "Test Streak Deadlift");
  for (const daysAgo of [1, 2, 3]) { // yesterday back through 3 days ago; today untouched
    await window.dbPut({
      id: `seed-yest-${daysAgo}`, exerciseId: movement.id, date: iso(daysAgo),
      weight: 40, reps: 5, sets: 1, ts: Date.now() - daysAgo * 86400000, isPR: false, est1RM: 40, groupId: null,
    });
  }
  await window.reloadFromDb();
  assert.equal(window.computeCurrentStreak(), 3, "today just not being logged yet shouldn't reset or exclude yesterday's streak");
});

test("recentEntriesFor respects the 14-day window and caps at 5, most recent first", async () => {
  const window = await bootApp();
  const iso = (daysAgo) => window.localISODate(new Date(Date.now() - daysAgo * 86400000));
  await window.addMovement("Test Recent Bench", "Press");
  const movement = window.allMovements().find((m) => m.name === "Test Recent Bench");

  // 7 entries inside the 14-day window (should cap at 5) + 1 outside it.
  for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
    await window.dbPut({
      id: `seed-recent-${daysAgo}`, exerciseId: movement.id, date: iso(daysAgo),
      weight: 60 + daysAgo, reps: 5, sets: 1, ts: Date.now() - daysAgo * 86400000, isPR: false, est1RM: 60, groupId: null,
    });
  }
  await window.dbPut({
    id: "seed-recent-old", exerciseId: movement.id, date: iso(20),
    weight: 999, reps: 5, sets: 1, ts: Date.now() - 20 * 86400000, isPR: false, est1RM: 60, groupId: null,
  });
  await window.reloadFromDb();

  const recent = window.recentEntriesFor(movement.id);
  assert.equal(recent.length, 5, "should cap at 5 even though 7 are within the window");
  assert.ok(recent.every((e) => e.weight !== 999), "the 20-day-old entry must not appear");
  assert.equal(recent[0].weight, 60, "most recent (today, daysAgo=0) first");
});

test("session note round-trips through IndexedDB and is scoped per date", async () => {
  const window = await bootApp();
  const today = window.todayISO();

  await window.saveSessionNote(today, "  הרגשתי חזק היום  ");
  const stored = await window.dbGetSetting(`sessionNote:${today}`);
  assert.equal(stored, "הרגשתי חזק היום", "should be trimmed via the same cleanStr cap as other free-text fields");

  const otherDate = window.localISODate(new Date(Date.now() - 5 * 86400000));
  const storedOther = await window.dbGetSetting(`sessionNote:${otherDate}`);
  assert.equal(storedOther, null, "a note on one date must not leak onto another");
});
