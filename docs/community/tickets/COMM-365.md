# COMM-365 Namespace cloud.js's flat state object by feature domain

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`cloud.js`'s single `state` object has ~89 top-level keys spanning feed,
comments, admin, challenges, events, recaps, notifications, and more, all flat
siblings with no sub-namespacing. Workable today because comments group keys
by ticket, but every new feature cluster grows the same flat namespace,
increasing collision risk.

## Acceptance criteria

- [ ] `state` restructured into per-domain namespaces (`state.feed`, `state.admin`,
  `state.challenges`, ...).
- [ ] All ~340 read/write sites updated to the new shape.
- [ ] Existing test suite passes with no behavior change.

## Location / evidence

- `cloud.js:3-45` (the `state = {...}` literal)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
