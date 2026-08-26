#!/usr/bin/env node
// Sub-task D: EMOM WODs with a rotating movement lineup, built through the
// WOD builder (reusable/named, same pattern as Fran/Grace) rather than a
// one-off freeform entry. Drives the real "EMOM" format chip, the
// minutes stepper, picking two movements in order, and logging an attempt
// with one reps field per movement.
//
// Usage:
//   node emom.mjs                 # local working tree
//   TARGET_URL=<url> node emom.mjs # a deployed site
import { chromium } from "playwright";
import { resolveTarget } from "./lib/target.mjs";
import { dismissWelcomeModal, consoleErrorCollector } from "./lib/actions.mjs";

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

await page.click("#tabWodBtn");
await page.waitForTimeout(200);
await page.click("[data-action='open-wod-picker']");
await page.waitForTimeout(200);
await page.click("[data-action='open-wod-builder']");
await page.waitForSelector("#wodBuilderOverlay.open", { timeout: 5000 });

await page.fill("#wodBuilderName", "Test Builder EMOM");
await page.click("#wodBuilderFormats .format-chip[data-format='emom']");
await page.waitForTimeout(150);

const minutesStepperShown = await page.evaluate(() => !!document.querySelector("[data-action='builder-emom-minutes'].stepper-val"));
check("selecting EMOM format shows the minutes stepper", minutesStepperShown);
await page.fill("[data-action='builder-emom-minutes'].stepper-val", "12");
await page.dispatchEvent("[data-action='builder-emom-minutes'].stepper-val", "change");

// Pick two movements, in order — Wall Balls first, then Burpees.
await page.fill("#wodBuilderMoveSearch", "Wall Balls");
await page.waitForTimeout(150);
await page.click(".movecheck-row[data-name='Wall Balls']");
await page.waitForTimeout(100);
const noWeightTypeToggle = await page.evaluate(() => !document.querySelector("[data-action='toggle-builder-movement-type']"));
check("EMOM movements skip the reps/duration toggle (reps-only by design)", noWeightTypeToggle);

await page.fill("[data-action='builder-movement-reps'][data-field='Wall Balls'].stepper-val", "15");
await page.dispatchEvent("[data-action='builder-movement-reps'][data-field='Wall Balls'].stepper-val", "change");

await page.fill("#wodBuilderMoveSearch", "Burpees");
await page.waitForTimeout(150);
await page.click(".movecheck-row[data-name='Burpees']");
await page.waitForTimeout(100);
await page.fill("[data-action='builder-movement-reps'][data-field='Burpees'].stepper-val", "10");
await page.dispatchEvent("[data-action='builder-movement-reps'][data-field='Burpees'].stepper-val", "change");

await page.click("[data-action='create-wod']");
await page.waitForTimeout(300);

const descText = await page.evaluate(() => document.querySelector(".wod-desc")?.textContent || "");
check("created EMOM's description mentions both movements and the minute count", descText.includes("EMOM 12") && descText.includes("Wall Balls") && descText.includes("Burpees"), descText);

const emomSteppers = await page.evaluate(() => [...document.querySelectorAll("[data-action='wod-emom-step'].stepper-val")].map((el) => el.value));
check("log form shows one prefilled stepper per rotation movement, in order", JSON.stringify(emomSteppers) === JSON.stringify(["15", "10"]), JSON.stringify(emomSteppers));

const scoreTypeLabel = await page.evaluate(() => document.body.textContent.includes("EMOM"));
check("score-type stat card shows EMOM, not a fallback label", scoreTypeLabel);

// Log an attempt: matched wall balls, scaled down burpees.
await page.fill("[data-action='wod-emom-step'][data-field='0'].stepper-val", "15");
await page.dispatchEvent("[data-action='wod-emom-step'][data-field='0'].stepper-val", "change");
await page.fill("[data-action='wod-emom-step'][data-field='1'].stepper-val", "7");
await page.dispatchEvent("[data-action='wod-emom-step'][data-field='1'].stepper-val", "change");
await page.click("[data-action='save-wod']");
await page.waitForTimeout(300);

const noPrFlash = await page.evaluate(() => document.getElementById("wodFlashBox")?.style.display !== "flex");
check("saving an EMOM attempt never flashes a PR (no cross-attempt scoring)", noPrFlash);

await page.click("#tabCalendarBtn");
await page.waitForTimeout(200);
const calText = (await page.evaluate(() => document.getElementById("calDetail")?.textContent || "")).replace(/\s+/g, " ").trim();
check("calendar day view shows per-movement reps (15 · 7), not a generic score", calText.includes("15 · 7"), calText);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nemom: FAILED" : "\nemom: all checks passed");
process.exit(failed ? 1 : 0);
