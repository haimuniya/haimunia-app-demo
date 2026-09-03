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
import { switchTab, dismissWelcomeModal, consoleErrorCollector } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

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

// COMM-333: cloud.js boots unconditionally regardless of which tab a
// script visits, and cloud-config.js points at the real, live production
// Supabase project - without this, an offline-only check like this one
// still fires real network calls (session restore, anonymous sign-in via
// the auto-backup bootstrap, etc.) against production in the background,
// which is both a safety risk (see lib/mockCloud.mjs's own comment) and
// the source of intermittent 401/409 console errors this suite saw.
await installMockCloud(page);
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible" });
await dismissWelcomeModal(page);

await switchTab(page, "tabWodBtn");
await page.waitForTimeout(200);

// COMM-360: selectedWodId now defaults to null (not WOD_LIBRARY[0]/"Fran")
// so a fresh load lands on the log subtab's empty state, not a pre-filled
// form - a user must explicitly pick a WOD (from here, via benchmarks
// below) before any log form appears.
const emptyStateVisible = await page.evaluate(() => (document.getElementById("wodContent")?.textContent || "").includes("בחרו אימון כדי להתחיל"));
check("the log subtab shows the pick-a-WOD empty state on a fresh load, not a pre-filled form", emptyStateVisible);

// Reach the benchmarks subtab via its pill in the subtabbar.
await page.click("button.subtabbtn[data-subtab='benchmarks']");
await page.waitForTimeout(200);

const pillActive = await page.evaluate(() => document.querySelector(".subtabbtn[data-subtab='benchmarks']").classList.contains("active"));
check("benchmarks pill highlights on tap", pillActive);

// No search/filter input exists in renderWodBenchmarksSection() as of
// this app version — it lists the full WOD_LIBRARY directly with no
// wrapper id and no way to narrow it. That's a real behavior change from
// what this check originally covered (flagged separately, not rebuilt
// here) — this check now covers what actually exists: the full list.
const listText = await page.evaluate(() => document.getElementById("wodContent")?.textContent || "");
check("benchmarks list shows Girls and Heroes entries", listText.includes("Fran") && listText.includes("Murph"), listText.slice(0, 80));

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
