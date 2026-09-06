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

// A returning member logging in on a NEW device satisfies every gate ABOVE
// the carousel (session, redemption, non-anonymous) and the seen-flag is
// per-device localStorage, so it is unset for them. Before the predicate
// gained its !state.profile half they were shown all three intro screens,
// ending on a button promising "המשך להשלמת הפרופיל" - a profile form they
// already completed long ago and were never going to see. Reproduced live
// before the fix; this is the regression guard.
test("a returning member on a brand-new device goes straight to the club, never the first-run carousel", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", recovery_verified_at: new Date().toISOString(), visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  // The device has never seen the carousel - a new phone, or cleared data.
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:seenIntroCarousel": "0" } });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.ok(!window.document.querySelector('[data-intro-carousel="1"]'), "an existing profile means signup is long finished - the first-run carousel must not intercept it");
});

// The seen-flag is only stamped by the FINAL Next click, so an abandoned
// run leaves it unset - which is correct, and is exactly the case where a
// leftover step index is visible to the next person on the device.
test("abandoning the carousel and signing out does not start the next member mid-carousel", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:seenIntroCarousel": "0" } });
  await signUpToCarousel(window);
  click(window, '[data-community-action="intro-carousel-next"]');
  await waitFor(() => window.document.querySelector('[data-intro-carousel="1"]').dataset.introStep === "club_rules", 3000);
  assert.equal(window.localStorage.getItem("haimunia-demo:seenIntroCarousel"), "0", "abandoned mid-way, so the device flag is still unset");

  await mock.client.auth.signOut();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);

  window.document.querySelector('#communityLogin input[name="username"]').value = "";
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);
  window.document.querySelector('#communityInviteCode input[name="code"]').value = "CLUBCODE";
  submit(window, "communityInviteCode");
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 3000);
  window.document.querySelector('#communityCredentials input[name="username"]').value = "gil";
  window.document.querySelector('#communityCredentials input[name="password"]').value = "correcthorse";
  window.document.querySelector('#communityCredentials input[name="passwordConfirm"]').value = "correcthorse";
  submit(window, "communityCredentials");
  await waitFor(() => !!window.document.querySelector('[data-intro-carousel="1"]'), 3000);
  assert.equal(window.document.querySelector('[data-intro-carousel="1"]').dataset.introStep, "welcome_intro", "the next member starts at screen 1, not wherever the previous one abandoned");
});

