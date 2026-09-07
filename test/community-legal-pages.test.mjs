// COMM-335: PRIVACY.md/TERMS.md are the source-of-truth plain-text policies;
// privacy.html/terms.html are hand-maintained styled copies of the same
// content for in-app viewing (see the comment at the top of each .html file).
// Nothing generates one from the other, so the risk is silent drift between
// them. This suite guards the facts that matter most against that drift
// (no leftover placeholders, and the load-bearing facts — 30-day deletion,
// minimum age, hosting region, "contact your coach" — agree across all four
// files) rather than diffing full prose, which would be too brittle.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const privacyMd = fs.readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
const termsMd = fs.readFileSync(new URL("../TERMS.md", import.meta.url), "utf8");
const privacyHtml = fs.readFileSync(new URL("../privacy.html", import.meta.url), "utf8");
const termsHtml = fs.readFileSync(new URL("../terms.html", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

const bracketPlaceholder = /\[[A-Z][^\]]*\]/;

test("PRIVACY.md and TERMS.md have no leftover bracketed placeholders", () => {
  assert.doesNotMatch(privacyMd, bracketPlaceholder);
  assert.doesNotMatch(termsMd, bracketPlaceholder);
});

test("privacy.html and terms.html have no leftover bracketed placeholders either", () => {
  assert.doesNotMatch(privacyHtml, bracketPlaceholder);
  assert.doesNotMatch(termsHtml, bracketPlaceholder);
});

test("no draft/legal-review disclaimer language remains anywhere", () => {
  const draftLanguage = /this is a draft|requires legal review|not yet reviewed/i;
  for (const [name, text] of [
    ["PRIVACY.md", privacyMd],
    ["TERMS.md", termsMd],
    ["privacy.html", privacyHtml],
    ["terms.html", termsHtml],
  ]) {
    assert.doesNotMatch(text, draftLanguage, `${name} still contains draft/review language`);
  }
});

// All four documents became bilingual (Hebrew first, English second) on
// 2026-09-06: the club's members are Israeli and read Hebrew, so a notice
// they cannot read is not a notice. Every guarantee below is therefore
// asserted in BOTH languages - an English-only assertion would let the
// Hebrew half, which is the half members are actually given, silently lose
// the promise.
//
// Matching runs on a whitespace-normalised copy of each file. That is what
// lets one regex cover the Markdown (hard-wrapped at ~72 columns) and the
// HTML (wrapped differently, and indented inside <p>/<li>) without either a
// reflow or a re-indent breaking a test about legal content. The phrases
// themselves are still required verbatim.
const flat = (text) => text.replace(/\s+/g, " ");
const privacyMdFlat = flat(privacyMd);
const privacyHtmlFlat = flat(privacyHtml);
const termsMdFlat = flat(termsMd);
const termsHtmlFlat = flat(termsHtml);
const privacyBoth = [privacyMdFlat, privacyHtmlFlat];
const termsBoth = [termsMdFlat, termsHtmlFlat];
const allFour = [...privacyBoth, ...termsBoth];

test("all four documents carry both languages, with Hebrew as the members' text", () => {
  for (const text of allFour) {
    assert.match(text, /[֐-׿]/, "no Hebrew at all in a document members are meant to read");
    // Which language wins is itself a legal statement and has to be present
    // in both halves: the Hebrew sentence for the members it binds, and an
    // English one so an English-only reader knows theirs is the translation.
    assert.match(text, /הנוסח העברי הוא הקובע/);
    assert.match(text, /the Hebrew (?:text above )?governs for members/);
  }
});

test("both formats agree there is no separate legal entity, and point to the coach as the real contact path", () => {
  for (const text of privacyBoth) {
    assert.match(text, /no separate (?:company|legal entity)/);
    assert.match(text, /your coach directly/);
    assert.match(text, /אין חברה מאחורי האפליקציה/);
    assert.match(text, /למאמן\/ת שלכם ישירות/);
  }
  for (const text of termsBoth) {
    assert.match(text, /no separate company/);
    assert.match(text, /your coach directly/);
    assert.match(text, /אין חברה מאחורי האפליקציה/);
    assert.match(text, /למאמן\/ת שלכם ישירות/);
  }
});

test("both formats agree on the real, verifiable facts: 30-day deletion window, minimum age 13, and Supabase's ap-southeast-1 region", () => {
  for (const text of privacyBoth) {
    assert.match(text, /30.days/);
    assert.match(text, /under 13/);
    assert.match(text, /ap-southeast-1/);
    assert.match(text, /30 ימים/);
    assert.match(text, /מתחת לגיל 13/);
  }
  for (const text of termsBoth) {
    assert.match(text, /at least 13/);
    assert.match(text, /בני 13 לפחות/);
  }
});

// The 2026-09-06 correction. The policy used to describe the coach-facing
// engagement signal as coming from "your class attendance history (not what
// you view or click in the app)" - the exact inverse of the truth twice
// over: the app has no class-attendance source at all (that is Arbox's, and
// out of scope for this product), and the "not active"/"new members" coach
// lists are built on activity_pings, whose only writer is pingActivity() in
// cloud.js and which records "this member opened the app today".
//
// It also declared two collections that do not exist: class attendance and
// upcoming bookings "tied to your account", and a birthday toggle
// (202608280003 deliberately created no birth-date column anywhere).
//
// These assertions exist so that neither the false denial nor the
// over-declaration can come back by an edit that is not thinking about it.
test("the policy does not re-declare data the app never collects, in either language", () => {
  for (const text of privacyBoth) {
    assert.doesNotMatch(text, /your class attendance history/i);
    assert.doesNotMatch(text, /Class attendance and upcoming bookings/i);
    assert.doesNotMatch(text, /whether your birthday is shown/i);
    assert.doesNotMatch(text, /האם יום ההולדת שלכם מוצג/);
  }
});

test("the policy states what a training day actually is - a logged workout, not a class check-in - in both languages", () => {
  for (const text of privacyBoth) {
    assert.match(text, /"יום אימון" באפליקציה הוא יום שרשמתם בו אימון ביומן/);
    assert.match(text, /לא מחוברת למערכת הרישום או הצ'ק־אין של המועדון/);
    assert.match(text, /a day you logged a workout/);
    assert.match(text, /not connected to the club's class booking or check-in system/);
  }
});

test("the policy keeps the database-enforced promise that coaches see rates, not a log of training days", () => {
  // 202609060013 narrowed attendance_log_staff_select from
  // `has_perm('community.analytics.view') OR is_staff()` down to the
  // permission alone, precisely so this sentence is true in the schema and
  // not only on paper. If the schema is ever widened back, this promise has
  // to be revisited rather than quietly left standing.
  for (const text of privacyBoth) {
    assert.match(text, /הקצב שלכם, לא רשימת האימונים שלכם/);
    assert.match(text, /your rate, not a list of your workouts/);
    assert.match(text, /Reading another member's day-by-day rows requires the admin\/analytics permission/);
  }
});

test("the policy separates the app-open measure from training, and says which coach surfaces come from it", () => {
  for (const text of privacyBoth) {
    assert.match(text, /ימי פתיחת אפליקציה — לא אימונים, לא נוכחות בשיעור ולא פרסום בפיד/);
    assert.match(text, /count days the app was opened — not workouts, not class attendance, and not posting to the feed/);
  }
});

test("app.js's legal links point at the styled HTML pages, not the raw markdown", () => {
  assert.match(appJs, /href="\.\/privacy\.html"/);
  assert.match(appJs, /href="\.\/terms\.html"/);
  assert.doesNotMatch(appJs, /href="\.\/PRIVACY\.md"/);
  assert.doesNotMatch(appJs, /href="\.\/TERMS\.md"/);
});

test("privacy.html and terms.html load theme-init.js and stay RTL/Hebrew-shelled like the rest of the app", () => {
  for (const html of [privacyHtml, termsHtml]) {
    assert.match(html, /<html lang="he" dir="rtl">/);
    assert.match(html, /<script src="\.\/theme-init\.js"><\/script>/);
  }
});
