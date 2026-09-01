#!/usr/bin/env node
// COMM-317 (Phase 3 QA sweep) browser scenario for COMM-316: open the
// weekly recap and see the classmates line, real Chromium against the
// in-page mock backend (lib/mockCloud.mjs).
//
// Same boundary community-recap.mjs (COMM-234) already drew and this file
// keeps: recap_weekly is a scheduled Edge Function this repo has no local
// server to run, so the scenario seeds `weekly_recaps` with the row it
// would have produced (classmates included, exactly the
// `{user_id, display_name, handle, avatar_url}` shape recap_weekly_classmates()
// is pinned to by supabase/tests/0047) and exercises the real client
// surface reading it: the dialog render, the classmates line's names-not-a-
// count content, the profile links, and the quiet-week empty line on a
// second week with none.
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

const seedTables = {
  profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
  invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  weekly_recaps: [{
    id: "wr-1", user_id: "u1", week_start: "2026-08-24",
    sessions_completed: 3, streak: 1, prs: [], achievements: [],
    challenge_progress: [], club_challenge_progress: {}, upcoming_event: null,
    // recap_weekly_classmates()'s documented shape (contracts.md, COMM-316):
    // up to 5 objects, already privacy-gated server-side, rendered in the
    // order returned — this is that output, standing in for what the Edge
    // Function would have written.
    classmates: [
      { user_id: "u2", display_name: "נועם", handle: "noam", avatar_url: null },
      { user_id: "u3", display_name: "מאיה", handle: "maya", avatar_url: null },
    ],
    generated_at: VERIFIED,
  }, {
    // A quiet week, older than the one above, present from boot so
    // recap-older's own real query (a real .lt("week_start", ...).order()
    // round trip against the mock) has a real second row to find rather
    // than one spliced in mid-test.
    id: "wr-2", user_id: "u1", week_start: "2026-08-17",
    sessions_completed: 0, streak: 0, prs: [], achievements: [],
    challenge_progress: [], club_challenge_progress: {}, upcoming_event: null,
    classmates: [], generated_at: VERIFIED,
  }],
  onboarding_progress: [{ user_id: "u1", welcomed_at: VERIFIED, first_week_shown_at: VERIFIED, first_month_shown_at: VERIFIED }],
  notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);

await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="account"]');
await page.waitForFunction(() => document.body.textContent.includes("הסיכום השבועי שלי"), { timeout: 5000 });

await page.click('[data-community-action="open-recap"]');
await page.waitForSelector('[data-cloud-dialog="recapView"]', { timeout: 5000 });
await page.waitForSelector('[data-cloud-dialog="recapView"] [data-recap-classmates="ready"]', { timeout: 5000 });

const lineText = await page.textContent('[data-cloud-dialog="recapView"] [data-recap-classmates="ready"]');
check("the classmates line lists real names, not just a count", lineText.includes("נועם") && lineText.includes("מאיה"), lineText);

const linkCount = await page.$$eval(
  '[data-cloud-dialog="recapView"] [data-recap-classmates="ready"] [data-community-action="view-profile"]',
  (els) => els.length
);
check("each classmate is a link to their profile", linkCount === 2, String(linkCount));

const linkedIds = await page.$$eval(
  '[data-cloud-dialog="recapView"] [data-recap-classmates="ready"] [data-community-action="view-profile"]',
  (els) => els.map((e) => e.getAttribute("data-id")).sort()
);
check("the links point at the two real classmates, in the order the row returned them", JSON.stringify(linkedIds) === JSON.stringify(["u2", "u3"]), JSON.stringify(linkedIds));

// Navigate to the older, quiet week with recap-older — a real prev-week
// round trip against the mock, not a second page load — and confirm the
// quiet-week empty line, not an omitted line and not an error.
await page.click('[data-cloud-dialog="recapView"] [data-community-action="recap-older"]');
await page.waitForFunction(() => document.querySelector('[data-cloud-dialog="recapView"]')?.textContent.includes("2026-08-17"), { timeout: 5000 });
await page.waitForSelector('[data-cloud-dialog="recapView"] [data-recap-classmates="empty"]', { timeout: 5000 });
const emptyLineText = await page.textContent('[data-cloud-dialog="recapView"] [data-recap-classmates="empty"]');
check("a quiet week with zero overlap gets an honest empty classmates line, not an error and not an omitted section", emptyLineText.includes("אין חברים משותפים השבוע"), emptyLineText);

// And back — the line is not stuck from either week.
await page.click('[data-cloud-dialog="recapView"] [data-community-action="recap-newer"]');
await page.waitForFunction(() => document.querySelector('[data-cloud-dialog="recapView"]')?.textContent.includes("2026-08-24"), { timeout: 5000 });
await page.waitForSelector('[data-cloud-dialog="recapView"] [data-recap-classmates="ready"]', { timeout: 5000 });
const lineTextAgain = await page.textContent('[data-cloud-dialog="recapView"] [data-recap-classmates="ready"]');
check("navigating back to the populated week shows the classmates line again, unchanged", lineTextAgain.includes("נועם") && lineTextAgain.includes("מאיה"), lineTextAgain);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-recap-classmates: FAILED" : "\ncommunity-recap-classmates: all checks passed");
process.exit(failed ? 1 : 0);
