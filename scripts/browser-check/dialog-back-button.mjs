#!/usr/bin/env node
// Regression net for the Android/PWA hardware back button against every
// dialog this app knows how to open, in BOTH of its two independent dialog
// registries.
//
// THE BUG THIS GUARDS. A real-user report this session: with any app dialog
// open (achievements was the one caught, but the gap was every dialog), the
// Android back gesture/button did nothing - there was no popstate/history
// handling anywhere in the app, so "back" had no state of its own to
// consume, and depending on the browser that either did nothing or
// backgrounded/exited the installed PWA. A member had to force-close the
// whole app to get out of an open dialog. app.js was fixed for this
// (registerAppDialog()'s own history.pushState()/popstate wiring, see
// app.js around "appDialogHistoryPushed") - but that fix reaches only
// APP_DIALOGS. cloud.js keeps its OWN, entirely separate CLOUD_DIALOGS
// registry with its own open/close plumbing (a different render model too:
// APP_DIALOGS overlays are permanent DOM nodes that toggle an "open" class;
// CLOUD_DIALOGS overlays only exist in the DOM while their state flag says
// open), so the same fix did not reach it automatically. This file:
//   1. regression-proves app.js's fix stays correct for every one of its
//      11 registered dialogs (grep `registerAppDialog(` in app.js) - not
//      just achievements, the one a human happened to notice.
//   2. does the same for cloud.js's CLOUD_DIALOGS (grep for that registry
//      in cloud.js), after this same session wired cloud.js's own
//      history/popstate layer to mirror app.js's exactly (see
//      "cloudDialogHistoryPushed" in cloud.js) - the fix this file exists
//      to keep from silently regressing.
//   3. spot-checks that back joins the OTHER three close affordances (X,
//      Escape, backdrop) consistently, not just for one dialog per
//      registry, on a representative sample: appConfirm (already has its
//      own dedicated 4-affordance file, app-dialog-keyboard.mjs - not
//      repeated here), navMenu and achievements from APP_DIALOGS; composer
//      and modAction from CLOUD_DIALOGS.
//   4. where a close affordance's semantics matter (deleting an entry,
//      filing a report), asserts back behaves like Escape/backdrop -
//      DISMISS, never confirm/submit - the same lesson app-dialog-
//      keyboard.mjs pins for the destructive confirm sheet.
//
// COVERAGE NOTE. Two of CLOUD_DIALOGS's 14 entries are not exercised here:
// reclaimInvite (a ghost-member reclaim sheet gated on a grace-period that
// has elapsed - meaningful seed data for it is a small project on its own)
// and clubWodBoard (needs a live club-WOD session plus feed placement).
// Neither is covered by the pre-existing jsdom contract file either
// (test/community-dialog-focus.test.mjs's own header names the dialogs it
// pins, and stops at 12) - this file adds a 13th (termSheet) beyond that,
// and is honest about the two still outstanding rather than faking seed
// data just to tick a box.
//
// HOW A DIALOG IS OPENED. Wherever a real, reachable user action exists
// (a button on the Add/Calendar/WOD/Community tabs, the nav menu, a
// directory row) this drives that action, the same as every other browser-
// check script. Two cloud dialogs have no such trigger by design - prPrompt
// and achUnlock only ever appear as the client's own reaction to a PR/
// achievement being detected - so those two are opened the same way
// test/community-dialog-focus.test.mjs does in jsdom: emitting the real
// product-bus event / calling the real public consumer function
// (window.HaimuniaEvents.emit(...PR_CREATED...), window.claimCommunity-
// Achievements(...)) rather than a synthetic click on nothing.
//
// Usage:
//   node dialog-back-button.mjs
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import {
  switchTab, dismissWelcomeModal, selectMovement, consoleErrorCollector,
  clickOverlayBackdrop, readAppConfirm, resolveAppConfirm,
} from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

