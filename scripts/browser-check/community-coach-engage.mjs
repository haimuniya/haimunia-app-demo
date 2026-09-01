#!/usr/bin/env node
// COMM-317 (Phase 3 QA sweep) browser scenario for COMM-304: the coach
// Engage section showing a real flagged member for the first time, real
// Chromium against the in-page mock backend (lib/mockCloud.mjs).
//
// COMM-226 built this section as a flag-gated, hidden-unless-on shell
// reading coach_engagement_flags under existing staff RLS, with nothing to
// show it — the table shipped empty. COMM-304 is the ticket that flips
// state.featureFlags.coachEngage default-on and gives coach_detect_engagement_
// decline() its first real writes. This is the first browser-level coverage
// of the section with actual rows in it: two open flags at different
// levels, the "reach out" one-tap action (post_create + a POST_COACH
// update, congratulateCelebrateItem's own pattern per COMM-304's own
// acceptance criteria), review, and dismiss.
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
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u9", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u10", handle: "gil", display_name: "גיל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    { user_id: "u9", invite_id: "inv-1", role: "member", redeemed_at: daysAgo(200) },
    { user_id: "u10", invite_id: "inv-1", role: "member", redeemed_at: daysAgo(200) },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  // coach_detect_engagement_decline()'s real output shape (202608310008):
  // id, user_id, level, status, flagged_at — the five columns COMM-304's
  // own client half selects and no more (the two session-count columns
  // never reach this table's read).
  coach_engagement_flags: [
    { id: "flag-1", user_id: "u9", level: "significant", status: "open", flagged_at: daysAgo(1) },
    { id: "flag-2", user_id: "u10", level: "mild", status: "open", flagged_at: daysAgo(2) },
  ],
  workout_posts: [], post_comments: [], analytics_events: [], notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });

// post_create is an RPC the mock has no built-in default for (every real
// caller registers it per-scenario). It also inserts the real
// workout_posts row engageReachOut's own subsequent update targets by id,
// the same way the real RPC would have.
await page.evaluate(() => {
  window.__postCreateCalls = [];
  window.__mock.onRpc("post_create", (args) => {
    const id = "post-" + (window.__postCreateCalls.length + 1);
    window.__postCreateCalls.push(args);
    window.__mock.db.workout_posts.push({
      id, author_id: "u1", body: args.body, visibility: args.visibility,
      post_type: "POST_WORKOUT", created_at: new Date().toISOString(), metadata: {},
    });
    return { data: id, error: null };
  });
});

await dismissWelcomeModal(page);

await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="coach"]');
await page.waitForFunction(() => document.body.textContent.includes("מעקב מעורבות"), { timeout: 5000 });
await page.waitForFunction(
  () => document.querySelectorAll('[data-community-action="coach-engage-reach-out"]').length === 2,
  { timeout: 5000 }
);
check("the Engage section shows both real flagged members for the first time, not the COMM-226 empty state", true);

const sectionText = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-community-action="coach-engage-reach-out"]'));
  return rows.map((b) => b.closest(".log-row").textContent);
});
check("the significant-decline member's row shows the real level label", sectionText.some((t) => t.includes("נועה") && t.includes("ירידה משמעותית בהגעה")), JSON.stringify(sectionText));
check("the mild-decline member's row shows the real level label", sectionText.some((t) => t.includes("גיל") && t.includes("ירידה קלה בהגעה")), JSON.stringify(sectionText));
check("no raw session-count figure reaches this staff view — only the level bucket", !sectionText.some((t) => /\d{2,}/.test(t)), JSON.stringify(sectionText));

// ---- Reach out (one-tap, no confirm dialog, per COMM-225's own pattern) --
await page.click('[data-community-action="coach-engage-reach-out"][data-id="flag-1"]');
await page.waitForFunction(() => window.__postCreateCalls.length === 1, { timeout: 5000 });
const reachOutArgs = await page.evaluate(() => window.__postCreateCalls[0]);
check("reach-out posted through post_create, club-visible", reachOutArgs.visibility === "club", JSON.stringify(reachOutArgs));
check("the reach-out body is a generic warm check-in that never names the decline or a level", reachOutArgs.body.includes("נועה") && !/ירידה|נעדר|לא פעיל/.test(reachOutArgs.body), reachOutArgs.body);

await page.waitForFunction(
  () => window.__mock.db.workout_posts.some((p) => p.post_type === "POST_COACH"),
  { timeout: 5000 }
);
check("the created post was updated to POST_COACH, the real second half of the reach-out write", true);

await page.waitForFunction(
  () => document.querySelector('[data-community-action="coach-engage-reach-out"][data-id="flag-1"]')?.disabled === true,
  { timeout: 5000 }
);
check("the reach-out control disables itself after one tap — no double-send", true);

// ---- Review one flag, dismiss the other -----------------------------------
await page.click('[data-community-action="coach-engage-review"][data-id="flag-1"]');
await page.waitForFunction(
  () => !document.querySelector('[data-community-action="coach-engage-reach-out"][data-id="flag-1"]'),
  { timeout: 5000 }
);
const reviewedRow = await page.evaluate(() => window.__mock.db.coach_engagement_flags.find((f) => f.id === "flag-1"));
check("marking reviewed wrote status/reviewed_by/reviewed_at in one real RLS update, and the row left the open list", reviewedRow.status === "reviewed" && reviewedRow.reviewed_by === "u1" && !!reviewedRow.reviewed_at, JSON.stringify(reviewedRow));

await page.click('[data-community-action="coach-engage-dismiss"][data-id="flag-2"]');
await page.waitForFunction(() => document.body.textContent.includes("אין חברים שדורשים תשומת לב"), { timeout: 5000 });
const dismissedRow = await page.evaluate(() => window.__mock.db.coach_engagement_flags.find((f) => f.id === "flag-2"));
check("dismissing the second flag wrote status='dismissed' and the section fell back to the real empty state, both flags now resolved", dismissedRow.status === "dismissed", JSON.stringify(dismissedRow));

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-coach-engage: FAILED" : "\ncommunity-coach-engage: all checks passed");
process.exit(failed ? 1 : 0);
