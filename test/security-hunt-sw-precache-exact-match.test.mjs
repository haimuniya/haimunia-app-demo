// Security hunt, round 3 (2026-09-11), client-side security posture agent.
// isPrecached() (sw.js) used to compare with url.pathname.endsWith("/"+rel) -
// a suffix match, so a same-origin request to /anything/app.js would also
// count as precached and get written back to the shared cache, not only the
// real ./app.js at the app's own base path. Grepped app.js/cloud.js for any
// fetch() built from a dynamic same-origin URL and found none, so this
// wasn't reachable through this app's own code - but it was strictly looser
// than the actual set of files install() precaches, and cheap to close
// outright rather than leave as a latent cache-poisoning-shaped gap for a
// future code path to fall into.
//
// sw.js runs in a ServiceWorkerGlobalScope this suite can't boot (no
// `caches`/`clients`/install lifecycle in Node), so this test extracts just
// isPrecached() and the ASSETS list it closes over - the same source-slicing
// technique test/sw-precache.test.mjs already uses on this file - and
// evaluates that real function body in a sandboxed `self`, rather than
// re-implementing its logic as a separate copy that could drift from the
// shipped file.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");

function loadIsPrecached(swOrigin) {
  const assetsStart = sw.indexOf("const REQUIRED_ASSETS");
  const assetsEnd = sw.indexOf(";", sw.indexOf("const ASSETS = [...REQUIRED_ASSETS")) + 1;
  const assetsBlock = sw.slice(assetsStart, assetsEnd);
  const fnStart = sw.indexOf("function isPrecached");
  const fnEnd = sw.indexOf("\n}", fnStart) + 2;
  const fnSource = sw.slice(fnStart, fnEnd);
  assert.ok(assetsBlock.includes("OPTIONAL_ASSETS") && assetsBlock.includes("const ASSETS ="), "sanity check: the asset-list block must still exist and end right after ASSETS is built");
  assert.match(fnSource, /^function isPrecached\(url\) \{[\s\S]*\}$/, "sanity check: isPrecached's source must have been sliced out cleanly");

  const context = { self: { location: new URL(swOrigin) }, URL, result: null };
  vm.createContext(context);
  vm.runInContext(`${assetsBlock}\n${fnSource}\nresult = isPrecached;`, context);
  return context.result;
}

test("isPrecached matches the real precached files at the app's own base path", () => {
  const isPrecached = loadIsPrecached("https://haimuniya.github.io/haimunia-app-demo-publish/sw.js");
  assert.strictEqual(isPrecached(new URL("https://haimuniya.github.io/haimunia-app-demo-publish/app.js")), true);
  assert.strictEqual(isPrecached(new URL("https://haimuniya.github.io/haimunia-app-demo-publish/")), true);
  assert.strictEqual(isPrecached(new URL("https://haimuniya.github.io/haimunia-app-demo-publish/src/constants.js")), true);
});

test("isPrecached no longer treats a same-origin path merely ENDING in a precached filename as precached", () => {
  const isPrecached = loadIsPrecached("https://haimuniya.github.io/haimunia-app-demo-publish/sw.js");
  // The exact bypass shape this fix closes: a suffix match let this through
  // before, even though install() never cached anything at this path.
  assert.strictEqual(isPrecached(new URL("https://haimuniya.github.io/haimunia-app-demo-publish/anything/app.js")), false);
  assert.strictEqual(isPrecached(new URL("https://haimuniya.github.io/evil/app.js")), false);
  assert.strictEqual(isPrecached(new URL("https://haimuniya.github.io/haimunia-app-demo-publish/src/attacker/db.js")), false);
});

test("isPrecached still resolves correctly at a different deploy base path (root-scoped, no subdirectory)", () => {
  const isPrecached = loadIsPrecached("https://example.com/sw.js");
  assert.strictEqual(isPrecached(new URL("https://example.com/app.js")), true);
  assert.strictEqual(isPrecached(new URL("https://example.com/")), true);
  assert.strictEqual(isPrecached(new URL("https://example.com/nested/app.js")), false);
});
