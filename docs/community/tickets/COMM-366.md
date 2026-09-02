# COMM-366 Spike scoped/keyed rendering as an alternative to cloud.js's full-tree innerHTML rerender

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Every state mutation triggers a full `innerHTML` rebuild of the visible tab
(341 `rerender()` call sites), which is expensive enough that a ~60-line
manual DOM-focus-restoration subsystem (`syncCloudDialogFocus`) exists purely
to compensate. This is a scaling risk as Phase 2/3 (challenges, events,
recaps, coach dashboard) add more UI on top of the same pattern.

## Acceptance criteria

- [ ] A design note or spike evaluates scoping rerenders to the changed panel (or a
  lightweight keyed-diff approach) instead of the whole tab.
- [ ] Either a migration plan is proposed, or an explicit documented decision is
  made to keep full-rerender with known limits.

## Location / evidence

- `cloud.js:9655` (`syncCloudDialogFocus`), `:9573-9605` (`CLOUD_DIALOGS`
  registry)
- `grep -c "rerender()" cloud.js` → 341

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
