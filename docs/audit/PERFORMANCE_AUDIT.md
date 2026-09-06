# Performance audit

Commit `d2e6408`, branch `main`. All byte counts, timings and grep counts below were
measured on this machine. See `COMMANDS_AND_TEST_RESULTS.md` for the environment and
for the commit-boundary caveat.

**No Lighthouse score is reported.** No Lighthouse or Lighthouse CI dependency exists
anywhere in this repo, and there is no real mobile device here. The only
device-shaped numbers below are Chrome DevTools Protocol CPU-throttling multipliers,
which are a CPU proxy — not a phone, and they say nothing about network, memory or
thermal behaviour.

---

## 1. Payload size and script loading

### Measured sizes

```
$ wc -c app.js cloud.js
 243730 app.js
 841432 cloud.js
1085162 total
```

Full parser-blocking JavaScript payload, in load order:

| Bytes | File | Needed by a member who never opens Community? |
|------:|------|---|
| 960 | `theme-init.js` *(in `<head>`)* | yes |
| 5,606 | `src/shared/safe-helpers.js` | yes |
| **131,061** | `vendor/supabase.js` | **no** |
| 1,513 | `cloud-config.js` | no |
| **6,659** | `src/eventbus.js` | **no** |
| **19,740** | `src/analytics.js` | **no** |
| **7,588** | `src/realtime.js` | **no** |
| **11,989** | `src/image.js` | **no** |
| **841,432** | `cloud.js` | **no** |
| 22,041 | `src/constants.js` | yes |
| 1,210 | `src/format.js` | yes |
| 7,607 | `src/sanitize.js` | yes |
| 14,314 | `src/db.js` | yes |
| 243,730 | `app.js` | yes |
| **1,315,450** | **total blocking JS** | |
| **1,018,469** | **Community-only subtotal (77.4 %)** | |

There is **no build step** — no webpack/rollup/vite/esbuild/Makefile in the repo
(`package.json` has only `sync-version`, `check-*`, `smoke-test-*`, `setup-hooks`,
`test`). Nothing is minified, tree-shaken, or code-split. All 1.29 MB is shipped as
authored source, comments included. `cloud.js` alone is comment-dense enough that a
large fraction of its 841 KB is prose the browser still has to parse.

### How they are loaded — `index.html`

**12 `<script src=...>` tags, all synchronous. Not one carries `defer`, `async`, or
`type="module"`.**

- 1 in `<head>`: `theme-init.js` (line 8) — genuinely render-blocking, and
  deliberately so; it sets the theme before first paint to avoid a flash.
- 11 at the end of `<body>` (lines 1087–1102), in a fixed order the code depends on
  (`safe-helpers` → `vendor/supabase` → `cloud-config` → 4 platform modules →
  `cloud.js` → `constants`/`format`/`sanitize`/`db` → `app.js`).

Because they sit at the end of `<body>`, they do not block parsing of the markup above
them. But they **do** block `DOMContentLoaded`, and — critically — `<main><div
id="content" role="tabpanel"></div></main>` (line 791) is **empty in the HTML**. Every
pixel of app content is produced by `app.js`'s `render()`. So the first *meaningful*
paint is gated on downloading, parsing and executing **all 1.29 MB**, in strict serial
order, `cloud.js` included.

### Finding 1 — `cloud.js` is loaded eagerly for every user, always

**`cloud.js` is not lazy-loaded.** It is a plain `<script src="./cloud.js">` at
`index.html:1097`, and the file is one immediately-invoked IIFE (`(function () {` at
line 1, `})();` at line 12501) that runs its full top-level body on every boot:
registering `online` / `haimunia-sync-needed` / `pagehide` listeners, a capture-phase
`click` listener, a `keydown` listener, `client.auth.onAuthStateChange(...)`, and four
product-event-bus subscriptions.

A member who installs the PWA to log workouts offline and **never taps Community** still
pays for:

- **1,018,469 bytes (77.4 % of all JS)** downloaded and cached,
- the full parse + execute cost of `cloud.js` on **every single cold start**,
- a `supabase.createClient(...)` construction and a boot-time `auth.getSession()`.

