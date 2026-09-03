# COMM-323 Port Noam's card-based Settings screen redesign

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Community's Settings screen (`renderSettingsBody`) still renders the pre-
redesign layout (`.divider-label`/`.card`/`.footer-note`), while Noam's
`renderSettingsModalBody` has a card-based redesign (profile card, `.settings-
block` sections, icon buttons, styled danger-zone confirm) that never made it
into Community.

## Acceptance criteria

- [x] Community's Settings screen uses the `.settings-pane`/`.settings-
  block`/profile-card/icon-button component set instead of `.divider-
  label`/`.card`/`.footer-note`.
- [x] Community-only rows (cloud/backup panel, Privacy/Terms legal links) are
  preserved as additional sections in the new visual language, not dropped.
- [x] The cloud-aware backup-staleness threshold (5/30-day split, see COMM-355) is
  carried into the new `.settings-warn` component rather than reverting to
  Noam's flat 21-day rule.
- [x] Existing settings-related tests (`test/*.mjs`) still pass; screen remains
  keyboard/focus-trap accessible (untouched - only `renderSettingsBody()`'s
  own markup changed, not `openSettings()`/the dialog registry around it).

## Shipped 2026-09-03

`crossfit-pwa-Noam` is not checked out in this workspace, so Noam's actual
`.settings-*` CSS couldn't be copied verbatim - the ticket's own evidence
names the component set (`.settings-pane`/`.settings-block`/profile
card/icon buttons/styled danger zone) but not Noam's exact values. Built the
same shape from this app's own already-established components instead of
guessing at Noam's pixels:

- `.settings-pane` (a `flex column` list of sections) replaces the old
  `.divider-label` + bare `.card` alternation.
- The profile card reuses `.who` verbatim - the exact avatar+name component
  the nav menu already renders - rather than a near-duplicate, plus a
  trailing `.icon-chip.icon-chip-steel` edit button (COMM-345's icon-button
  convention) where a plain `.link-btn` text link stood before.
- `.settings-block` (card elevation + a `.settings-block-title` heading)
  groups Appearance, the cloud/backup panel, Data & Backup, Legal, and the
  Danger Zone - every existing Community-only row (cloud/backup panel,
  Privacy/Terms links) preserved as its own section, nothing dropped.
- The danger-zone confirm now uses `.chip-btn.danger`/`.chip-btn.primary.danger`
  (COMM-346, built alongside this ticket) instead of hand-rolled inline red
  styles.
- `test/audit-ux-fixes.test.mjs`'s destructive-button test used to regex-
  match the old inline style string verbatim; rewritten to render the real
  Settings screen and assert the `.danger` class instead, same intent.
  `test/community-backup-sync.test.mjs`'s source-slice check of the
  cloud-aware threshold logic (COMM-355) needed no change - that logic
  itself is untouched, only its presentation.

## Location / evidence

- Community: `app.js:2797-2858` (`renderSettingsBody`)
- Noam reference: `app.js:4022-4087` (`renderSettingsModalBody`), plus
  `.settings-*` CSS rules in Noam's `index.html`

## Dependencies

- COMM-355

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
