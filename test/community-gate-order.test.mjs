// Design spec section 7 — THE COMMUNITY GATE WAS BACKWARDS.
//
// The gate led with a login form and a 56px primary `התחברות ושחזור החשבון`,
// for an account the arriving member does not have. The path every arriving
// member actually needs — `חבר/ה חדש/ה? התחלת הרשמה עם קוד הזמנה` — was the
// smallest, lowest-contrast thing on the screen: a 13px underlined .link-btn
// at the bottom.
//
// For a club rolling this out to a cohort, EVERY arriving member is new, so
// the primary action was the one almost nobody needed. Three personas hit it
// independently; the beginner's verbatim first reaction was "I don't have a
// username. Did I already sign up and forget? Did I do something wrong?" — a
// member blaming herself for the app's ordering.
//
// WHAT THIS FILE MEASURES, and why it is executing rather than source-text:
// the claim being made is about a PATH (how many screens, how many taps, how
// prominent the needed action is), and a regex over cloud.js cannot see a
// path. These boot the real app against a mock Supabase and walk it.
//
// THE HEADLINE NUMBER IS NOT THE TAP COUNT. Cold arrival was two screens and
// two taps to reach the code field before this change, and it is two screens
// and two taps after it. What changed is WHICH action is primary at each
// step, and that is what the assertions below pin: the needed action goes
// from a 13px underlined link to the screen's .save-btn, and a cold arriving
// member is no longer shown a credential form they cannot fill.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, waitForCommunityGate, openCommunityLogin } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
// redeem_invite_code constrains p_code to ^[a-f0-9]{40,128}$, and
// captureInviteDeepLink() re-checks the same shape before it will prefill.
const CODE = "a1b2c3d4e5".repeat(4) + "f00d";

async function openGate(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitForCommunityGate(window);
  return window.document.getElementById("content");
}

test("a cold arriving member lands on a choice screen whose PRIMARY action is the invite code, not a login form", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  const content = await openGate(window);

  // The primary action - the one 56px .save-btn on the screen - is the one
  // almost everybody needs. This is the whole inversion.
  const primaries = [...content.querySelectorAll(".save-btn")];
  assert.equal(primaries.length, 1, "the gate must offer exactly one primary action, so there is no ambiguity about the main path");
  assert.equal(primaries[0].textContent.trim(), "יש לי קוד הזמנה");
  assert.equal(primaries[0].getAttribute("data-community-action"), "start-signup");

  // ...and it is NOT a login form. Before this change, a member who has
  // never heard of this app was shown a username field first.
  assert.equal(content.querySelector("#communityLogin"), null,
    "the cold gate must not lead with a credential form for an account nobody has yet");
  assert.equal(content.querySelectorAll('input[name="username"]').length, 0);
  assert.ok(!/התחברות ושחזור החשבון/.test(content.textContent),
    "the old login-first primary CTA must be gone from the gate");
});

test("the invite-code screen's own reassurance moves UP to the gate verbatim, because it was one screen too late", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  const content = await openGate(window);
  const text = content.textContent.replace(/\s+/g, " ");

  // These two sentences are the app's own best writing and they are what
  // stops a nervous member concluding she has done something wrong. They
  // existed already - one screen further in, where the panic had already
  // happened.
  assert.match(text, /הכניסה עם קוד הזמנה שמקבלים מהמאמן\/ת/);
  assert.match(text, /הקוד לא נוגע לרישום האימונים שלכם/,
    "the sentence that bounds the invite code - it does not touch your workout log - must be on the FIRST screen");
  // And a plain statement of what the tab even is, which the old gate never
  // made at all.
  assert.match(text, /כאן רואים מה קורה במועדון/);
});

test("the staff sentence is deleted from the gate and rewritten in member terms on the login screen", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  const content = await openGate(window);

  // "הסנכרון הפרטי" and "הרשאות הצוות" mean nothing to a member, and were
  // being shown at 12.5px to somebody with no account and no staff role.
  for (const staffWord of ["הסנכרון הפרטי", "הרשאות הצוות"]) {
    assert.ok(!content.textContent.includes(staffWord),
      `"${staffWord}" is staff vocabulary and must not be on the arriving member's first screen`);
  }
  assert.ok(!src.includes("הסנכרון הפרטי והרשאות הצוות"),
    "the staff sentence must be gone from cloud.js entirely, not merely hidden behind a branch");

  await openCommunityLogin(window);
  const login = window.document.getElementById("content").textContent;
  assert.match(login, /התחברות מחזירה את הפרופיל שלך/,
    "the login screen answers the question a member on THAT screen is actually asking");
  assert.ok(!/הרשאות הצוות/.test(login));
});

