# COMM-323 Port Noam's card-based Settings screen redesign

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Community's Settings screen (`renderSettingsBody`) still renders the pre-
redesign layout (`.divider-label`/`.card`/`.footer-note`), while Noam's
`renderSettingsModalBody` has a card-based redesign (profile card, `.settings-
block` sections, icon buttons, styled danger-zone confirm) that never made it
into Community.

## Acceptance criteria

- [ ] Community's Settings screen uses the `.settings-pane`/`.settings-
  block`/profile-card/icon-button component set instead of `.divider-
  label`/`.card`/`.footer-note`.
- [ ] Community-only rows (cloud/backup panel, Privacy/Terms legal links) are
  preserved as additional sections in the new visual language, not dropped.
- [ ] The cloud-aware backup-staleness threshold (5/30-day split, see COMM-355) is
  carried into the new `.settings-warn` component rather than reverting to
  Noam's flat 21-day rule.
- [ ] Existing settings-related tests (`test/*.mjs`) still pass; screen remains
  keyboard/focus-trap accessible (see COMM-341).

## Location / evidence

- Community: `app.js:2797-2858` (`renderSettingsBody`)
- Noam reference: `app.js:4022-4087` (`renderSettingsModalBody`), plus
  `.settings-*` CSS rules in Noam's `index.html`

## Dependencies

- COMM-355

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
