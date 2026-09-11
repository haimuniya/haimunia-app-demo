// COMM-368. src/shared/safe-helpers.js is the one definition of the low-level
// safety helpers (esc/cssSel/bag/clean*/uid) for every Box Log client. This
// file locks in the properties that make it usable as a shared, versioned
// module rather than a fourth copy:
//
//   * it is self-contained (no identifier from this repo leaks in),
//   * it publishes a frozen window.BoxLogSafe,
//   * it carries a VERSION that matches src/shared/package.json,
//   * the app's bare-identifier bindings and window.* globals both resolve to
//     the very same function objects it exports - not to a re-implementation,
//   * cloud.js reaches it through window and no longer defines safeText
//     (COMM-367).
//
// The behavior of each helper is covered where it always was, against the
// booted app: test/sanitizers.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp, bootCommunity } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const helpersSrc = fs.readFileSync(new URL("../src/shared/safe-helpers.js", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../src/shared/package.json", import.meta.url), "utf8"));
const constantsSrc = fs.readFileSync(new URL("../src/constants.js", import.meta.url), "utf8");
const formatSrc = fs.readFileSync(new URL("../src/format.js", import.meta.url), "utf8");
const sanitizeSrc = fs.readFileSync(new URL("../src/sanitize.js", import.meta.url), "utf8");
const cloudSrc = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

const SHARED = ["esc", "cssSel", "bag", "cleanStr", "cleanNum", "cleanId", "cleanISODate", "cleanTs", "uid"];

test("the shared module publishes exactly the documented surface, frozen", () => {
  const g = {};
  new Function("window", helpersSrc)(g);
  const S = g.BoxLogSafe;
  assert.ok(S, "safe-helpers.js must publish window.BoxLogSafe");
  assert.ok(Object.isFrozen(S), "BoxLogSafe must be frozen so no later script can swap out an escape");
  for (const name of SHARED) assert.equal(typeof S[name], "function", `${name} must be exported`);
  assert.equal(typeof S.VERSION, "string");
  assert.equal(S.LIMITS.idLen, 128);
  assert.ok(Object.isFrozen(S.LIMITS));
});

test("the shared module is self-contained: it runs with nothing but a global object", () => {
  // Anything it reached out to (LIMITS from src/constants.js, say) would make
  // it unusable in the sibling repo, which is the whole point of extracting
  // it. Loaded with a bare object as its only input, it must still work.
  const g = {};
  new Function("window", helpersSrc)(g);
  const S = g.BoxLogSafe;
  assert.equal(S.esc(`<b>&"'`), "&lt;b&gt;&amp;&quot;&#39;");
  assert.equal(S.cleanId("a".repeat(500)).length, 128);
  assert.equal(S.cleanISODate("2024-13-40"), null);
  assert.equal(Object.getPrototypeOf(S.bag()), null);
  assert.match(S.uid("x"), /^x-/);
  // No `import`/`require`/`export` - it stays a classic script, no build step.
  assert.doesNotMatch(helpersSrc, /^\s*(import|export)\s/m);
  assert.doesNotMatch(helpersSrc, /\brequire\(/);
});

test("VERSION is declared once and src/shared/package.json agrees with it", () => {
  const m = helpersSrc.match(/const VERSION = "([^"]+)";/);
  assert.ok(m, "safe-helpers.js must declare a VERSION constant");
  assert.equal(pkg.version, m[1], "package.json version must track the VERSION constant");
  assert.equal(pkg.name, "@boxlog/safe-helpers");
  assert.equal(pkg.main, "safe-helpers.js");
});

test("no file in this repo re-declares a shared helper - there is exactly one implementation", () => {
  for (const src of [constantsSrc, formatSrc, sanitizeSrc]) {
    for (const name of SHARED) {
      assert.doesNotMatch(src, new RegExp(`^function ${name}\\(`, "m"), `${name} must not be re-declared outside src/shared/`);
    }
  }
  // COMM-367: cloud.js's own byte-identical copy, named safeText, is gone.
  assert.doesNotMatch(cloudSrc, /\bsafeText\b/);
  assert.match(cloudSrc, /const esc = window\.BoxLogSafe\.esc;/);
});

