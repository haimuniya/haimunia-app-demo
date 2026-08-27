// This app and the real production app (haimuniya.github.io/haimunia-app/)
// are served from the same GitHub Pages origin, just different paths —
// browser storage (IndexedDB, localStorage, sessionStorage, Cache Storage)
// is scoped per-origin, not per-path. Before this fix, this demo used the
// production app's exact IndexedDB name ("box-log-db") and localStorage
// key prefix ("haimunia:") — a real member's local training data and this
// demo's community/social code shared one database. Locking in that every
// identifier here is demo-specific, so this can't silently regress back to
// colliding with production.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bootApp } from "./helpers/boot.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("the IndexedDB database is named distinctly from the production app's \"box-log-db\"", async () => {
  const window = await bootApp();
  await window.addMovement("Test Isolation Squat", "Squat");
  window.applyFieldValue("step", "weight", 40);
  window.applyFieldValue("step", "reps", 5);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();

  const dbNames = (await window.indexedDB.databases()).map((d) => d.name);
  assert.ok(dbNames.includes("haimunia-demo-db"), `expected a "haimunia-demo-db" database, got: ${JSON.stringify(dbNames)}`);
  assert.ok(!dbNames.includes("box-log-db"), "must never use the production app's own IndexedDB name");
});

test("every localStorage/sessionStorage key is namespaced \"haimunia-demo:\", never the bare \"haimunia:\" or \"boxlog:\" prefix production uses", async () => {
  const window = await bootApp();
  window.setThemePref("light");
  window.setTextScalePref("large");
  window.saveWelcomeForm("בודק");
  window.document.querySelector("[data-action='export-data']")?.click();
  await new Promise((r) => setTimeout(r, 0));

  const keys = Object.keys(window.localStorage).concat(Object.keys(window.sessionStorage || {}));
  assert.ok(keys.length > 0, "the flows above should have written at least one storage key to check");
  for (const k of keys) {
    assert.ok(!/^haimunia:/.test(k), `storage key "${k}" uses the bare production prefix, not "haimunia-demo:"`);
    assert.ok(!/^boxlog:/.test(k), `storage key "${k}" uses the production app's legacy "boxlog:" prefix`);
  }
});

test("source files contain no lingering reference to the production app's storage identifiers", async () => {
  for (const file of ["app.js", "theme-init.js", "cloud.js", "sw.js"]) {
    const src = readFileSync(path.join(root, file), "utf8");
    assert.ok(!src.includes('"box-log-db"'), `${file} should never reference the production DB name`);
    assert.ok(!/["']haimunia:/.test(src), `${file} should never use the bare "haimunia:" storage-key prefix`);
    assert.ok(!/["']boxlog:/.test(src), `${file} should never use the production app's legacy "boxlog:" prefix`);
  }
});

test("the service worker's cache cleanup only ever deletes its own demo-prefixed cache versions", async () => {
  const src = readFileSync(path.join(root, "sw.js"), "utf8");
  assert.match(src, /const CACHE = `haimunia-demo-v/, "the cache name itself should be demo-prefixed");
  // The real bug wasn't just the name — the activate handler used to delete
  // ANY cache that wasn't its own current version, which would also delete
  // the production app's cache the first time both had run in one browser.
  // The fix scopes the cleanup to its own prefix, not just "not me".
  assert.match(src, /keys\.filter\(\(k\) => k\.startsWith\("haimunia-demo-v"\) && k !== CACHE\)/, "cache cleanup must only ever touch its own demo-prefixed caches, never delete indiscriminately");
});
