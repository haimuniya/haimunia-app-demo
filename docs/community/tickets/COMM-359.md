# COMM-359 Give the est-1RM trend chart an accessible name or data alternative

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

The generated SVG progression chart (shared logic in both apps) has no
`role="img"`, no `aria-label`/`<title>`, and no accompanying text/table
summary — a screen-reader user gets nothing where a sighted user sees a full
progress trend including which points are PRs. Confirmed still open from the
2026-08-27 audit's finding #11.

## Acceptance criteria

- [ ] Chart given `role="img"` with a computed `aria-label` summarizing range and
  latest value, and/or an adjacent visually-hidden data table.
- [ ] Chart announces a meaningful summary via a screen reader with no visual change
  for sighted users.

## Location / evidence

- Community: `app.js:2113-2121` (`renderChart`)
- Noam: `app.js:3024-3053`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
