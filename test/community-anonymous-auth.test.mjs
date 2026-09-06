// Product decision: no real email is ever collected, sent, or required
// for community sign-in - a magic-link email often opens in whatever the
// phone's default browser is, not inside the installed home-screen PWA,
// landing the session somewhere other than where the person actually
// wanted to be. signInAnonymously() still exists, but only as a
// one-time, invisible bootstrap step for a brand-new signup, needed
// purely because redeem_invite_code requires some session to attach to.
// It is no longer the permanent identity: see
// community-username-password-auth.test.mjs for the username+password
// upgrade that replaces it immediately after redemption, which is what
// makes logging back in from a different device possible - something
// plain anonymous-only sign-in structurally couldn't offer, and the
// reason it stopped being the whole story.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("sign-in uses signInAnonymously(), with no email collection anywhere", () => {
  // Still signInAnonymously, now wrapped in withCaptcha() (SEC-004) which
  // passes { options: { captchaToken } } when a site key is configured and
  // calls it with no options at all when one is not. The property this test
  // guards - anonymous sign-in, never an email flow - is unchanged.
  assert.match(cloudJs, /client\.auth\.signInAnonymously\(captchaToken \? \{ options: \{ captchaToken \} \} : undefined\)/);
  assert.doesNotMatch(cloudJs, /signInWithOtp/);
  assert.doesNotMatch(cloudJs, /communityEmail/);
  assert.doesNotMatch(cloudJs, /emailRedirectTo/);
});

test("ensureAnonymousSession only ever attempts once per page load, and only once a session doesn't already exist", () => {
  const fn = cloudJs.slice(cloudJs.indexOf("async function ensureAnonymousSession"), cloudJs.indexOf("async function signOut") > -1 ? cloudJs.indexOf("async function signOut") : cloudJs.indexOf("async function saveProfile"));
  assert.match(fn, /if \(!client \|\| state\.user \|\| anonSignInAttempted\) return;/);
  assert.match(fn, /anonSignInAttempted = true;/);
});

test("the signed-out (or backup-only anonymous, pre-signup) render state triggers ensureAnonymousSession and shows a connecting message, not an email form", () => {
  // Widened from a plain !state.user check: a backup-only anonymous
  // session (see community-backup-sync.test.mjs) can already exist by the
  // time this renders, off the back of Settings > "protect my data" - the
  // same login-or-start screen still has to show until signupStarted is
  // explicitly set, rather than skipping straight past it.
  const branch = cloudJs.slice(cloudJs.indexOf("if (!state.user || (state.user.is_anonymous && !state.signupStarted)) {"), cloudJs.indexOf("if (!state.redemption)"));
  assert.match(branch, /ensureAnonymousSession\(\);/);
  assert.doesNotMatch(branch, /type="email"/);
  assert.doesNotMatch(branch, /שליחת קישור/);
});

test("a real sign-out button exists now that logging back in is possible with real credentials", () => {
  assert.match(cloudJs, /data-community-action="sign-out"/);
  assert.match(cloudJs, /action === "sign-out"\) client\.auth\.signOut\(\)/);
});
