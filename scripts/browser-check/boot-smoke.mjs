#!/usr/bin/env node
// Baseline smoke check: fresh load, fonts actually load (not falling back
// to system sans-serif), no unexpected page reload, all 5 tabs switch
// cleanly, no console errors. Run before any release — this is the fastest
// of the three checks and catches the broadest class of regressions.
//
// Usage:
//   node boot-smoke.mjs                 # local working tree
//   TARGET_URL=<url> node boot-smoke.mjs # a deployed site
import { chromium } from "playwright";
import { resolveTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const target = await resolveTarget();
console.log(`Target: ${target.url}${target.local ? " (local static server)" : ""}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

let navCount = 0;
page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navCount++; });

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
check("app shell became visible", true);

const fontInfo = await page.evaluate(async () => {
  await document.fonts.ready;
  return {
    dir: document.documentElement.dir,
    hasRubik: [...document.fonts].some((f) => f.family === "Rubik" && f.status === "loaded"),
  };
});
check("dir=rtl on <html>", fontInfo.dir === "rtl");
check("Rubik font actually loaded", fontInfo.hasRubik);

// The service worker's clients.claim() used to fire an unconditional
// reload on every first-ever install — see CHANGES.md, "stop
// self-reloading on first install". Give it a few seconds to (not) happen.
await page.waitForTimeout(4000);
check("no unexpected page reload in the first 4s", navCount === 1, `navCount=${navCount}`);

await dismissWelcomeModal(page);
for (const id of ["tabHistoryBtn", "tabCalendarBtn", "tabWodBtn", "tabCommunityBtn", "tabAddBtn"]) {
  await switchTab(page, id);
  await page.waitForTimeout(150);
}
const contentNotEmpty = await page.evaluate(() => document.getElementById("content").children.length > 0);
check("all 5 tabs switch without an empty/broken content area", contentNotEmpty);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nboot-smoke: FAILED" : "\nboot-smoke: all checks passed");
process.exit(failed ? 1 : 0);
