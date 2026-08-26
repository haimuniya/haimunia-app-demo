#!/usr/bin/env node
// Drives a real 5-round working-up ladder (6/5/4/3/3 reps, different weight
// each) through the actual UI: toggle on, save each round, confirm the PR
// celebration stays suppressed, confirm the calendar day view groups them
// into one card, edit one round in place, delete another, finish the
// ladder without switching tabs first.
//
// Usage:
//   node ladder.mjs                 # local working tree
//   TARGET_URL=<url> node ladder.mjs # a deployed site
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

await selectMovement(page, "Strict");
const exerciseName = (await page.textContent(".exercise-select span")).trim();
check("selected the intended exercise", exerciseName === "Strict Press", `got "${exerciseName}"`);

await page.click("[data-action='toggle-ladder-mode']");
await page.waitForFunction(() => document.querySelector("[data-action='toggle-ladder-mode']").textContent.includes("סולם פעיל"), { timeout: 5000 });

const rungs = [[60, 6], [70, 5], [80, 4], [85, 3], [90, 3]];
let celebrations = 0;
for (let i = 0; i < rungs.length; i++) {
  const [w, r] = rungs[i];
  const stillOn = await page.evaluate(() => document.querySelector("[data-action='toggle-ladder-mode']").textContent.includes("סולם פעיל"));
  if (!stillOn) { check(`ladder mode still on before rung ${i + 1}`, false); break; }

  await page.fill("[data-field='weight'].stepper-val", String(w));
  await page.dispatchEvent("[data-field='weight'].stepper-val", "change");
  await page.fill("[data-field='reps'].stepper-val", String(r));
  await page.dispatchEvent("[data-field='reps'].stepper-val", "change");
  await page.click("[data-action='save-set']");
  await page.waitForTimeout(300);
  if (await dismissCelebrationIfOpen(page)) celebrations++;
}
check("all 5 rungs saved with ladder mode staying on throughout", !failed);
check("PR celebration stayed suppressed for all 5 rungs", celebrations === 0, `fired ${celebrations}/5`);

await page.click("#tabCalendarBtn");
await page.waitForTimeout(200);
const dayRows = await page.evaluate(() =>
  [...document.querySelectorAll("#calDetail .log-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim())
);
check("calendar groups the 5 rounds into one card", dayRows.length === 1 && dayRows[0].includes("5 סטים"), JSON.stringify(dayRows));
check("all 5 weight/rep pairs present in order", dayRows[0]?.includes("6×60") && dayRows[0]?.includes("3×90"));

const editButtons = page.locator("#calDetail button[data-action='edit-entry']");
await editButtons.nth(2).click();
await page.waitForTimeout(150);
await page.click("#tabAddBtn");
await page.waitForTimeout(150);
await page.fill("[data-field='weight'].stepper-val", "82.5");
await page.dispatchEvent("[data-field='weight'].stepper-val", "change");
await page.click("[data-action='save-set']");
await page.waitForTimeout(250);
await dismissCelebrationIfOpen(page);
await page.click("#tabCalendarBtn");
await page.waitForTimeout(200);
const afterEdit = await page.evaluate(() => document.querySelector("#calDetail .log-row")?.textContent || "");
check("editing one round updates it in place, still grouped", afterEdit.includes("4×82.5") && afterEdit.includes("5 סטים"));

const delBefore = await page.locator("#calDetail button[data-action='delete-entry']").count();
await page.locator("#calDetail button[data-action='delete-entry']").last().click();
await page.waitForTimeout(200);
const delAfter = await page.locator("#calDetail button[data-action='delete-entry']").count();
check("deleting one round removes exactly one", delBefore === 5 && delAfter === 4, `${delBefore} -> ${delAfter}`);

await page.click("#tabAddBtn");
await page.waitForTimeout(150);
await page.click("[data-action='toggle-ladder-mode']"); // finish, without switching tabs afterward
await page.waitForTimeout(150);
const toggleAfterFinish = (await page.textContent("[data-action='toggle-ladder-mode']")).trim();
check("finishing re-renders immediately (no stale toggle text)", !toggleAfterFinish.includes("סולם פעיל"), toggleAfterFinish);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nladder: FAILED" : "\nladder: all checks passed");
process.exit(failed ? 1 : 0);
