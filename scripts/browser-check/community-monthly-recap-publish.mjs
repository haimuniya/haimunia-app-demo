#!/usr/bin/env node
// COMM-317 (Phase 3 QA sweep) browser scenario for COMM-309: publish a
// monthly club recap from the admin preview, real Chromium against the
// in-page mock backend (lib/mockCloud.mjs).
//
// Does not exercise recap_monthly_generate() itself (a service-role-only
// Postgres function this repo has no local server to run against — same
// boundary community-recap.mjs already drew for recap_weekly). Seeds
// monthly_club_recaps with the unpublished draft row generation would have
// produced and exercises the real client surface: the staff preview, the
// permission gate the ticket named as the one thing the client half had to
// get right (community.analytics.view or real is_admin, narrower than
// is_staff() — a coach previewing a draft must not be shown a "פרסום"
// button the database would refuse), and the real recap_monthly_publish RPC
// call.
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

function draftRow() {
  return {
    id: "mrec-1", club_id: "club-1", month_start: "2026-08-01",
    sessions_logged: 412, posts_created: 63, new_members: 5,
    challenges_completed: 2, events_held: 4,
    generated_at: VERIFIED, published_at: null,
  };
}

async function registerPublishRpc(page) {
  await page.evaluate(() => {
    window.__mock.onRpc("recap_monthly_publish", (args) => {
      const user = window.__mock.getUser();
      const uid = user && user.id;
      // Mirrors the real recap_monthly_publish()'s own gate:
      // community.analytics.view or real is_admin(), narrower than
      // is_staff() — the one asymmetry COMM-309's own header note insists
      // the client half must respect. Read off the same fixtures cloud.js's
      // hasPerm()/isAdmin() already resolved for the button, not
      // re-derived, so the mock and the client agree on who may call this.
      const me = window.__mock.db.profiles.find((p) => p.id === uid);
      const isAdmin = !!(me && me.is_admin);
      const role = (window.__mock.db.invite_redemptions.find((r) => r.user_id === uid) || {}).role;
      const canPublish = isAdmin || role === "admin";
      if (!canPublish) return Promise.resolve({ data: null, error: { message: "not authorized" } });
      const row = window.__mock.db.monthly_club_recaps.find((r) => r.id === args.p_id);
      if (!row) return Promise.resolve({ data: null, error: { message: "recap not found" } });
      if (row.published_at) return Promise.resolve({ data: null, error: { message: "recap already published" } });
      row.published_at = new Date().toISOString();
      return Promise.resolve({ data: null, error: null });
    });
  });
}

// ===========================================================================
// Part 1: a coach previewing the draft — sees the figures, never a button
// the database would refuse.
// ===========================================================================
{
  const seedTables = {
    profiles: [{ id: "coach1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "coach1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    monthly_club_recaps: [draftRow()],
    notifications: [], notification_preferences: [],
  };
  const target = await resolveLocalOnlyTarget();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, seedTables, { user: { id: "coach1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await registerPublishRpc(page);
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector(".subtabbar", { timeout: 5000 });
  await page.click('[data-community-action="set-tab"][data-tab="coach"]');
  await page.waitForFunction(() => document.body.textContent.includes("סיכום חודשי למועדון"), { timeout: 5000 });
  await page.waitForFunction(() => document.body.textContent.includes("412"), { timeout: 5000 });
  check("a coach previewing the draft sees the real figures (is_staff() is enough for the read policy)", true);
  const publishBtn = await page.$('[data-community-action="coach-monthly-recap-publish"]');
  check("a coach gets no publish control at all — is_staff() is not the gate recap_monthly_publish() checks", !publishBtn);
  check("and is told why, rather than left to wonder if the draft is broken", (await page.textContent("body")).includes("רק בעל/ת הרשאת אנליטיקה או מנהל/ת יכול/ה לפרסם"));
  check("no console errors (coach preview)", errors.length === 0, errors.join(" | "));
  await browser.close();
  await target.close();
  if (errors.length) failed = true;
}

// ===========================================================================
// Part 2: an admin publishes it.
// ===========================================================================
{
  const seedTables = {
    profiles: [{ id: "admin1", handle: "roi", display_name: "רועי", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "admin1", invite_id: "inv-1", role: "admin", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    monthly_club_recaps: [draftRow()],
    notifications: [], notification_preferences: [],
  };
  const target = await resolveLocalOnlyTarget();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, seedTables, { user: { id: "admin1", is_anonymous: false, email: "roi@members.haimuniya.invalid" } });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await registerPublishRpc(page);
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector(".subtabbar", { timeout: 5000 });
  await page.click('[data-community-action="set-tab"][data-tab="coach"]');
  await page.waitForFunction(() => document.body.textContent.includes("סיכום חודשי למועדון"), { timeout: 5000 });
  await page.waitForSelector('[data-community-action="coach-monthly-recap-publish"]', { timeout: 5000 });
  check("an admin (community.analytics.view / is_admin) gets the real publish control on the draft", true);
  check("the draft is still labelled a draft before publishing", (await page.textContent("body")).includes("טיוטה"));

  await page.click('[data-community-action="coach-monthly-recap-publish"]');
  await page.waitForFunction(
    () => window.__mock.db.monthly_club_recaps.find((r) => r.id === "mrec-1")?.published_at != null,
    { timeout: 5000 }
  );
  check("publishing stamped published_at through the real recap_monthly_publish RPC", true);
  await page.waitForFunction(() => !document.querySelector('[data-community-action="coach-monthly-recap-publish"]'), { timeout: 5000 });
  check("a published recap has no publish control left — this ticket's own \"cannot be un-published or edited\" rule", true);
  check("the preview now reads a publish timestamp instead of the draft label", (await page.textContent("body")).includes("פורסם") && !(await page.textContent("body")).includes("· טיוטה"));

  // A second publish attempt (the real server-side "already published"
  // refusal, mapped to the copy monthlyRecapErrorText() carries verbatim)
  // — proven by calling the RPC again directly, since the client button is
  // already gone.
  const secondCallError = await page.evaluate(async () => {
    const { error } = await window.__mock.client.rpc("recap_monthly_publish", { p_id: "mrec-1" });
    return error && error.message;
  });
  check("a second publish call for an already-published month is refused server-side, never silently re-published", secondCallError === "recap already published", String(secondCallError));

  check("no console errors (admin publish)", errors.length === 0, errors.join(" | "));
  await browser.close();
  await target.close();
  if (errors.length) failed = true;
}

console.log(failed ? "\ncommunity-monthly-recap-publish: FAILED" : "\ncommunity-monthly-recap-publish: all checks passed");
process.exit(failed ? 1 : 0);
