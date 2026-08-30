# COMM-222 New member onboarding sequence, non-attendance steps

Phase: 2
Agent: recaps
Status: todo
Attendance-blocked: partial

## User outcome

A brand-new member is walked through a short, useful sequence in their first
weeks instead of landing in an empty community with no orientation.

## Acceptance criteria

- [ ] Day 1: a dismissible welcome step pointing at the feed and how to post,
  shown once, on the member's first community session after `MEMBER_JOINED`.
- [ ] After the first week: a step surfacing the current active challenge
  (COMM-207's list), shown once.
- [ ] After the first month: a step showing the member's own first monthly
  progress summary, built from the same data COMM-220's weekly recaps
  aggregate over the period, not the Phase 3 club-wide monthly recap.
- [ ] Steps tied to the member's first and third class are explicitly
  deferred: not built here, carry a TODO tied to COMM-P07 and COMM-316, and
  do not block the three steps above from shipping.
- [ ] Each step fires exactly once per member, idempotent across repeat
  logins, tracked server-side so a new device does not re-show a step
  already seen.
- [ ] Dismissing a step early does not block the next one from appearing on
  schedule.

## Frontend states

- Empty: not applicable, a step either has not reached its trigger time or
  has already been shown.
- Loading: the step card shows a skeleton on first paint.
- Error: a failed dismiss-write retries silently on next load rather than
  showing an error to a brand-new member.
- Populated: the step card with its specific content and a Dismiss control.

## Client calls and contracts

- Direct RLS select/update on `onboarding_progress`, own row. See "Needs from
  schema, recaps" in `docs/community/contracts.md`.
- Consumes `MEMBER_JOINED` from the event bus (COMM-012) to know when the
  clock starts.

## Validation rules and limits

- A step is marked shown only after the member has actually seen it
  (rendered), not merely scheduled.

## Migration outline

- `onboarding_progress` table, own-row select and update, row seeded at
  `MEMBER_JOINED` time. See "Needs from schema, recaps". schema lands it.

## Dependencies

- COMM-005, COMM-012, COMM-207, COMM-220.
