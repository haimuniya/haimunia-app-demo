#!/usr/bin/env node
// COMM-234 browser scenario: create, join, and leave a challenge — real
// Chromium, real cloud.js, driven against the in-page mock Supabase backend
// (see lib/mockCloud.mjs; this never touches the real production project).
//
// Always runs against the local static server, never TARGET_URL — see
// resolveLocalOnlyTarget()'s own comment.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const NOW = Date.now();
const iso = (deltaDays) => new Date(NOW + deltaDays * 86400000).toISOString();
const VERIFIED = new Date().toISOString();

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
    { id: "coach1", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    { user_id: "coach1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  challenges: [
    { id: "c-existing", challenge_type: "individual_target", title: "אתגר קיים", description: "", metric_type: "session_count", target_value: 5, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {} },
  ],
  challenge_participants: [], challenge_teams: [], challenge_progress: [],
  workout_posts: [], feed_page_rows: [], analytics_events: [],
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
await page.click('[data-community-action="set-tab"][data-tab="boards"]');
await page.waitForFunction(() => document.body.textContent.includes("אתגרי המועדון"), { timeout: 5000 });
check("Boards tab loaded with the club-challenges heading", true);

// --- create ------------------------------------------------------------
await page.waitForSelector('[data-community-action="open-challenge-form"]', { timeout: 5000 });
await page.click('[data-community-action="open-challenge-form"]');
await page.waitForSelector("#communityChallengeForm", { timeout: 5000 });
await page.fill('#communityChallengeForm input[name="title"]', "10 אימונים בספטמבר");
await page.fill('#communityChallengeForm textarea[name="description"]', "יעד חודשי");
await page.fill('#communityChallengeForm input[name="metricType"]', "session_count");
await page.fill('#communityChallengeForm input[name="targetValue"]', "10");
await page.fill('#communityChallengeForm input[name="startAt"]', "2026-09-01");
await page.fill('#communityChallengeForm input[name="endAt"]', "2026-09-30");
await page.locator("#communityChallengeForm").evaluate((form) => form.requestSubmit());
await page.waitForSelector('[data-challenge-status="draft"]', { timeout: 5000 });
const createdText = await page.textContent('[data-challenge-status="draft"]');
check("a coach's create form produces a draft challenge card in the list", createdText.includes("10 אימונים בספטמבר"), createdText);

const createdId = await page.evaluate(() => {
  const row = window.__mock.db.challenges.find((c) => c.title === "10 אימונים בספטמבר");
  return row ? row.id : null;
});
check("the created row actually landed in the backend as a draft", !!createdId);

// Publish it so join/leave below has something live to act on — the ticket
// scenario is "create, join, leave", and a draft cannot be joined.
await page.evaluate((id) => { window.__mock.db.challenges.find((c) => c.id === id).status = "active"; }, createdId);
await page.click('[data-community-action="set-tab"][data-tab="boards"]');
await page.waitForFunction(() => document.body.textContent.includes("אתגרי המועדון"), { timeout: 5000 });

// --- join ----------------------------------------------------------------
const joinSelector = `[data-challenge-id="${createdId}"] [data-community-action="join-challenge"]`;
await page.waitForSelector(joinSelector, { timeout: 5000 });
await page.click(joinSelector);
await page.waitForFunction(
  (id) => window.__mock.db.challenge_participants.some((p) => p.challenge_id === id && p.user_id === "u1"),
  createdId,
  { timeout: 5000 }
);
check("joining wrote a challenge_participants row for the real signed-in user", true);
await page.waitForFunction(
  (id) => {
    const card = document.querySelector(`[data-challenge-id="${id}"]`);
    return !!card && card.textContent.includes("נרשמת/ה");
  },
  createdId,
  { timeout: 5000 }
);
check("the card flips to the joined state in the UI", true);

// --- leave -----------------------------------------------------------------
const card = page.locator(`[data-challenge-id="${createdId}"]`);
await card.locator('[data-community-action="open-challenge"]').first().click();
await page.waitForSelector('[data-cloud-dialog="challengeView"]', { timeout: 5000 });
await page.click('[data-community-action="leave-challenge"]');
await page.waitForSelector('[data-community-action="confirm-yes"]', { timeout: 5000 });
await page.click('[data-community-action="confirm-yes"]');
await page.waitForFunction(
  (id) => !window.__mock.db.challenge_participants.some((p) => p.challenge_id === id && p.user_id === "u1"),
  createdId,
  { timeout: 5000 }
);
check("leaving deleted the participant row", true);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-challenge-lifecycle: FAILED" : "\ncommunity-challenge-lifecycle: all checks passed");
process.exit(failed ? 1 : 0);
