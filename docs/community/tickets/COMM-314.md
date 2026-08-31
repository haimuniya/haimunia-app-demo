# COMM-314 Versioned abandoned-profile purge Edge Function and runbook

Phase: 3
Agent: identity-privacy
Status: todo
Attendance-blocked: no

`docs/community/contracts.md` already carries a stub for this ticket's Edge
Function (`purge_abandoned_profiles`: "Schedule: daily. Versioned.
Idempotent. Purpose: remove abandoned anonymous profiles per the retention
rule.") — this ticket is that stub, built out. Not to be confused with
`purge_due_accounts()` (202608260001), which already ships and purges a
member's own *explicit* deletion request 30 days after they ask
(PRIVACY.md's "schedules permanent removal after 30 days"). This ticket is a
different, new category: an anonymous account that never asked for anything
because it never became a real member — `auth.users.is_anonymous = true`,
created by `signInAnonymously()`, that never redeemed an invite and never
called `mark_recovery_verified()`, sitting with nothing to lose because it
was never a person's real account to begin with.

## User outcome

An anonymous session someone opened once and never came back to does not sit
in the database forever as an orphaned row nobody is responsible for.

## Acceptance criteria

- [ ] `purge_abandoned_profiles` identifies an "abandoned" account as: real
  `auth.users.is_anonymous = true`, no `invite_redemptions` row for that
  user, no `profiles.recovery_verified_at`, and `auth.users.created_at`
  older than a named retention window — the exact window is not settled by
  this ticket, see "Open question" below; the function reads it from one
  named constant so a later change is a one-line edit, not a redeploy of
  logic.
- [ ] "Versioned" means the function carries an explicit version identifier
  in its own logs/output, so a later change to the abandonment criteria is
  distinguishable in the success/failure record from a run under the old
  rule — the same spirit as `SCHEMA_VERSION` in the analytics helper, one
  more place a definition can change without silently reinterpreting old
  runs.
- [ ] Idempotent: a re-run finds nothing left to purge for an account
  already removed and does nothing, same shape `purge_due_accounts()`
  already has.
- [ ] Runs daily, service-role only, same auth posture `recap_weekly`
  already established (explicit `Authorization: Bearer <service role key>`
  check inside the function body, not just platform `verify_jwt`).
- [ ] A member who redeems an invite or verifies recovery at any point,
  even the day before the window would have closed, is never eligible —
  the two checks (`invite_redemptions`, `recovery_verified_at`) both have
  to be genuinely absent, not merely old.
- [ ] Removal deletes the `auth.users` row (cascading through `profiles`
  and everything foreign-keyed to it, the same cascade shape
  `purge_due_accounts()` already relies on), not a soft-delete — there is
  nothing to preserve for an account that was never redeemed.
- [ ] Records success and failure counts with no personal content in its
  logs, matching `recap_weekly` and `purge_due_accounts`'s existing
  discipline.
- [ ] A short runbook (`docs/community/attendance-purge-runbook.md` or
  folded into an existing ops doc, planner's call at build time) documents:
  how to run it manually, how to change the retention window safely, how
  to verify a run's counts, and what to do if the count looks wrong before
  the next scheduled run — the "runbook" half of this ticket's own title,
  not optional.

## Frontend states

Not applicable. Scheduled server function with no client surface.

## Client calls and contracts

- Not client-invoked. Runs as a scheduled Edge Function, service role only.

## Validation rules and limits

- The retention window is a named constant, not a client parameter or a
  database-configurable value reachable by any client role.
- No client, staff included, can trigger a purge run directly through the
  app — this is an ops-invoked or scheduled-only function, matching
  `purge_due_accounts()`'s existing `service_role`-only grant.

## Migration outline

- No new table. `purge_abandoned_profiles` is a new Edge Function
  (`supabase/functions/purge_abandoned_profiles/index.ts`), reading
  `auth.users`, `invite_redemptions`, and `profiles` directly with the
  service-role key (which bypasses RLS, same posture `recap_weekly`
  already uses for its own service-role writes).

## Dependencies

- COMM-016, COMM-017, the existing `purge_due_accounts()` function
  (202608260001), COMM-220 (the Edge Function auth pattern to follow).

## Open question — resolved 2026-08-31

The retention window (how long an unredeemed, unverified anonymous account
sits before it is eligible) was not stated anywhere in this repo's docs.
**Confirmed with the user: 30 days**, matching the existing
`purge_due_accounts()` window. Build against this value.
