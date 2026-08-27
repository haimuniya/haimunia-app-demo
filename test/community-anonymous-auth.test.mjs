// Product decision: no email collection at all for community sign-in.
// A magic-link email often opens in whatever the phone's default browser
// is, not inside the installed home-screen PWA, landing the session
// somewhere other than where the person actually wanted to be. Sign-in
// is now a real Supabase Auth anonymous session (client.auth.signInAnonymously()),
// created invisibly the first time the Community tab is opened, with the
// invite code remaining the only real gate (unchanged: checked server-side
// by profiles_insert_self's RLS policy at profile-creation time, not by
// how the session was created).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("sign-in uses signInAnonymously(), with no email collection anywhere", () => {
  assert.match(cloudJs, /client\.auth\.signInAnonymously\(\)/);
  assert.doesNotMatch(cloudJs, /signInWithOtp/);
  assert.doesNotMatch(cloudJs, /communityEmail/);
  assert.doesNotMatch(cloudJs, /emailRedirectTo/);
});

test("ensureAnonymousSession only ever attempts once per page load, and only once a session doesn't already exist", () => {
  const fn = cloudJs.slice(cloudJs.indexOf("async function ensureAnonymousSession"), cloudJs.indexOf("async function signOut") > -1 ? cloudJs.indexOf("async function signOut") : cloudJs.indexOf("async function saveProfile"));
  assert.match(fn, /if \(!client \|\| state\.user \|\| anonSignInAttempted\) return;/);
  assert.match(fn, /anonSignInAttempted = true;/);
});

test("the signed-out render state triggers ensureAnonymousSession and shows a connecting message, not an email form", () => {
  const branch = cloudJs.slice(cloudJs.indexOf("if (!state.user) {"), cloudJs.indexOf("if (!state.redemption)"));
  assert.match(branch, /ensureAnonymousSession\(\);/);
  assert.doesNotMatch(branch, /type="email"/);
  assert.doesNotMatch(branch, /שליחת קישור/);
});

test("there is no sign-out button — anonymous sessions have no path back in, so it would be misleading", () => {
  assert.doesNotMatch(cloudJs, /data-community-action="sign-out"/);
  assert.doesNotMatch(cloudJs, />יציאה</);
});
