// Design sync & audit remediation (2026-09-02), the four "unassigned (app.js
// core, outside the 15-agent community roster)" tickets: COMM-339, COMM-340,
// COMM-349, COMM-360. See docs/community/backlog.md's "Design sync & audit
// remediation (2026-09-02)" section and docs/community/tickets/COMM-*.md for
// the full findings.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";

const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

// ===== COMM-339 ============================================================
// The armed "delete everything" confirm row must not survive a close/reopen
// of Settings with no explicit confirm or cancel in between.

test("COMM-339: closing Settings after arming the delete-everything confirm resets it, so reopening shows the initial button", async () => {
  const window = await bootApp();
  window.openSettings();
  const askBtn = window.document.querySelector('[data-action="ask-clear"]');
  assert.ok(askBtn, "Settings should render the initial (non-armed) delete trigger");
  askBtn.click();
  assert.ok(window.document.querySelector('[data-action="do-clear"]'), "clicking ask-clear should arm the confirm row");

  window.closeSettings();
  window.openSettings();

  assert.ok(window.document.querySelector('[data-action="ask-clear"]'), "reopening Settings must show the initial non-armed button again");
  assert.equal(window.document.querySelector('[data-action="do-clear"]'), null, "the armed confirm row must not survive a close/reopen with no confirm or cancel");
});

test("COMM-339: an explicit cancel still resets confirmClear the same way (unchanged behavior)", async () => {
  const window = await bootApp();
  window.openSettings();
  window.document.querySelector('[data-action="ask-clear"]').click();
  window.document.querySelector('[data-action="cancel-clear"]').click();
  assert.ok(window.document.querySelector('[data-action="ask-clear"]'));
  assert.equal(window.document.querySelector('[data-action="do-clear"]'), null);
});

// ===== COMM-340 =============================================================
// Android Chrome: fixed UI (bottom bar, modal chrome) must resize around the
// on-screen keyboard rather than float over it.

test("COMM-340: the viewport meta declares interactive-widget=resizes-content", () => {
  const viewportTag = indexHtml.match(/<meta name="viewport"[^>]*>/);
  assert.ok(viewportTag, "index.html should have a viewport meta tag");
  assert.match(viewportTag[0], /interactive-widget=resizes-content/);
});

// ===== COMM-349 =============================================================
// Filed as a duplicate of COMM-328 by a second, independent audit pass.
// COMM-328 (done) migrated the 8 remaining core dialogs onto app.js's own
// APP_DIALOGS registry and narrowed appDialogFocusables()'s bare [href] to
// a[href]. COMM-349's own acceptance criteria is just to verify COMM-328's
// covered that selector narrowing before closing both - pinned here so a
// future edit can't silently regress it back to a bare [href].

test("COMM-349/COMM-328: all 8 remaining core dialogs are registered on APP_DIALOGS alongside navMenu/settings", () => {
  const expected = ["navMenu", "settings", "picker", "wodPicker", "wodBuilder", "achievements", "celebration", "notifications", "onboarding", "welcome"];
  for (const key of expected) {
    assert.match(appJs, new RegExp(`registerAppDialog\\("${key}"`), `${key} should be registered on APP_DIALOGS`);
  }
});

test("COMM-349/COMM-328: appDialogFocusables() narrows the bare [href] clause to a[href]", () => {
  assert.match(appJs, /querySelectorAll\('button, a\[href\], input, select, textarea, \[tabindex\]:not\(\[tabindex="-1"\]\)'\)/);
});

// ===== COMM-360 =============================================================
// selectedId/selectedWodId must not default to Back Squat/Fran - a fresh
// load (and a post-clear-all-data state) must force an explicit choice
// before the save action is available.

test("COMM-360: a fresh load shows the log screen's pick-a-movement empty state, not a pre-filled Back Squat, and hides the save action", async () => {
  const window = await bootApp();
  window.document.getElementById("tabAddBtn").click();
  const content = window.document.getElementById("content").innerHTML;
  assert.match(content, /בחרו תרגיל כדי להתחיל/, "should prompt to pick a movement");
  assert.doesNotMatch(content, /Back Squat|סקוואט/, "must not pre-fill a movement's name before one is chosen");
  assert.equal(window.document.getElementById("bottomBar").style.display, "none", "no save action until a movement is chosen");
});

test("COMM-360: saveSet() is a no-op until a movement is explicitly chosen, then works normally after picking one", async () => {
  const window = await bootApp();
  window.document.getElementById("tabAddBtn").click();
  await window.saveSet();
  let content = window.document.getElementById("content").innerHTML;
  assert.match(content, /עדיין לא נרשמו סטים היום/, "an unchosen save must not create an entry");

  window.document.querySelector('[data-action="open-picker"]').click();
  window.document.querySelector('[data-action="pick-movement"]').click();
  await window.saveSet();
  content = window.document.getElementById("content").innerHTML;
  assert.doesNotMatch(content, /עדיין לא נרשמו סטים היום/, "saving after an explicit pick must succeed");
  assert.equal(window.document.getElementById("bottomBar").style.display, "flex", "the save action appears once a movement is chosen");
});

test("COMM-360: a fresh load shows the WOD screen's pick-a-WOD empty state, not a pre-filled Fran, and hides the save action", async () => {
  const window = await bootApp();
  window.document.getElementById("tabWodBtn").click();
  const wodContent = window.document.getElementById("wodContent").innerHTML;
  assert.match(wodContent, /בחרו אימון כדי להתחיל/, "should prompt to pick a WOD");
  assert.doesNotMatch(wodContent, /Fran/i, "must not pre-fill a WOD's name before one is chosen");
  assert.equal(window.document.getElementById("bottomBar").style.display, "none", "no save action until a WOD is chosen");
});

test("COMM-360: saveWod() is a no-op until a WOD is chosen, defending the same way saveSet() does", async () => {
  const window = await bootApp();
  window.document.getElementById("tabWodBtn").click();
  await assert.doesNotReject(window.saveWod(), "saveWod must not throw when nothing is selected yet");
});

test("COMM-360: clearAllData() resets both selections back to unset, not back to Back Squat/Fran", async () => {
  const window = await bootApp();
  window.document.getElementById("tabAddBtn").click();
  window.document.querySelector('[data-action="open-picker"]').click();
  window.document.querySelector('[data-action="pick-movement"]').click();
  await window.saveSet();

  window.downloadBackup = () => true; // COMM-339-adjacent safety net, not under test here
  await window.clearAllData();

  const logContent = window.document.getElementById("content").innerHTML;
  assert.match(logContent, /בחרו תרגיל כדי להתחיל/, "post-wipe log screen must ask again, not resume on Back Squat");

  window.document.getElementById("tabWodBtn").click();
  const wodContent = window.document.getElementById("wodContent").innerHTML;
  assert.match(wodContent, /בחרו אימון כדי להתחיל/, "post-wipe WOD screen must ask again, not resume on Fran");
});
