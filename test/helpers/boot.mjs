// Boots the real app (index.html + app.js, byte-for-byte off disk) inside a
// jsdom window backed by a fresh, isolated in-memory IndexedDB per call — so
// tests exercise the actual production code path, not a reimplementation of
// it, with no state leaking between tests.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import FDBFactory from "fake-indexeddb/lib/FDBFactory";
import FDBKeyRange from "fake-indexeddb/lib/FDBKeyRange";

const testDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(testDir);
const htmlPath = path.join(root, "index.html");
const appJsPath = path.join(root, "app.js");
const cloudJsPath = path.join(root, "cloud.js");
// app.js was split into a few self-contained files, loaded as separate
// <script> tags in index.html, in the same order below. Real browsers
// share one global *lexical* environment across classic <script> tags, so
// a top-level `let`/`const` in one is visible from a later one — verified
// against real Chromium via scripts/browser-check. jsdom's window.eval()
// does NOT reproduce that: each separate eval() call gets its own script
// scope, so a later call's `let X` from an earlier one throws
// ReferenceError. Concatenating into one string before a single eval()
// (below) sidesteps that jsdom-only gap without changing app.js itself.
const appSrcPaths = [
  path.join(root, "src", "constants.js"),
  path.join(root, "src", "format.js"),
  path.join(root, "src", "sanitize.js"),
  path.join(root, "src", "db.js"),
];
function readAppSrc() {
  return appSrcPaths.map((p) => readFileSync(p, "utf8")).join("\n") + "\n" + readFileSync(appJsPath, "utf8");
}
// The shared platform modules (COMM-012 to COMM-015) load BEFORE cloud.js
// in index.html, not after, because cloud.js reaches them through window.
// They get their own eval() rather than joining the concatenation above
// for exactly that reason - the order has to match index.html. Each one
// is a self-contained IIFE that only publishes to window, so unlike the
// app src files they do not depend on a top-level `let` being visible
// across script tags, and the separate eval costs nothing.
// COMM-368. src/shared/safe-helpers.js belongs at the head of THIS list, not
// the app-src concatenation below: it is the first script index.html loads,
// before cloud.js, and cloud.js reads window.BoxLogSafe.esc off it (COMM-367).
// It publishes only to window, so a separate eval costs it nothing.
const platformSrcPaths = [
  path.join(root, "src", "shared", "safe-helpers.js"),
  path.join(root, "src", "eventbus.js"),
  path.join(root, "src", "analytics.js"),
  path.join(root, "src", "realtime.js"),
  path.join(root, "src", "image.js"),
  // The community write queue. Same position as index.html: before
  // cloud.js, which registers its handlers at load.
  path.join(root, "src", "outbox.js"),
];
function readPlatformSrc() {
  return platformSrcPaths.map((p) => readFileSync(p, "utf8")).join("\n");
}

function newDom(url) {
  const html = readFileSync(htmlPath, "utf8");
  const dom = new JSDOM(html, {
    // COMM-229. Overridable so a test can boot with a ?notif=... query
    // string (app.js reads it at its own top-level, before any script
    // below runs) - every other caller keeps the plain origin default.
    url: url || "https://example.test/",
    // "outside-only" parses the document but does NOT auto-run its <script>
    // tags (no network/file fetch needed for ./app.js or ./theme-init.js);
    // it still exposes window.eval so we can run app.js ourselves below.
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.indexedDB = new FDBFactory();
  window.IDBKeyRange = FDBKeyRange;

  // jsdom implements neither matchMedia nor a full randomUUID-capable crypto.
  window.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  window.crypto = globalThis.crypto;

  // window.confirm has no jsdom implementation; default to "yes" for tests
  // that go through confirmation flows (e.g. import merge).
  window.confirm = () => true;
  window.alert = () => {};
  return window;
}

export async function bootApp() {
  const window = newDom();
  window.eval(readPlatformSrc());
  window.eval(readAppSrc());

  await waitFor(() => window.document.getElementById("loading").style.display === "none", 5000);
  return window;
}

// Boots cloud.js alongside app.js, in the same order the real
// index.html script tags do (cloud.js first, so its functions exist on
// window by the time app.js's render() can call
// window.renderCommunityApp), wired to a mock Supabase client instead of
// a real project - see helpers/mockSupabase.mjs. This is what lets a
// test actually execute the community/sync surface (refreshSession,
// the login/signup gates, publishing, moderation) instead of only
// regex-matching cloud.js's source text.
export async function bootCommunity(mock, opts = {}) {
  const window = newDom(opts.url);
  window.HAIMUNIA_CONFIG = { supabaseUrl: "https://mockproj.supabase.co", supabasePublishableKey: "mock-key",
    // COMM-229. Same shape cloud-config.js ships - a test that stubs the
    // Push API needs a real (if fake) key here for vapidKeyToUint8Array to
    // decode, matching what a real browser is handed.
    notifPushVapidPublicKey: "BD16mHSAcS-jU5cV2xEqkNy09hCQ7MTjkY22CK8UrRw1JpI_5kjReL7tME6O4BFmQhuiaOVCWQ-nqsnoa1_0nAo" };
  window.supabase = { createClient: () => mock.client };
  // Redesign, Phase 3: default every test to "already saw the first-run
  // intro carousel" - unlike syncEnabled/coachEngage below, cloud.js reads
  // this on every render (hasSeenIntroCarousel()), not just at module init,
  // so the vast majority of existing tests boot a member straight to
  // whatever screen they actually mean to test (the profile-completion
  // form, the tabbed UI, ...) instead of being intercepted by a carousel
  // they have no interest in. A test that DOES want the carousel passes
  // `localStorage: { "haimunia-demo:seenIntroCarousel": "0" }` (below) to
  // override this default back to unseen.
  window.localStorage.setItem("haimunia-demo:seenIntroCarousel", "1");
  // cloud.js reads this synchronously at module init (state.syncEnabled),
  // so it has to be set before cloud.js is eval'd below, not after.
  if (opts.syncEnabled) window.localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1");
  // COMM-226. featureFlags.coachEngage is read the same way, once, at the
  // same module-init literal - any other localStorage-backed flag added
  // later can go through this same generic hook instead of a new
  // one-off opts.* special case each time.
  if (opts.localStorage) {
    for (const [key, value] of Object.entries(opts.localStorage)) window.localStorage.setItem(key, value);
  }
  // COMM-229. app.js's own `if ("serviceWorker" in navigator)` registration
  // block (including the "message" listener wired to
  // communityHandlePushDeepLink) runs synchronously, in the same tick that
  // hides the #loading indicator below - by the time this function's own
  // window is handed back there is no later point at which a test could
  // still inject navigator.serviceWorker and have that block see it, so
  // this has to land before readAppSrc() is eval'd, not after.
  if (opts.serviceWorkerStub) window.navigator.serviceWorker = opts.serviceWorkerStub;

  const cloudJs = readFileSync(cloudJsPath, "utf8");
  window.eval(readPlatformSrc());
  window.eval(cloudJs);
  window.eval(readAppSrc());

  await waitFor(() => window.document.getElementById("loading").style.display === "none", 5000);
  return window;
}

export function waitFor(check, timeoutMs = 2000, intervalMs = 5) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let result;
      try { result = check(); } catch (e) { return reject(e); }
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(poll, intervalMs);
    })();
  });
}
