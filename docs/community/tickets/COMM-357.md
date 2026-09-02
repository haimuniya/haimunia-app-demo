# COMM-357 Replace hardcoded rgba tints in announcement badges and coach comment highlight with color-mix()

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Announcement priority badges and the coach-authored comment highlight hardcode
literal rgba tints matching `--red`/`--brass`'s light-theme values only. In
dark theme those tokens change but the hardcoded tints don't, so the
badge/highlight background silently stops matching its own border and text
color once dark mode is active — the `color-mix()` pattern already established
for `.icon-chip-*` exists specifically to avoid this.

## Acceptance criteria

- [ ] Hardcoded rgba tints in `announcementPriorityBadge`/`announcementAccentStyle`
  and the coach comment row replaced with `color-mix(in srgb, var(--red) 16%,
  transparent)` / `var(--brass)` equivalents.
- [ ] Announcement priority badges and coach-highlighted comments visually match
  their token color in both themes.

## Location / evidence

- `cloud.js:897-898, 907-908` (announcement badges)
- `cloud.js:3930` (coach comment highlight)
- Reference pattern: `index.html:241-254`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
