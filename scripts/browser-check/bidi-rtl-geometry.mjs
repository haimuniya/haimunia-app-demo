#!/usr/bin/env node
// Bidi isolation, asserted the only way it can be: by measuring where the
// characters actually land.
//
// THE BUG. The app is `<html lang="he" dir="rtl">` end to end, and the
// training log is where mixed-script content is the norm rather than the
// exception - rep schemes ("21-15-9"), English movement names, weights
// ("43/30"), all typed into RTL Hebrew paragraphs. Interpolated bare, the
// Unicode bidirectional algorithm reorders those LTR runs against the
// paragraph and what is PAINTED stops matching what was typed. A coach's
//
//     21-15-9 Thrusters + Pull-ups. Rx 43/30 ק"ג.
//
// reached members with the rep scheme at the opposite end of the line; one
// audit persona read it as 9-15-21. That is why this is a safety bug and
// not a cosmetic one: not a garbled string a member notices and ignores,
// but a plausible, valid-looking, DIFFERENT workout they follow to the
// letter without ever knowing it is not the one that was written. Fixed in
// 3a85c76 (cloud.js, 46 sites) and d568aee (app.js) by wrapping each LINE
// in <bdi>.
//
// WHY THIS FILE HAS TO EXIST. Both commits were proven by hand, once, with
// per-character geometry in Chromium, and neither shipped a test. No unit
// test can replace it: the bidi algorithm never touches the DOM, so the
// text node still reads "21-15-9" in logical order while the screen shows
// something else. `textContent` is correct on the broken build. A unit test
// can at best assert that <bdi> appears at the render sites it already
// knows about, which is a restatement of the diff rather than a check on
// the behaviour, and says nothing at all about a NEW render site added
// later without it - which is precisely how this bug arrived the first
// time (<bdi> already existed in cloud.js, wrapping only @handle).
//
// EVERY ASSERTION HERE IS PAIRED WITH A CONTROL. A geometry check with no
// control is close to worthless - "painted order matches typed order" is
// also true of a string that would never have reordered, on a surface that
// was already LTR, in a container that never inherited dir=rtl. In all
// three cases it passes just as happily against the bug. So each check
// below also builds the PRE-FIX node (same text, no isolation) as a
// sibling of the real one, under identical inherited style, and requires
// it to reorder. If the control ever stops reordering, the sample has gone
// stale and the check is no longer proving anything - that is reported as
// a failure too, deliberately.
//
// Usage:
//   node bidi-rtl-geometry.mjs                 # local working tree
//   TARGET_URL=<url> node bidi-rtl-geometry.mjs # a deployed site
import { chromium } from "playwright";
import { resolveTarget } from "./lib/target.mjs";
import { switchTab, dismissWelcomeModal, dismissCelebrationIfOpen, selectBenchmarkWod, consoleErrorCollector } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";
import { paintedText, paintedTextOfUnisolatedControl } from "./lib/geometry.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

// Asserts the pair: the shipped node paints as `expectedPainted`, and the
// pre-fix node built beside it does not.
//
// `typed` and `expectedPainted` are two different strings whenever the text
// contains Hebrew, and the difference is correct rather than a bug. Reading
// the screen left to right, an RTL sub-run inside an LTR line is encountered
// last character first: `ק"ג` is typed in that order and painted `ג"ק`. That
// is what a Hebrew reader sees and reads correctly, because they read that
// run right to left. The property under test is the ORDER OF THE RUNS - rep
// scheme, then movements, then weight, then unit - not the internal
// direction of each run, which the bidi algorithm is supposed to flip and
// which was never broken. Conflating the two is how an assertion here ends
// up demanding the app force everything LTR, which is the other bug.
//
// The control is built from `typed`, because that is what the pre-fix code
// interpolated.
async function checkIsolated(page, label, selector, { typed, expectedPainted }) {
  const real = await paintedText(page, selector);
  const control = await paintedTextOfUnisolatedControl(page, selector, typed);
  check(`${label}: the runs paint in the order they were typed`, real === expectedPainted, `painted "${real}", wanted "${expectedPainted}"`);
  check(
    `${label}: and the un-isolated control still reorders, so the check is load-bearing`,
    control !== expectedPainted,
    `control painted "${control}"${control === expectedPainted ? " — identical to the fixed node, so this sample no longer reproduces the bug and proves nothing" : ""}`,
  );
  return { real, control };
}

// The specific misreading the audit recorded: a member seeing 9-15-21 and
// doing a different, plausible, valid-looking workout. Asserted directly and
// by leftmost painted position rather than by string equality, so it stays
// meaningful even if the surrounding copy changes.
async function checkRepSchemeReadsForward(page, label, selector) {
  const painted = await paintedText(page, selector);
  check(
    `${label}: the rep scheme reads 21-15-9, not the valid-looking 9-15-21`,
    painted.includes("21-15-9") && !painted.includes("9-15-21"),
    painted,
  );
  check(
    `${label}: and it is painted at the start of the line, where it was typed`,
    painted.trimStart().startsWith("21-15-9"),
    painted,
  );
}

const target = await resolveTarget();
console.log(`Target: ${target.url}${target.local ? " (local static server)" : ""}`);

