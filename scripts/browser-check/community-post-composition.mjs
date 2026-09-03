#!/usr/bin/env node
// COMM-363 browser scenario: compose and publish a post end-to-end, real
// Chromium against the in-page mock backend (lib/mockCloud.mjs).
//
// Community's single most-used action had only mocked-Supabase unit
// coverage (test/community-composer.test.mjs) before this - real enough to
// prove publishComposer()'s own logic, but never through a real browser's
// actual DOM events (input/change/click), a real textarea's own value
// handling, or the real feed render that follows a successful publish.
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
  community_feed: [], feed_page_rows: [], feed_impressions: [], feed_interactions: [],
  follows: [], blocks: [], reactions: [], post_comments: [], hidden_posts: [],
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

// post_create has no built-in mock default (every caller registers its own,
// same as every node composer test) - window.__mock exists as soon as
// navigation completes.
await page.evaluate(() => {
  window.__mock.onRpc("post_create", (args, ctx) => {
    const id = "post-" + ((ctx.db.__postSeq = (ctx.db.__postSeq || 0) + 1));
    ctx.db.workout_posts = ctx.db.workout_posts || [];
    ctx.db.workout_posts.push({ id, body: args.body, visibility: args.visibility, author_id: ctx.currentUser.id });
    return { data: id, error: null };
  });
});

await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });

await page.click('[data-community-action="open-composer"]');
await page.waitForSelector("#postComposer", { timeout: 5000 });

const publishBtn = () => page.$('[data-community-action="composer-publish"]');
check("Publish starts disabled with no text and no media", await (await publishBtn()).isDisabled());

await page.fill("[data-composer-body]", "בוקר טוב מהקהילה — יום נהדר לאימון");
// A real browser textarea only fires "input" from fill(); the composer's
// own counter/Publish-enable logic reads off that same real event, not a
// synthetic one constructed inside the page like the jsdom unit test does.
check("Publish enables once real typed text is present", !(await (await publishBtn()).isDisabled()));

const visSelect = await page.$("[data-composer-visibility]");
await visSelect.selectOption("only_me");

await page.click('[data-community-action="composer-publish"]');
await page.waitForFunction(() => window.__mock.db.workout_posts && window.__mock.db.workout_posts.length === 1, { timeout: 5000 });
check("publishing actually called post_create and wrote a real row", true);

const written = await page.evaluate(() => window.__mock.db.workout_posts[0]);
check("the published post carries the typed body", written.body.includes("בוקר טוב מהקהילה"), written.body);
check("the published post carries the chosen visibility", written.visibility === "only_me", written.visibility);

await page.waitForFunction(() => !document.getElementById("postComposer"), { timeout: 5000 });
check("the composer closes on a successful publish", true);

await page.waitForSelector('.post-card[data-post-type="POST_TEXT"]', { timeout: 5000 });
const feedText = await page.textContent('.post-card[data-post-type="POST_TEXT"]');
check("the new post appears in the feed immediately (optimistic insert)", feedText.includes("בוקר טוב מהקהילה"), feedText);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-post-composition: FAILED" : "\ncommunity-post-composition: all checks passed");
process.exit(failed ? 1 : 0);
