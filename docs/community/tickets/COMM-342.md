# COMM-342 Fix reversed prev/next month chevron icons on the calendar

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Community's `cal-prev`/`cal-next` buttons use swapped SVG path values relative
to Noam — a concrete, verifiable bug, not a style choice.

## Acceptance criteria

- [ ] `cal-prev`/`cal-next` SVG `path` values swapped to match Noam's
  prev=left/next=right convention.

## Location / evidence

- Community: `app.js:2637-2642`
- Noam reference: `app.js:3757-3762`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
