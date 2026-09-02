# COMM-325 Finish the .chip-btn.primary / .selected migration for filter and toggle chips

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

`index.html` documents that `.chip-btn.primary` used to double as both "submit
action" and "currently selected," which read as confusing, and that
`.selected` (brass outline) was added to fix it for feed scope, leaderboard
scope, and mod-queue status. That migration was left half-finished: roughly a
dozen other selection UIs (moderation audit filters, admin analytics toggles,
post visibility picker, challenge/event type pickers, RSVP, notification
preferences, mod-action duration picker, post comparison toggle) still flip to
`.primary` when active.

## Acceptance criteria

- [ ] Every selection-state (filter/toggle chip currently active) call site in
  `cloud.js` uses `.selected` instead of `.primary`.
- [ ] `.chip-btn.primary` remains reserved for true submit/action buttons only.
- [ ] No visual regression to the already-fixed call sites (feed scope, leaderboard
  scope, mod-queue status).

## Location / evidence

- `cloud.js:4098-4099, 4201, 4653-4654, 4669, 5007, 6219, 6888, 7090-7091, 7040,
  9108, 9223, 9403` (still using `.primary` for selection)
- Already-correct reference pattern: `cloud.js:3529, 9388-9389, 4032`
- Rationale comment: `index.html:449-455`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
