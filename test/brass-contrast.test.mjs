// COMM-361: light-theme --brass is used at 13-14px bold for PR/1RM stat
// values and (in Community) leaderboard/badge/priority text - real numeric
// data, not decoration - so it needs to clear the WCAG AA 4.5:1 floor for
// normal text against both surfaces it actually renders on (--surface and
// --bg). Computes the real relative-luminance contrast ratio from the
// tokens as shipped, so a future edit to any of these three tokens gets
// caught here instead of by eyeballing it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extractRootTokens() {
  const start = html.indexOf(":root{");
  const end = html.indexOf("}", start);
  const block = html.slice(start, end);
  const tokens = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[m[1]] = m[2];
  return tokens;
}

function luminance(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(hexA, hexB) {
  const [a, b] = [luminance(hexA), luminance(hexB)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

test("light-theme --brass clears 4.5:1 AA contrast against --surface and --bg", () => {
  const tokens = extractRootTokens();
  assert.ok(tokens.brass, "sanity check: --brass must be found in the light :root block");
  assert.ok(tokens.surface && tokens.bg, "sanity check: --surface and --bg must be found");

  const vsSurface = contrast(tokens.brass, tokens.surface);
  const vsBg = contrast(tokens.brass, tokens.bg);

  assert.ok(vsSurface >= 4.5, `--brass (${tokens.brass}) vs --surface (${tokens.surface}) is ${vsSurface.toFixed(2)}:1, below the 4.5:1 AA floor`);
  assert.ok(vsBg >= 4.5, `--brass (${tokens.brass}) vs --bg (${tokens.bg}) is ${vsBg.toFixed(2)}:1, below the 4.5:1 AA floor`);
});
