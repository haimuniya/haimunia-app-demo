# COMM-367 Remove the duplicate safeText() implementation in cloud.js, use the shared esc()

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: done
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`cloud.js` reimplements HTML-escaping locally as `safeText()` (used 372 times)
instead of calling the already-global `esc()` from `src/format.js`, which does
the exact same character-map escape. Any future hardening of the escape logic
has to be made in two places.

## Acceptance criteria

- [x] `safeText()` deleted from `cloud.js`; all 485 remaining references use
  `esc()` instead. `esc()` itself moved on to `src/shared/safe-helpers.js`
  in COMM-368, which landed in the same pass; cloud.js binds it once at the
  head of its IIFE as `const esc = window.BoxLogSafe.esc`, the same way it
  reaches every other platform module.
- [x] `grep -c safeText cloud.js` returns 0; visual output unchanged (the two
  implementations had an identical character map and an identical
  null/undefined guard - `v == null` vs `?? ""`).

## Location / evidence

- `src/format.js:22` (`esc`)
- `cloud.js:369` (`safeText`, 372 call sites)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