Only the *data* is lazy. `ensureCommunityDataLoaded()` (cloud.js, guarded on
`state.communityDataLoaded` / `state.communityDataLoading`) defers the 14-way
`Promise.all` of `loadFeed` / `loadStreaks` / `loadEvents` / … until the Community tab
actually renders. That is a genuinely good deferral — but it defers round-trips, not
the megabyte.

This is the single largest available performance win. Splitting `cloud.js` +
`vendor/supabase.js` + the four `src/` platform modules behind a dynamic import on
first Community-tab activation would cut cold-start blocking JS from **1.29 MB to
~296 KB (–77 %)**. `sw.js` already treats all six as `OPTIONAL_ASSETS`, and `app.js`
already guards every integration point defensively (`typeof renderCommunityApp ===
"function"`), so the architecture is *already* shaped for this — only the `<script>`
tag is eager.

### Mitigations already in place

- `sw.js` precaches everything, so this is a **first-visit and post-update** cost, not
  a per-visit one. Repeat visits serve from Cache Storage.
- Fonts are self-hosted and subset per weight/script (`rubik-*-latin` /
  `rubik-*-hebrew`), and `boot-smoke.mjs` verifies Rubik actually loads.
- Navigation preload is enabled in the SW `activate` handler.

---

## 2. Render cost — measured, not estimated

From `scripts/browser-check/community-render-cost.mjs` on the clean run:

```
Community tab, signed-in member, feed loaded:
  post cards in #content   20
  HTML returned            26797 bytes
  elements in #content     275
  focusable controls       92
  window.render()          0.952 ms   (mean of 50)
  innerHTML write alone    0.364 ms
  => string building       0.588 ms of it

innerHTML write vs. feed depth (one real post card, repeated):
  cards    bytes   elements   ms/write
      1     1169         12      0.027
     10    11690        120      0.213
     30    35070        360      0.630
     60    70140        720      1.287
    120   140280       1440      1.727

Same full render(), under CDP CPU throttling:
  1x slowdown (desktop)            0.873 ms/render
  4x slowdown (~mid-range phone)   3.453 ms/render
  6x slowdown (~low-end phone)     5.610 ms/render
```

**This is healthy.** 3.45 ms at 4× throttle is comfortably inside a 16 ms frame, the
scaling with feed depth is roughly linear (not quadratic), and the repo has its own
trip-wire assertion (`< 16 ms at 4x`) guarding it. Credit where due: the team measured
this and wrote the regression test.

The architectural cost is real but bounded: the app rebuilds `#content` wholesale on
every state change (the scenario asserts *"a rerender still destroys and rebuilds every
node"*), with **390 `rerender()` call sites in `cloud.js`** and 57 `render()` sites in
`app.js`. Because every node is destroyed, focus, caret, scroll and `<details>` state
must all be restored by hand — which is where the accessibility fragility in
`ACCESSIBILITY_AUDIT.md` comes from. One tap on `toggle-comments` costs 2 full rebuilds,
which the scenario asserts is bounded.

---

## 3. Query patterns in `cloud.js`

### Finding 2 — search fires a network round-trip **and** a full DOM rebuild on every keystroke

Three search boxes bind `input` with **no debounce on the fetch**:

| `cloud.js` line | Wiring |
|---|---|
| 11619 | `input.addEventListener("input", () => searchPeople(input.value))` |
| 11631 | `dirInput.addEventListener("input", () => directorySearch(dirInput.value))` |
| 11798 | `adminInput.addEventListener("input", () => searchMembers(adminInput.value))` |

The code states this outright (cloud.js:4020):

> *"Both boxes fire a request on every input event (there is no debounce on the fetch
> itself - COMM-228 chose latency over batching and the token guard makes it safe)"*

Typing `noam` = **4** `community_search` RPCs and 4 full `#content` rebuilds. The one
debounce that exists (`SEARCH_TRACK_DEBOUNCE_MS = 600`, cloud.js:4028) debounces only
the **analytics event**, explicitly so the metric isn't inflated — not the query.

Existing guards make this *correct* but not *cheap*:

- `searchToken` monotonic counter discards out-of-order responses,
- `SEARCH_MIN_CHARS = 2` floor plus client-side `sanitizeSearchQuery()` mirroring the
  server's stripped characters, so `%_,()` never costs a round trip,
- `SEARCH_GROUP_LIMIT = 10` caps each result group,
- focus/caret restoration after each rebuild (cloud.js:11624, 11633) — needed precisely
  *because* each keystroke destroys the input the member is typing into.

It was a deliberate, documented trade (latency over batching) for a small club. It is
still the clearest per-interaction inefficiency in the file, and it scales badly with
roster size and RTT. A 150–250 ms debounce would cut request volume ~4× with no
perceptible latency change.

### Finding 3 — no `.range()` anywhere; several unbounded list queries

```
$ grep -c "\.range(" cloud.js   → 0
$ grep -c "\.limit(" cloud.js   → 12
```

**Zero uses of `.range()` in the entire file.** All PostgREST-level pagination is done
via `.limit()` or pushed server-side into RPCs.

**Properly paginated (server-side cursor RPCs) — good:**

| Surface | Mechanism |
|---|---|
| Feed | `feed_page(p_cursor, …)` — ranking, diversity and page boundary all in Postgres |
| Notifications | `notif_list({ p_cursor: c.cursor, p_limit: NOTIF_PAGE_SIZE })` (cloud.js:10296), with a real cursor loop, `loadMoreNotifs()` and an age cutoff |
| Member roster | `admin_member_roster({ p_cursor, p_limit: ROSTER_PAGE_SIZE })` (cloud.js:5259) |
| Moderation queue | `mod_queue({ p_cursor: null, p_limit: 50 })` (cloud.js:2279) |
| Search / directory | `community_search({ p_limit: … })`, `people_suggestions({ p_limit: … })` |

**Bounded by a `.limit()` — acceptable:**
comments 400 (3520), reactions 200 (3451), streaks 50 (1147), announcements 20 (1570),
weekly leaderboard 50 (1609), directory page (4782), challenge contributors 30 (6567).

**Unbounded list-fetching queries — the actual gap:**

| Line | Query | Growth |
|---|---|---|
| 6476 | `.from("challenges").select("*").order("end_at")` | every challenge ever created, including `archived`, fetched in full on every `loadChallenges()` |
| 8052 | `.from("events").select("*").order("start_at")` | every event ever created, including past and cancelled |
| 8061 | `.from("event_attendees").select(…).in("event_id", ids)` | one row per RSVP across *all* those events, with a joined `profiles(…)` per row |
| 1229 | `.from("attendance_log").select("occurred_on").eq("user_id", …)` | one row per training day, forever (~250/yr — slow-growing but unbounded) |
| 8798 | `.from("weekly_recaps").select("*").eq("user_id", …)` | one row per week, forever |
| 9746 | `.from("follows").select(idCol + ",created_at").eq(matchCol, …)` | full follower/following list, no limit |
| 3989 | `.from("private_records")…limit(20000)` | capped, and correctly cursored via `syncCursorKey` — noted only because 20000 is a large ceiling |

Challenges and events are the ones to fix: they have no `status` filter, no date
window, and no limit. A club three years in re-downloads every archived challenge and
every past event on **every** Community-tab load.

### Finding 4 — one genuine N+1, deliberately taken

`loadChallenges()` (cloud.js:6488–6491):

```js
const active = state.challenges.items.filter((c) => c.status === "active");
await Promise.all(active.map(async (c) => {
  const { data: p, error: pErr } = await client.rpc("chal_progress", { challenge_id: c.id });
  if (!pErr && p) state.challenges.aggregates[c.id] = p;
}));
```

One `chal_progress` RPC **per active challenge**. The code documents the choice:

> *"chal_progress() is fetched for every active challenge, not lazily per card: this is
> a single small club, active challenges are few…"*

Mitigated by `Promise.all` (concurrent, not serial) and by scoping to `status ===
"active"` only. It is a conscious trade sized to one club, not an oversight — but it is
the only unbatched per-row query loop in the file, and it becomes N round-trips if a
club ever runs many concurrent challenges. A `chal_progress_bulk(uuid[])` would
collapse it to one.