test("login is a screen of its own, so only one credential form is ever mounted by the gate", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  const content = await openGate(window);
  assert.equal(content.querySelectorAll("form").length, 0, "the choice screen mounts no form at all");

  const form = await openCommunityLogin(window);
  assert.ok(form, "the login form appears once the member asks for it");
  assert.equal(window.document.querySelectorAll("#content form").length, 1,
    "and it is the only form on the screen - a credential form must never share a screen with another");
});

test("the login CTA is a real >=44px control, not the 13px underlined link the needed action used to be", () => {
  // The defect was not only the ORDER, it was the treatment: .link-btn is
  // this app's de-emphasised inline link idiom (13px/36px, underlined), and
  // it was carrying the one action almost every arriving member needed.
  // Flipping the order while leaving the loser as a .link-btn would just
  // have moved the defect onto the returning member.
  assert.match(src, /class="gate-alt" data-community-action="show-login"/,
    "the gate's secondary action must be a .gate-alt control, not a .link-btn");
  const rule = indexHtml.match(/\.gate-alt\{([^}]*)\}/);
  assert.ok(rule, "index.html must define .gate-alt");
  assert.match(rule[1], /min-height:44px/, "spec 7.1 requires a >=44px target for the login action");
  const back = indexHtml.match(/\.gate-back\{([^}]*)\}/);
  assert.ok(back, "index.html must define .gate-back");
  assert.match(back[1], /min-height:44px/, "spec 7.2 requires the same for the back control");
});

test("MEASURED: cold arrival reaches the invite-code field in 2 screens / 2 taps, with zero credential forms on the way", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  const d = window.document;
  let taps = 0;
  const screens = [];

  d.getElementById("tabCommunityBtn").click(); taps++;
  await waitForCommunityGate(window);
  screens.push({ code: false, usernames: d.querySelectorAll("#content input[name=username]").length });

  d.querySelector('#content [data-community-action="start-signup"]').click(); taps++;
  await waitFor(() => !!d.getElementById("communityInviteCode"), 3000);
  screens.push({ code: true, usernames: d.querySelectorAll("#content input[name=username]").length });

  assert.equal(screens.length, 2, "two screens: what this is, then the code");
  assert.equal(taps, 2, "two taps: open the tab, then take the primary action");
  assert.deepEqual(screens.map((s) => s.usernames), [0, 0],
    "neither screen on the arriving member's path asks for a username - the account does not exist yet");
  // The tap count is unchanged from before this pass, and that is fine: the
  // second tap used to land on a 13px grey underline and now lands on the
  // screen's primary button.
  assert.ok(d.querySelector("#communityInviteCode [data-invite-code]"), "and the code field is reached");
});

test("MEASURED: the QR deep link still lands on the code field in 1 screen / 1 tap, prefilled — the flip does not fight 9c15214", async () => {
  const window = await bootCommunity(createMockSupabase(), {
    syncEnabled: false, url: `https://example.test/?tab=community&invite=${CODE}`,
  });
  const d = window.document;
  d.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!d.getElementById("communityInviteCode"), 4000);

  // captureInviteDeepLink() sets signupStarted, which skips the choice
  // screen entirely - correct, because somebody who scanned a joining QR has
  // already answered the question that screen asks. This is now the COMMON
  // arrival for anyone who scanned the club's QR, so the gate flip must not
  // add a screen to it.
  assert.ok(d.querySelector("#communityInviteCode [data-invite-code]"));
  assert.equal(d.querySelector("#communityInviteCode [data-invite-code]").value, CODE,
    "the scanned code is still prefilled, so this path needs no typing at all");
  assert.ok(d.querySelector("[data-invite-prefilled]"), "and still says where the code came from");
  assert.equal(d.querySelector('#content [data-community-action="show-login"]'), null,
    "a QR scanner is not shown the choice screen - they already chose by scanning");
});

