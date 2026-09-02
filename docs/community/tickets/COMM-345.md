# COMM-345 Give the notification bell a consistent icon-button class matching the nav-menu button

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Community's two header icon buttons use two different treatments:
`#navMenuBtn` uses `.icon-chip.icon-chip-steel`, while `#notificationsBellBtn`
has no class at all — just inline styles with no background/border/shadow. The
two buttons don't match each other, let alone Noam's `.icon-btn`.

## Acceptance criteria

- [ ] `#notificationsBellBtn` given a consistent class (either `.icon-chip.icon-
  chip-steel` to match `#navMenuBtn`, or `.icon-btn` if the intent is to match
  Noam).
- [ ] Both header icons are visually consistent with each other.

## Location / evidence

- `index.html:595-599`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
