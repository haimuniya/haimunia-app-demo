#!/usr/bin/env node
// COMM-234 browser scenario: one-tap congratulate from the Coach Dashboard,
// real Chromium against the in-page mock backend (lib/mockCloud.mjs).
//
// Note on "confirm": COMM-225 deliberately has no confirm dialog for this
// action — cloud.js's own congratulateCelebrateItem() comment says "the tap
// itself is the confirmation" (see test/community-coach-tools.test.mjs for
// the executing node coverage of that design, including the disabled-after
// no-op and the error/retry path). COMM-234's own acceptance criteria list
// "coach Congratulate confirm" among the dialogs needing keyboard/focus
// tests, but no such dialog exists by design — flagged in this sweep's
// report rather than fabricated here.
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
const NOW = Date.now();
const daysAgoIso = (days) => new Date(NOW - days * 86400000).toISOString();

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(400) },
    { id: "u9", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(3), show_prs: true, in_leaderboards: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    { user_id: "u9", invite_id: "inv-1", role: "member", redeemed_at: daysAgoIso(3) },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
  coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
  post_comments: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });

// coach_celebrate_feed is an RPC the mock has no built-in default for
// (every real caller registers it per-scenario, same as every node test
// that shares this) — window.__mock exists as soon as navigation completes
// (addInitScript runs before any page script, cloud.js included).
await page.evaluate(() => {
  window.__mock.onRpc("coach_celebrate_feed", () => ({
    data: [{ kind: "pr", user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, occurred_at: new Date().toISOString(), post_id: "p-pr", detail: { movement: "סקוואט", result: '100 ק"ג' } }],
    error: null,
  }));
});

await dismissWelcomeModal(page);

await page.click("#tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="coach"]');
await page.waitForSelector('[data-community-action="coach-congratulate"]', { timeout: 5000 });
check("the Celebrate list shows the PR item with a Congratulate control", true);

await page.click('[data-community-action="coach-congratulate"]');
await page.waitForFunction(
  () => window.__mock.db.post_comments && window.__mock.db.post_comments.some((c) => c.post_id === "p-pr"),
  { timeout: 5000 }
);
check("one tap wrote the congratulation comment onto the member's real PR post", true);

const commentText = await page.evaluate(() => window.__mock.db.post_comments.find((c) => c.post_id === "p-pr").body);
check("the comment names the celebrated member", commentText.includes("נועה"), commentText);

await page.waitForFunction(() => document.querySelector('[data-community-action="coach-congratulate"]').textContent.includes("ברכתם"), { timeout: 5000 });
const disabledAfter = await page.evaluate(() => document.querySelector('[data-community-action="coach-congratulate"]').disabled);
check("the control disables itself immediately after (no double-send is possible)", disabledAfter);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-coach-congratulate: FAILED" : "\ncommunity-coach-congratulate: all checks passed");
process.exit(failed ? 1 : 0);
