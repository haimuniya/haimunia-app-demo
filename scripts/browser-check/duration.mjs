#!/usr/bin/env node
// Sub-task A: timed-hold entries in the strength Log tab. Drives the actual
// reps/duration toggle, the duration stepper, the History tab's duration
// chart, and the calendar day view's duration formatting — none of this is
// reachable from jsdom (no real layout/CSS, and the point here is mostly
// "does the UI actually show the right controls"), so it's covered here
// instead of (or in addition to) the node:test suite.
//
// Usage:
//   node duration.mjs                 # local working tree
//   TARGET_URL=<url> node duration.mjs # a deployed site
import { chromium } from "playwright";
import { resolveTarget } from "./lib/target.mjs";
import { dismissWelcomeModal, selectMovement, dismissCelebrationIfOpen, consoleErrorCollector } from "./lib/actions.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const target = await resolveTarget();
console.log(`Target: ${target.url}${target.local ? " (local static server)" : ""}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 1000 } });
const errors = await consoleErrorCollector(page);

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible" });
await dismissWelcomeModal(page);

await selectMovement(page, "Weighted Plank");
const exerciseName = (await page.textContent(".exercise-select span")).trim();
check("selected the intended exercise", exerciseName.includes("Weighted Plank"), `got "${exerciseName}"`);

// Default is reps mode — no duration stepper, barbell visual present.
const barbellVisibleBefore = await page.evaluate(() => !!document.getElementById("barbellVisual"));
check("reps mode still shows the barbell visual (unchanged default)", barbellVisibleBefore);

await page.click("[data-action='set-log-entry-type'][data-type='duration']");
await page.waitForTimeout(150);

const barbellGone = await page.evaluate(() => !document.getElementById("barbellVisual"));
check("switching to duration mode removes the barbell visual", barbellGone);
const durationStepperShown = await page.evaluate(() => !!document.querySelector("[data-field='durationSeconds'].stepper-val"));
check("duration mode shows a duration stepper", durationStepperShown);
const repsStepperGone = await page.evaluate(() => !document.querySelector("[data-field='reps'].stepper-val"));
check("duration mode hides the reps stepper", repsStepperGone);

await page.fill("[data-field='durationSeconds'].stepper-val", "40");
await page.dispatchEvent("[data-field='durationSeconds'].stepper-val", "change");
await page.fill("[data-field='sets'].stepper-val", "3");
await page.dispatchEvent("[data-field='sets'].stepper-val", "change");
await page.click("[data-action='save-set']");
await page.waitForTimeout(300);
await dismissCelebrationIfOpen(page);

const footerText = await page.evaluate(() => document.querySelector("[data-action='view-log-date-calendar']")?.textContent || "");
check('day footer shows the hold as 3×40"', footerText.includes('3×40"'), footerText.trim());

// A shorter second hold should not flash a PR.
await page.fill("[data-field='durationSeconds'].stepper-val", "25");
await page.dispatchEvent("[data-field='durationSeconds'].stepper-val", "change");
await page.click("[data-action='save-set']");
await page.waitForTimeout(300);
const celebratedOnShorterHold = await dismissCelebrationIfOpen(page);
check("a shorter hold than the existing best does not celebrate a PR", !celebratedOnShorterHold);

// History tab: duration-mode chart renders (an SVG, not the reps rep-table).
await page.click("#tabHistoryBtn");
await page.waitForTimeout(200);
await page.click(`.exercise-row[data-action='select-history']:has-text("Weighted Plank")`);
await page.waitForTimeout(200);
const historyHasSvg = await page.evaluate(() => !!document.querySelector(".chart-card svg"));
const historyHasBestHold = (await page.evaluate(() => document.querySelector(".chart-card")?.textContent || "")).includes("שיא החזקה");
check("History tab renders a chart for the duration exercise", historyHasSvg);
check("History tab shows a best-hold stat instead of the rep-record grid", historyHasBestHold);

// Calendar day view: both rounds show with duration formatting, not "0×0".
await page.click("#tabCalendarBtn");
await page.waitForTimeout(200);
const calText = await page.evaluate(() => document.getElementById("calDetail")?.textContent || "");
check('calendar day view formats the hold entries as seconds (25") not reps', calText.includes('25"'), calText.replace(/\s+/g, " ").trim());

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nduration: FAILED" : "\nduration: all checks passed");
process.exit(failed ? 1 : 0);
