// Batch of UX findings from an independent review, fixed together since
// each is small and self-contained: a missing section heading, sub-44px
// tab touch targets, onboarding never mentioning the Community tab, a
// silent empty-WOD-name failure, a destructive action with no visual
// weight of its own, no safety net before an irreversible data wipe, an
// EMOM station silently losing its position on uncheck/recheck, and a
// weekly-challenge key format that could be typed wrong with no warning.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";

const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("bodyweight gets its own section label, matching measurements", async () => {
  const window = await bootApp();
  window.document.getElementById("tabHistoryBtn").click();
  const area = window.document.getElementById("bodyweightArea");
  const label = [...area.querySelectorAll(".section-label")].find((el) => el.textContent === "משקל גוף");
  assert.ok(label, "bodyweight should have its own .section-label, not read as just another tracked exercise");
});

test("the main tab bar and community sub-tab bar meet the 44px touch-target baseline", () => {
  assert.match(indexHtml, /\.tabbtn\{[^}]*min-height:44px/);
  assert.match(indexHtml, /\.subtabbtn\{[^}]*min-height:44px/);
});

test("onboarding mentions the Community tab, not just the four offline screens", () => {
  const start = indexHtml.indexOf('id="onboardingOverlay"');
  const end = indexHtml.indexOf("close-onboarding");
  const block = indexHtml.slice(start, end);
  assert.match(block, />קהילה</);
  assert.match(block, /קוד הזמנה/, "should mention it needs an invite code, not just name the tab");
});

test("submitting the WOD builder with an empty name shows a real error and marks the field invalid, instead of silently doing nothing", async () => {
  const window = await bootApp();
  window.document.getElementById("tabWodBtn").click();
  window.openWodBuilder("");
  window.document.getElementById("wodBuilderName").value = "";
  window.createWodFromBuilder();
  const hint = window.document.getElementById("wodBuilderNameHint");
  assert.equal(hint.style.display, "block");
  assert.ok(hint.textContent.length > 0, "the hint must actually say something, not just become visible");
  assert.equal(window.document.getElementById("wodBuilderName").getAttribute("aria-invalid"), "true");
});

test("the destructive clear-all-data trigger has its own red-bordered styling, not the plain footer link style", () => {
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(src, /data-action="ask-clear" style="color:var\(--red\); font-size:11px; font-weight:700; border:1px solid var\(--red\)/);
});

test("clearing all data auto-downloads a backup first, same safety net import already gets", async () => {
  const window = await bootApp();
  // COMM-360: saveSet() now refuses to save until a movement is explicitly
  // chosen (nothing is pre-selected on a fresh load) - pick one first, same
  // as a real user would via the picker.
  window.document.getElementById("tabAddBtn").click();
  window.document.querySelector('[data-action="open-picker"]').click();
  window.document.querySelector('[data-action="pick-movement"]').click();
  await window.saveSet(); // logs one entry using the default weight/reps/sets
  let calledWith = null;
  window.downloadBackup = (payload) => { calledWith = payload; return true; };
  await window.clearAllData();
  assert.ok(calledWith, "downloadBackup must be called before the wipe");
  assert.ok(Array.isArray(calledWith.entries) && calledWith.entries.length >= 1, "the auto-backup must actually contain the data about to be deleted, not an empty shell");
});

test("unchecking then rechecking an EMOM station restores its original rotation position instead of moving it to the end", async () => {
  const window = await bootApp();
  window.document.getElementById("tabWodBtn").click();
  window.openWodBuilder("");
  window.document.querySelector('[data-action="builder-set-format"][data-format="emom"]').click();
  const names = ["Air Squat", "Push-Ups", "Sit-Ups"];
  for (const n of names) window.document.querySelector(`[data-action="toggle-builder-movement"][data-name="${n}"]`)?.click();
  // Uncheck and recheck the middle station.
  window.document.querySelector('[data-action="toggle-builder-movement"][data-name="Push-Ups"]').click();
  window.document.querySelector('[data-action="toggle-builder-movement"][data-name="Push-Ups"]').click();
  assert.deepEqual(window.activeBuilderMovementNames(), names, "the rotation order must be unchanged after an uncheck/recheck cycle");
});

test("the weekly-challenge comparison-key field validates the real movement:/wod: format, and the placeholder shows a real example", () => {
  assert.match(cloudJs, /placeholder="movement:back-squat:est1rm"/);
  assert.match(cloudJs, /\/\^\(movement:\[a-z0-9-\]\+:\(est1rm\|duration\)\|wod:\[a-z0-9-\]\+:\[a-z\]\+:\(rx\|scaled\)\)\$\//);
});
