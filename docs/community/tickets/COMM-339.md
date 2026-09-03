# COMM-339 Reset confirmClear when the Settings modal closes

Phase: Design sync & audit remediation (2026-09-02)
Agent: unassigned (app.js core, outside the 15-agent community roster)
Status: done
Priority: P1
Attendance-blocked: no

## Problem / user outcome

The armed "delete everything" confirmation (`confirmClear`) is set true when
the user taps the delete button, but is only reset inside `clearAllData()`
itself or by explicit cancel — not when the Settings sheet is simply closed. A
user who backs out of the delete flow and later reopens Settings for an
unrelated reason sees the destructive confirm row still showing, one tap away
from wiping all data with no fresh warning.

## Acceptance criteria

- [x] `confirmClear` is reset to `false` inside `closeSettings()`.
- [x] Closing/reopening Settings after tapping "מחיקת כל הנתונים" but not confirming
  or cancelling always shows the initial (non-armed) button.

## Location / evidence

- `app.js:253` (`let confirmClear = false`)
- `app.js:3807` (set true), `:3809` (`cancel-clear`), `:1579` (reset inside
  `clearAllData()`)
- `app.js:3493-3501` (`closeSettings()`, does not reset it)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
