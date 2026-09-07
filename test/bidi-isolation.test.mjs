// bidiText/bidiHtml: the run-level half of the RTL bidi defect.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The bidi algorithm never touches the
// DOM, so no unit test can see a reordering bug: the text node still reads
// "3×5 @ 60" in logical order after the engine has decided to paint it as
// "60 @ 5×3". Painted order is asserted where it is visible, in Chromium, by
// scripts/browser-check/bidi-rtl-geometry.mjs.
//
// What IS unit-testable, and is what this file locks down, is the thing the
// geometry check has to take on faith: the STRUCTURE the helper emits. Where
// the run boundaries fall, which lines are left alone, that no isolate ever
// straddles a tag, and - the one that has nothing to do with bidi at all -
// that every character of untrusted input still leaves through esc().
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";

const helpersSrc = fs.readFileSync(new URL("../src/shared/safe-helpers.js", import.meta.url), "utf8");
const appSrc = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const cloudSrc = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const g = {};
new Function("window", helpersSrc)(g);
const { bidiText, bidiHtml, esc } = g.BoxLogSafe;

// Undo esc() and drop the isolation markup, to compare against what was typed.
const unesc = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const stripped = (html) => unesc(html.replace(/<\/?bdi(?: dir="ltr")?>/g, ""));

// ---------------------------------------------------------------------------
// The promotion. This is the half that keeps the rest of the file honest: the
// assertions below describe src/shared/safe-helpers.js, and they only describe
// the app if the app is actually calling it.
// ---------------------------------------------------------------------------

test("there is exactly one definition: app.js and cloud.js bind the helper, they do not re-declare it", () => {
  // The drift failure mode is silent. One copy quietly stops isolating and
  // nobody sees a broken string — only a plausible, valid-looking, different
  // workout. A source-level assertion is the only thing that catches a fourth
  // copy being pasted back in later.
  for (const [name, src] of [["app.js", appSrc], ["cloud.js", cloudSrc]]) {
    assert.doesNotMatch(src, /^\s*function bidiText\s*\(/m, `${name} must not re-declare bidiText`);
    assert.doesNotMatch(src, /^\s*function bidiHtml\s*\(/m, `${name} must not re-declare bidiHtml`);
  }
  assert.match(appSrc, /const bidiText = SAFE\.bidiText;/);
  assert.match(cloudSrc, /const bidiText = window\.BoxLogSafe\.bidiText;/);
  assert.match(cloudSrc, /const bidiHtml = window\.BoxLogSafe\.bidiHtml;/);
});

test("the booted app really has the shared module under it, behaving as asserted above", async () => {
  const window = await bootApp();
  const S = window.BoxLogSafe;
  assert.equal(typeof S.bidiText, "function", "the booted app must expose the promoted helper");
  assert.equal(typeof S.bidiHtml, "function");
  // Same behaviour inside the booted app as in the standalone module — this is
  // what app.js's `const bidiText = SAFE.bidiText` resolves to at runtime.
  assert.equal(S.bidiText("עשיתי 3×5 @ 60 היום"), '<bdi>עשיתי <bdi dir="ltr">3×5 @ 60</bdi> היום</bdi>');
  //
  // WHY THE BINDING ITSELF IS ASSERTED AT THE SOURCE LEVEL ABOVE AND NOT HERE.
  // The obvious check — window.eval("bidiText") === S.bidiText, the way
  // test/shared-safe-helpers.test.mjs probes esc/bag/cleanId — cannot work for
  // a `const`, and the reason is a jsdom artifact rather than anything about
  // the app. boot.mjs evaluates the concatenated sources with window.eval();
  // in eval code, function DECLARATIONS land in the global var environment and
  // stay reachable, while top-level `let`/`const` go into a declarative
  // environment that is discarded when the eval returns. So `allWodMovementTags`
  // probes fine and `barWeight`, `LIMITS`, `SAFE` and `bidiText` all raise
  // ReferenceError — none of which is true of the real page, where classic
  // <script> tags share one global lexical environment. app.js's own functions
  // close over that scope either way, which is why every other test in the
  // suite exercises bidiText through the app perfectly happily.
  //
  // The runtime binding is therefore proven where it is actually observable:
  // scripts/browser-check/bidi-rtl-geometry.mjs drives the WOD-history search
  // in real Chromium and asserts the rendered node contains the shared
  // helper's own isolate. That check fails if app.js goes back to a local copy.
});

test("VERSION was bumped for the added helpers, as the module's contract requires", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../src/shared/package.json", import.meta.url), "utf8"));
  const declared = helpersSrc.match(/const VERSION = "([^"]+)";/)[1];
  assert.equal(pkg.version, declared, "package.json must track the VERSION constant");
  // Adding a helper is a MINOR bump under src/shared/README.md's protocol:
  // additive, so a consumer repo still on the previous version does not go
  // out of contract by staying there.
  const [major, minor] = declared.split(".").map(Number);
  assert.ok(major === 1 && minor >= 1, `expected at least 1.1.x for the added bidi helpers, got ${declared}`);
});

