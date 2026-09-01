#!/usr/bin/env node
// COMM-317 (Phase 3 QA sweep) browser scenario for COMM-307: log a session
// through the app's real client sync path and see the "trained-with-you"
// classmates card appear on the feed, real Chromium against the in-page
// mock backend (lib/mockCloud.mjs).
//
// Two halves, deliberately kept apart, matching COMM-234's own precedent of
// not simulating a server pipeline this repo has no local server for
// (community-recap.mjs pre-seeds weekly_recaps rather than driving
// recap_weekly's Edge Function):
//
//   1. THE REAL CLIENT EMIT PATH, actually driven, not stubbed. This calls
//      window.queueSyncRecord() — the exact function app.js's own save-set
//      flow calls — with a strength_entry dated today, lets the real
//      "haimunia-sync-needed" listener fire cloud.js's real flushOutbox(),
//      and asserts on two real effects: a private_records upsert reaches
//      the mock backend, and the ATTENDANCE_RECORDED bus emit reaches
//      analytics_events as a real attendance_recorded row. Nothing about
//      this half is mocked away; it is the first browser-level coverage
//      COMM-300's client half has had.
//   2. THE CARD ITSELF, off attendance_log rows seeded directly. The mock's
//      attendance_classmates_today() stand-in (test/helpers/mockSupabase.mjs)
//      reads a `attendance_log` table it does not derive from
//      private_records — deriving one from the other is the
//      private_records_attendance_log Postgres trigger's job, already
//      proven by 60+ pgTAP assertions in supabase/tests/0037 and 0041, and
//      not something a JS mock re-implements. So this half seeds
//      attendance_log directly with "both members already trained today",
//      standing in for what the trigger would have produced from step 1
//      once it reached a real Postgres instance, and drives the client
//      surface — the card's render, its content, its Follow control, and
//      its classmates_card_viewed analytics — for real.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VERIFIED = new Date().toISOString();
const TODAY = new Date().toISOString().slice(0, 10);

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  // Step 2's precondition: u2 already trained today, and — once the trigger
  // this scenario cannot run locally has done its job off step 1's real
  // sync — so will u1. Seeded now so the card has something to prove
  // against; u1's own row is appended by the scenario itself, below.
  attendance_log: [{ user_id: "u2", occurred_on: TODAY, recorded_at: VERIFIED }],
  private_records: [], follows: [], blocks: [], analytics_events: [],
  feed_page_rows: [], notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

// syncEnabled is read from localStorage at cloud.js's top-level module
// evaluation, so it has to be set before that script runs — same init-script
// timing installMockCloud already relies on for window.supabase.
await page.addInitScript(() => localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1"));
await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);

// ===========================================================================
// Step 1: log a session through the real client path.
// ===========================================================================
const beforeCount = await page.evaluate(() => window.__mock.db.private_records.length);
check("private_records starts empty", beforeCount === 0);

await page.evaluate(async (today) => {
  await window.queueSyncRecord(
    "strength_entry",
    { id: "e-today", exerciseId: "back-squat", date: today, type: "reps", weight: 100, reps: 5, sets: 3, ts: Date.now() },
    false
  );
}, TODAY);

await page.waitForFunction(
  () => window.__mock.db.private_records.some((r) => r.user_id === "u1" && r.record_id === "e-today"),
  { timeout: 5000 }
);
check("queueSyncRecord + the real haimunia-sync-needed listener flushed the outbox to a real private_records upsert", true);

const syncedRow = await page.evaluate(() => window.__mock.db.private_records.find((r) => r.record_id === "e-today"));
check("the synced row carries today's date and the strength_entry type the client actually sent", syncedRow.record_type === "strength_entry" && syncedRow.payload && syncedRow.payload.date === TODAY, JSON.stringify(syncedRow));

await page.waitForFunction(
  () => window.__mock.db.analytics_events.some((e) => e.event_name === "attendance_recorded"),
  { timeout: 5000 }
);
const attendanceEvent = await page.evaluate(() => window.__mock.db.analytics_events.find((e) => e.event_name === "attendance_recorded"));
check("ATTENDANCE_RECORDED's real bus emit reached analytics_events as attendance_recorded", !!attendanceEvent);
check("and carries occurred_on only — no workout title, no result", attendanceEvent.props && Object.keys(attendanceEvent.props).sort().join(",") === "occurred_on", JSON.stringify(attendanceEvent.props));

// Step 2's precondition, completed: what the private_records trigger would
// have produced server-side from the real write step 1 just made.
await page.evaluate((today) => {
  window.__mock.db.attendance_log.push({ user_id: "u1", occurred_on: today, recorded_at: new Date().toISOString() });
}, TODAY);

// ===========================================================================
// Step 2: the card itself, on the feed the member lands on by default.
// ===========================================================================
await switchTab(page, "tabCommunityBtn");
await page.waitForSelector('[data-classmates-today="ready"]', { timeout: 5000 });
check("the classmates card renders once both members' attendance_log rows exist for today", true);

const cardText = await page.textContent('[data-classmates-today="ready"]');
check("the card names the classmate who trained today", cardText.includes("נועם"), cardText);
check("the card does not name the caller themselves", !cardText.includes("דנה"), cardText);

await page.waitForFunction(
  () => window.__mock.db.analytics_events.some((e) => e.event_name === "classmates_card_viewed"),
  { timeout: 5000 }
);
const viewedEvent = await page.evaluate(() => window.__mock.db.analytics_events.find((e) => e.event_name === "classmates_card_viewed"));
check("classmates_card_viewed fired once the card actually reached the screen", viewedEvent && viewedEvent.props && viewedEvent.props.rows === 1, JSON.stringify(viewedEvent && viewedEvent.props));

await page.click('[data-classmates-today="ready"] [data-community-action="follow"][data-id="u2"]');
await page.waitForFunction(
  () => window.__mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u2"),
  { timeout: 5000 }
);
check("the card's Follow control reuses the real follow() insert path — no new follow mechanism", true);

const noMessageAffordance = await page.evaluate(() => !document.querySelector('[data-classmates-today="ready"] [data-community-action="message"]'));
check("no Message affordance on the card, per the phase's standing no-messaging resolution", noMessageAffordance);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-classmates-card: FAILED" : "\ncommunity-classmates-card: all checks passed");
process.exit(failed ? 1 : 0);