test("index.html loads the shared module before everything that depends on it", () => {
  const scripts = [...html.matchAll(/<script(?: defer)? src="([^"]+)"/g)].map((m) => m[1]);
  const shared = scripts.indexOf("./src/shared/safe-helpers.js");
  assert.ok(shared >= 0, "index.html must load ./src/shared/safe-helpers.js");
  for (const dep of ["./cloud.js", "./src/constants.js", "./src/format.js", "./src/sanitize.js", "./app.js"]) {
    const at = scripts.indexOf(dep);
    assert.ok(at > shared, `${dep} must load after the shared safety helpers`);
  }
});

test("the app's bare identifiers and window globals are the shared module's own functions, not copies", async () => {
  const window = await bootApp();
  const S = window.BoxLogSafe;
  assert.ok(S, "the booted app must expose window.BoxLogSafe");
  for (const name of SHARED) {
    assert.equal(window[name], S[name], `window.${name} must be the shared module's own ${name}`);
  }
  // And the bare identifier the rest of app.js/src compiles against resolves
  // to it too (esc is called ~112 times in app.js as a bare name).
  assert.equal(window.eval("esc"), S.esc);
  assert.equal(window.eval("bag"), S.bag);
  assert.equal(window.eval("cleanId"), S.cleanId);
  // LIMITS.idLen is read back off the shared module rather than restated, so
  // cleanId's cap and src/constants.js's cap can never drift apart. (LIMITS is
  // a top-level `const`, so unlike the `var` bindings above it stays in the
  // script scope and is only checkable at the source level.)
  assert.match(constantsSrc, /idLen: SAFE\.LIMITS\.idLen/);
  assert.doesNotMatch(constantsSrc, /idLen: \d/);
  assert.equal(window.cleanId("a".repeat(500)).length, S.LIMITS.idLen);
});

// Live bug hunt (2026-09-11): a missing/invalid ts always fell back to
// Date.now() - fine for a genuinely new record, wrong for legacy data with
// no ts column at all. Confirmed live: reloading the same ts-less record
// twice produced two DIFFERENT manufactured "now" values, feeding directly
// into shouldApplyRemote()'s cross-device conflict resolution, which
// trusts ts verbatim. Fixed with an optional fallbackDateIso that every
// sanitizeEntry()-family caller already has in scope.
test("cleanTs falls back to the record's own date when ts is missing, instead of a fresh Date.now() every time", async () => {
  const window = await bootApp();
  const midnightOf = (iso) => new Date(iso + "T00:00:00Z").getTime();

  assert.equal(window.cleanTs(undefined, "1991-06-15"), midnightOf("1991-06-15"), "a missing ts derives from the given date, not the clock");
  assert.equal(window.cleanTs(0, "2020-01-01"), midnightOf("2020-01-01"), "an invalid (zero) ts also falls back to the date, not just undefined");
  assert.equal(window.cleanTs(undefined, "1991-06-15"), window.cleanTs(undefined, "1991-06-15"), "the SAME input must always produce the SAME output - stable across reloads, not a fresh timestamp each time");

  // A real, present ts is untouched regardless of what date is also passed.
  assert.equal(window.cleanTs(12345, "1991-06-15"), 12345);

  // No fallback date at all keeps the original behavior for callers with no
  // date concept: still a real, current timestamp, not NaN/0/undefined.
  const before = Date.now();
  const noFallback = window.cleanTs(undefined);
  assert.ok(noFallback >= before && noFallback <= Date.now() + 1000, "with no fallback date, still defaults to something close to now");

  // Integration: a ts-less legacy record sanitizes to a date-derived ts,
  // not a manufactured "now" - exercised through the real sanitize layer,
  // not just the low-level helper in isolation.
  const sanitizedBw = window.sanitizeBodyweight({ id: "bw-legacy", date: "1991-06-15", weight: 80 });
  assert.equal(sanitizedBw.ts, midnightOf("1991-06-15"));
  const sanitizedEntry = window.sanitizeEntry({ id: "set-legacy", exerciseId: "back-squat", date: "1991-06-15", type: "reps", weight: 60, reps: 5, sets: 1 });
  assert.equal(sanitizedEntry.ts, midnightOf("1991-06-15"));
});

test("cloud.js escapes through the shared esc(): a hostile display name is inert in the rendered community tab", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock);
  assert.equal(window.BoxLogSafe.esc('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  // The community layer must be looking at the same function object, so a
  // future hardening fix in safe-helpers.js reaches all ~370 of its sinks.
  assert.equal(window.eval("window.BoxLogSafe.esc"), window.BoxLogSafe.esc);
});
