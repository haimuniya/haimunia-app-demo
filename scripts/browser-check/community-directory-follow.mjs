#!/usr/bin/env node
// COMM-234 browser scenario: open the members directory and follow someone
// from it, real Chromium against the in-page mock backend (lib/mockCloud.mjs).
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
function member(id, name, extra) {
  return Object.assign({ id, handle: id, display_name: name, is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true }, extra || {});
}

const seedTables = {
  profiles: [member("u1", "דנה"), member("u2", "נועם")],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
  ],
  follows: [], blocks: [], reactions: [], post_comments: [],
  feed_page_rows: [], feed_impressions: [], feed_interactions: [], hidden_posts: [],
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

await page.click("#tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="directory"]');
await page.waitForFunction(() => document.querySelectorAll('[data-directory-group="members"] [data-community-action="view-profile"]').length === 1, { timeout: 5000 });
check("the directory lists the one other club member", true);

const noSelfRow = await page.$('[data-community-action="view-profile"][data-id="u1"]');
check("the caller never sees their own row in the roster", !noSelfRow);

await page.click('[data-community-action="follow"][data-id="u2"]');
await page.waitForFunction(
  () => window.__mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u2"),
  { timeout: 5000 }
);
check("following from the directory wrote a real follows edge", true);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-directory-follow: FAILED" : "\ncommunity-directory-follow: all checks passed");
process.exit(failed ? 1 : 0);