// The two systems are siblings, not one system: the carousel is per-device
// and one-time, the five onboarding cards are per-member, server-stamped and
// recurring. They can never be on screen together because the carousel gate
// returns before the tabbed UI (which is where renderOnboardingStep lives)
// is ever built - asserted here rather than left to the reading.
test("the carousel and the recurring onboarding card never co-render", async () => {
  const mock = createMockSupabase({ onboarding_progress: [] });
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:seenIntroCarousel": "0" } });
  await signUpToCarousel(window);
  assert.ok(!window.document.querySelector("[data-onboarding-step]"), "no onboarding card while the carousel owns the screen");
  for (let i = 0; i < 3; i++) click(window, '[data-community-action="intro-carousel-next"]');
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  assert.ok(!window.document.querySelector('[data-intro-carousel="1"]'), "and the carousel is gone once it hands off");
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

// ===== The admin editor's other states - byte-identical sibling shape to
// renderOnboardingContentEditor(), covered by
// test/community-onboarding-content-editor.test.mjs, missing here until now.

// Wraps mock.client.from() for exactly one table, so a test can force one
// call's outcome (a delayed read, a forced error) without touching every
// other table read/write this same boot performs. Mirrors the shape
// community-onboarding-content-editor.test.mjs's own "RLS-refused" test
// already uses for a single table's .select, generalized slightly to also
// cover .update and a controllable delay.
function interceptTable(mock, table, { onThen, onUpdate } = {}) {
  const realFrom = mock.client.from;
  mock.client.from = (t) => {
    const api = realFrom(t);
    if (t !== table) return api;
    let isUpdate = false;
    if (onUpdate) {
      const origUpdate = api.update.bind(api);
      api.update = (payload) => { isUpdate = true; return origUpdate(payload); };
    }
    const realThen = api.then.bind(api);
    api.then = (onFulfilled, onRejected) => {
      if (isUpdate && onUpdate) return onUpdate(realThen).then(onFulfilled, onRejected);
      if (onThen) return onThen(realThen).then(onFulfilled, onRejected);
      return realThen(onFulfilled, onRejected);
    };
    return api;
  };
}

test("Loading: a distinct skeleton renders before the read resolves, then the populated rows render", async () => {
  const mock = seededStaff({
    intro_carousel_content: [{ step: "welcome_intro", title: "כותרת בדיקה", body: "גוף בדיקה", updated_at: new Date().toISOString() }],
  }, "admin");
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  interceptTable(mock, "intro_carousel_content", { onThen: (realThen) => gate.then(realThen) });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openManageOnboarding(window);
  await waitFor(() => !!window.document.querySelector('[data-intro-editor-skeleton="1"]'), 3000);
  assert.equal(window.document.querySelector('[data-intro-editor-row="welcome_intro"]'), null, "no row before the read resolves");
  releaseRead();
  await waitFor(() => !!window.document.querySelector('[data-intro-editor-row="welcome_intro"]'), 3000);
  assert.equal(window.document.querySelector('[data-intro-editor-skeleton="1"]'), null, "the skeleton is gone once populated");
  assert.equal(window.document.querySelector('[data-intro-editor-row="welcome_intro"] [data-intro-edit-title]').value, "כותרת בדיקה");
});

test("Error: a failed load shows the ticket's own copy, with a working retry", async () => {
  const mock = seededStaff({
    intro_carousel_content: [{ step: "welcome_intro", title: "כותרת בדיקה", body: "גוף בדיקה", updated_at: new Date().toISOString() }],
  }, "admin");
  // renderManageApp() computes every sub-tab's html up front on each render
  // (not just the active one), so more than one loadIntroCarouselContent()
  // call can be in flight from the same navigation before the first one
  // resolves. A `phase` flag (rather than a call counter) keeps every
  // concurrent call in the same phase consistent with one another - they
  // all see "boom" until the test itself flips it, only after the error
  // state has actually landed - instead of racing each other to different
  // outcomes.
  let phase = "error";
  interceptTable(mock, "intro_carousel_content", {
    onThen: (realThen) => (phase === "error" ? Promise.resolve({ data: null, error: { message: "boom" } }) : realThen()),
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openManageOnboarding(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את תוכן מסך הפתיחה."), 3000);
  phase = "recovered";
  window.document.querySelector('[data-community-action="intro-content-retry"]').click();
  await waitFor(() => !!window.document.querySelector('[data-intro-editor-row="welcome_intro"]'), 3000);
  assert.equal(window.document.querySelector('[data-intro-editor-skeleton="1"]'), null, "populated, not stuck on the skeleton");
});

test("a save with an empty title is refused client-side, and the empty (unsaved) edit stays in the input rather than resetting", async () => {
  const mock = seededStaff({
    intro_carousel_content: [{ step: "welcome_intro", title: "כותרת ישנה", body: "גוף ישן", updated_at: new Date().toISOString() }],
  }, "admin");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openManageOnboarding(window);
  await waitFor(() => !!window.document.querySelector('[data-intro-editor-row="welcome_intro"]'), 3000);
  const row = window.document.querySelector('[data-intro-editor-row="welcome_intro"]');
  const titleInput = row.querySelector('[data-intro-edit-title]');
  titleInput.value = "";
  titleInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  row.querySelector('[data-community-action="intro-content-save"]').click();
  await waitFor(() => window.document.querySelector('[data-intro-editor-row="welcome_intro"]').textContent.includes("יש למלא כותרת"), 3000);
  assert.equal(window.document.querySelector('[data-intro-editor-row="welcome_intro"] [data-intro-edit-title]').value, "", "the empty edit is not silently reset");
  assert.equal(mock.db.intro_carousel_content.find((r) => r.step === "welcome_intro").title, "כותרת ישנה", "no write reaches the server at all");
});

test("a write the server refuses with a real error shows the failure copy, not a false save", async () => {
  const mock = seededStaff({
    intro_carousel_content: [{ step: "welcome_intro", title: "כותרת ישנה", body: "גוף ישן", updated_at: new Date().toISOString() }],
  }, "admin");
  interceptTable(mock, "intro_carousel_content", { onUpdate: () => Promise.resolve({ data: null, error: { message: "boom" } }) });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openManageOnboarding(window);
  await waitFor(() => !!window.document.querySelector('[data-intro-editor-row="welcome_intro"]'), 3000);
  const row = window.document.querySelector('[data-intro-editor-row="welcome_intro"]');
  const titleInput = row.querySelector('[data-intro-edit-title]');
  titleInput.value = "כותרת חדשה";
  titleInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  row.querySelector('[data-community-action="intro-content-save"]').click();
  await waitFor(() => window.document.querySelector('[data-intro-editor-row="welcome_intro"]').textContent.includes("השמירה נכשלה"), 3000);
  assert.equal(mock.db.intro_carousel_content.find((r) => r.step === "welcome_intro").title, "כותרת ישנה", "the server-side row is untouched");
});

test("a refused RLS write (does not raise - matches zero rows) is caught by the honest read-back check, not reported as a false success", async () => {
  // Same documented quirk as intro_carousel_content's own migration
  // (202609050007, byte-identical RLS shape to onboarding_step_content):
  // update() 'succeeds' (no error) but the row is unchanged when RLS's
  // USING clause refuses it, because a real refusal on UPDATE matches zero
  // rows rather than raising. The mock's own .update() always applies
  // unconditionally, so this proves the client re-reads after every save
  // (loadIntroCarouselContent runs again) by counting select calls, the
  // same proof-of-honesty shape the onboarding sibling test already uses.
  const mock = seededStaff({
    intro_carousel_content: [{ step: "welcome_intro", title: "כותרת ישנה", body: "גוף ישן", updated_at: new Date().toISOString() }],
  }, "admin");
  const selectCalls = [];
  const realFrom = mock.client.from;
  mock.client.from = (table) => {
    const api = realFrom(table);
    if (table === "intro_carousel_content") {
      const origSelect = api.select;
      api.select = (...args) => { selectCalls.push(1); return origSelect.apply(api, args); };
    }
    return api;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openManageOnboarding(window);
  await waitFor(() => !!window.document.querySelector('[data-intro-editor-row="welcome_intro"]'), 3000);
  const initialReads = selectCalls.length;
  window.document.querySelector('[data-intro-editor-row="welcome_intro"] [data-community-action="intro-content-save"]').click();
  await waitFor(() => selectCalls.length > initialReads, 3000);
});
