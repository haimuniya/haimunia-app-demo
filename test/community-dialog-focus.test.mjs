// COMM-190. Keyboard and focus management for every Phase 1 overlay dialog,
// executed for real in jsdom against the mock Supabase client through the
// production render path.
//
// One shared contract, asserted per dialog:
//   - it opens as role="dialog" aria-modal="true" and carries
//     data-cloud-dialog so the shared focus layer owns it
//   - focus moves into the dialog on open (first control focused)
//   - Tab from the last control wraps to the first, Shift+Tab from the
//     first wraps to the last - focus is trapped inside
//   - Escape closes it and returns focus to the control that opened it
//   - a click on the dim backdrop (the overlay element itself) closes it
//
// Dialogs covered: post composer, PR share prompt, achievement celebration,
// member profile overlay, notification centre, report sheet, moderation
// review sheet, moderation context sheet.
//
// The Escape wiring itself is also spot-checked in the per-cluster files;
// this file is the single place the whole focus contract is pinned so a
// regression in the shared layer fails one obvious test.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

// Mirrors the focusable filter in cloud.js so first/last line up with what
// the trap computes internally.
function focusables(dlg) {
  return Array.prototype.slice
    .call(dlg.querySelectorAll('button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((n) => !n.disabled && n.getAttribute("aria-hidden") !== "true" && !/display:\s*none/.test(n.getAttribute("style") || ""));
}
function tab(window, shift) {
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: !!shift, bubbles: true }));
}
function escape(window) {
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

// An opener that survives a full re-render of #content, so "focus returns to
// the invoking control" is testable. Focused before it is activated, the way
// a keyboard or screen-reader user reaches it.
function makeOpener(window, dataset) {
  const btn = window.document.createElement("button");
  btn.id = "test-opener";
  Object.keys(dataset).forEach((k) => { btn.dataset[k] = dataset[k]; });
  btn.textContent = "opener";
  window.document.body.appendChild(btn);
  btn.focus();
  assert.equal(window.document.activeElement, btn, "opener holds focus before activation");
  return btn;
}

async function openCommunity(window) {
  // The offline app's own first-run "what's your name" welcome modal opens
  // on boot when no local profile exists yet (app.js openWelcomeModal) and
  // grabs focus itself 50ms later. Every community test tolerates that
  // because it never asserts activeElement; this file does, so it lets
  // that one-time, one-off grab land and finish before opening anything of
  // its own, rather than letting it race a Phase 1 dialog's own focus-in.
  await new Promise((resolve) => setTimeout(resolve, 150));
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
}

// The full shared contract for one open dialog. `opener` is either the
// element that invoked it (stable across renders) or a function returning
// the current live element for a control that #content re-renders and
// therefore replaces, like the notification bell.
async function assertDialogContract(window, key, opener, close) {
  const getOpener = typeof opener === "function" ? opener : () => opener;
  const sel = `[data-cloud-dialog="${key}"]`;
  const dlg = window.document.querySelector(sel);
  assert.ok(dlg, `${key}: the overlay is in the DOM`);
  assert.equal(dlg.getAttribute("role"), "dialog", `${key}: role="dialog"`);
  assert.equal(dlg.getAttribute("aria-modal"), "true", `${key}: aria-modal="true"`);

  // focus moved into the dialog on open
  await waitFor(() => dlg.contains(window.document.activeElement), 3000);
  assert.ok(dlg.contains(window.document.activeElement), `${key}: focus is inside the dialog on open`);

  // focus is trapped
  const f = focusables(dlg);
  assert.ok(f.length >= 2, `${key}: at least two focusable controls to cycle (${f.length})`);
  const first = f[0];
  const last = f[f.length - 1];
  last.focus();
  tab(window, false);
  assert.equal(window.document.activeElement, first, `${key}: Tab from the last control wraps to the first`);
  first.focus();
  tab(window, true);
  assert.equal(window.document.activeElement, last, `${key}: Shift+Tab from the first control wraps to the last`);

  // Escape closes and restores focus to the opener
  escape(window);
  await waitFor(() => !window.document.querySelector(sel), 3000);
  await waitFor(() => window.document.activeElement === getOpener(), 3000);
  assert.equal(window.document.activeElement, getOpener(), `${key}: Escape restores focus to the invoking control`);

  // backdrop click closes too
  await close();
  await waitFor(() => !!window.document.querySelector(sel), 3000);
  const reopened = window.document.querySelector(sel);
  reopened.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => !window.document.querySelector(sel), 3000);
  assert.ok(!window.document.querySelector(sel), `${key}: a click on the backdrop closes the dialog`);
}

