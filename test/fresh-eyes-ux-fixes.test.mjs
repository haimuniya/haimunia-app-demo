// Batch of small, self-contained findings from a fresh-eyes product/UX
// review (a genuine first-time hands-on tour of the shipped app, not a
// code read): a near-empty nav menu, "1 ימים" grammar, and other small
// polish items grouped together the same way test/audit-ux-fixes.test.mjs
// already batches an earlier review's small findings.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("the nav menu shows an app version footer instead of ending in empty space", async () => {
  const window = await bootApp();
  window.document.getElementById("navMenuBtn").click();
  const list = window.document.getElementById("navMenuList");
  assert.match(list.textContent, /v\d+\.\d+\.\d+/, "the nav menu names the running app version");
  assert.match(list.textContent, /האימוניה/, "the footer names the app, not a bare version number");
});

test("a one-day streak reads '1 יום ברצף', not the grammatically wrong '1 ימים ברצף'", async () => {
  const window = await bootApp();
  await window.addMovement("Streak Grammar Check", "Squat");
  window.applyFieldValue("step", "weight", 40);
  window.applyFieldValue("step", "reps", 5);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();
  window.closeCelebration();

  assert.equal(window.computeCurrentStreak(), 1, "one set logged today is a one-day streak");

  window.document.getElementById("navMenuBtn").click();
  const who = window.document.querySelector("#navMenuList .who-sub");
  assert.equal(who.textContent, "1 יום ברצף");

  const streakLabel = window.document.getElementById("streakLabel");
  assert.equal(streakLabel.getAttribute("aria-label"), "1 יום ברצף");
});

test("a near-empty progress chart (1-2 points) explains itself instead of just looking sparse", async () => {
  const window = await bootApp();
  const oneNote = window.renderChart([{ dateLabel: "01.09", est1RM: 50, isPR: true }]);
  assert.match(oneNote, /עוד 2 נתונים ותראו כאן מגמה/);

  const twoNote = window.renderChart([
    { dateLabel: "01.09", est1RM: 50, isPR: true },
    { dateLabel: "05.09", est1RM: 55, isPR: true },
  ]);
  assert.match(twoNote, /עוד 1 נתון ותראו כאן מגמה/);

  const threeNote = window.renderChart([
    { dateLabel: "01.09", est1RM: 50, isPR: true },
    { dateLabel: "05.09", est1RM: 55, isPR: true },
    { dateLabel: "09.09", est1RM: 58, isPR: true },
  ]);
  assert.doesNotMatch(threeNote, /ותראו כאן מגמה/, "the hint drops away once there's enough to actually trend");
});
