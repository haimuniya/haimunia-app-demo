// Service worker for האימוניה.
// Version is the single source of truth for the cache name — bumping
// APP_VERSION in app.js is what ships an update. Don't edit SW_VERSION by
// hand: run `npm run sync-version` (see app.js) to copy it here.
const SW_VERSION = "3.0.18";
// "haimunia-demo-v..." — deliberately distinct from the production app's
// own "haimunia-v..." cache prefix. Both service workers are scoped to
// the same origin (haimuniya.github.io), and the activate handler below
// deletes any Cache Storage entry that isn't the current CACHE name —
// with a shared prefix, this demo's own cleanup could delete the real
// app's cached assets (Cache Storage is origin-wide, not scoped per SW).
const CACHE = `haimunia-demo-v${SW_VERSION}`;

// Required: the app cannot render/run offline without these. A miss here
// fails the whole install (the old service worker — and its own cache —
// stays in control, per the Cache/Service Worker spec's normal failed-
// install behavior), rather than silently activating a shell that's
// missing its own HTML or JS.
const REQUIRED_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./theme-init.js",
  "./cloud.js",
];
// Optional: visual/informational assets — a miss degrades the experience
// (a font falls back, an icon is missing) but never breaks the app, so
// install still proceeds without them.
const OPTIONAL_ASSETS = [
  "./vendor/supabase.js",
  "./PRIVACY.md",
  "./TERMS.md",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
  "./assets/mark.png",
  "./assets/icon-barbell.png",
  "./assets/icon-chevrons.png",
  "./assets/logo-full.png",
  "./assets/medal-bronze.png",
  "./assets/medal-silver.png",
  "./assets/medal-gold.png",
  "./assets/fonts/rubik-400-latin.woff2",
  "./assets/fonts/rubik-400-hebrew.woff2",
  "./assets/fonts/rubik-600-latin.woff2",
  "./assets/fonts/rubik-600-hebrew.woff2",
  "./assets/fonts/rubik-700-latin.woff2",
  "./assets/fonts/rubik-700-hebrew.woff2",
  "./assets/fonts/rubik-800-latin.woff2",
  "./assets/fonts/rubik-800-hebrew.woff2",
  "./assets/fonts/rubik-900-latin.woff2",
  "./assets/fonts/rubik-900-hebrew.woff2",
  "./assets/fonts/jbmono-500-latin.woff2",
  "./assets/fonts/jbmono-700-latin.woff2",
  "./assets/fonts/anton-400-latin.woff2",
];
const ASSETS = [...REQUIRED_ASSETS, ...OPTIONAL_ASSETS];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // addAll() is all-or-nothing across the whole list; doing required
      // assets as their own strict Promise.all() means a miss here is
      // exactly as fatal as it should be, without also failing on an
      // optional asset miss the way a single addAll() over everything would.
      await Promise.all(REQUIRED_ASSETS.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      await Promise.allSettled(
        OPTIONAL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" }))
            .catch((err) => console.warn("[sw] precache miss:", url, err))
        )
      );
    })
  );
  // No skipWaiting() here on purpose. The page shows an update banner and the
  // user decides when to swap; activating under a running page would leave the
  // old app.js talking to a new cache.
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Only ever delete this demo's OWN old cache versions — Cache
      // Storage is shared across the whole origin, not scoped per service
      // worker, so a bare "!== CACHE" here would also delete the real
      // production app's cache the first time both apps have run in the
      // same browser.
      await Promise.all(keys.filter((k) => k.startsWith("haimunia-demo-v") && k !== CACHE).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }
      await self.clients.claim();
    })()
  );
});

// The update banner in index.html triggers the swap explicitly.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Only app-shell files get written back to the cache, so a stray same-origin
// request can't grow the cache without bound.
function isPrecached(url) {
  return ASSETS.some((a) => {
    const rel = a.replace(/^\.\//, "");
    return rel === "" ? url.pathname.endsWith("/") : url.pathname.endsWith("/" + rel);
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // Only ever touch our own origin. The previous version cached every
  // successful GET from anywhere, which meant unbounded growth and let any
  // third-party response sit in the app's cache indefinitely.
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return;

  // Environment configuration must never be served stale. It may change
  // independently of the app shell when switching demo/staging projects.
  if (url.pathname.endsWith("/cloud-config.js")) {
    e.respondWith(fetch(req, { cache: "no-store" }).catch(() => new Response("window.HAIMUNIA_CONFIG={};", { headers: { "Content-Type": "application/javascript" } })));
    return;
  }

  // Navigations: serve the shell. Matching with ignoreSearch is what makes the
  // manifest shortcuts (./index.html?tab=add) work offline — an exact-URL match
  // missed on the query string and fell through to a network error.
  if (req.mode === "navigate") {
    e.respondWith(
      (async () => {
        try {
          const preload = await e.preloadResponse;
          if (preload) return preload;
          return await fetch(req);
        } catch (err) {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(req, { ignoreSearch: true })) ||
            (await cache.match("./index.html")) ||
            (await cache.match("./")) ||
            new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } })
          );
        }
      })()
    );
    return;
  }

  // Same-origin assets: stale-while-revalidate, but only re-cache things that
  // are part of the app shell.
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic" && isPrecached(url)) {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })()
  );
});
