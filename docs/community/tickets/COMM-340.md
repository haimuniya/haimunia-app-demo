# COMM-340 Add interactive-widget=resizes-content to the viewport meta

Phase: Design sync & audit remediation (2026-09-02)
Agent: unassigned (app.js core, outside the 15-agent community roster)
Status: done
Priority: P1
Attendance-blocked: no

## Problem / user outcome

On Android Chrome, focusing a text/number input leaves `position:fixed`
elements (the save bar, modal chrome) floating over the on-screen keyboard
instead of the layout resizing around it — reproduced and fixed in Noam on a
real device by adding `interactive-widget=resizes-content` to the viewport
meta. Community's viewport meta is missing the same directive.

## Acceptance criteria

- [x] `interactive-widget=resizes-content` added to Community's viewport meta tag.
  Already present (landed in e5fe413 alongside the P0 fixes; this ticket's own
  status just hadn't been bumped) - now pinned by a source assertion in
  `test/design-sync-audit-app-core.test.mjs`, which nothing did before.
- [ ] Verified on Android Chrome: focusing any text/number input no longer leaves
  fixed UI floating with an exposed gap beneath it. **Not done** - no real
  Android device or browser access from this environment.

## Location / evidence

- `index.html:46` (current viewport meta, missing the directive)
- Fixed UI affected: `.bottom-bar` (`index.html:238`), every `.modal-overlay`
  (`index.html:258`)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
