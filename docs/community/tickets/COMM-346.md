# COMM-346 Add a .chip-btn.danger modifier and remove inline destructive-button styling

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

There is no shared "this action is destructive" chip style — destructive
actions are styled 3 different ad hoc ways in `cloud.js`, including an
identical full red-fill inline style string duplicated verbatim at two
separate call sites.

## Acceptance criteria

- [ ] `.chip-btn.danger` added to the shared stylesheet.
- [ ] All inline `color:var(--red)`/`background:var(--red)` overrides on `.chip-btn`
  in `cloud.js` replaced with the new modifier.
- [ ] `grep` for inline red overrides on `.chip-btn` in `cloud.js` returns 0
  results.

## Location / evidence

- `cloud.js:4146, 4059, 4943` (inline red text)
- `cloud.js:3348, 9234` (duplicated full red-fill inline style)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
