#!/usr/bin/env node
// COMM-234 browser scenario: run a combined search and see results grouped
// by members / events / challenges, real Chromium against the in-page
// mock backend (lib/mockCloud.mjs).
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
const NOW = Date.now();
const iso = (deltaDays) => new Date(NOW + deltaDays * 86400000).toISOString();

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true },
    { id: "u2", handle: "ritz", display_name: "ריצה נועם", visible_to_club: true, allow_follows: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  events: [{ id: "e1", title: "ריצת בוקר", event_type: "social", status: "published", start_at: iso(4), created_by: "u2" }],
  challenges: [{ id: "c1", challenge_type: "individual_target", title: "ריצת 50 קילומטר", status: "active", start_at: iso(-2), end_at: iso(9), created_by: "u2", target_value: 50, metric_type: "distance", join_mode: "open", visibility: "club", config: {} }],
  feed_page_rows: [], analytics_events: [], follows: [], hidden_posts: [], saved_posts: [], notifications: [], notification_preferences: [],
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
await page.waitForSelector("#communityClubTop", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="account"]');
await page.waitForSelector("#communityPeopleSearch", { timeout: 5000 });

await page.fill("#communityPeopleSearch", "ריצ");
await page.waitForFunction(() => document.querySelectorAll('[data-search-group="members"] .log-row').length === 1, { timeout: 5000 });

const groupOrder = await page.$$eval("[data-search-group]", (els) => els.map((e) => e.dataset.searchGroup));
check("results render grouped, members/events/challenges in order, never interleaved", JSON.stringify(groupOrder) === JSON.stringify(["members", "events", "challenges"]), JSON.stringify(groupOrder));

const membersText = await page.textContent('[data-search-group="members"]');
check("the members group shows the matching member", membersText.includes("ריצה נועם"));
const eventsText = await page.textContent('[data-search-group="events"]');
check("the events group shows the matching event", eventsText.includes("ריצת בוקר"));
const challengesText = await page.textContent('[data-search-group="challenges"]');
check("the challenges group shows the matching challenge", challengesText.includes("ריצת 50 קילומטר"));

const searchCalls = await page.evaluate(() => window.__mock.callsTo("community_search").length);
check("exactly one round trip for the settled query, not three", searchCalls === 1, `calls=${searchCalls}`);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-search: FAILED" : "\ncommunity-search: all checks passed");
process.exit(failed ? 1 : 0);