test("a returning member who scanned the QR by mistake still reaches the login FORM in one tap, not the choice screen", async () => {
  // This is 9c15214's escape hatch, and the flip could easily have made it
  // two taps by landing "כבר יש לכם חשבון? התחברות" on the choice screen -
  // which would have been a quiet regression of somebody else's fix.
  const window = await bootCommunity(createMockSupabase(), {
    syncEnabled: false, url: `https://example.test/?tab=community&invite=${CODE}`,
  });
  const d = window.document;
  d.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!d.getElementById("communityInviteCode"), 4000);

  d.querySelector('#content [data-community-action="back-to-login"]').click();
  await waitFor(() => !!d.getElementById("communityLogin"), 3000);
  assert.ok(d.getElementById("communityLogin"),
    "one tap must reach the login form itself, not a screen that then offers login");
});

test("spec 7.2: the invite step has a back control, so tapping in by accident is not a dead end", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  const d = window.document;
  await openGate(window);
  d.querySelector('#content [data-community-action="start-signup"]').click();
  await waitFor(() => !!d.getElementById("communityInviteCode"), 3000);

  // Before this, the only button on the invite screen was "אישור קוד": a
  // member who tapped in by accident, or who just wanted to re-read what the
  // community even was, had to leave via the bottom tab bar.
  const back = d.querySelector('#content [data-community-action="gate-back"]');
  assert.ok(back, "the invite step must offer a way back");
  back.click();
  await waitFor(() => !!d.querySelector('#content [data-community-action="show-login"]'), 3000);
  assert.ok(d.querySelector('#content [data-community-action="start-signup"]'),
    "and it returns to the choice screen, with both doors offered again");

  // The two controls are deliberately separate: they go to different places.
  // Collapsing them would make one of the two labels a lie.
  assert.notEqual(
    src.indexOf('data-community-action="gate-back"'),
    src.indexOf('data-community-action="back-to-login"'));
});

test("the two gate flags never tangle: invite -> login -> back lands on the choice screen, not on either screen it came from", async () => {
  // The gate is driven by TWO independent flags - signupStarted ("this
  // person is joining", which captureInviteDeepLink and
  // ensureAnonymousSession also key off) and ui.gateView ("which of the two
  // pre-signup screens to paint"). Keeping them separate is what lets the QR
  // scanner's "כבר יש לכם חשבון" land directly on the login form. The risk
  // that buys is the two getting out of step, so this walks the one path
  // that sets and then clears both.
  const window = await bootCommunity(createMockSupabase(), {
    syncEnabled: false, url: `https://example.test/?tab=community&invite=${CODE}`,
  });
  const d = window.document;
  d.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!d.getElementById("communityInviteCode"), 4000);  // signupStarted = true

  d.querySelector('#content [data-community-action="back-to-login"]').click();
  await waitFor(() => !!d.getElementById("communityLogin"), 3000);      // + gateView = "login"

  d.querySelector('#content [data-community-action="gate-back"]').click();
  await waitFor(() => !!d.querySelector('#content [data-community-action="show-login"]'), 3000);

  // Both flags cleared: neither the invite step nor the login form is left
  // showing, and the member is back at the screen that explains the choice.
  assert.equal(d.getElementById("communityLogin"), null, "the login form is gone");
  assert.equal(d.getElementById("communityInviteCode"), null, "and so is the invite step");
  assert.ok(d.querySelector('#content [data-community-action="start-signup"]'),
    "leaving the choice screen as the single resting state of the gate");
});

test("backing out of the login screen returns to the choice screen", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  const d = window.document;
  await openGate(window);

  await openCommunityLogin(window);
  d.querySelector('#content [data-community-action="gate-back"]').click();
  await waitFor(() => !!d.querySelector('#content [data-community-action="start-signup"]'), 3000);
  assert.equal(d.getElementById("communityLogin"), null, "back from login returns to the choice screen");
});

test("the invite field accepts the full code length the server actually allows, and is not set up to be typed", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  const d = window.document;
  await openGate(window);
  d.querySelector('#content [data-community-action="start-signup"]').click();
  await waitFor(() => !!d.getElementById("communityInviteCode"), 3000);

  const input = d.querySelector("#communityInviteCode [data-invite-code]");
  assert.equal(input.getAttribute("dir"), "ltr");
  assert.equal(input.getAttribute("autocomplete"), "off",
    "a one-time invite code is not a credential a password manager should be offering to fill");
  // Design spec 7.2 says maxlength=48 because it describes the code as "a
  // 48-character hex string". The SERVER's own constraint - and
  // INVITE_CODE_PATTERN in cloud.js, which mirrors it - is
  // ^[a-f0-9]{40,128}$. A 48 cap would silently truncate a longer, perfectly
  // valid code and produce a "wrong code" error for a code that was right,
  // so the cap follows the schema rather than the prose.
  assert.equal(Number(input.getAttribute("maxlength")), 128);
  assert.match(src, /INVITE_CODE_PATTERN = \/\^\[a-f0-9\]\{40,128\}\$\//);
});

