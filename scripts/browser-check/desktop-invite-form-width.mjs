#!/usr/bin/env node
// Live bug hunt (2026-09-11): the ≥1200px staff-tier rule widens #app to
// ~940px for genuinely tabular admin work (roster, moderation queue,
// analytics) - see desktop-layout.mjs for that mechanism's own coverage.
// The person-invite and shared-code creation forms render inside that same
// widened container but are single-field forms, not tables - .text-input's
// own width:100% stretched them to the full measure regardless. Measured
// live before the fix: an 874px-wide "מקסימום שימושים" number input next
// to an 89px submit button.
//
// EVERY ASSERTION IS PAIRED WITH A CONTROL: the fix is a single CSS rule
// ([data-invite-management-section]{max-width:448px}), so this script also
// removes it live and re-measures, proving the same page and the same
// element WOULD fail without it.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = await consoleErrorCollector(page);

const VERIFIED = new Date().toISOString();
await installMockCloud(page, {
  profiles: [{ id: "admin-1", handle: "roi", display_name: "רועי", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
  invite_redemptions: [{ user_id: "admin-1", invite_id: "i1", role: "admin", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  workout_posts: [], feed_page_rows: [], post_comments: [], reports: [], admin_actions: [],
  pins: [], posting_restrictions: [], follows: [], hidden_posts: [], notifications: [],
  notification_preferences: [],
}, { user: { id: "admin-1", is_anonymous: false, email: "admin@members.haimuniya.invalid" } });
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible" });
await dismissWelcomeModal(page);

await page.waitForSelector("#desktopSidebar .navrow[data-tab='manage']", { timeout: 10000 });
await page.click("#desktopSidebar .navrow[data-tab='manage']");
await page.waitForSelector("#content .subtabbar[aria-label='ניווט בניהול']", { timeout: 10000 });

const appWidth = await page.evaluate(() => Math.round(document.getElementById("app").getBoundingClientRect().width));
check("the staff-tier widening is actually in effect for this check to mean anything", appWidth > 560, `#app w=${appWidth}`);

// The shared-code create form lives behind a collapsed <details> disclosure
// by default (see the separate live-bug-hunt fix for that disclosure's own
// open-state bug) - open it before this check can even see the input.
await page.waitForSelector("#inviteSharedCodeDisclosure summary", { timeout: 10000 });
await page.click("#inviteSharedCodeDisclosure summary");
await page.waitForSelector("#communityInviteCodeCreate [name='maxUses']", { state: "visible", timeout: 10000 });
const widthOf = () => page.evaluate(() => Math.round(document.querySelector("#communityInviteCodeCreate [name='maxUses']").getBoundingClientRect().width));

const fixedWidth = await widthOf();
check("the shared-code form's number input stays a sane single-column width, not stretched across the widened admin column", fixedWidth <= 460, `width=${fixedWidth}px (#app is ${appWidth}px)`);

// ---- Control: remove the fix's own CSS rule live and re-measure ----
await page.addStyleTag({ content: "[data-invite-management-section]{ max-width: none !important; }" });
const brokenWidth = await widthOf();
check(
  "control: removing the fix's own rule DOES stretch the same input back out",
  brokenWidth > 700,
  brokenWidth > 700 ? `width=${brokenWidth}px, confirms the check can detect the bug` : `width=${brokenWidth}px — this check can no longer detect the bug it guards`,
);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ndesktop-invite-form-width: FAILED" : "\ndesktop-invite-form-width: all checks passed");
process.exit(failed ? 1 : 0);