// ===== post composer ================================================

test("post composer: focus-in, trap, Escape restores focus, backdrop closes", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);

  const opener = makeOpener(window, { communityAction: "open-composer" });
  opener.click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="composer"]'), 3000);

  await assertDialogContract(window, "composer", opener, async () => {
    opener.click();
  });
});

// ===== PR share prompt ==============================================

test("PR share prompt: focus-in, trap, Escape restores focus, backdrop closes", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("pr_share", () => ({ data: "pr-post-1", error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);

  const record = { record_id: "rec-42", movement: "Deadlift", new_result: '180 ק"ג', previous_result: '172.5 ק"ג', improvement: '+7.5 ק"ג' };
  const emit = () => window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: { ...record, record_id: "rec-" + Math.random().toString(36).slice(2) } });

  const opener = makeOpener(window, {});
  // Add note so the prompt has a note field, guaranteeing >= 2 focusables
  // even before a photo is attached.
  emit();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="prPrompt"]'), 3000);
  window.document.querySelector('[data-community-action="pr-add-note"]').click();
  await waitFor(() => !!window.document.querySelector("[data-pr-note]"), 3000);
  // re-assert the opener still holds the restore slot
  assert.ok(window.document.body.contains(opener));

  await assertDialogContract(window, "prPrompt", opener, async () => {
    opener.focus();
    emit();
  });
});

// ===== achievement celebration =====================================

test("achievement celebration: focus-in, trap, Escape restores focus, backdrop closes", async () => {
  const def = {
    id: "d-first_pr", code: "first_pr", name: "השיא הראשון", description: "", category: "performance",
    trigger_type: "PR_CREATED", threshold: 1, repeatable: false, visibility: "club", icon: "⭐",
    enabled: true, config: { client_claimable: true },
  };
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_achievements: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
    achievement_definitions: [def],
    member_achievements: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("ach_share", () => ({ data: "ach-post-1", error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);

  const opener = makeOpener(window, {});
  await window.claimCommunityAchievements(["first_pr"]);
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="achUnlock"]'), 3000);

  await assertDialogContract(window, "achUnlock", opener, async () => {
    opener.focus();
    window.shareEarnedAchievement
      ? null
      : null;
    // re-open the same celebration through the public unlock consumer
    window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: "first_pr", member_achievement_id: "ma-1", visibility: "club" });
  });
});

// ===== member profile overlay ======================================

test("profile overlay: focus-in, trap, Escape restores focus, backdrop closes", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("community_profile", () => ({
    data: { display_name: "רון לוי", role: "member", member_since: "2023-04-01", training_frequency: "3 בשבוע" },
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);

  const opener = makeOpener(window, { communityAction: "view-profile", id: "u2" });
  opener.click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="profileView"]'), 3000);
  await waitFor(() => !/טוען פרופיל/.test(window.document.querySelector('[data-cloud-dialog="profileView"]').textContent), 3000);

  await assertDialogContract(window, "profileView", opener, async () => {
    opener.click();
    await waitFor(() => !/טוען פרופיל/.test(window.document.querySelector('[data-cloud-dialog="profileView"]').textContent), 3000);
  });
});

// ===== notification centre =========================================

test("notification centre: focus-in, trap, Escape restores focus, backdrop closes", async () => {
  const notifs = [];
  for (let i = 1; i <= 3; i++) {
    notifs.push({
      id: "n" + i, user_id: "u1", type: "comment_reply", category: "community",
      title: "התראה " + i, body: "גוף " + i, source_type: null, source_id: null,
      deep_link: null, read_at: null, created_at: new Date(Date.parse("2026-08-29T09:00:00Z") - i * 60000).toISOString(),
    });
  }
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    notifications: notifs,
    notification_preferences: [],
    feed_page_rows: [],
    follows: [], hidden_posts: [], saved_posts: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);

  const bell = window.document.querySelector('[data-community-action="feed-notifications"]');
  assert.ok(bell, "the notification bell renders");
  bell.focus();
  bell.click();
  const settle = async () => {
    await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="notifCenter"]'), 3000);
    await waitFor(() => {
      const c = window.document.querySelector('[data-cloud-dialog="notifCenter"]');
      return c && !/aria-busy="true"/.test(c.innerHTML);
    }, 3000);
  };
  await settle();

  // The bell lives inside #content and is replaced on every render, so the
  // stable restore target is re-resolved by selector - assert against that.
  await assertDialogContract(
    window,
    "notifCenter",
    () => window.document.querySelector('[data-community-action="feed-notifications"]'),
    async () => {
      window.document.querySelector('[data-community-action="feed-notifications"]').click();
      await settle();
    },
  );
});

