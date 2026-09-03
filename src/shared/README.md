# `@boxlog/safe-helpers`

The low-level safety helpers shared by every Box Log client. One file,
`safe-helpers.js`, no dependencies, no build step.

Filed as **COMM-368**. Before it, `esc` / `cssSel` / `bag` / `cleanStr` /
`cleanNum` / `cleanId` / `cleanISODate` / `cleanTs` / `uid` existed as two
byte-identical but independently-maintained copy-pasted forks — one in this
repo (spread across `src/format.js`, `src/sanitize.js` and
`src/constants.js`), one in the sibling `crossfit-pwa-Noam` repo's `app.js` —
with no mechanism to propagate a security-relevant fix from either side to the
other except a human remembering to port it by hand.

## What is in scope

Only helpers that are (a) pure, (b) dependency-free, and (c) genuinely generic
— not tied to either app's schema, DOM, storage or copy:

| Helper | Purpose |
| --- | --- |
| `esc(v)` | HTML-escape for any `innerHTML` / template-literal sink |
| `cssSel(v)` | escape a value for use inside a CSS attribute selector |
| `bag()` | prototype-less accumulator object, for maps keyed by untrusted strings |
| `cleanStr(v, max)` | strip control chars, trim, hard-cap length |
| `cleanNum(v, min, max, fallback)` | finite-check, clamp, round to 2dp |
| `cleanId(v)` | conservative opaque-identifier charset + length cap |
| `cleanISODate(v)` | accept only a real `YYYY-MM-DD` |
| `cleanTs(v)` | finite, positive, capped at year 2100 |
| `uid(prefix)` | `crypto.randomUUID` with two documented fallbacks |
| `LIMITS.idLen` | the one length cap `cleanId` enforces |

Explicitly **out** of scope, and deliberately left in this repo's own files:
the per-record sanitizers (`sanitizeEntry`, `sanitizeCustomWod`, …), which are
specific to this app's schema; `catColor` / `catLabel`, which are lookups over
this repo's own tables; `estimate1RM` / `formatDuration` / `fmtDate` /
`localISODate` / `todayISO`, which are product formatting, not safety.

## How this repo consumes it

`index.html` loads `./src/shared/safe-helpers.js` **first**, before every other
script. The module publishes a frozen `window.BoxLogSafe`. Two consumption
styles, both load-order safe:

- **Bare identifiers.** `src/constants.js` opens with
  `const esc = SAFE.esc, cssSel = SAFE.cssSel, …`. Classic `<script>` tags
  share one global lexical environment, so `app.js`, `src/format.js`,
  `src/sanitize.js` and `src/db.js` resolve those bindings unchanged — exactly
  the way they already resolve `LIMITS`.
- **`window.BoxLogSafe.*`.** `cloud.js` is its own IIFE, evaluated before
  `src/constants.js`, and already reaches every other platform module
  (eventbus, analytics, realtime, image) through `window`. It takes
  `const esc = window.BoxLogSafe.esc;` at the head of its IIFE (COMM-367).

`sw.js` precaches the file as a **required** asset: `app.js` calls `esc()` and
`uid()` unconditionally, so the offline shell genuinely cannot run without it.

## Versioning and propagation protocol

`VERSION` is declared inside `safe-helpers.js` and mirrored in
`package.json`. Both must be bumped together.

- **Patch** — comment or formatting only, no behavior change.
- **Minor** — a new helper added. Additive; existing consumers keep working.
- **Major** — an existing helper returns something different for some input.
  Every consumer has to re-verify.

A consuming repo records the version it is on (in its own vendored copy's
header, or via `npm ls` if it consumes the package). To propagate a fix:

1. Change `safe-helpers.js` here, bump `VERSION` + `package.json`.
2. Run `npm test` in this repo (`test/shared-safe-helpers.test.mjs` covers the
   module boundary directly; the rest of the suite covers it in situ).
3. Update each consumer to the new version, which for a vendored consumer means
   copying this one file verbatim and recording the new `VERSION`.

The point is that step 3 is now a version bump against a single named artifact
with a changelog-able version number, instead of a human diffing two `app.js`
files from memory.

## Known limitation (as of COMM-368)

This half of the ticket is real and complete: the helpers now have exactly one
definition in this repo, behind a named, versioned module boundary that this
repo itself consumes.

The other half — **`crossfit-pwa-Noam` actually consuming this module** — is
not done, and was not doable from the workspace COMM-368 was implemented in
(this repo was checked out alone; the sibling repo was not present). Until that
lands, `crossfit-pwa-Noam`'s `app.js:320-402` remains an unlinked fork, and a
fix here still has to be hand-carried there. Closing that gap needs a change in
the *other* repo: either load this file as its own `<script>` (it is
framework-free and host-agnostic on purpose), or vendor it verbatim and record
the `VERSION` it copied.
