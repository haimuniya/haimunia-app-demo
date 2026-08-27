// Audit finding (DevOps): the service worker's install handler used to
// treat every precached asset the same way — a miss on any one of them,
// including app.js itself, was silently swallowed and install proceeded
// anyway. That's backwards for the app shell's own files: a missing
// app.js should fail install outright (the old service worker stays in
// control) rather than activate a broken shell. This locks in the split
// between required (strict) and optional (best-effort) precaching.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("the app shell's own core files are required precache assets", () => {
  const requiredBlock = sw.slice(sw.indexOf("const REQUIRED_ASSETS"), sw.indexOf("const OPTIONAL_ASSETS"));
  for (const asset of ['"./"', '"./index.html"', '"./app.js"', '"./theme-init.js"', '"./cloud.js"']) {
    assert.ok(requiredBlock.includes(asset), `${asset} must be in REQUIRED_ASSETS`);
  }
});

test("required assets are cached with a strict Promise.all (a miss fails install), optional ones with Promise.allSettled", () => {
  const installHandler = sw.slice(sw.indexOf('self.addEventListener("install"'), sw.indexOf('self.addEventListener("activate"'));
  assert.match(installHandler, /await Promise\.all\(REQUIRED_ASSETS\.map/);
  assert.match(installHandler, /await Promise\.allSettled\(\s*\n\s*OPTIONAL_ASSETS\.map/);
  // Required must NOT be wrapped in a per-item .catch() the way optional
  // is — that's exactly what made a miss non-fatal before.
  const requiredLine = installHandler.slice(installHandler.indexOf("Promise.all(REQUIRED_ASSETS"), installHandler.indexOf("Promise.allSettled"));
  assert.doesNotMatch(requiredLine, /\.catch\(/);
});

test("every src/*.js file index.html loads is a required precache asset", () => {
  // app.js was split into src/*.js files (see src/db.js), loaded as their
  // own <script> tags - a forgotten one here breaks the offline shell
  // silently, same failure mode as a forgotten app.js. Scoped to src/
  // rather than every <script> tag: cloud.js/vendor/supabase.js/
  // cloud-config.js are deliberately handled differently (optional or
  // fetched fresh - see the tests above and the cloud-config.js special
  // case in the fetch handler), so a blanket rule would false-positive
  // on those, not just catch a real miss.
  const requiredBlock = sw.slice(sw.indexOf("const REQUIRED_ASSETS"), sw.indexOf("const OPTIONAL_ASSETS"));
  const srcScripts = [...html.matchAll(/<script src="(\.\/src\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcScripts.length > 0, "sanity check: index.html should load at least one ./src/*.js file to compare against");
  for (const src of srcScripts) {
    assert.ok(requiredBlock.includes(`"${src}"`), `${src} is loaded by index.html but missing from REQUIRED_ASSETS`);
  }
});

test("optional assets still include every font, icon, and medal image — nothing lost in the split", () => {
  const optionalBlock = sw.slice(sw.indexOf("const OPTIONAL_ASSETS"), sw.indexOf("const ASSETS ="));
  for (const asset of ['"./manifest.json"', '"./vendor/supabase.js"', '"./assets/medal-gold.png"', '"./assets/fonts/rubik-400-hebrew.woff2"']) {
    assert.ok(optionalBlock.includes(asset), `${asset} must still be precached, just as optional`);
  }
});
