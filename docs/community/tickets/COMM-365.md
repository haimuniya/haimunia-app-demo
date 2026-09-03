# COMM-365 Namespace cloud.js's flat state object by feature domain

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: done
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`cloud.js`'s single `state` object has ~89 top-level keys spanning feed,
comments, admin, challenges, events, recaps, notifications, and more, all flat
siblings with no sub-namespacing. Workable today because comments group keys
by ticket, but every new feature cluster grows the same flat namespace,
increasing collision risk.

## Acceptance criteria

- [x] `state` restructured into per-domain namespaces (`state.feed`, `state.admin`,
  `state.challenges`, ...). 17 namespaces; the root keeps only the 13-key
  session/auth/config core that every domain reads and no domain owns.
- [x] All read/write sites updated to the new shape: 1,181 of the 1,538
  `state.*` references were rewritten, the other 357 are the root session
  core and stayed put. `state[key]` (the dialog registry) became a per-entry
  `isOpen()` getter, so nothing reaches state by a computed key any more.
- [x] Existing test suite passes with no behavior change. New guard:
  `test/community-state-namespaces.test.mjs`.

## Location / evidence

- `cloud.js:3-45` (the `state = {...}` literal)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
