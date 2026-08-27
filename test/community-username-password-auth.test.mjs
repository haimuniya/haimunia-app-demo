// Plain anonymous-only sign-in (no email, no password) had a real,
// user-reported problem: there was no way to log back into the same
// account from a different device or after clearing site data - every
// fresh session was a disconnected identity with its own invite-code
// redemption and profile, "a mess" in the user's own words. Replaced
// with a real username + password account, still with no actual email
// ever collected or sent: a brand-new member redeems the invite code on
// a throwaway anonymous session (needed only because redeem_invite_code
// requires some session to attach to), then immediately sets a
// username + password, which upgrades that same auth.uid() to a
// permanent account via Supabase's supported anonymous-user-conversion
// path (client.auth.updateUser). A returning member just signs in with
// those credentials on any device and reaches the same account, same
// data - the thing anonymous-only sign-in structurally couldn't offer.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("the synthetic email is built locally from a username, never collected as real email, using the RFC 2606 .invalid TLD", () => {
  assert.match(src, /function usernameToEmail\(username\) \{ return `\$\{username\}@members\.haimuniya\.invalid`; \}/);
});

test("login() signs in with the synthetic email + typed password, and does not create a new session type", () => {
  assert.match(src, /async function login\(form\)/);
  assert.match(src, /client\.auth\.signInWithPassword\(\{ email: usernameToEmail\(username\), password \}\)/);
});

test("setCredentials() upgrades the anonymous session in place via updateUser, and refreshes state.user from the result", () => {
  assert.match(src, /async function setCredentials\(form\)/);
  assert.match(src, /client\.auth\.updateUser\(\{ email: usernameToEmail\(username\), password \}\)/);
  assert.match(src, /state\.user = data\.user;/);
});

test("startSignup() begins the anonymous bootstrap only when explicitly chosen, not automatically on load", () => {
  assert.match(src, /function startSignup\(\) \{ state\.signupStarted = true; ensureAnonymousSession\(\); rerender\(\); \}/);
});

test("the gate order is: login-or-start -> (bootstrap) -> invite code -> set credentials (only while still anonymous) -> profile -> app", () => {
  const start = src.indexOf("window.renderCommunityApp = function ()");
  const end = src.indexOf("const p = state.profile || {};");
  const body = src.slice(start, end);

  const loginGate = body.indexOf('if (!state.signupStarted) return');
  const bootstrapGate = body.indexOf("ensureAnonymousSession();");
  const redemptionGate = body.indexOf("if (!state.redemption) return");
  const credentialsGate = body.indexOf("if (state.user.is_anonymous) return");
  const profileGate = body.indexOf("if (!state.profile) return");

  assert.ok(loginGate > -1, "must offer login (or starting signup) before any session exists");
  assert.ok(bootstrapGate > loginGate, "anonymous bootstrap must only run after login-or-start, not before");
  assert.ok(redemptionGate > bootstrapGate, "invite code gate comes after the user has some session");
  assert.ok(credentialsGate > redemptionGate, "credentials must be set right after redeeming the code");
  assert.ok(profileGate > credentialsGate, "profile completion is the last gate, only once the account is permanent");
});

test("a returning member who signs in with real credentials never sees the credentials-setup screen (gated on is_anonymous)", () => {
  assert.match(src, /if \(state\.user\.is_anonymous\) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">יצירת חשבון/);
});

test("the login form and the credentials form each validate independently and clear their own field errors on success", () => {
  assert.match(src, /field\("communityLogin", "username"/);
  assert.match(src, /field\("communityLogin", "password"/);
  assert.match(src, /field\("communityCredentials", "username"/);
  assert.match(src, /field\("communityCredentials", "password"/);
  assert.match(src, /field\("communityCredentials", "passwordConfirm"/);
  assert.match(src, /setFieldErrors\("communityCredentials", \{\}\);/);
});

test("sign-out is wired now that logging back in is possible, and resets signupStarted plus the anonymous-attempt guard so a fresh signup can start cleanly afterward", () => {
  assert.match(src, /data-community-action="sign-out"/);
  assert.match(src, /action === "sign-out"\) client\.auth\.signOut\(\)/);
  assert.match(src, /state\.signupStarted = false;\s*\n\s*anonSignInAttempted = false;/);
});

test("communityLogin and communityCredentials submits are wired to their handlers", () => {
  assert.match(src, /event\.target\.id === "communityLogin"\) \{ event\.preventDefault\(\); login\(event\.target\); \}/);
  assert.match(src, /event\.target\.id === "communityCredentials"\) \{ event\.preventDefault\(\); setCredentials\(event\.target\); \}/);
});
