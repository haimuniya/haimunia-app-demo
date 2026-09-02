# COMM-338 Run the pgTAP suite in CI and add a multi-role live smoke test before deploy

Phase: Design sync & audit remediation (2026-09-02)
Agent: qa
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

This audit (and the two before it) was static-only — no live Supabase
connection was made, and the repo's own pgTAP suite was not executed as part
of prior sign-off. SQL that reads correctly in isolation can still diverge
from what's actually enforced in production if migrations were applied out of
order or manually.

## Acceptance criteria

- [ ] CI runs the full pgTAP suite (`supabase/tests/`) against a disposable,
  migration-only database on every migration change.
- [ ] A multi-role live smoke test (anonymous, member, coach, admin, blocked user)
  runs against staging before go-live.
- [ ] The build fails on any red RLS test.

## Location / evidence

- `supabase/tests/*.sql` (~19+ files)

## Dependencies

- COMM-332

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
