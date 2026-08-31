#!/usr/bin/env node
// COMM-234 browser scenario: view and share a weekly recap, real Chromium
// against the in-page mock backend (lib/mockCloud.mjs). Does not exercise
// the recap_weekly Edge Function itself (that is server-side, verified
// separately per docs/community/backlog.md's recaps cluster notes) — this
// is the client surface reading the row it produces.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
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
    id: "wr-1", user_id: "u1", week_start: "2026-08-17",
    sessions_completed: 5, streak: 2, prs: [], achievements: [],
    challenge_progress: [], club_challenge_progress: {}, upcoming_event: null,
    generated_at: VERIFIED,
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

// post_create is an RPC the mock has no default for (every real caller
// registers it per-scenario, same as every node test that shares this).
await page.evaluate(() => {
  window.__postCreateCall = null;
  window.__mock.onRpc("post_create", (args) => { window.__postCreateCall = args; return { data: "post-1", error: null }; });
});

await page.click("#tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="account"]');
await page.waitForFunction(() => document.body.textContent.includes("הסיכום השבועי שלי"), { timeout: 5000 });

await page.click('[data-community-action="open-recap"]');
await page.waitForSelector('[data-cloud-dialog="recapView"]', { timeout: 5000 });
await page.waitForFunction(() => document.querySelector('[data-cloud-dialog="recapView"]').textContent.includes("2026-08-17"), { timeout: 5000 });
const recapText = await page.textContent('[data-cloud-dialog="recapView"]');
check("the recap dialog shows the member's most recent week's sessions figure", /5/.test(recapText));
check("the recap dialog shows the member's streak figure", recapText.includes("🔥 2"));

const noPostYet = await page.evaluate(() => window.__postCreateCall === null);
check("viewing/browsing the recap never posts anything on its own", noPostYet);

await page.click('[data-cloud-dialog="recapView"] [data-community-action="share-recap"][data-figure="streak"]');
await page.waitForFunction(() => window.__postCreateCall !== null, { timeout: 5000 });
const shareArgs = await page.evaluate(() => window.__postCreateCall);
check("Share Recap posts through post_create with the chosen figure (streak) in the body", /2/.test(shareArgs.body || ""), JSON.stringify(shareArgs));
check("the shared recap post is club-visible, matching the documented default", shareArgs.visibility === "club");

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-recap: FAILED" : "\ncommunity-recap: all checks passed");
process.exit(failed ? 1 : 0);
