# COMM-234 Phase 2 QA sweep and browser scenarios

Phase: 2
Agent: qa
Status: todo
Attendance-blocked: no

## User outcome

Phase 2 ships with the same CI guarantee Phase 1 had: every acceptance
criterion has an assertion, and all three CI jobs stay green.

## Acceptance criteria

- [ ] Every Phase 2 ticket's acceptance criteria has a matching test,
  cross-referenced by ticket id in the PR that closes it.
- [ ] Every new table Phase 2 schema adds (`weekly_recaps`,
  `onboarding_progress`, `member_contact_log`, and any other table landed
  under a "Needs from schema" section during the phase) gets the standard
  RLS boundary test, following the same per-table pattern used for the
  Phase 0 and Phase 1 handoffs in `docs/community/backlog.md`.
- [ ] Browser scenarios added for: create, join, and leave a challenge; RSVP
  to an event and see capacity update live; open the notification center and
  see a challenge and an event notification; run a combined search; open the
  members directory and follow someone from it; view and share a weekly
  recap; one-tap congratulate from the coach dashboard.
- [ ] Realtime scenarios (COMM-209, COMM-227) are covered with
  `test/helpers/mockSupabase.mjs` kept faithful to RLS, or explicitly flagged
  if genuine Postgres realtime cannot be simulated in CI, the same caveat
  already logged for Phase 0's local pgTAP gap.
- [ ] New dialogs (challenge create/edit, event create/edit, directory
  filter panel, push permission prompt, coach Congratulate confirm) get
  keyboard and focus tests per the standing qa rule: opener stored, first
  control focused, Tab and Shift+Tab trapped, Escape policy, focus restored
  on close.
- [ ] No regression in the existing suite or the browser checks.
- [ ] Every ticket that resolved a spec ambiguity in this run (COMM-208's
  "joined/completed" routing, COMM-216's companion-post comment design,
  COMM-224's Welcome-as-public-comment design) has a test that pins the
  chosen behavior, not just the acceptance criteria text.

## Frontend states

Not applicable. This ticket is the test and CI gate for every other Phase 2
state already specified in its own ticket.

## Client calls and contracts

- No new contract. Exercises every Phase 2 contract listed in
  `docs/community/contracts.md`.

## Validation rules and limits

- A ticket is not counted done until all three CI jobs pass on it, matching
  the standing qa rule.

## Migration outline

- None directly; may prompt a schema follow-up if a boundary test finds a
  gap, same as COMM-019/COMM-020 did in Phase 0.

## Dependencies

- Every Phase 2 ticket, COMM-201 through COMM-233.
