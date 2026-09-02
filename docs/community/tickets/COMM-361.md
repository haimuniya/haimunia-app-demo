# COMM-361 Darken light-theme --brass or add a higher-contrast text variant

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Light-theme `--brass` on `--surface` measures ~4.22:1, below the 4.5:1 WCAG AA
threshold for normal text, and is used at 13-14px bold for PR/1RM stat values
and (newly in Community) leaderboard/badge/priority text — meaningful numeric
data, not decoration.

## Acceptance criteria

- [ ] Light-theme `--brass` darkened (or a dedicated higher-contrast text variant
  introduced) until it measures ≥4.5:1 against `--surface` and `--bg`.
- [ ] An automated contrast check passes for every `color:var(--brass)` text usage
  in both themes.

## Location / evidence

- `index.html:86` (token)
- Usage: `app.js:1808-1814,2156-2181,2229-2235,2383,2666-2707,2770,3151-3187`;
  `cloud.js:898,3371-3372,3551-3552`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
