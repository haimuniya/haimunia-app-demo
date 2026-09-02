# COMM-322 Restore --shadow-sm design token

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Community's `.subtabbtn.active` and `.rx-btn.active-type` silently lost their
box-shadow when `--shadow-sm` was dropped from `:root` during a prior
redesign, with no comment or changelog entry explaining the removal.

## Acceptance criteria

- [ ] `--shadow-sm` re-added to `:root` (light and dark blocks) in `index.html`,
  matching Noam's values or an intentionally updated elevation language.
- [ ] `box-shadow:var(--shadow-sm)` re-applied to `.subtabbtn.active` and `.rx-
  btn.active-type`.
- [ ] Visual check: active sub-tab and active Rx/Scaled chip both show a visible
  shadow in both themes.

## Location / evidence

- `index.html` `:root` block (token definitions)
- `index.html` `.subtabbtn.active`, `.rx-btn.active-type` rules
- Reference: `crossfit-pwa-Noam/index.html:94,117,129,153,510,1130`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
