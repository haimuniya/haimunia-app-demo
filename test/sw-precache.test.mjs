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
  for (const asset of ['"./"', '"./index.html"', '"./app.js"', '"./theme-init.js"']) {
    assert.ok(requiredBlock.includes(asset), `${asset} must be in REQUIRED_ASSETS`);
  }
});

// COMM-330: cloud.js (700KB) and its community-only src/* dependencies were
// previously required, so a failed fetch of any of them blocked the entire
// offline app shell — even though app.js already guards every cloud.js
// integration point defensively (typeof checks, try/catch around bus.emit).
// They must degrade gracefully instead: the offline training log installs
// fully even if the community layer can't be fetched.
test("cloud.js and its community-only src/* dependencies are optional, not required", () => {
  const requiredBlock = sw.slice(sw.indexOf("const REQUIRED_ASSETS"), sw.indexOf("const OPTIONAL_ASSETS"));
  const optionalBlock = sw.slice(sw.indexOf("const OPTIONAL_ASSETS"), sw.indexOf("const ASSETS ="));
  for (const asset of ['"./cloud.js"', '"./src/eventbus.js"', '"./src/analytics.js"', '"./src/realtime.js"', '"./src/image.js"']) {
    assert.ok(!requiredBlock.includes(asset), `${asset} must not be in REQUIRED_ASSETS`);
    assert.ok(optionalBlock.includes(asset), `${asset} must be in OPTIONAL_ASSETS`);
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

// COMM-330: this used to require every src/*.js file index.html loads,
// which pulled the community-only modules (eventbus, analytics, realtime,
// image) into REQUIRED_ASSETS alongside the true core dependencies
// (constants, format, sanitize, db) app.js calls unconditionally. Split by
// which ones app.js actually cannot run without.
const CORE_SRC_SCRIPTS = ["./src/constants.js", "./src/format.js", "./src/sanitize.js", "./src/db.js"];

test("every core src/*.js file (constants, format, sanitize, db) is a required precache asset", () => {
  const requiredBlock = sw.slice(sw.indexOf("const REQUIRED_ASSETS"), sw.indexOf("const OPTIONAL_ASSETS"));
  const srcScripts = [...html.matchAll(/<script(?: defer)? src="(\.\/src\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcScripts.length > 0, "sanity check: index.html should load at least one ./src/*.js file to compare against");
  for (const src of CORE_SRC_SCRIPTS) {
    assert.ok(srcScripts.includes(src), `sanity check: index.html should still load ${src}`);
    assert.ok(requiredBlock.includes(`"${src}"`), `${src} is a core app.js dependency but missing from REQUIRED_ASSETS`);
  }
});

test("every src/*.js file index.html loads is precached, required or optional", () => {
  // A forgotten src/*.js file (in neither list) would silently break the
  // offline shell or the community layer with no install-time signal.
  const requiredBlock = sw.slice(sw.indexOf("const REQUIRED_ASSETS"), sw.indexOf("const OPTIONAL_ASSETS"));
  const optionalBlock = sw.slice(sw.indexOf("const OPTIONAL_ASSETS"), sw.indexOf("const ASSETS ="));
  const srcScripts = [...html.matchAll(/<script(?: defer)? src="(\.\/src\/[^"]+)"/g)].map((m) => m[1]);
  for (const src of srcScripts) {
    const inRequired = requiredBlock.includes(`"${src}"`);
    const inOptional = optionalBlock.includes(`"${src}"`);
    assert.ok(inRequired || inOptional, `${src} is loaded by index.html but missing from both REQUIRED_ASSETS and OPTIONAL_ASSETS`);
  }
});

test("optional assets still include every font, icon, and medal image — nothing lost in the split", () => {
  const optionalBlock = sw.slice(sw.indexOf("const OPTIONAL_ASSETS"), sw.indexOf("const ASSETS ="));
  for (const asset of ['"./manifest.json"', '"./vendor/supabase.js"', '"./assets/medal-gold.png"', '"./assets/fonts/rubik-400-hebrew.woff2"']) {
    assert.ok(optionalBlock.includes(asset), `${asset} must still be precached, just as optional`);
  }
});