test("MEASURED: the duplicate input[name=username] - what the split fixed, and the half that is app.js's", async () => {
  // The spec claims two username fields "exist in the DOM simultaneously
  // because both forms render at once", and that giving login its own screen
  // fixes it structurally. THE FIRST HALF IS TRUE AND THE SECOND IS NOT, and
  // it is worth pinning which is which so the remaining half is not assumed
  // done.
  //
  // The gate never rendered two forms: its branches return early, so only one
  // is ever built. The second field is backupCredentials in #settingsBody,
  // which app.js repopulates on EVERY render regardless of whether the
  // settings overlay is open (app.js:4263, deliberately - see closeSettings).
  // From the moment any anonymous backup session exists it sits in the DOM
  // permanently, display:none behind a closed overlay.
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: true });
  const d = window.document;
  const creds = () => [...d.querySelectorAll('input[name="username"][autocomplete="username"]')];

  d.getElementById("tabCommunityBtn").click();
  await waitForCommunityGate(window);
  assert.equal(creds().length, 0,
    "a cold arriving member is now shown NO credential field at all - this is what the split genuinely bought");

  // maybeAutoStartBackup() can create this session off a saved set, with no
  // invite code and no Community involvement at all.
  await mock.client.auth.signInAnonymously();
  await waitFor(() => creds().length > 0, 4000);
  const onChoice = creds();
  assert.equal(onChoice.length, 1, "and even with a backup session the gate itself still contributes none");
  assert.ok(onChoice[0].closest("#settingsBody"),
    "the one field present is the Settings backup form, not the gate - which is the actual cause");

  d.querySelector('#content [data-community-action="show-login"]').click();
  await waitFor(() => !!d.getElementById("communityLogin"), 3000);

  // LANDED. app.js now marks #settingsOverlay inert while it is closed, which
  // is the fix this test was written to wait for.
  //
  // Two credential fields still EXIST in the document - #settingsBody is
  // still populated on every render, deliberately, because several checks
  // legitimately read it while the sheet is closed. What has changed is that
  // only one of them is real: `inert` takes the closed sheet out of the
  // accessibility tree, out of the tab order and out of hit-testing, so a
  // screen reader announces one username field, Tab reaches one, and a
  // password manager has one to fill. That is what "the duplicate is gone"
  // has to mean here, and it is asserted as such rather than by counting
  // nodes, which would only be measuring where the markup happens to live.
  const settingsOverlay = d.getElementById("settingsOverlay");
  assert.equal(settingsOverlay.hasAttribute("inert"), true,
    "the closed settings sheet must be inert, or its backup form is a second live username field");
  const live = creds().filter((el) => !el.closest("[inert]"));
  assert.equal(live.length, 1, "exactly one credential field is reachable at a time");
  assert.ok(live[0].closest("#communityLogin"),
    "and it is the login form the member is actually looking at, not the one behind a closed sheet");

  // ...and it lifts when the sheet is opened, or Settings would be unusable.
  window.openSettings();
  assert.equal(settingsOverlay.hasAttribute("inert"), false, "an open sheet must not be inert");
  window.closeSettings();
  assert.equal(settingsOverlay.hasAttribute("inert"), true, "and it goes back when the sheet closes");
});

test("signing out returns a member to the choice screen, not to a bare login form", async () => {
  const VERIFIED = new Date().toISOString();
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  const d = window.document;
  d.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!d.querySelector(".subtabbar"), 4000);

  d.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!d.querySelector('[data-community-action="sign-out"]'), 3000);
  d.querySelector('[data-community-action="sign-out"]').click();
  await waitForCommunityGate(window);

  // Signing out on a shared phone and being handed back a login form
  // pre-framed as "the way in" is the same wrong ordering, one screen later.
  assert.ok(d.querySelector('#content [data-community-action="start-signup"]'));
  assert.equal(d.getElementById("communityLogin"), null);
});
