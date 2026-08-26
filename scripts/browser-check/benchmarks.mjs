#!/usr/bin/env node
// The WOD tab's third sub-tab, בנצ'מרקים: a browsable list of the built-in
// Girls/Heroes benchmark WODs (WOD_LIBRARY), separate from custom ones —
// tap one to jump straight into logging it.
//
// Usage:
//   node benchmarks.mjs                 # local working tree
//   TARGET_URL=<url> node benchmarks.mjs # a deployed site
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

// A fresh load has no WOD pre-selected — renderWodLogSection's empty state
// should prompt for one instead of silently loading WOD_LIBRARY[0] (used
// to always be Fran, which read as "this is already my workout").
const noLogForm = await page.evaluate(() => !document.getElementById("wodLogDateInput"));
check("no WOD pre-selected on a fresh load — the log subtab shows the empty-state prompt", noLogForm);
// The pill and the empty-state button share the same data-action/data-subtab
// (both drive switchWodSubtab), so scope to .movement-btn to mean the
// empty-state one specifically, not the always-present subtabbar pill.
const emptyStateBenchmarkBtn = "button.movement-btn[data-action='switch-wod-subtab'][data-subtab='benchmarks']";
const buildBtnVisible = await page.locator("[data-action='open-wod-builder']").isVisible();
const benchmarkBtnVisible = await page.locator(emptyStateBenchmarkBtn).isVisible();
check("empty state offers both יצירת אימון and בנצ'מרק", buildBtnVisible && benchmarkBtnVisible, `build=${buildBtnVisible} benchmark=${benchmarkBtnVisible}`);

// Reach the benchmarks tab via that same empty-state button, not just the pill.
await page.click(emptyStateBenchmarkBtn);
await page.waitForTimeout(200);

const pillActive = await page.evaluate(() => document.querySelector(".subtabbtn[data-subtab='benchmarks']").classList.contains("active"));
check("benchmarks pill highlights on tap", pillActive);

const listText = await page.evaluate(() => document.getElementById("wodBenchmarksListArea")?.textContent || "");
check("benchmarks list shows Girls and Heroes entries", listText.includes("Fran") && listText.includes("Murph"), listText.slice(0, 80));

await page.fill("#wodBenchmarksSearch", "Grace");
await page.waitForTimeout(200);
const filteredText = await page.evaluate(() => document.getElementById("wodBenchmarksListArea")?.textContent || "");
check("search filters the list", filteredText.includes("Grace") && !filteredText.includes("Fran"), filteredText.slice(0, 80));

await page.click("[data-action='select-benchmark'][data-id='grace']");
await page.waitForTimeout(200);
const logActive = await page.evaluate(() => document.querySelector(".subtabbtn[data-subtab='log']").classList.contains("active"));
check("picking a benchmark switches to the log subtab", logActive);
const wodName = await page.evaluate(() => document.querySelector(".exercise-select span")?.textContent || "");
check("log form shows the picked benchmark", wodName === "Grace", wodName);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nbenchmarks: FAILED" : "\nbenchmarks: all checks passed");
process.exit(failed ? 1 : 0);
