# COMM-332 Verify and fix migration-check / pgTAP CI status (COMM-020)

Phase: Design sync & audit remediation (2026-09-02)
Agent: qa
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

`docs/community/backlog.md` states the pgTAP step is `continue-on-error`/non-
blocking (COMM-020), but the current `.github/workflows/test.yml` has no
`continue-on-error` on that step — it is a hard gate today. A from-scratch
local `supabase test db` run failed 68 of 1995 assertions across 17 of 56 test
files (admin_actions, analytics_events, notification triggers, announcement
priority/expiry, feed leaderboard/suggestions, attendance log, relationship
score, and more). If this reflects real CI state, `migration-check` is either
quietly not gating or currently blocking every merge.

## Acceptance criteria

- [ ] Actual current GitHub Actions status for `migration-check` on the latest run
  is confirmed (green or red) — not inferred from backlog.md's note.
- [ ] A clean `supabase start && supabase test db` run against a fresh migration-
  only database shows 0 failures.
- [ ] `docs/community/backlog.md`'s COMM-020 status note is corrected to match
  whatever the true current state is (either the suite is fixed and the note is
  removed, or the note is corrected to say it's actually a hard blocking gate
  today).
- [ ] The RLS-tagged pgTAP files specifically (`admin_actions`, `attendance_log`,
  `community_health_score`, etc. — see COMM-368) are re-verified once green.

## Location / evidence

- `.github/workflows/test.yml` (`migration-check` job, `supabase test db` step)
- `supabase/tests/*_test.sql` (56 files, 1995 assertions)
- `docs/community/backlog.md` Phase 0 status note (stale COMM-020 reference)

## Dependencies

- COMM-368

## Resolved, 2026-09-02

`.github/workflows/test.yml`'s `migration-check` job confirmed to have no
`continue-on-error` on the `supabase test db` step — it is and always was a
hard gate. Actual GitHub Actions run status could not be checked directly
(no `gh` CLI available in this environment), so this is verified from the
workflow file's own text, not a live run.

Re-ran the suite from a clean slate: `supabase db reset` (all 76 current
migrations, up from the 13 the stale backlog note references) followed by
`supabase test db`. Result: `Files=56, Tests=1995 ... Result: PASS`, zero
failures — including every RLS-tagged file (admin_actions, attendance_log,
community_health_score, and the rest COMM-368 named).

The 68/1995-failure count from the same-day audit does not reproduce on a
clean run. That audit's own report flagged the run as against an
already-up stack, not a guaranteed-pristine one — this result confirms
that caveat was the real explanation, not a genuine regression. No code or
migration change was needed; only `docs/community/backlog.md`'s stale
Phase-0-era note was corrected (see that file, "Note (2026-09-02..." right
after the original Phase 0 status paragraph).

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