**Everything else that looks like N+1 is already batched**, and visibly on purpose:

- `.in("id", uniqueIds)` for profile hydration (810) — with a comment at 1892
  describing exactly this batching decision
- `.in("user_id", ids)` for contact log (1777)
- `.in("event_id", ids)` for attendees (8061)
- `member_roles({ p_ids: need })` (3551)
- `notif_mark_read` chunked at 100 ids per call (10338, 10354)

---

## 4. Service worker caching (`sw.js`)

### Cache versioning — correct

```js
const SW_VERSION = "4.3.0";                  // sw.js:5
const CACHE = `haimunia-demo-v${SW_VERSION}`; // sw.js:12
```

The cache name **is** versioned, so updates propagate. `npm run check-version` verifies
`APP_VERSION` and `SW_VERSION` are in lockstep (both `4.3.0` — verified passing), and
the header comment routes edits through `npm run sync-version` rather than by hand.

`activate` deletes only `k.startsWith("haimunia-demo-v") && k !== CACHE` — a deliberate
guard, documented in-file, so this demo's cleanup cannot wipe the production app's
cache on the shared `haimuniya.github.io` origin. Good defensive detail.

### Update handshake — matches `CHANGES.md`, verified line by line

All three claims confirmed against current `sw.js` / `app.js`:

| Claim | Verified |
|---|---|
| No `skipWaiting()` in `install` | ✅ `sw.js:100` — *"No skipWaiting() here on purpose"*; the only `self.skipWaiting()` is at `sw.js:125` |
| `SKIP_WAITING` postMessage flow | ✅ `sw.js:123–125` receives; `app.js:3980` posts |
| Reload on `controllerchange` | ✅ `app.js:4447–4452` |

`app.js:4447` correctly gates the reload on a `swapRequested` flag so the first-ever
`clients.claim()` does not trigger a spurious reload (the comment notes this was
wiping in-progress typing on every first visit). `update-flow.mjs` passes.

### Fetch strategy for the two large JS files

`app.js` and `cloud.js` are both in the precache list (`app.js` REQUIRED, `cloud.js`
OPTIONAL) and are served by the same-origin branch: **stale-while-revalidate**, with
`isPrecached(url)` gating write-back so a stray same-origin request cannot grow the
cache without bound. Cross-origin and non-HTTPS requests are skipped entirely;
`cloud-config.js` is forced `no-store`.

The one consequence worth naming: stale-while-revalidate means a returning user gets
the **previous** `app.js`/`cloud.js` from cache on first paint and the new one only on
the next load. That is exactly what the deliberate no-`skipWaiting()` handshake is for
— the running page and its cached assets stay on the same version until the user (or a
visibility regain) accepts the swap. Consistent and correct, not a bug.

---

## Summary — ranked

| # | Finding | Severity | Evidence |
|---|---|---|---|
| 1 | `cloud.js` + Supabase + platform modules (**1,018,469 B, 77 % of all JS**) load eagerly via a sync `<script>` for every user, including those who never open Community. No build step, no splitting. | **High** | `index.html:1087–1102`; `cloud.js` IIFE lines 1 / 12501 |
| 2 | `challenges` and `events` fetched with `select("*")`, no status filter, no date window, no limit — grows forever | **Medium** | `cloud.js:6476`, `cloud.js:8052` |
| 3 | Three search boxes fire an RPC + a full `#content` rebuild per keystroke; zero fetch debounce | **Medium** | `cloud.js:11619, 11631, 11798`; comment at 4020 |
| 4 | `chal_progress` N+1 across active challenges | Low (documented trade) | `cloud.js:6488–6491` |
| 5 | Render architecture rebuilds all 275 nodes per state change (390 `rerender()` sites) — measured fast, but forces manual focus/caret/scroll restoration | Low (measured, guarded) | `community-render-cost.mjs`, 3.45 ms @ 4× |

**Not measured here:** Lighthouse score, real-device timings, network waterfall, TTI/LCP/CLS, memory. None of the tooling for any of those exists in this repo.
