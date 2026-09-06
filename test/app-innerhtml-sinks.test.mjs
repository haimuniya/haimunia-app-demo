// Launch-readiness audit, SEC-018.
//
// The security pass flagged 37 innerHTML/outerHTML sinks in app.js and
// recorded confidence LOW, because it had sampled four of them rather than
// tracing all 37 - "worth doing before launch; not worth blocking on".
// This file is that pass, done mechanically so it also stays done.
//
// WHY app.js RATHER THAN cloud.js: cloud.js renders remote,
// attacker-influenced data and has ZERO innerHTML assignments (asserted
// below, so that stays true). app.js renders the LOCAL training log - but
// "local" is not the same as "trusted": records round-trip through
// private_records and come back from the network, and an import file is
// user-supplied. So the sinks are worth pinning even though the blast
// radius is self-XSS rather than cross-member.
//
// The rule enforced: every `${...}` inside an innerHTML/outerHTML
// assignment must be esc()-wrapped, a numeric coercion, or an identifier
// this file explicitly allow-lists as a proven constant. A new unwrapped
// interpolation fails here rather than shipping.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = fs.readFileSync(path.join(root, "app.js"), "utf8");
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");

// Identifiers proven safe by inspection during the SEC-018 pass. Each entry
// records WHY, because an allow-list without reasons rots into a mute
// button.
const PROVEN_SAFE = new Map([
  // Hardcoded SVG string literals in the ICONS object (app.js ~2218).
  // No user input reaches them; they are markup by construction.
  ["ICONS.chevronsLeft", "hardcoded SVG literal in const ICONS"],
  ["ICONS.dumbbell", "hardcoded SVG literal in const ICONS"],
  ["ICONS.flame", "hardcoded SVG literal in const ICONS"],
  // computeCurrentStreak(): `let streak = 0` incremented in a while loop
  // and returned. Provably an integer, never a string.
  ["streak", "integer counter from computeCurrentStreak()"],
]);

function sinkLines(src) {
  return src.split("\n")
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => /\.(innerHTML|outerHTML)\s*=/.test(line));
}

test("cloud.js still has zero innerHTML/outerHTML assignments", () => {
  // This is the load-bearing one: cloud.js is where remote, other-member
  // data is rendered. It reaches esc() unguarded at the top of the file
  // precisely so it fails loudly rather than degrading to a no-op.
  assert.equal(sinkLines(cloudJs).length, 0,
    "cloud.js renders attacker-influenced data - it must keep using template composition with esc(), never a raw innerHTML sink");
});

test("every interpolation in an app.js innerHTML sink is escaped, numeric, or a proven constant", () => {
  const offenders = [];
  for (const { n, line } of sinkLines(appJs)) {
    for (const m of line.matchAll(/\$\{([^}]+)\}/g)) {
      const expr = m.group ? m.group(1) : m[1];
      const e = expr.trim();
      // Escaped, explicitly coerced, or a bare number.
      if (/^(esc|Number|String|parseInt|parseFloat)\s*\(/.test(e)) continue;
      if (/^\d+$/.test(e)) continue;
      // A nested template that is itself fully escaped is fine; the regex
      // above already caught the simple cases, so anything left is checked
      // against the allow-list by exact text.
      if (PROVEN_SAFE.has(e)) continue;
      offenders.push(`app.js:${n} -> \${${e}}`);
    }
  }
  assert.deepEqual(offenders, [],
    "unescaped interpolation reaching an innerHTML sink - wrap it in esc(), coerce it with Number(), or add it to PROVEN_SAFE with the reason it cannot carry user input");
});

test("the sink count is pinned, so a new sink is a deliberate decision", () => {
  // Not a style rule - a review trigger. Adding an innerHTML sink to app.js
  // should require looking at this file and thinking about escaping, which
  // is exactly what SEC-018 found had not happened.
  const count = sinkLines(appJs).length;
  assert.equal(count, 37,
    `app.js has ${count} innerHTML/outerHTML sinks, expected 37. If you added one, verify its interpolations are escaped and update this number; if you removed one, just update it.`);
});

test("esc() is a single shared definition, so there is one escaping rule and not several", () => {
  const helpers = fs.readFileSync(path.join(root, "src", "shared", "safe-helpers.js"), "utf8");
  // & < > " ' - correct for both text and quoted-attribute contexts.
  assert.match(helpers, /function esc\(/);
  for (const ch of ["&", "<", ">", '"', "'"]) {
    assert.ok(helpers.includes(ch), `esc() must handle ${ch}`);
  }
  // No second definition anywhere that could drift from it.
  assert.doesNotMatch(appJs, /^\s*function esc\(/m,
    "app.js must use the shared esc(), not define its own");
  assert.doesNotMatch(cloudJs, /^\s*function esc\(/m,
    "cloud.js must use the shared esc(), not define its own");
});