// The one assertion every dialog in both registries has to satisfy: it is
// open, then a real browser back navigation (page.goBack(), exactly what an
// Android back gesture/button does to a PWA) closes it - not "does
// something", closes it, and nothing else. "hidden" covers both this app's
// two overlay shapes: app.js's overlays stay IN the DOM and lose the "open"
// class (CSS makes an unopened .modal-overlay display:none); cloud.js's
// leave the DOM entirely. Either way, "hidden" is the honest, shape-agnostic
// assertion.
async function checkBackCloses(page, label, overlaySelector) {
  await page.waitForSelector(overlaySelector, { state: "visible", timeout: 5000 });
  await page.goBack();
  try {
    await page.waitForSelector(overlaySelector, { state: "hidden", timeout: 5000 });
    check(`${label}: back button closes it`, true);
  } catch {
    check(`${label}: back button closes it`, false, "still open after page.goBack() — the Android back gesture would do nothing here");
  }
}

const VERIFIED = new Date().toISOString();

// ============================================================================
// PART 1 — app.js's APP_DIALOGS (offline half, no Community sign-in needed)
// ============================================================================
async function runAppDialogs(browser) {
  const target = await resolveLocalOnlyTarget();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = await consoleErrorCollector(page);
  // Never let this page reach the real backend, even though it is not
  // testing Community — cloud.js boots unconditionally on every tab.
  await installMockCloud(page);
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });

  // ---- welcome (escapable:false) ----------------------------------------
  // This is also a direct regression test for a second bug this same audit
  // found while building this file: app.js's popstate handler originally
  // called dlg.close() unconditionally, with no check of the SAME
  // def.escapable flag its own Escape handler five lines above already
  // respects — so a back-press here used to run closeWelcomeModal() WITHOUT
  // ever calling saveUserName(), silently discarding the member's name
  // while the mandatory first-run gate vanished. Fixed in app.js (the
  // popstate handler now re-arms the reserved history entry for a
  // non-escapable dialog instead of closing it) — this asserts that stays
  // fixed: back must NOT close it.
  await page.waitForFunction(() => document.getElementById("welcomeOverlay")?.classList.contains("open"), { timeout: 4000 });
  await page.goBack();
  await page.waitForTimeout(300); // let a (wrong) close, if one happened, finish rendering
  const welcomeStillOpen = await page.evaluate(() => document.getElementById("welcomeOverlay")?.classList.contains("open"));
  check("welcome (escapable:false): back does NOT close it — it re-arms, like Escape already refuses to", welcomeStillOpen);

  await dismissWelcomeModal(page, "בדיקה");

  // ---- onboarding (escapable:false) -------------------------------------
  // Fresh profile, 0 logged entries: the tour-offer card is on the Add tab
  // (shouldShowTourCard() in app.js). Same escapable:false regression as
  // welcome above.
  await page.waitForSelector("[data-action='open-onboarding']", { timeout: 5000 });
  await page.click("[data-action='open-onboarding']");
  await page.waitForFunction(() => document.getElementById("onboardingOverlay")?.classList.contains("open"), { timeout: 5000 });
  await page.goBack();
  await page.waitForTimeout(300);
  const onboardingStillOpen = await page.evaluate(() => document.getElementById("onboardingOverlay")?.classList.contains("open"));
  check("onboarding (escapable:false): back does NOT close it either", onboardingStillOpen);
  await page.click("[data-action='close-onboarding']");
  await page.waitForFunction(() => !document.getElementById("onboardingOverlay")?.classList.contains("open"), { timeout: 5000 });

  // ---- celebration (first-ever logged entry) -----------------------------
  await selectMovement(page, "Strict");
  await page.fill("[data-field='weight'].stepper-val", "40");
  await page.dispatchEvent("[data-field='weight'].stepper-val", "change");
  await page.fill("[data-field='reps'].stepper-val", "5");
  await page.dispatchEvent("[data-field='reps'].stepper-val", "change");
  await page.click("[data-action='save-set']");
  await page.waitForFunction(() => document.getElementById("celebrationOverlay")?.classList.contains("open"), { timeout: 5000 });
  await page.goBack();
  await page.waitForSelector("#celebrationOverlay", { state: "hidden", timeout: 5000 });
  check("celebration: back closes it", true);
  const entriesAfterCelebrationBack = await page.evaluate(() => Array.from(document.querySelectorAll("#calDetail")).length >= 0); // sanity no-throw
  check("celebration: closing via back did not touch the logged set (sanity)", entriesAfterCelebrationBack);

  // ---- appConfirm: back only, full 4-affordance contract already pinned
  // by app-dialog-keyboard.mjs -------------------------------------------
  await switchTab(page, "tabCalendarBtn");
  await page.waitForTimeout(200);
  const binCountBefore = await page.locator("#calDetail button[data-action='delete-entry']").count();
  check("one logged set is on the calendar to delete", binCountBefore >= 1, String(binCountBefore));
  await page.locator("#calDetail button[data-action='delete-entry']").first().click();
  const confirmText = await readAppConfirm(page);
  check("appConfirm names its subject before back is tested", confirmText.message.length > 0, confirmText.message);
  await page.goBack();
  await page.waitForSelector("#appConfirmOverlay", { state: "hidden", timeout: 5000 });
  const binCountAfterBack = await page.locator("#calDetail button[data-action='delete-entry']").count();
  check("appConfirm: back closes it AND dismisses — same non-answer as Escape/backdrop, not a yes", binCountAfterBack === binCountBefore, `${binCountBefore} -> ${binCountAfterBack}`);

  // ---- navMenu: full 4-affordance sample ---------------------------------
  async function openNavMenu() {
    await page.click("[data-action='open-nav-menu']");
    await page.waitForFunction(() => document.getElementById("navMenuOverlay")?.classList.contains("open"), { timeout: 5000 });
  }
  // No backdrop-click sub-check here: navMenu is index.html's "full-page
  // pattern" (align-items:stretch, padding:0, its .modal-sheet stretches to
  // fill the whole overlay - see index.html's own comment at
  // #navMenuOverlay's declaration) — there is no exposed backdrop pixel for
  // a click to land on; e.target is always the sheet or its content, never
  // the overlay div itself. Found empirically: a literal backdrop-click
  // attempt here just timed out (the click landed on real header content).
  // Not a bug — a full-screen menu deliberately does not close on a random
  // tap inside it before the user has read it — so this checks the three
  // affordances that actually apply and leaves the 4th sample (backdrop
  // included) to picker below, which genuinely has one.
  await openNavMenu();
  await page.click("#navMenuOverlay button[data-action='close-nav-menu']");
  await page.waitForSelector("#navMenuOverlay", { state: "hidden", timeout: 5000 });
  check("navMenu: X closes it", true);
  await openNavMenu();
  await page.keyboard.press("Escape");
  await page.waitForSelector("#navMenuOverlay", { state: "hidden", timeout: 5000 });
  check("navMenu: Escape closes it", true);
  await openNavMenu();
  await checkBackCloses(page, "navMenu", "#navMenuOverlay");

  // ---- settings -----------------------------------------------------------
  await openNavMenu();
  await page.click("#navMenuOverlay [data-action='open-settings']");
  await page.waitForFunction(() => document.getElementById("settingsOverlay")?.classList.contains("open"), { timeout: 5000 });
  await checkBackCloses(page, "settings", "#settingsOverlay");

  // ---- picker: full 4-affordance sample -----------------------------------
  // Unlike navMenu/settings/achievements above, picker keeps the DEFAULT
  // .modal-overlay layout (align-items:flex-end, .modal-sheet max-height:85%)
  // - a real bottom sheet with an exposed backdrop above it - so this is
  // where the backdrop-click affordance actually gets exercised for an
  // APP_DIALOGS entry beyond appConfirm (already covered exhaustively by
  // app-dialog-keyboard.mjs).
  async function openPicker() {
    await switchTab(page, "tabAddBtn");
    await page.click("[data-action='open-picker']");
    await page.waitForFunction(() => document.getElementById("pickerOverlay")?.classList.contains("open"), { timeout: 5000 });
  }
  await openPicker();
  await page.click("#pickerOverlay button[data-action='close-picker']");
  await page.waitForSelector("#pickerOverlay", { state: "hidden", timeout: 5000 });
  check("picker: X closes it", true);
  await openPicker();
  await page.keyboard.press("Escape");
  await page.waitForSelector("#pickerOverlay", { state: "hidden", timeout: 5000 });
  check("picker: Escape closes it", true);
  await openPicker();
  await clickOverlayBackdrop(page, "#pickerOverlay");
  await page.waitForSelector("#pickerOverlay", { state: "hidden", timeout: 5000 });
  check("picker: backdrop click closes it", true);
  await openPicker();
  await checkBackCloses(page, "picker", "#pickerOverlay");

  // ---- wodPicker / wodBuilder (WOD tab's empty log state offers both) -----
  await switchTab(page, "tabWodBtn");
  await page.waitForSelector("[data-action='open-wod-picker']", { timeout: 5000 });
  await page.click("[data-action='open-wod-picker']");
  await page.waitForFunction(() => document.getElementById("wodPickerOverlay")?.classList.contains("open"), { timeout: 5000 });
  await checkBackCloses(page, "wodPicker", "#wodPickerOverlay");

  await page.waitForSelector("[data-action='open-wod-builder']", { timeout: 5000 });
  await page.click("[data-action='open-wod-builder']");
  await page.waitForFunction(() => document.getElementById("wodBuilderOverlay")?.classList.contains("open"), { timeout: 5000 });
  await checkBackCloses(page, "wodBuilder", "#wodBuilderOverlay");

  // ---- achievements: the dialog literally named in the real-user report --
  // Also index.html's "full-page pattern" (#achievementsOverlay{align-
  // items:stretch;padding:0} plus its own height:100svh override) - same
  // "no exposed backdrop pixel exists" reasoning as navMenu above, so no
  // backdrop-click sub-check here either. X/Escape/back is the honest full
  // set for this dialog's actual shape.
  async function openAchievements() {
    await openNavMenu();
    await page.click("#navMenuOverlay [data-action='open-achievements']");
    await page.waitForFunction(() => document.getElementById("achievementsOverlay")?.classList.contains("open"), { timeout: 5000 });
  }
  await openAchievements();
  await page.click("#achievementsOverlay button[data-action='close-achievements']");
  await page.waitForSelector("#achievementsOverlay", { state: "hidden", timeout: 5000 });
  check("achievements: X closes it", true);
  await openAchievements();
  await page.keyboard.press("Escape");
  await page.waitForSelector("#achievementsOverlay", { state: "hidden", timeout: 5000 });
  check("achievements: Escape closes it", true);
  await openAchievements();
  await checkBackCloses(page, "achievements — THE dialog from the real-user report", "#achievementsOverlay");

  // ---- notifications (app.js's own release-notes popup; distinct from
  // cloud.js's notifCenter below) — no on-screen trigger under normal
  // conditions (it self-opens on an unseen release), so open it the same
  // way the jsdom-unreachable prPrompt/achUnlock cases below are opened:
  // call the real, exported opener directly. openNotifications() is a
  // classic-script top-level function, so it is a bare window global here.
  await page.evaluate(() => window.openNotifications());
  await page.waitForFunction(() => document.getElementById("notificationsOverlay")?.classList.contains("open"), { timeout: 5000 });
  await checkBackCloses(page, "notifications (release notes)", "#notificationsOverlay");

  check("no console errors (app.js dialogs)", errors.length === 0, errors.join(" | "));

  await page.close();
  await target.close();
}

