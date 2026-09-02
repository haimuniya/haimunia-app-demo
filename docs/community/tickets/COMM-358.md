# COMM-358 Add roving-tabindex and Arrow-key support to all role="tablist" groups

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

The main bottom-nav, WOD sub-tabs, and (new in Community) the feed scope
filter are all marked up with `role="tab"`/`role="tablist"` (correctly paired
with `aria-selected`), which sets an assistive-technology user's expectation
of Arrow-key navigation between tabs. No Arrow/Home/End handling exists
anywhere in either repo.

## Acceptance criteria

- [ ] A shared roving-tabindex/Arrow-key controller added for all `role="tablist"`
  groups (main nav, WOD sub-tabs, community feed filters).
- [ ] Arrow keys move selection and focus within each tablist; Home/End jump to
  first/last tab; only the active tab remains a Tab stop.

## Location / evidence

- `app.js:136` (main nav), `:3343-3346` (WOD sub-tabs)
- `cloud.js:9387-9389` (feed scope filter, new instance)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
