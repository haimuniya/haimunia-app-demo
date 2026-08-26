// Coverage gap closed (full-codebase audit, "regression + coverage" pass):
// the achievements modal and the post-save celebration popup had zero
// automated coverage before this. Uses the "אתלט שלם" (well-rounded)
// milestone — logging one set in each of the five PR categories
// (ACHIEVEMENT_PR_CATEGORIES) — since it's deterministic and needs no date
// or session-count bookkeeping, unlike the streak/session-count badges.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("logging a set in every PR category earns the well-rounded badge and pops the celebration", async () => {
  const window = await bootApp();
  assert.equal(window.isWellRounded(), false, "should not start well-rounded");

  const categories = ["Squat", "Deadlift", "Press", "Olympic", "Pull"];
  for (const cat of categories) {
    await window.addMovement(`Test WR ${cat}`, cat);
    window.applyFieldValue("step", "weight", 40);
    window.applyFieldValue("step", "reps", 5);
    window.applyFieldValue("step", "sets", 1);
    await window.saveSet();
  }

  assert.equal(window.isWellRounded(), true, "one set in each PR category should satisfy the well-rounded rule");

  // The last save should have triggered celebrateAfterSave(), which pops
  // the celebration overlay for any badge newly earned by that save.
  assert.equal(window.document.getElementById("celebrationOverlay").classList.contains("open"), true, "earning a new badge should pop the celebration overlay");
  const medalsText = window.document.getElementById("celebrationMedals").textContent;
  assert.ok(medalsText.includes("אתלט שלם"), "the newly-earned well-rounded medal should be shown in the celebration");

  window.closeCelebration();
  assert.equal(window.document.getElementById("celebrationOverlay").classList.contains("open"), false);
});

test("the achievements modal shows the well-rounded badge as earned, with its rule hidden once unlocked", async () => {
  const window = await bootApp();
  for (const cat of ["Squat", "Deadlift", "Press", "Olympic", "Pull"]) {
    await window.addMovement(`Test Ach ${cat}`, cat);
    window.applyFieldValue("step", "weight", 30);
    window.applyFieldValue("step", "reps", 3);
    window.applyFieldValue("step", "sets", 1);
    await window.saveSet();
  }
  window.closeCelebration();

  window.openAchievements();
  assert.equal(window.document.getElementById("achievementsOverlay").classList.contains("open"), true);
  // Match on the medal's own name exactly, not a substring search over the
  // whole badge — the capstone badge's *rule* text also mentions "אתלט שלם"
  // as one of its requirements, which a loose substring match would hit
  // first (it renders earlier in the list) and it's locked by design.
  const badge = [...window.document.querySelectorAll(".medal-badge")].find((el) => el.querySelector(".medal-name")?.textContent === "אתלט שלם");
  assert.ok(badge, "the well-rounded medal should be rendered in the achievements list");
  assert.ok(badge.classList.contains("earned"), "it should be marked earned, not locked");
  assert.ok(!badge.querySelector(".medal-rule"), "an earned badge should not show its unlock rule as a caption");

  window.closeAchievements();
  assert.equal(window.document.getElementById("achievementsOverlay").classList.contains("open"), false);
});

test("a locked achievement shows its rule as a visible caption (touch screens never see the title tooltip)", async () => {
  const window = await bootApp();
  window.openAchievements();
  const locked = window.document.querySelector(".medal-badge.locked");
  assert.ok(locked, "a fresh install should have plenty of locked badges");
  assert.ok(locked.querySelector(".medal-rule"), "a locked badge must print its rule, since title tooltips never show on touch");
});

test("a plain PR with no new badge still celebrates, without a badge grid", async () => {
  const window = await bootApp();
  await window.addMovement("Test Plain PR Deadlift", "Deadlift");
  window.applyFieldValue("step", "weight", 60);
  window.applyFieldValue("step", "reps", 5);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();
  window.closeCelebration();

  // A heavier set on the same movement is a PR but (on its own) shouldn't
  // complete any category/streak/milestone tier this fresh.
  window.applyFieldValue("step", "weight", 65);
  await window.saveSet();

  assert.equal(window.document.getElementById("celebrationOverlay").classList.contains("open"), true, "a plain PR alone should still pop the celebration");
  const title = window.document.getElementById("celebrationTitle").textContent;
  assert.equal(title, "שיא אישי חדש!", "a PR-only celebration should use the PR title, not the badge one");
  const prLine = window.document.getElementById("celebrationPrLine");
  assert.equal(prLine.style.display, "block");
  assert.ok(prLine.textContent.includes("Test Plain PR Deadlift"));
});
