# COMM-326 Fix hardcoded dark popover background in post menu and mention picker

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

The post action menu (⋯) and the @mention autocomplete picker hardcode
`background:#1f2023`, a literal near-black hex, so both render as a dark
popover regardless of the active theme — every other overlay in the app
resolves its surface color from `var(--surface)`/`var(--surface2)`.

## Acceptance criteria

- [ ] `#1f2023` replaced with `var(--surface)` (or `var(--surface2)`) in both
  `.post-menu` and `.mention-picker`.
- [ ] The `rgba(255,255,255,.06)` hover highlight replaced with a theme-aware
  equivalent (`var(--surface2)` or a `color-mix()` tint).
- [ ] Both menus visually match the active theme in light and dark mode, consistent
  with `.modal-sheet`.

## Location / evidence

- `cloud.js:3964` (`.mention-picker`)
- `cloud.js:4958` (`.post-menu`)
- `cloud.js:3962` (hover highlight)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
