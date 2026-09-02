# COMM-330 Reclassify cloud.js from REQUIRED to OPTIONAL in the service-worker precache list

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

`sw.js` marks `cloud.js` (700KB) as a REQUIRED precache asset, so a failed
fetch of it during install blocks the entire offline app shell — even though
`app.js` already defensively guards every cloud.js integration point (proving
the core training log doesn't need it to be present). `vendor/supabase.js` is
already correctly classified OPTIONAL; `cloud.js` should be too.

## Acceptance criteria

- [ ] `cloud.js` (and its community-only `src/*` dependencies not needed by the core
  app) moved from `REQUIRED_ASSETS` to `OPTIONAL_ASSETS` in `sw.js`.
- [ ] Killing network mid-install for `cloud.js` alone still results in a fully
  installed, offline-capable core app (add/wod/history/calendar tabs work
  offline).
- [ ] The Community tab degrades to its existing loading/error fallback until
  network returns, with no change to core-tab behavior.
- [ ] `test/sw-precache.test.mjs` updated to assert the new required/optional split.

## Location / evidence

- `sw.js:19-33` (`REQUIRED_ASSETS` includes `"./cloud.js"`)
- `sw.js:76` (install handler, `Promise.all` over required assets)
- Core app's existing defensive guard: `app.js:3040` (`typeof renderCommunityApp
  === "function" ? ... : ...`)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