// ===== report sheet ================================================

test("report sheet: focus-in, trap, Escape restores focus, backdrop closes", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
    reports: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);

  const opener = makeOpener(window, { communityAction: "report", id: "post-1" });
  opener.click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="reportSheet"]'), 3000);

  await assertDialogContract(window, "reportSheet", opener, async () => {
    opener.click();
  });
});

// ===== moderation review sheet + context sheet =====================

function modMock() {
  const mock = createMockSupabase({
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
    admin_actions: [],
    pins: [],
    posting_restrictions: [],
    feed_page_rows: [{ id: "post-1", author_id: "author-1", post_type: "POST_TEXT", body: "תוכן שדווח", created_at: VERIFIED }],
    follows: [], hidden_posts: [], saved_posts: [], notifications: [],
  });
  mock.setUser({ id: "mod-1", is_anonymous: false, email: "mod@members.haimuniya.invalid" });
  return mock;
}

async function openQueue(window) {
  await openCommunity(window);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="mod-action"]'), 4000);
}

test("moderation review sheet: focus-in, trap, Escape restores focus, backdrop closes", async () => {
  const window = await bootCommunity(modMock(), { syncEnabled: false });
  await openQueue(window);

  const opener = window.document.querySelector('[data-community-action="mod-action"][data-decision="warn"]');
  assert.ok(opener, "the warn action button is offered on the queue row");
  opener.focus();
  opener.click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="modAction"]'), 3000);

  const sel = '[data-cloud-dialog="modAction"]';
  const dlg = window.document.querySelector(sel);
  assert.equal(dlg.getAttribute("role"), "dialog");
  assert.equal(dlg.getAttribute("aria-modal"), "true");
  await waitFor(() => dlg.contains(window.document.activeElement), 3000);

  const f = focusables(dlg);
  assert.ok(f.length >= 2, `modAction: at least two focusables (${f.length})`);
  f[f.length - 1].focus();
  tab(window, false);
  assert.equal(window.document.activeElement, f[0], "modAction: Tab wraps to first");
  f[0].focus();
  tab(window, true);
  assert.equal(window.document.activeElement, f[f.length - 1], "modAction: Shift+Tab wraps to last");

  escape(window);
  await waitFor(() => !window.document.querySelector(sel), 3000);
  await waitFor(() => window.document.activeElement === window.document.querySelector('[data-community-action="mod-action"][data-decision="warn"]'), 3000);

  // backdrop
  window.document.querySelector('[data-community-action="mod-action"][data-decision="warn"]').click();
  await waitFor(() => !!window.document.querySelector(sel), 3000);
  window.document.querySelector(sel).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => !window.document.querySelector(sel), 3000);
  assert.ok(!window.document.querySelector(sel), "modAction: backdrop click closes");
});

test("moderation context sheet: focus-in, trap, Escape restores focus, backdrop closes", async () => {
  const window = await bootCommunity(modMock(), { syncEnabled: false });
  await openQueue(window);

  const opener = window.document.querySelector('[data-community-action="mod-context"]');
  assert.ok(opener, "the view-context button is offered on the queue row");
  opener.focus();
  opener.click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="modContext"]'), 3000);

  const sel = '[data-cloud-dialog="modContext"]';
  const dlg = window.document.querySelector(sel);
  assert.equal(dlg.getAttribute("role"), "dialog");
  await waitFor(() => dlg.contains(window.document.activeElement), 3000);

  const f = focusables(dlg);
  assert.ok(f.length >= 2, `modContext: at least two focusables (${f.length})`);
  f[f.length - 1].focus();
  tab(window, false);
  assert.equal(window.document.activeElement, f[0], "modContext: Tab wraps to first");
  f[0].focus();
  tab(window, true);
  assert.equal(window.document.activeElement, f[f.length - 1], "modContext: Shift+Tab wraps to last");

  escape(window);
  await waitFor(() => !window.document.querySelector(sel), 3000);
  await waitFor(() => window.document.activeElement === window.document.querySelector('[data-community-action="mod-context"]'), 3000);

  window.document.querySelector('[data-community-action="mod-context"]').click();
  await waitFor(() => !!window.document.querySelector(sel), 3000);
  window.document.querySelector(sel).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => !window.document.querySelector(sel), 3000);
  assert.ok(!window.document.querySelector(sel), "modContext: backdrop click closes");
});