// ---------------------------------------------------------------------------
// The property that outranks every bidi property here.
// ---------------------------------------------------------------------------

test("escaping is untouched: every character of untrusted input still leaves through esc()", () => {
  const hostile = [
    '<img src=x onerror="alert(1)">',
    "בדיקה <script>alert(1)</script> סוף",
    `אמר 'שלום' & "להתראות" <b>3×5 @ 60</b>`,
    "&lt;already escaped&gt;",
    "'\"&<>",
  ];
  for (const raw of hostile) {
    const out = bidiText(raw);
    // No markup survives except the isolation this helper itself adds.
    assert.doesNotMatch(
      out.replace(/<\/?bdi(?: dir="ltr")?>/g, ""),
      /[<>]/,
      `bidiText must not leave a raw angle bracket in the output for ${JSON.stringify(raw)}`,
    );
    // And it is lossless: the exact input comes back out.
    assert.equal(stripped(out), raw, "the isolation must not add, drop or reorder a character");
  }
});

test("run boundaries are computed BEFORE escaping, so an escape is never mistaken for a word", () => {
  // Post-escape, `ק"ג` reads as `ק&quot;ג` and a character-by-character run
  // finder sees the Latin word `quot` sitting inside a Hebrew word. If the
  // boundaries were found on the escaped string this would isolate it.
  const out = bidiText('הרמתי 100 ק"ג');
  assert.match(out, /ק&quot;ג/, "the quote must still be escaped");
  assert.doesNotMatch(out, /<bdi dir="ltr">[^<]*quot/, "an HTML entity must never be isolated as if it were prose");
});

// ---------------------------------------------------------------------------
// The run rule.
// ---------------------------------------------------------------------------

test("a neutral BETWEEN two anchors is interior - this is the whole defect", () => {
  // `×` and `@` resolve to the paragraph's RTL direction (UBA N1 has European
  // numbers act as R for adjacent neutrals), splitting one logical run into
  // three number runs laid out right to left: `60 @ 5×3`.
  assert.equal(bidiText("עשיתי 3×5 @ 60 היום"), '<bdi>עשיתי <bdi dir="ltr">3×5 @ 60</bdi> היום</bdi>');
});

test("a neutral between Hebrew and an anchor stays OUTSIDE the run", () => {
  // The parentheses belong to the Hebrew paragraph. The bidi algorithm's own
  // bracket-pair rule (N0) plus mirroring (L4) already paint them correctly -
  // measured, see the geometry check. Swallowing them would be over-isolation.
  assert.equal(bidiText("עם תווית בלוק (A/B/C/D)"), '<bdi>עם תווית בלוק (<bdi dir="ltr">A/B/C/D</bdi>)</bdi>');
});

test("a sentence-final '.' is after the last anchor, so it stays outside too", () => {
  assert.equal(
    bidiText("נשבר לי ב-3×5 @ 60. המשך מחר"),
    '<bdi>נשבר לי ב-<bdi dir="ltr">3×5 @ 60</bdi>. המשך מחר</bdi>',
  );
});

