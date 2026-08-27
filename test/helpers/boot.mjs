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

function newDom() {
  const html = readFileSync(htmlPath, "utf8");
  const dom = new JSDOM(html, {
    url: "https://example.test/",
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
  const appJs = readFileSync(appJsPath, "utf8");
  window.eval(appJs);

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
  const window = newDom();
  window.HAIMUNIA_CONFIG = { supabaseUrl: "https://mockproj.supabase.co", supabasePublishableKey: "mock-key" };
  window.supabase = { createClient: () => mock.client };
  // cloud.js reads this synchronously at module init (state.syncEnabled),
  // so it has to be set before cloud.js is eval'd below, not after.
  if (opts.syncEnabled) window.localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1");

  const cloudJs = readFileSync(cloudJsPath, "utf8");
  window.eval(cloudJs);
  const appJs = readFileSync(appJsPath, "utf8");
  window.eval(appJs);

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
