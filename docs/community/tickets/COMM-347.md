# COMM-347 Promote high-traffic classless inline components in cloud.js into real CSS classes

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

~19 community-only class names (`coach-badge`, `pr-badge`, `notif-group`,
`post-menu`, `progress-track`, etc.) have zero corresponding CSS rule — every
instance re-declares its look inline, in some cases (badges) duplicating an
identical style string at 2-3 independent call sites.

## Acceptance criteria

- [ ] The ~10 highest-traffic one-off inline styles (badge, progress bar, menu,
  notif group) promoted into real CSS classes in `index.html`, mirroring how
  `.post-card`/`.comment-row`/`.avatar-badge` were already promoted.
- [ ] `coach-badge`/`pr-badge` share one `.badge-tag` rule; `.progress-track` has
  one definition.
- [ ] Inline `style=` on these elements retains only truly dynamic values
  (widths/colors computed at render time).

## Location / evidence

- `cloud.js:3913` (coach-badge), `:5037,:5057` (pr-badge, duplicated), `:3907`
  (reaction-strip), `:9020,:9029` (notif-group), `:4943,:4956,:4958` (post-
  menu), `:5104,:5247` (progress-track, duplicated), `:8306` (badge-grid)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
