# COMM-367 Remove the duplicate safeText() implementation in cloud.js, use the shared esc()

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`cloud.js` reimplements HTML-escaping locally as `safeText()` (used 372 times)
instead of calling the already-global `esc()` from `src/format.js`, which does
the exact same character-map escape. Any future hardening of the escape logic
has to be made in two places.

## Acceptance criteria

- [ ] `safeText()` deleted from `cloud.js`; all 372 call sites use `esc()` from
  `src/format.js` instead.
- [ ] `grep -c safeText cloud.js` returns 0; visual output unchanged.

## Location / evidence

- `src/format.js:22` (`esc`)
- `cloud.js:369` (`safeText`, 372 call sites)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
