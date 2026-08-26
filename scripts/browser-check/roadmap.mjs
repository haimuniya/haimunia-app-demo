#!/usr/bin/env node
// Covers the "look at every tab" roadmap round: onboarding, the bell/
// notifications overlay, the streak indicator, recent-history-at-entry,
// and per-day session notes. Local-only in spirit (a fresh browser context
// is always a "fresh install" from the app's point of view, so this
// exercises the first-run paths specifically) but works against any target.
//
// Usage:
//   node roadmap.mjs                 # local working tree
//   TARGET_URL=<url> node roadmap.mjs # a deployed site
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolveTarget } from "./lib/target.mjs";
import { selectMovement, dismissCelebrationIfOpen, consoleErrorCollector } from "./lib/actions.mjs";

const outDir = "C:/Users/shaha/.claude/jobs/f023e6d8/tmp/screenshots";
mkdirSync(outDir, { recursive: true });

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

// --- Onboarding: fresh install shows it right after the welcome form ---
await page.fill("#welcomeNameInput", "בודק סבב");
await page.click("[data-action='save-user-name']");
await page.waitForTimeout(200);
const onboardingOpen = await page.evaluate(() => document.getElementById("onboardingOverlay").classList.contains("open"));
check("onboarding shows after the first-ever welcome", onboardingOpen);
await page.screenshot({ path: `${outDir}/roadmap-01-onboarding.png` });
await page.click("[data-action='close-onboarding']");
await page.waitForTimeout(200);
const onboardingClosed = !(await page.evaluate(() => document.getElementById("onboardingOverlay").classList.contains("open")));
check("onboarding dismisses on tap", onboardingClosed);

const whatsNewOpen = await page.evaluate(() => document.getElementById("notificationsOverlay").classList.contains("open"));
check("no what's-new popup for a fresh install (nothing to catch up on)", !whatsNewOpen);

// --- Notifications bell ---
const badgeHiddenFresh = await page.evaluate(() => document.getElementById("notificationsBadge").style.display !== "flex");
check("bell badge shows nothing for a fresh install", badgeHiddenFresh);
await page.click("[data-action='open-notifications']");
await page.waitForTimeout(200);
const notifOpen = await page.evaluate(() => document.getElementById("notificationsOverlay").classList.contains("open"));
check("bell opens the notifications overlay", notifOpen);
const notifHasEntry = await page.evaluate(() => document.getElementById("notificationsList").textContent.includes("."));
check("notifications list actually renders a version entry", notifHasEntry);
await page.screenshot({ path: `${outDir}/roadmap-02-notifications.png` });
await page.click("[data-action='close-notifications']");
await page.waitForTimeout(150);

// --- Streak + recent-history: log a set today, check both ---
await selectMovement(page, "Strict");
await page.fill("[data-field='weight'].stepper-val", "60");
await page.dispatchEvent("[data-field='weight'].stepper-val", "change");
await page.fill("[data-field='reps'].stepper-val", "5");
await page.dispatchEvent("[data-field='reps'].stepper-val", "change");
await page.click("[data-action='save-set']");
await page.waitForTimeout(300);
await dismissCelebrationIfOpen(page);

const streakVisible = await page.evaluate(() => document.getElementById("streakLabel").style.display === "flex");
const streakText = await page.evaluate(() => document.getElementById("streakLabel").textContent.trim());
check("streak indicator shows 1 after logging today's only set", streakVisible && streakText === "1", `visible=${streakVisible} text="${streakText}"`);
await page.screenshot({ path: `${outDir}/roadmap-03-streak.png` });

// Log a second set for the same exercise -> recent-history strip should appear.
await page.fill("[data-field='weight'].stepper-val", "65");
await page.dispatchEvent("[data-field='weight'].stepper-val", "change");
await page.click("[data-action='save-set']");
await page.waitForTimeout(300);
await dismissCelebrationIfOpen(page);
const recentText = await page.evaluate(() => document.body.textContent);
check("recent-history strip shows up after a second logged set", recentText.includes("14 הימים האחרונים"));
await page.screenshot({ path: `${outDir}/roadmap-04-recent-history.png` });

// --- Session note on the Calendar tab ---
await page.click("#tabCalendarBtn");
await page.waitForTimeout(250);
await page.fill("#sessionNoteInput", "בדיקת הערה אוטומטית");
await page.click("[data-action='save-session-note']");
await page.waitForTimeout(300);
const noteConfirmShown = (await page.evaluate(() => document.body.textContent)).includes("ההערה נשמרה");
check("saving a session note shows the confirmation message", noteConfirmShown);
await page.screenshot({ path: `${outDir}/roadmap-05-session-note.png` });

// Switch away and back to a different day, then back to today, to confirm
// the note actually persisted (not just sitting in the textarea).
await page.click("[data-action='cal-prev']");
await page.waitForTimeout(200);
await page.click("[data-action='cal-next']");
await page.waitForTimeout(200);
const today = await page.evaluate(() => window.todayISO());
await page.click(`[data-action='cal-select-day'][data-date="${today}"]`);
await page.waitForTimeout(400); // note loads async from IndexedDB
const noteValueAfterRoundTrip = await page.inputValue("#sessionNoteInput");
check("session note persists after navigating away and back", noteValueAfterRoundTrip === "בדיקת הערה אוטומטית", `got "${noteValueAfterRoundTrip}"`);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nroadmap: FAILED" : "\nroadmap: all checks passed");
process.exit(failed ? 1 : 0);
