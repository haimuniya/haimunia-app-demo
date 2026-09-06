// Launch-readiness audit, RELIABILITY. Two real defects in the invite-code
// redemption step, both found by instrumenting a browser-check scenario
// that had been failing intermittently for weeks and was recorded as "flaky
// under CPU contention". It was neither flaky nor contention.
//
// DEFECT 1 - the typed code was erased by a background render.
//   This app re-renders by replacing #content's innerHTML wholesale. Any
//   render landing between a keystroke and the submit swapped the invite
//   form for a fresh, empty one, discarding what the member had typed. The
//   render that actually did it in practice is maybeAutoStartBackup()'s
//   "your workouts are backed up" message, which fires on the member's
//   first local write and lands, on a cold start, at exactly the wrong
//   moment. The member then submitted an empty field and was told the code
//   was required - for a code they had just typed.
//
// DEFECT 2 - a successful redemption could strand the member forever.
//   redeemCode() calls redeem_invite_code (which CONSUMES the code) and
//   then decides what to show from a follow-up READ of invite_redemptions.
//   One failed or racing read left the invite form on screen for a code
//   that was already spent - and re-submitting it now returns "invalid".
//   The account could not proceed, with no error and no way forward.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");

function redeemCodeBody() {
  const start = cloudJs.indexOf("async function redeemCode(form)");
  assert.ok(start > -1, "redeemCode(form) must still exist");
  return cloudJs.slice(start, cloudJs.indexOf("\n  }", start) + 4);
}

test("DEFECT 1: the typed invite code survives a re-render because it lives in state, not only in the DOM", () => {
  // Declared as a real state leaf, so community-state-namespaces.test.mjs
  // keeps guarding it.
  assert.match(cloudJs, /inviteCodeDraft: ""/,
    "state.ui.inviteCodeDraft must be declared in the state literal");

  // Every keystroke is captured, in the same delegated input listener that
  // already does this for reportNote and the comment drafts.
  assert.match(cloudJs, /if \("inviteCode" in t\.dataset\) \{ state\.ui\.inviteCodeDraft = t\.value; return; \}/,
    "the invite input's keystrokes must be persisted to state");

  // And rendered back, or the value would still be lost on the next paint.
  assert.match(cloudJs, /name="code"[^`]*value="\$\{esc\(state\.ui\.inviteCodeDraft\)\}"[^`]*data-invite-code/,
    "the invite input must render its value from state and carry data-invite-code");
});

test("DEFECT 1: submit reads the code from state first, so a render between keystroke and submit cannot empty it", () => {
  const body = redeemCodeBody();
  assert.match(body, /const code = String\(state\.ui\.inviteCodeDraft \|\| form\.elements\.code\.value \|\| ""\)\.trim\(\);/,
    "state must be consulted before the DOM - the DOM node may be a fresh, empty replacement");
  // The DOM fallback is kept deliberately (a paste that never fires input,
  // an autofill), so this is a widening, not a swap.
  assert.match(body, /form\.elements\.code\.value/,
    "the DOM value is kept as a fallback rather than removed");
});

test("DEFECT 1: a successful redemption clears the draft so the next signup on this device does not inherit it", () => {
  const body = redeemCodeBody();
  assert.match(body, /setFieldErrors\("communityInviteCode", \{\}\);\s*\n\s*state\.ui\.inviteCodeDraft = "";/,
    "the draft is cleared on success");
});

test("DEFECT 2: a completed redemption retries the read that gates the funnel instead of trusting it once", () => {
  const body = redeemCodeBody();
  assert.match(body, /for \(let attempt = 0; attempt < 3 && !state\.redemption; attempt\+\+\)/,
    "the follow-up read is retried - it is the sole gate on a write that already succeeded");
  assert.match(body, /await loadRedemption\(\);/);
  // The retries must be spaced, or three immediate reads race the same way.
  assert.match(body, /setTimeout\(r, 150 \* attempt\)/,
    "retries back off rather than firing three times in the same tick");
});

test("DEFECT 2: a submit with no session reports something instead of silently doing nothing", () => {
  const body = redeemCodeBody();
  assert.doesNotMatch(body, /if \(!state\.user\) return;/,
    "the bare early return is gone - it was indistinguishable from the app being broken");
  assert.match(body, /if \(!state\.user\) return setFieldErrors\("communityInviteCode", \{ code: "[^"]+" \}\);/,
    "a missing session now produces a visible, human explanation");
});

test("the redemption path still refuses a bad code and still emits MEMBER_JOINED", () => {
  const body = redeemCodeBody();
  // Guard against the fixes above having widened what counts as success.
  assert.match(body, /if \(data === "invalid"\) return setFieldErrors/,
    "an invalid/expired/used code is still refused");
  assert.match(body, /data === "rate_limited"/, "the throttle answer is still handled");
  assert.match(body, /PRODUCT_EVENTS\.MEMBER_JOINED/, "MEMBER_JOINED is still emitted on success");
});
