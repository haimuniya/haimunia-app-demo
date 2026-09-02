# COMM-324 Port Noam's two-card WOD Builder layout with pinned footer

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Community's WOD Builder modal is the pre-redesign flat layout with the create
button placed mid-form — exactly the placement problem Noam's own code comment
says it fixed by pinning the create button to a footer. Format chips also lost
their descriptive subtitles.

## Acceptance criteria

- [ ] WOD Builder markup restructured into Noam's two-card layout (`.wodbuild-card-
  details` + `.wodbuild-card-moves`).
- [ ] "צור אימון" create button becomes a pinned footer (`.wodbuild-foot`),
  reachable regardless of scroll position.
- [ ] Format chips regain descriptive subtitles (e.g. "זמן" / "כמה מהר סיימתם").
- [ ] Existing WOD-builder tests pass; no regression to `renderWodBuilderFormats()`
  behavior.

## Location / evidence

- Community: `index.html:701-729` (flat `.modal-list` layout)
- Noam reference: `index.html:1347-1394`, `.wodbuild-*` CSS rules

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