test("the run neither swallows the Hebrew word before it nor the one after it", () => {
  const out = bidiText("עשיתי 3×5 @ 60 היום");
  const run = out.match(/<bdi dir="ltr">([^<]*)<\/bdi>/)[1];
  assert.equal(run, "3×5 @ 60");
  assert.doesNotMatch(run, /[֐-ࣿ]/, "a run must contain no RTL character at all - that is what makes forcing it LTR safe");
});

test("a stretch of CONTIGUOUS anchors is left alone: it cannot reorder against itself", () => {
  // Over an odd (RTL) embedding level UBA I2 raises both L and EN by one, so
  // `100` is a single directional run. Isolating it would be markup for
  // nothing.
  assert.equal(bidiText("הרמתי 100 קילו"), "<bdi>הרמתי 100 קילו</bdi>");
  assert.equal(bidiText("עשיתי Thrusters היום"), "<bdi>עשיתי Thrusters היום</bdi>");
  // Two single-anchor runs separated by Hebrew: each already sits where it
  // was typed, so neither is isolated.
  assert.equal(bidiText("בלוק A ואז בלוק B"), "<bdi>בלוק A ואז בלוק B</bdi>");
});

test("every maximal run in a line is isolated, not just the first", () => {
  const out = bidiText("בשעה 7:30 - 8:30 ואז 3×5 @ 60");
  assert.equal(out, '<bdi>בשעה <bdi dir="ltr">7:30 - 8:30</bdi> ואז <bdi dir="ltr">3×5 @ 60</bdi></bdi>');
});

// ---------------------------------------------------------------------------
// The gate. Over-isolating is the OTHER bug, and this is what stops it.
// ---------------------------------------------------------------------------

test("an LTR-first line is NOT run-isolated - isolating it re-creates the bug that was already fixed", () => {
  // <bdi> is dir="auto" and HTML's first-strong scan SKIPS characters inside
  // an isolate. Isolating the leading `21-15-9 Thrusters...` run would hide
  // it from that scan, hand the line's base direction to the `ק"ג` further
  // along, and paint `.ג"ק 21-15-9 Thrusters + Pull-ups. Rx 43/30` - the
  // exact pre-fix symptom, with the unit stranded from its number.
  const reported = '21-15-9 Thrusters + Pull-ups. Rx 43/30 ק"ג.';
  assert.equal(bidiText(reported), `<bdi>${esc(reported)}</bdi>`, "an LTR-first line keeps the shipped line-level treatment, unchanged");
  assert.doesNotMatch(bidiText(reported), /dir="ltr"/);
});

test("an all-Hebrew line is untouched, and a line with no strong character is left to <bdi>", () => {
  assert.equal(bidiText("היה קשה אבל סיימתי"), "<bdi>היה קשה אבל סיימתי</bdi>");
  // No strong character anywhere: <bdi>'s own dir="auto" already resolves
  // this LTR, which is right. Nothing to add.
  assert.equal(bidiText("3×5 @ 60"), "<bdi>3×5 @ 60</bdi>");
});

