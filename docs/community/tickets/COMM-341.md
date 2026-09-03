# COMM-341 Add a monthly stats summary, legend, and card chrome to the calendar screen

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Noam's calendar wraps the month grid in a bordered/shadowed `.cal-panel` card,
adds a legend row explaining the dot markers, and a 3-column monthly stats
summary (training days / total sets / PR days). Community has none of these —
the grid floats directly on the page background with no informational summary,
which is a real feature loss, not just a styling gap.

## Acceptance criteria

- [x] `.cal-panel` card wrapper, `.cal-legend`, and `.cal-month-stats` (training
  days / total sets / PR days) added to Community's calendar screen.
- [x] Stats computation *equivalent to* Noam's `renderCalendarGrid()` (see
  Shipped note below — not a literal port, since `crossfit-pwa-Noam` isn't
  checked out in this workspace).

## Location / evidence

- Community: `app.js:2635-2652` (`renderCalendarTab`)
- Noam reference: `app.js:3754-3776`, `:3509-3520` (`renderCalendarGrid`)

## Shipped 2026-09-03

`crossfit-pwa-Noam` is not checked out in this workspace, so its actual
`renderCalendarGrid()` stats formula couldn't be read — the ticket's own
title and problem statement name the three figures (training days / total
sets / PR days), which was enough to implement a real equivalent rather
than guess at Noam's exact algorithm:

- `.cal-panel` now wraps the header, weekday row, grid, `.cal-legend`, and
  `.cal-month-stats` in one bordered/shadowed card, matching every other
  data surface (`.card`/`.chart-card`) in this app.
- `.cal-legend` explains the two dot markers already on the grid (a plain
  steel dot for "יש נתונים", a brass one for "שיא אישי").
- New `computeCalendarMonthStats(year, month)` (`app.js`, next to
  `renderCalendarGrid()`) computes: training days (distinct dates in the
  month with a strength entry or WOD entry), total sets (count of strength
  `entries` in the month — a WOD session is a different unit of work and
  isn't folded in), and PR days (distinct dates with at least one PR).
  Recomputed on every month nav the grid itself already handles
  (`#calMonthStats` updated inside `renderCalendarGrid()`).
- Verified via `test/calendar.test.mjs` (unaffected — its `.cal-dot`
  assertions are scoped to the day-cell button, not the new legend's own
  `.cal-dot` icons) and a direct render check confirming the panel, legend,
  and correct stat values (1/1/1 after logging one PR set) all appear.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
