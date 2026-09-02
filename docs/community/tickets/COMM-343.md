# COMM-343 Port the chosen/unchosen exercise-select state and stat-hero cards to the Home/log screen

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Noam's log screen tracks whether an exercise has been explicitly chosen,
showing a distinct empty-state prompt ("מה עשינו היום?") when it hasn't, and
styles the est-1RM/best-hold stat cards with a `.stat-hero` accent.
Community's `renderLogTab` reads `selected.name` unconditionally with no
chosen/unchosen branch and no stat-hero styling.

## Acceptance criteria

- [ ] Community's `renderLogTab()` gains the chosen/unchosen branch and `.log-empty-
  hint` empty state.
- [ ] Stat cards adopt `.stat-hero` styling.
- [ ] No change to underlying data/state logic beyond the UI branch (data-
  correctness aspect of this gap is tracked separately, see COMM-360).

## Location / evidence

- Community: `app.js:2139-2200` (`renderLogTab`)
- Noam reference: `app.js:3072-3145`

## Dependencies

- COMM-360

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
