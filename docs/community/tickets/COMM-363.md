# COMM-363 Add browser-check scenarios for post composition and report moderation

Phase: Design sync & audit remediation (2026-09-02)
Agent: qa
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

The Playwright suite has grown to 24 scenarios with real community-flow
coverage (challenges, RSVP, directory follow, coach dashboard), but creating a
post — Community's single most-used action — and any moderation/report-review
flow have no real-browser coverage, only unit tests against a mocked Supabase
client.

## Acceptance criteria

- [ ] A `browser-check` scenario for composing and publishing a post end-to-end.
- [ ] A `browser-check` scenario for an admin reviewing and actioning a report end-
  to-end.
- [ ] Both pass in `run-all.mjs` alongside the existing 24 scenarios.

## Location / evidence

- `scripts/browser-check/*.mjs` (24 existing scenario files)
- Existing unit-only coverage: `test/community-composer.test.mjs`, `community-
  post-actions.test.mjs`, `community-moderation.test.mjs`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
