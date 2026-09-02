# COMM-349 Migrate the remaining 8 dialogs onto Community's dialog registry and narrow the focusable selector

Phase: Design sync & audit remediation (2026-09-02)
Agent: unassigned (app.js core, outside the 15-agent community roster)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Same underlying gap as COMM-328, filed by a second audit pass independently: 8
of 9 core dialogs lack Escape/Tab-trap handling, and `appDialogFocusables()`'s
selector has the same bare `[href]` issue Noam already fixed (narrowed to
`a[href]`), which will falsely include non-interactive `<use href>` medal SVG
elements once those dialogs are migrated.

## Acceptance criteria

- [ ] Tracked as a duplicate of COMM-328 — verify COMM-328's acceptance criteria
  explicitly include the `[href]` -> `a[href]` selector narrowing before closing
  both.

## Location / evidence

- Same locations as COMM-328

## Dependencies

- COMM-328

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
