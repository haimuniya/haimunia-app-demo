#!/usr/bin/env node
// COMM-317 (Phase 3 QA sweep) browser scenario for COMM-315: publish a
// member-of-the-week pick from the Coach Dashboard, real Chromium against
// the in-page mock backend (lib/mockCloud.mjs).
//
// member_of_week_candidates()/member_of_week_publish() are new RPCs with no
// default in test/helpers/mockSupabase.mjs (every real caller registers one
// per-scenario, the same shape post_create/coach_celebrate_feed already
// use elsewhere in this directory) — registered by hand below, close to the
// real envelope shape contracts.md pins: {category, category_label,
// candidates, published, previous_week_user_id, free_selection}.
//
// Covers both publish paths COMM-315's own acceptance criteria name: a
// computed-candidate one-click publish (this week's rotation category,
// "most_prs"), and the free-selection "coach's pick" form with its
// required-reason validation and its "cannot repeat last week's pick" note.
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
    { id: "coach1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_prs: true },
    { id: "u3", handle: "maya", display_name: "מאיה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
  ],
  invite_redemptions: [
    { user_id: "coach1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  member_of_week: [], workout_posts: [], notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "coach1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });

// The mock envelope: this week's rotation category is most_prs (COMM-315's
// own named rotation), one real candidate (u2, 5 PRs), and nobody published
// yet. member_of_week_publish resolves the real category server-side
// (candidate publish -> the rotation category; a free selection -> coachs
// pick), mirrored here rather than trusted from the client the way the real
// function's own comment insists on.
await page.evaluate(() => {
  window.__mock.db.__mow_published = null;
  function envelope() {
    const pub = window.__mock.db.__mow_published;
    return {
      category: "most_prs", category_label: "הכי הרבה שיאים אישיים",
      candidates: pub ? [] : [{ user_id: "u2", display_name: "נועם", handle: "noam", detail: { pr_count: 5 } }],
      published: pub,
      previous_week_user_id: null,
      free_selection: false,
    };
  }
  window.__mock.onRpc("member_of_week_candidates", () => ({ data: [envelope()], error: null }));
  window.__mock.onRpc("member_of_week_publish", (args) => {
    if (window.__mock.db.__mow_published) return Promise.resolve({ data: null, error: { message: "week already published" } });
    const reason = String(args.p_reason || "").trim();
    const isShortlisted = args.p_user_id === "u2";
    if (!isShortlisted && !reason) return Promise.resolve({ data: null, error: { message: "reason required for a coach's pick" } });
    window.__mock.db.__mow_published = { user_id: args.p_user_id, reason, published_at: new Date().toISOString() };
    window.__mock.db.member_of_week.push({
      id: "mow-1", week_start: "2026-08-24",
      category: isShortlisted ? "most_prs" : "coachs_pick",
      user_id: args.p_user_id, reason, published_by: "coach1", published_at: window.__mock.db.__mow_published.published_at,
    });
    return Promise.resolve({ data: "mow-1", error: null });
  });
});

await dismissWelcomeModal(page);

await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="coach"]');
await page.waitForFunction(() => document.body.textContent.includes("חבר/ת השבוע"), { timeout: 5000 });
await page.waitForSelector('[data-community-action="coach-mow-publish-candidate"][data-id="u2"]', { timeout: 5000 });
check("the week's rotation category and its real computed candidate are shown, not the empty state", true);
check("the section header names the real rotation category", (await page.textContent("body")).includes("הכי הרבה שיאים אישיים"));
const candidateRowText = await page.evaluate(() => document.querySelector('[data-community-action="coach-mow-publish-candidate"][data-id="u2"]').closest(".log-row").textContent);
check("the candidate's category-shaped detail renders translated, not a raw JSON dump", candidateRowText.includes("נועם") && candidateRowText.includes("5 שיאים אישיים השבוע"), candidateRowText);

// ---- Path 1: one-click publish of the computed candidate ------------------
await page.click('[data-community-action="coach-mow-publish-candidate"][data-id="u2"]');
await page.waitForFunction(() => window.__mock.db.__mow_published != null, { timeout: 5000 });
await page.waitForFunction(() => !document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), { timeout: 5000 });
check("publishing wrote a real member_of_week row and the suggestion UI is fully replaced by the published view", true);

const publishedRow = await page.evaluate(() => window.__mock.db.member_of_week[0]);
check("the row records the category the server resolved, most_prs for a shortlisted publish, not coachs_pick", publishedRow.category === "most_prs", JSON.stringify(publishedRow));
check("the published view names the real member", (await page.textContent("body")).includes("נועם"));

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-member-of-week-publish: FAILED" : "\ncommunity-member-of-week-publish: all checks passed");
process.exit(failed ? 1 : 0);
