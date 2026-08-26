#!/usr/bin/env node
// Exercises the service-worker update lifecycle end to end — the one class
// of bug this app has actually shipped twice (a self-reload on every first
// install; the update banner never auto-applying). None of this is
// reachable from the jsdom test suite, since jsdom doesn't implement
// Service Worker lifecycle events at all.
//
// Local-only: this script edits sw.js on disk (a temporary version bump,
// reverted at the end) to simulate a new deploy landing, so it always runs
// against a local static server over the working tree — TARGET_URL is
// ignored here.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "./lib/target.mjs";
import { startStaticServer } from "./lib/server.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const swPath = path.join(projectRoot, "sw.js");
const origSw = readFileSync(swPath, "utf8");
function bumpSwVersion(v) {
  writeFileSync(swPath, origSw.replace(/const SW_VERSION = "[^"]+";/, `const SW_VERSION = "${v}";`));
}
function restoreSw() {
  writeFileSync(swPath, origSw);
}

const { url, close } = await startStaticServer(projectRoot);
console.log(`Target: ${url} (local static server, sw.js will be temporarily edited)`);
const browser = await chromium.launch();

async function freshPage() {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  return { ctx, page };
}
async function waitForControllerActive(page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.state === "activated", { timeout: 15000 });
}

try {
  console.log("\n--- Scenario 1: first-ever install must not self-reload ---");
  {
    const { ctx, page } = await freshPage();
    let navCount = 0;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navCount++; });
    await page.goto(url, { waitUntil: "networkidle" });
    await waitForControllerActive(page);
    await page.waitForTimeout(4000);
    check("no reload within 4s of a fresh install", navCount === 1, `navCount=${navCount}`);
    await ctx.close();
  }

  console.log("\n--- Scenario 2: update arrives while page is HIDDEN -> auto-applies silently ---");
  {
    const { ctx, page } = await freshPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await waitForControllerActive(page);
    bumpSwVersion("0.0.1-check-hidden");
    await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }));
    // Attach the reload listener BEFORE triggering the update check — the
    // reload can land during the very next wait, and a listener attached
    // after the fact would simply miss an event that already happened.
    const navPromise = page.waitForEvent("load", { timeout: 15000 }).then(() => true).catch(() => false);
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await page.waitForTimeout(500);
    const bannerWhileHidden = await page.evaluate(() => document.getElementById("updateBanner").style.display === "block").catch(() => false);
    check("banner does NOT show while hidden", !bannerWhileHidden);
    check("page reloads automatically without ever showing a banner", await navPromise);
    restoreSw();
    await ctx.close();
  }

  console.log("\n--- Scenario 3: update arrives while page is VISIBLE -> banner shown, applies on next visibility regain ---");
  {
    const { ctx, page } = await freshPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await waitForControllerActive(page);
    bumpSwVersion("0.0.2-check-visible");
    await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }));
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await page.waitForTimeout(1000);
    const bannerShown = await page.evaluate(() => document.getElementById("updateBanner").style.display === "block");
    check("banner shows while actively visible", bannerShown);

    await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }));
    const navPromise = page.waitForEvent("load", { timeout: 15000 }).then(() => true).catch(() => false);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    check("reloads automatically on visibility regain, without ever tapping the banner", await navPromise);
    restoreSw();
    await ctx.close();
  }
} finally {
  restoreSw(); // belt and braces even if an assertion threw mid-scenario
  await browser.close();
  await close();
}

console.log(failed ? "\nupdate-flow: FAILED" : "\nupdate-flow: all checks passed");
process.exit(failed ? 1 : 0);
