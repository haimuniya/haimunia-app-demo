# COMM-348 Give .post-media-grid an actual grid layout

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

A post with 2+ photos is wrapped in a div whose class name (`.post-media-
grid`) implies a grid, but no `display:grid` rule exists anywhere for it — the
images stack vertically as plain block-level tags instead.

## Acceptance criteria

- [ ] `.post-media-grid` given a real `display:grid` rule (2-column for 2-4 photos),
  matching the visual weight of `.ach-grid`.
- [ ] A post with multiple photos renders as a grid, not a vertical stack.

## Location / evidence

- `cloud.js:4992` (`.post-media-grid` div, `cloud.js:4990` inline `margin-
  bottom` stacking)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
