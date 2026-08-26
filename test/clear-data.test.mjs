// Audit finding (low severity, cosmetic): clearAllData() reset 21 pieces of
// state but not the five ladderMode/ladderGroupId/ladderPrimaryId/
// ladderPartnerId/ladderBlockLabel variables. If "מחיקת כל הנתונים" was
// triggered while a ladder was active, the toggle kept showing "active"
// against a groupId that pointed at nothing once entries was emptied — not
// data corruption (currentLadderRounds() just renders "0 rounds"), but a
// stale toggle until the next ladder-ending interaction. Fixed by calling
// the existing endLadder() from clearAllData().
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("clearing all data ends an active ladder instead of leaving it stale", async () => {
  const window = await bootApp();
  await window.addMovement("Test Clear Ladder Squat", "Squat");
  window.toggleLadderMode();
  window.applyFieldValue("step", "weight", 40);
  window.applyFieldValue("step", "reps", 5);
  await window.saveSet();

  const isOn = () => window.document.querySelector("[data-action='toggle-ladder-mode']")?.textContent.includes("פעיל");
  assert.equal(isOn(), true, "ladder should be active after toggling it on and logging a round");

  await window.clearAllData();
  assert.equal(isOn(), false, "clearing all data should end the ladder, not leave it advertising a groupId that points at nothing");
});