test("the first strong character of a processed line is never moved inside an isolate", () => {
  // The invariant that makes the gate a proof rather than a precaution: if a
  // line's first strong character is RTL then no strong LTR character
  // precedes it, so hiding LTR characters inside isolates cannot move it.
  const lines = ["עשיתי 3×5 @ 60 היום", "עם תווית בלוק (A/B/C/D)", "בשעה 7:30 - 8:30 בבוקר", 'הרמתי 43/30 ק"ג בסוף'];
  for (const line of lines) {
    const out = bidiText(line);
    // Everything before the first isolate must still contain the Hebrew that
    // the engine will resolve the line's direction from.
    const beforeIsolate = out.split('<bdi dir="ltr">')[0];
    assert.match(beforeIsolate, /[֐-׿]/, `the line's own first strong character must stay outside every isolate: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// Line handling, preserved from the shipped fix.
// ---------------------------------------------------------------------------

test("isolation is per LINE, and rejoining reproduces the original text exactly", () => {
  const out = bidiText("שורה ראשונה\n21-15-9 Thrusters\nעשיתי 3×5 @ 60");
  assert.equal(out.split("\n").length, 3, "a pre-wrap surface must still break exactly where it did");
  assert.equal(stripped(out), "שורה ראשונה\n21-15-9 Thrusters\nעשיתי 3×5 @ 60");
  // Each line resolves from its OWN first strong character: line 2 is LTR and
  // left alone, line 3 is RTL and gets its run isolated.
  const [a, b, c] = out.split("\n");
  assert.equal(a, "<bdi>שורה ראשונה</bdi>");
  assert.equal(b, "<bdi>21-15-9 Thrusters</bdi>");
  assert.equal(c, '<bdi>עשיתי <bdi dir="ltr">3×5 @ 60</bdi></bdi>');
});

test("null/undefined are the empty string, as before", () => {
  assert.equal(bidiText(null), "<bdi></bdi>");
  assert.equal(bidiText(undefined), "<bdi></bdi>");
  assert.equal(bidiHtml(null), "<bdi></bdi>");
});

// ---------------------------------------------------------------------------
// bidiHtml: the already-escaped variant.
// ---------------------------------------------------------------------------

test("bidiHtml isolates runs without ever straddling a tag", () => {
  const input = 'תודה <button class="mention" data-id="x">@noam</button> על 3×5 @ 60';
  const out = bidiHtml(input);
  assert.equal(out, '<bdi>תודה <button class="mention" data-id="x">@noam</button> על <bdi dir="ltr">3×5 @ 60</bdi></bdi>');
  // Well-formed by construction: a tag BREAKS a run, so an isolate can never
  // contain half of one. Assert it directly rather than trusting the sample.
  for (const run of out.match(/<bdi dir="ltr">[\s\S]*?<\/bdi>/g) || []) {
    assert.doesNotMatch(run.slice('<bdi dir="ltr">'.length, -"</bdi>".length), /[<>]/, "no isolate may contain markup");
  }
});

test("bidiHtml treats an entity as one neutral character, not as the Latin word inside it", () => {
  // esc() turns `"` into `&quot;`. Character by character that reads as the
  // word `quot`, and unhandled it would isolate a Hebrew word's own escape.
  const out = bidiHtml("ק&quot;ג בלבד");
  assert.equal(out, "<bdi>ק&quot;ג בלבד</bdi>");
  assert.doesNotMatch(out, /dir="ltr"/);
  // And the entity is still passed through untouched when a run IS isolated
  // elsewhere in the same string.
  assert.equal(bidiHtml("הרמתי 3×5 @ 60 ק&quot;ג"), '<bdi>הרמתי <bdi dir="ltr">3×5 @ 60</bdi> ק&quot;ג</bdi>');
});

test("bidiHtml never alters the HTML it was handed beyond adding isolates", () => {
  const inputs = [
    'תודה <button class="mention" data-id="a-1">@noam</button> על הכל',
    "Rx 43/30 ק&quot;ג. נשבר לי",
    "שורה <b>מודגשת</b> עם 3×5 @ 60",
    "",
  ];
  for (const input of inputs) {
    const out = bidiHtml(input);
    assert.equal(out.replace(/<bdi(?: dir="ltr")?>/g, "").replace(/<\/bdi>/g, ""), input);
  }
});

// ---------------------------------------------------------------------------
// Adversarial input.
// ---------------------------------------------------------------------------

test("a stray bidi control character breaks a run instead of being swallowed by it", () => {
  // A forced-LTR isolate holding half of an unbalanced RLI/PDI pair is a worse
  // string than the one we started with.
  const out = bidiText("עשיתי 3⁧×5 @ 60 היום");
  for (const run of out.match(/<bdi dir="ltr">[\s\S]*?<\/bdi>/g) || []) {
    assert.doesNotMatch(run, /[‎-‏‪-‮⁦-⁩]/, "a run must never contain a bidi formatting control");
  }
});

test("pathological input terminates and stays lossless", () => {
  const inputs = [
    "",
    "\n\n\n",
    "×".repeat(500),
    ("עברית 3×5 @ 60 ".repeat(200)),
    "⁩⁦‮",
    "0".repeat(1000),
  ];
  for (const input of inputs) {
    assert.equal(stripped(bidiText(input)), input, `lossless for ${JSON.stringify(input.slice(0, 24))}…`);
  }
});