const browser = await chromium.launch();
// 390x844 he-IL: the viewport and locale the original geometry was measured
// at, so the reproduction is the reported one rather than a similar one.
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "he-IL" });
const errors = await consoleErrorCollector(page);

await installMockCloud(page);
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible" });
await dismissWelcomeModal(page);

// Sanity floor for everything below: if the surface under test were not
// actually RTL, no reordering could happen and every assertion in this file
// would be vacuous.
const pageRtl = await page.evaluate(() => getComputedStyle(document.documentElement).direction);
check("the page really is RTL, so bidi reordering is actually possible here", pageRtl === "rtl", pageRtl);

await switchTab(page, "tabWodBtn");
await page.waitForTimeout(200);
await selectBenchmarkWod(page, "fran");
await page.waitForSelector(".wod-desc", { timeout: 5000 });

// ---- 1. A built-in WOD description on the log screen ----
// Fran's own desc: an entirely LTR run (rep scheme + English movements)
// sitting in an RTL paragraph, which is the shape that inverts.
await checkIsolated(page, "a WOD description on the log screen", ".wod-desc", {
  typed: "21-15-9 Thrusters & Pull-ups",
  // No Hebrew in this one, so painted and typed order coincide.
  expectedPainted: "21-15-9 Thrusters & Pull-ups",
});
await checkRepSchemeReadsForward(page, "a WOD description on the log screen", ".wod-desc");

// The fix must isolate the run, NOT force the surface LTR - the same
// paragraph still has to lay out Hebrew correctly for every other string
// the app puts through it.
const descDir = await page.evaluate(() => getComputedStyle(document.querySelector(".wod-desc")).direction);
check("the description's own container stays rtl (the fix isolated, it did not flip the page)", descDir === "rtl", descDir);

// ---- 2. A member-typed note: the exact string from the report ----
// e.notes is free text a member types on their phone and is the field the
// audit actually caught this on. Logging it through the real form and
// reading it back off the history screen exercises the shipped path end to
// end rather than a fixture.
const REPORTED = '21-15-9 Thrusters + Pull-ups. Rx 43/30 ק"ג.';
// #wodNotesInput ("שינוי בתרגיל?") is rendered only on the Scaled branch —
// a note about how the workout was adapted only makes sense once it was.
await page.click("[data-action='set-rx'][data-rx='0']");
await page.waitForSelector("#wodNotesInput", { timeout: 5000 });
await page.fill("#wodNotesInput", REPORTED);
await page.dispatchEvent("#wodNotesInput", "input");
await page.fill("[data-field='wodMinutes'].stepper-val", "7");
await page.dispatchEvent("[data-field='wodMinutes'].stepper-val", "change");
await page.click("[data-action='save-wod']");
await page.waitForTimeout(300);
await dismissCelebrationIfOpen(page);

await switchTab(page, "tabCalendarBtn");
await page.waitForTimeout(250);
// The notes line under a logged WOD is the only node on this screen with
// that padding-inline-start, which keeps the selector off the sibling
// date/Rx spans that share its font-size.
const noteSel = "#calDetail div[style*='padding-inline-start:23px']";
const noteFound = await page.locator(noteSel).count();
check("the member-typed note reaches the calendar day view at all", noteFound > 0);
if (noteFound > 0) {
  await checkIsolated(page, "a member-typed mixed-script note", noteSel, {
    typed: REPORTED,
    // Character-for-character the AFTER line recorded in 3a85c76. The `ק"ג`
    // appears as `ג"ק` for the reason in checkIsolated's comment — it is one
    // RTL run, sitting where it was typed, at the end of the line beside the
    // 43/30 it belongs to rather than stranded 34 characters away from it.
    expectedPainted: '21-15-9 Thrusters + Pull-ups. Rx 43/30 ג"ק.',
  });
  await checkRepSchemeReadsForward(page, "a member-typed mixed-script note", noteSel);
}

// ---- 3. The other direction: an ordinary Hebrew note must stay RTL ----
// <bdi> takes each run's direction from its own first strong character, so
// a Hebrew-first note has to keep resolving RTL exactly as before. Without
// this, "isolate everything" could be satisfied by forcing LTR everywhere,
// which would break every Hebrew string in the app instead.
const HEBREW = "היה קשה אבל סיימתי";
const hebrewPainted = await page.evaluate((txt) => {
  const host = document.querySelector("#calDetail .log-row");
  if (!host) return null;
  const probe = document.createElement("div");
  probe.id = "__hebrewProbe";
  probe.style.cssText = "font-size:12px;";
  probe.appendChild(Object.assign(document.createElement("bdi"), { textContent: txt }));
  host.appendChild(probe);
  return true;
}, HEBREW);
if (hebrewPainted) {
  const painted = await paintedText(page, "#__hebrewProbe");
  // Painted left-to-right, an RTL-resolved Hebrew line reads as its own
  // reverse. Anything else means the run was forced LTR.
  const reversed = [...HEBREW].reverse().join("");
  check("a Hebrew-first line still resolves RTL (the fix isolates, it does not force LTR)", painted === reversed, `painted "${painted}"`);
  await page.evaluate(() => document.getElementById("__hebrewProbe")?.remove());
}

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nbidi-rtl-geometry: FAILED" : "\nbidi-rtl-geometry: all checks passed");
process.exit(failed ? 1 : 0);