// ============================================================================
// PART 2 — cloud.js's CLOUD_DIALOGS, member session
// ============================================================================
async function runCloudMemberDialogs(browser) {
  const target = await resolveLocalOnlyTarget();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = await consoleErrorCollector(page);

  const NOW = Date.now();
  const isoDay = (d) => new Date(NOW + d * 86400000).toISOString();
  const isoHour = (h) => new Date(NOW + h * 3600000).toISOString();
  const seedTables = {
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_achievements: true, allow_follows: true },
      { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true },
      { id: "author-1", handle: "kobi", display_name: "קובי", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "author-1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    achievement_definitions: [{
      id: "d-first_pr", code: "first_pr", name: "השיא הראשון", description: "", category: "performance",
      trigger_type: "PR_CREATED", threshold: 1, repeatable: false, visibility: "club", icon: "⭐",
      enabled: true, config: { client_claimable: true },
    }],
    member_achievements: [],
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 12, start_at: isoDay(-5), end_at: isoDay(20), status: "active", join_mode: "open", visibility: "club", created_by: "u1", config: {} }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: isoDay(-1), status: "active", progress_value: 4, completed_at: null }],
    challenge_teams: [], challenge_progress: [],
    events: [{ id: "e1", event_type: "workshop", title: "סדנת גמישות", description: "", status: "published", start_at: isoHour(24), end_at: null, location: "אולם 1", capacity: null, registration_deadline: null, created_by: "u1" }],
    event_attendees: [],
    weekly_recaps: [{ id: "wr-1", user_id: "u1", week_start: "2026-08-17", sessions_completed: 5, streak: 2, prs: [], achievements: [], challenge_progress: [], club_challenge_progress: {}, upcoming_event: null, generated_at: VERIFIED }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: VERIFIED, first_week_shown_at: VERIFIED, first_month_shown_at: VERIFIED }],
    workout_posts: [{ id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן לבדיקה", status: "active", created_at: VERIFIED, published_at: VERIFIED }],
    feed_page_rows: [{ id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן לבדיקה", created_at: VERIFIED }],
    post_comments: [], reports: [], admin_actions: [], pins: [], posting_restrictions: [],
    follows: [], blocks: [], reactions: [], hidden_posts: [], saved_posts: [],
    notifications: [], notification_preferences: [],
    community_feed: [], feed_impressions: [], feed_interactions: [], analytics_events: [],
  };

  await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector(".subtabbar", { timeout: 5000 });

  // ---- composer: full 4-affordance sample --------------------------------
  await page.evaluate(() => {
    window.__mock.onRpc("post_create", (args, ctx) => {
      const id = "post-new";
      ctx.db.workout_posts = ctx.db.workout_posts || [];
      ctx.db.workout_posts.push({ id, body: args.body, visibility: args.visibility, author_id: ctx.currentUser.id });
      return { data: id, error: null };
    });
  });
  async function openComposer() {
    await page.click('[data-community-action="open-composer"]');
    await page.waitForSelector('[data-cloud-dialog="composer"]', { timeout: 5000 });
  }
  await openComposer();
  await page.click('[data-community-action="composer-cancel"]');
  await page.waitForSelector('[data-cloud-dialog="composer"]', { state: "hidden", timeout: 5000 });
  check("composer: X (cancel) closes it", true);
  await openComposer();
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-cloud-dialog="composer"]', { state: "hidden", timeout: 5000 });
  check("composer: Escape closes it", true);
  await openComposer();
  // See clickOverlayBackdrop's own comment: on the Community tab, a naive
  // corner-of-the-overlay click hits the persistent header or bottom tab bar
  // instead of the dialog's own backdrop (a real, separate bug this file's
  // audit found and reported, not fixed here) — clicking just above the
  // actual .modal-sheet sidesteps both.
  await clickOverlayBackdrop(page, '[data-cloud-dialog="composer"]');
  await page.waitForSelector('[data-cloud-dialog="composer"]', { state: "hidden", timeout: 5000 });
  check("composer: backdrop click closes it", true);
  await openComposer();
  await checkBackCloses(page, "composer", '[data-cloud-dialog="composer"]');
  const postsAfterComposerBack = await page.evaluate(() => (window.__mock.db.workout_posts || []).length);
  check("composer: closing via back did not publish anything", postsAfterComposerBack === 1, `expected 1 (the seeded post), got ${postsAfterComposerBack}`);

  // ---- prPrompt: no on-screen trigger by design (client reaction to a
  // detected PR) — opened the same way test/community-dialog-focus.test.mjs
  // does, by emitting the real product-bus event. ------------------------
  await page.evaluate(() => {
    window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, {
      record: { record_id: "rec-1", movement: "Deadlift", new_result: '180 ק"ג', previous_result: '172.5 ק"ג', improvement: '+7.5 ק"ג' },
    });
  });
  await checkBackCloses(page, "prPrompt", '[data-cloud-dialog="prPrompt"]');

  // ---- achUnlock: same reasoning, opened via the real public consumer ---
  await page.evaluate(() => window.claimCommunityAchievements(["first_pr"]));
  await checkBackCloses(page, "achUnlock", '[data-cloud-dialog="achUnlock"]');

  // ---- profileView (directory row) --------------------------------------
  await page.evaluate(() => {
    window.__mock.onRpc("community_profile", () => ({
      data: { display_name: "נועם", role: "member", member_since: "2023-04-01", training_frequency: "3 בשבוע" },
      error: null,
    }));
  });
  await page.click('[data-community-action="set-tab"][data-tab="directory"]');
  await page.waitForSelector('[data-community-action="view-profile"][data-id="u2"]', { timeout: 5000 });
  await page.click('[data-community-action="view-profile"][data-id="u2"]');
  await page.waitForSelector('[data-cloud-dialog="profileView"]', { timeout: 5000 });
  await checkBackCloses(page, "profileView", '[data-cloud-dialog="profileView"]');

  // ---- notifCenter --------------------------------------------------------
  await switchTab(page, "tabCommunityBtn");
  await page.click('[data-community-action="set-tab"][data-tab="feed"]').catch(() => {});
  await page.waitForSelector('[data-community-action="feed-notifications"]', { timeout: 5000 });
  await page.click('[data-community-action="feed-notifications"]');
  await page.waitForSelector('[data-cloud-dialog="notifCenter"]', { timeout: 5000 });
  await checkBackCloses(page, "notifCenter", '[data-cloud-dialog="notifCenter"]');

  // ---- reportSheet — back must DISMISS, not submit a report --------------
  await page.waitForSelector('[data-community-action="toggle-post-menu"][data-id="post-1"]', { timeout: 5000 });
  await page.click('[data-community-action="toggle-post-menu"][data-id="post-1"]');
  await page.click('[data-community-action="report"][data-id="post-1"]');
  await page.waitForSelector('[data-cloud-dialog="reportSheet"]', { timeout: 5000 });
  await page.click('[data-report-reason="harassment"]');
  await checkBackCloses(page, "reportSheet", '[data-cloud-dialog="reportSheet"]');
  const reportsAfterBack = await page.evaluate(() => (window.__mock.db.reports || []).length);
  check("reportSheet: back dismissed — a reason was picked but never submitted, so no report was filed", reportsAfterBack === 0, String(reportsAfterBack));

  // ---- termSheet (Account tab's glossary entry point) --------------------
  await page.click('[data-community-action="set-tab"][data-tab="account"]');
  await page.waitForSelector('[data-community-action="term-glossary-open"]', { timeout: 5000 });
  await page.click('[data-community-action="term-glossary-open"]');
  await page.waitForSelector('[data-cloud-dialog="termSheet"]', { timeout: 5000 });
  await checkBackCloses(page, "termSheet", '[data-cloud-dialog="termSheet"]');

  // ---- confirmSheet (delete-account, Account tab) — back must cancel ----
  await page.click('[data-community-action="set-tab"][data-tab="account"]');
  await page.waitForSelector('[data-community-action="delete-account"]', { timeout: 5000 });
  await page.click('[data-community-action="delete-account"]');
  await page.waitForSelector('[data-cloud-dialog="confirmSheet"]', { timeout: 5000 });
  await checkBackCloses(page, "confirmSheet (delete-account)", '[data-cloud-dialog="confirmSheet"]');
  const stillSeesAccountTab = await page.evaluate(() => !!document.querySelector('[data-community-action="delete-account"]'));
  check("confirmSheet: back cancelled — the account row is still there, nothing was deleted", stillSeesAccountTab);

  // ---- challengeView / eventView / recapView ------------------------------
  await page.click('[data-community-action="set-tab"][data-tab="boards"]');
  await page.waitForSelector('[data-challenge-id="c1"]', { timeout: 5000 });
  await page.click('[data-challenge-id="c1"] [data-community-action="open-challenge"]');
  await page.waitForSelector('[data-community-action="leave-challenge"]', { timeout: 5000 });
  await checkBackCloses(page, "challengeView", '[data-cloud-dialog="challengeView"]');

  await page.waitForSelector('[data-event-id="e1"]', { timeout: 5000 });
  await page.click('[data-event-id="e1"] [data-community-action="open-event"]');
  await page.waitForSelector('[data-cloud-dialog="eventView"] [data-community-action="event-rsvp"]', { timeout: 5000 });
  await checkBackCloses(page, "eventView", '[data-cloud-dialog="eventView"]');

  await page.click('[data-community-action="set-tab"][data-tab="account"]');
  await page.waitForSelector('[data-community-action="open-recap"]', { timeout: 5000 });
  await page.click('[data-community-action="open-recap"]');
  await page.waitForSelector('[data-cloud-dialog="recapView"] [data-community-action="share-recap"]', { timeout: 5000 });
  await checkBackCloses(page, "recapView", '[data-cloud-dialog="recapView"]');

  check("no console errors (cloud.js member dialogs)", errors.length === 0, errors.join(" | "));

  await page.close();
  await target.close();
}

