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

test("both formats agree there is no separate legal entity, and point to the coach as the real contact path", () => {
  for (const text of [privacyMd, privacyHtml]) {
    assert.match(text, /no separate (?:company|legal entity)/);
    assert.match(text, /your coach directly/);
  }
  for (const text of [termsMd, termsHtml]) {
    assert.match(text, /no separate company/);
    assert.match(text, /your coach directly/);
  }
});

test("both formats agree on the real, verifiable facts: 30-day deletion window, minimum age 13, and Supabase's ap-southeast-1 region", () => {
  for (const text of [privacyMd, privacyHtml]) {
    assert.match(text, /30.days/);
    assert.match(text, /under 13/);
    assert.match(text, /ap-southeast-1/);
  }
  for (const text of [termsMd, termsHtml]) {
    assert.match(text, /at least 13/);
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
