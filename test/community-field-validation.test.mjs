// Every real-validation input in cloud.js (invite code, handle, announcement
// title/body, weekly challenge fields) now goes through a shared field()
// helper that splices aria-invalid + aria-describedby onto the input when
// state.fieldErrors has an entry for it, and renders the same error text
// visibly right under the field via that id - one message, wired to both a
// screen reader and a sighted user, instead of only a generic banner at the
// top of the form.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("a shared field() helper wires aria-invalid/aria-describedby onto the input and renders a matching visible error", () => {
  assert.match(src, /function field\(formId, name, labelText, inputHtml\)/);
  assert.match(src, /aria-invalid="true" aria-describedby="\$\{errId\}"/);
  assert.match(src, /class="field-error" id="\$\{errId\}" role="alert"/);
});

test("state carries per-form field errors, cleared on successful submit and on sign-out", () => {
  assert.match(src, /fieldErrors: \{\}/);
  assert.match(src, /function setFieldErrors\(formId, errors\)/);
  // COMM-365 split the one-line sign-out reset into per-namespace lines, so
  // these two assignments no longer sit side by side.
  assert.match(src, /state\.ui\.fieldErrors = \{\};/);
  assert.match(src, /state\.admin\.reports = \[\];/);
});

test("the invite code field uses field() instead of a bare labelless input", () => {
  assert.match(src, /field\("communityInviteCode", "code", "קוד הזמנה"/);
  assert.match(src, /setFieldErrors\("communityInviteCode", \{ code: "יש להזין קוד הזמנה" \}\)/);
});

test("both handle inputs (profile gate and account tab) route through field() under the same form id, so a duplicate-handle error lands on the right one", () => {
  const matches = src.match(/field\("communityProfile", "handle", "שם משתמש \(handle\)"/g) || [];
  assert.equal(matches.length, 2);
  assert.match(src, /error\.code === "23505"\) setFieldErrors\(formId, \{ handle: "שם המשתמש כבר תפוס" \}\)/);
});

test("the announcement and weekly-challenge composers validate every required field individually, not just as one generic message", () => {
  assert.match(src, /field\("communityAnnouncement", "title", "כותרת"/);
  assert.match(src, /field\("communityAnnouncement", "body", "תוכן"/);
  assert.match(src, /field\("communityWeeklyChallenge", "title", "שם האתגר"/);
  assert.match(src, /field\("communityWeeklyChallenge", "comparisonKey", "מפתח השוואה"/);
  assert.match(src, /field\("communityWeeklyChallenge", "startsOn", "תאריך התחלה"/);
  assert.match(src, /field\("communityWeeklyChallenge", "endsOn", "תאריך סיום"/);
});
