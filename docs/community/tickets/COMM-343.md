# COMM-343 Port the chosen/unchosen exercise-select state and stat-hero cards to the Home/log screen

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Noam's log screen tracks whether an exercise has been explicitly chosen,
showing a distinct empty-state prompt ("מה עשינו היום?") when it hasn't, and
styles the est-1RM/best-hold stat cards with a `.stat-hero` accent.
Community's `renderLogTab` reads `selected.name` unconditionally with no
chosen/unchosen branch and no stat-hero styling.

## Acceptance criteria

- [x] Community's `renderLogTab()` gains the chosen/unchosen branch and `.log-empty-
  hint` empty state.
- [x] Stat cards adopt `.stat-hero` styling.
- [x] No change to underlying data/state logic beyond the UI branch (data-
  correctness aspect of this gap is tracked separately, see COMM-360).

## Shipped 2026-09-03

`renderLogTab()` now guards on `movementById(selectedId)` at the top and
returns a `.exercise-select.log-empty-hint` prompt ("מה עשינו היום?" /
"בחירת תרגיל") instead of reading `selected.name`/`selected.category`
unconditionally. As COMM-360 (not built here) hasn't shipped yet,
`selectedId` still always defaults to `MOVEMENTS[0].id`, so this branch is
currently dead in production — it exists so the UI is already correct and
safe the moment COMM-360 starts actually leaving it unset, rather than
crashing on a null selection. Not exercisable by a runtime test today for
the same reason (no code path currently leaves `selectedId` unset); verified
by code review and by the full existing log-tab test suite (`app-flow`,
`superset-blocks`, `edit-navigation-guard`) continuing to pass unchanged.

The log screen's own est-1RM/best-hold/last-session stat cards
(`.stat-card`) now also carry `.stat-hero` (brass-tinted border/background,
a larger value) — scoped to this screen's three cards specifically, not
every `.stat-card` app-wide (progress/history keep the plain treatment).

## Location / evidence

- Community: `app.js:2139-2200` (`renderLogTab`)
- Noam reference: `app.js:3072-3145`

## Dependencies

- COMM-360

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
