// Redesign, Phase 3: the first-run intro carousel. Three purely
// informational screens (welcome_intro/club_rules/getting_started), shown
// once per DEVICE before a brand-new member reaches the already-existing,
// already-unskippable credentials/profile-completion gates in
// renderCommunityApp() - this does not touch those gates at all, only
// precedes them. Content is admin-editable via intro_carousel_content
// (202609050007), a deliberate sibling of onboarding_step_content, not an
// extension of it.
//
// Executing tests (bootCommunity + mock Supabase), not source-text matches
// - they drive the real gate cascade and the real
// loadIntroCarouselContent()/introCarouselNext()/saveIntroCarouselContent()
// paths.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

function submit(window, id) {
  window.document.getElementById(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}
function click(window, selector) {
  window.document.querySelector(selector).click();
}

// Drives a brand-new signup up to (but not through) the carousel: invite
// code + credentials, same real path community-recovery-method.test.mjs
// already exercises for the gate right after this one.
async function signUpToCarousel(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);
  window.document.querySelector('#communityInviteCode input[name="code"]').value = "CLUBCODE";
  submit(window, "communityInviteCode");
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 3000);
  window.document.querySelector('#communityCredentials input[name="username"]').value = "dana";
  window.document.querySelector('#communityCredentials input[name="password"]').value = "correcthorse";
  window.document.querySelector('#communityCredentials input[name="passwordConfirm"]').value = "correcthorse";
  submit(window, "communityCredentials");
  await waitFor(() => !!window.document.querySelector('[data-intro-carousel="1"]'), 3000);
}

test("a brand-new signup sees the 3-step carousel BEFORE the profile-completion form, not instead of it", async () => {
  // opts.localStorage overrides bootCommunity's own default (every OTHER
  // test in this repo gets "already seen" so the carousel does not
  // intercept them) back to genuinely unseen - this is the one file that
  // wants that.
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:seenIntroCarousel": "0" } });
  await signUpToCarousel(window);

  assert.equal(window.document.querySelector('[data-intro-carousel="1"]').dataset.introStep, "welcome_intro", "starts on the first screen");
  assert.ok(!window.document.querySelector('[data-community-action="intro-carousel-back"]'), "no back button on the first screen");

  click(window, '[data-community-action="intro-carousel-next"]');
  await waitFor(() => window.document.querySelector('[data-intro-carousel="1"]').dataset.introStep === "club_rules", 3000);
  assert.ok(window.document.querySelector('[data-community-action="intro-carousel-back"]'), "back button appears from the second screen on");

  click(window, '[data-community-action="intro-carousel-next"]');
  await waitFor(() => window.document.querySelector('[data-intro-carousel="1"]').dataset.introStep === "getting_started", 3000);
  assert.match(window.document.querySelector('[data-community-action="intro-carousel-next"]').textContent, /המשך להשלמת הפרופיל/, "the last screen's button names what happens next, not a generic \"הבא\"");

  click(window, '[data-community-action="intro-carousel-back"]');
  await waitFor(() => window.document.querySelector('[data-intro-carousel="1"]').dataset.introStep === "club_rules", 3000);
  click(window, '[data-community-action="intro-carousel-next"]');
  await waitFor(() => window.document.querySelector('[data-intro-carousel="1"]').dataset.introStep === "getting_started", 3000);

  click(window, '[data-community-action="intro-carousel-next"]');
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  assert.ok(!window.document.querySelector('[data-intro-carousel="1"]'), "the carousel is gone, replaced by the real profile-completion gate");
});

test("finishing the carousel sets the one-time device flag, so a later render never shows it again", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:seenIntroCarousel": "0" } });
  await signUpToCarousel(window);
  assert.equal(window.localStorage.getItem("haimunia-demo:seenIntroCarousel"), "0", "genuinely unseen going in");
  for (let i = 0; i < 3; i++) click(window, '[data-community-action="intro-carousel-next"]');
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  assert.equal(window.localStorage.getItem("haimunia-demo:seenIntroCarousel"), "1", "the finish click stamps the flag - a fresh boot of this same device would skip straight past it");
});

test("every OTHER test's default boot never sees the carousel - bootCommunity's own default flag is already \"seen\"", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);
  window.document.querySelector('#communityInviteCode input[name="code"]').value = "CLUBCODE";
  submit(window, "communityInviteCode");
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 3000);
  window.document.querySelector('#communityCredentials input[name="username"]').value = "gil";
  window.document.querySelector('#communityCredentials input[name="password"]').value = "correcthorse";
  window.document.querySelector('#communityCredentials input[name="passwordConfirm"]').value = "correcthorse";
  submit(window, "communityCredentials");
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  assert.ok(!window.document.querySelector('[data-intro-carousel="1"]'), "goes straight to profile completion, matching every pre-Phase-3 test in this repo");
});

test("carousel content reflects intro_carousel_content's own rows, falling back to the seed copy while unloaded", async () => {
  const mock = createMockSupabase({
    intro_carousel_content: [
      { step: "welcome_intro", title: "ברוכים הבאים לחדר הכושר שלנו!", body: "טקסט מותאם אישית מהמאמן הראשי.", updated_at: new Date().toISOString() },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:seenIntroCarousel": "0" } });
  await signUpToCarousel(window);
  await waitFor(() => window.document.querySelector('[data-intro-carousel="1"]').textContent.includes("ברוכים הבאים לחדר הכושר שלנו!"), 3000);
  assert.match(window.document.querySelector('[data-intro-carousel="1"]').textContent, /טקסט מותאם אישית מהמאמן הראשי/);
});

// ===== The admin editor, Manage tab's "קליטה" sub-tab =====================

function seededStaff(extra, role) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: role === "admin", recovery_verified_at: new Date().toISOString(), visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: role === "admin" ? "member" : (role || "member"), redeemed_at: new Date().toISOString() }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}
async function openManageOnboarding(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  click(window, '[data-community-action="set-manage-tab"][data-tab="onboarding"]');
}

test("a plain member never sees the intro-carousel editor entry point", async () => {
  const window = await bootCommunity(seededStaff(null, "member"), { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.ok(!window.document.getElementById("tabManageBtn"), "a plain member has no Manage tab at all");
});

test("a coach sees the intro-carousel editor beside the recurring-onboarding one, and saving a row writes via a direct update", async () => {
  const mock = seededStaff({
    intro_carousel_content: [{ step: "welcome_intro", title: "כותרת ישנה", body: "גוף ישן", updated_at: new Date().toISOString() }],
  }, "coach");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openManageOnboarding(window);
  await waitFor(() => !!window.document.querySelector('[data-intro-editor-section="1"]'), 3000);
  assert.ok(window.document.querySelector('[data-onboarding-editor-section="1"]'), "both editors render on the same sub-tab");

  const row = window.document.querySelector('[data-intro-editor-row="welcome_intro"]');
  const titleInput = row.querySelector('[data-intro-edit-title]');
  titleInput.value = "כותרת חדשה מהמאמן";
  titleInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  row.querySelector('[data-community-action="intro-content-save"]').click();
  await waitFor(() => mock.db.intro_carousel_content.find((r) => r.step === "welcome_intro").title === "כותרת חדשה מהמאמן", 3000);
  await waitFor(() => window.document.querySelector('[data-intro-editor-row="welcome_intro"]').textContent.includes("נשמר"), 3000);
});