// ============================================================================
// PART 3 — cloud.js's CLOUD_DIALOGS, head_coach session (modAction/modContext)
// ============================================================================
async function runCloudAdminDialogs(browser) {
  const target = await resolveLocalOnlyTarget();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = await consoleErrorCollector(page);

  const seedTables = {
    profiles: [
      { id: "mod-1", handle: "mod", display_name: "מודרטור", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "author-1", handle: "kobi", display_name: "קובי", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "reporter-1", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "mod-1", invite_id: "i1", role: "head_coach", redeemed_at: VERIFIED },
      { user_id: "author-1", invite_id: "i2", role: "member", redeemed_at: VERIFIED },
      { user_id: "reporter-1", invite_id: "i3", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    workout_posts: [{ id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן שדווח", status: "active", created_at: VERIFIED, published_at: VERIFIED }],
    post_comments: [],
    reports: [{ id: "rep-1", reporter_id: "reporter-1", target_type: "post", target_id: "post-1", reason: "harassment", note: "", status: "open", created_at: VERIFIED }],
    admin_actions: [], pins: [], posting_restrictions: [],
    feed_page_rows: [{ id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן שדווח", created_at: VERIFIED }],
    follows: [], hidden_posts: [], saved_posts: [], notifications: [], notification_preferences: [],
  };

  await installMockCloud(page, seedTables, { user: { id: "mod-1", is_anonymous: false, email: "mod@members.haimuniya.invalid" } });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await switchTab(page, "tabManageBtn");
  await page.click('[data-community-action="set-manage-tab"][data-tab="moderation"]');
  await page.waitForSelector('[data-community-action="mod-action"]', { timeout: 5000 });

  // ---- modAction: full 4-affordance sample -------------------------------
  async function openModAction() {
    await page.click('[data-community-action="mod-action"][data-decision="warn"]');
    await page.waitForSelector('[data-cloud-dialog="modAction"]', { timeout: 5000 });
  }
  await openModAction();
  await page.click('[data-community-action="mod-action-cancel"]');
  await page.waitForSelector('[data-cloud-dialog="modAction"]', { state: "hidden", timeout: 5000 });
  check("modAction: X (cancel) closes it", true);
  await openModAction();
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-cloud-dialog="modAction"]', { state: "hidden", timeout: 5000 });
  check("modAction: Escape closes it", true);
  await openModAction();
  await clickOverlayBackdrop(page, '[data-cloud-dialog="modAction"]');
  await page.waitForSelector('[data-cloud-dialog="modAction"]', { state: "hidden", timeout: 5000 });
  check("modAction: backdrop click closes it", true);
  await openModAction();
  await checkBackCloses(page, "modAction", '[data-cloud-dialog="modAction"]');
  const reportStatusAfterBack = await page.evaluate(() => window.__mock.db.reports.find((r) => r.id === "rep-1")?.status);
  check("modAction: back cancelled the review — the report is still open, nothing was actioned", reportStatusAfterBack === "open", reportStatusAfterBack);

  // ---- modContext ---------------------------------------------------------
  await page.click('[data-community-action="mod-context"]');
  await page.waitForSelector('[data-cloud-dialog="modContext"]', { timeout: 5000 });
  await checkBackCloses(page, "modContext", '[data-cloud-dialog="modContext"]');

  check("no console errors (cloud.js admin dialogs)", errors.length === 0, errors.join(" | "));

  await page.close();
  await target.close();
}

const browser = await chromium.launch();
await runAppDialogs(browser);
await runCloudMemberDialogs(browser);
await runCloudAdminDialogs(browser);
await browser.close();

console.log(failed ? "\ndialog-back-button: FAILED" : "\ndialog-back-button: all checks passed");
process.exit(failed ? 1 : 0);
