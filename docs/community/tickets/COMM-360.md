# COMM-360 Default selectedId/selectedWodId to unset with an explicit pick-one empty state

Phase: Design sync & audit remediation (2026-09-02)
Agent: unassigned (app.js core, outside the 15-agent community roster)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Community still defaults `selectedId`/`selectedWodId` to Back Squat/Fran on
every fresh load (and after "clear all data"), unlike Noam which now requires
an explicit choice. A user can save a set/WOD under the wrong exercise without
realizing they never actually chose one — a logged-data-correctness risk, not
just cosmetic.

## Acceptance criteria

- [ ] `selectedId`/`selectedWodId` default to unset; the log/WOD screens show an
  explicit "pick a movement / pick a WOD" prompt before the save action is
  enabled.
- [ ] A fresh load and post-"clear all data" state never shows a pre-filled Back
  Squat/Fran selection.

## Location / evidence

- `app.js:225` (`selectedWodId` default), `:187` (`selectedId` default),
  `:1567,1569` (reset in `clearAllData()`)
- Noam reference: `movementExplicitlyChosen` flag, empty-state prompt in
  `renderWodLogSection()`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
