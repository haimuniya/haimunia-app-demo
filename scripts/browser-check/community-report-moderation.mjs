#!/usr/bin/env node
// COMM-363 browser scenario: report a post, then have an admin review and
// action it end-to-end, real Chromium against the in-page mock backend
// (lib/mockCloud.mjs). Both mod_queue and mod_review are built-in mock RPC
// stand-ins (test/helpers/mockSupabase.mjs) with real permission and
// state-transition logic, the same ones test/community-moderation.test.mjs
// already proves through the mocked-Supabase path - this exercises the same
// contract through real DOM events (click) and a real role switch, not
// window.eval'd click-handler calls or a single pre-authenticated session.
//
// The role switch (reporter -> head_coach) is done directly against the
// mock's auth client, the same shortcut community-live-sync-and-auth.test.mjs
// takes to reach a second account - the login *form* itself already has
// dedicated coverage elsewhere and is not what this scenario is testing.
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
  profiles: [
    { id: "author-1", handle: "kobi", display_name: "קובי", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "reporter-1", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "mod-1", handle: "mod", display_name: "מודרטור", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
  ],
  invite_redemptions: [
    { user_id: "author-1", invite_id: "i1", role: "member", redeemed_at: VERIFIED },
    { user_id: "reporter-1", invite_id: "i2", role: "member", redeemed_at: VERIFIED },
    { user_id: "mod-1", invite_id: "i3", role: "head_coach", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  workout_posts: [{ id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן שדווח", status: "active", created_at: VERIFIED, published_at: VERIFIED }],
  feed_page_rows: [{ id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן שדווח", created_at: VERIFIED }],
  post_comments: [], reports: [], admin_actions: [], pins: [], posting_restrictions: [],
  follows: [], hidden_posts: [], notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "reporter-1", is_anonymous: false, email: "noa@members.haimuniya.invalid" } });

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);

// --- Step 1: the reporter reports the post from the real feed card. ---
// "Report" lives inside the post's "⋯" overflow menu, not on the card
// itself - opening it first is the same click a real member makes.
await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.waitForSelector('[data-community-action="toggle-post-menu"][data-id="post-1"]', { timeout: 10000 });
await page.click('[data-community-action="toggle-post-menu"][data-id="post-1"]');
await page.waitForSelector('[data-community-action="report"][data-id="post-1"]', { timeout: 5000 });
await page.click('[data-community-action="report"][data-id="post-1"]');

await page.waitForSelector("[data-report-reason]", { timeout: 5000 });
await page.click('[data-report-reason="harassment"]');
await page.click('[data-community-action="report-submit"]');
await page.waitForFunction(() => /הדיווח התקבל/.test(document.body.textContent), { timeout: 5000 });
check("the report sheet confirms receipt", true);

const reportRow = await page.evaluate(() => window.__mock.db.reports.find((r) => r.target_id === "post-1"));
check("a real report row was written for the correct reporter and reason", !!reportRow && reportRow.reporter_id === "reporter-1" && reportRow.reason === "harassment");

await page.click('[data-community-action="report-close"]');

// --- Step 2: switch identity to the head coach who moderates. ---
await page.evaluate(() => {
  window.__mock.seedCredentials("mod-1", "mod@members.haimuniya.invalid", "modpass123");
});
await page.evaluate(() => window.__mock.client.auth.signOut());
await page.waitForFunction(() => !!document.getElementById("communityLogin"), { timeout: 5000 });
await page.evaluate(() => window.__mock.client.auth.signInWithPassword({ email: "mod@members.haimuniya.invalid", password: "modpass123" }));
await page.waitForFunction(() => !!document.querySelector(".subtabbar"), { timeout: 5000 });

// --- Step 3: the moderator opens the queue and removes the content. ---
await page.click('[data-community-action="set-tab"][data-tab="account"]');
await page.waitForSelector('[data-community-action="mod-action"][data-decision="remove"]', { timeout: 5000 });
check("the head coach sees the reported item with a Remove action in the real moderation queue", true);

await page.click('[data-community-action="mod-action"][data-decision="remove"]');
await page.waitForSelector('[data-community-action="mod-action-run"]', { timeout: 5000 });
await page.click('[data-community-action="mod-action-run"]');

await page.waitForFunction(
  () => window.__mock.db.workout_posts.find((p) => p.id === "post-1")?.status === "removed",
  { timeout: 5000 }
);
check("the real mod_review RPC removed the reported post", true);

const auditRows = await page.evaluate(() => window.__mock.db.admin_actions.map((a) => a.action_type));
check("a report_review audit row was written", auditRows.includes("report_review"), auditRows.join(","));
check("a content_delete audit row was written", auditRows.includes("content_delete"), auditRows.join(","));

const reportAfter = await page.evaluate(() => window.__mock.db.reports.find((r) => r.target_id === "post-1"));
check("the report itself moved to action_taken", reportAfter.status === "action_taken", reportAfter.status);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-report-moderation: FAILED" : "\ncommunity-report-moderation: all checks passed");
process.exit(failed ? 1 : 0);
