# COMM-341 Add a monthly stats summary, legend, and card chrome to the calendar screen

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Noam's calendar wraps the month grid in a bordered/shadowed `.cal-panel` card,
adds a legend row explaining the dot markers, and a 3-column monthly stats
summary (training days / total sets / PR days). Community has none of these —
the grid floats directly on the page background with no informational summary,
which is a real feature loss, not just a styling gap.

## Acceptance criteria

- [ ] `.cal-panel` card wrapper, `.cal-legend`, and `.cal-month-stats` (training
  days / total sets / PR days) added to Community's calendar screen.
- [ ] Stats computation ported from Noam's `renderCalendarGrid()`.

## Location / evidence

- Community: `app.js:2635-2652` (`renderCalendarTab`)
- Noam reference: `app.js:3754-3776`, `:3509-3520` (`renderCalendarGrid`)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
