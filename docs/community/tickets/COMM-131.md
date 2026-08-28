# COMM-131 Achievement definitions seed, non-attendance

Phase: 1
Agent: achievements
Status: todo
Attendance-blocked: partial

## User outcome

The club launches with a meaningful set of achievements across performance,
progress, consistency, community, and club identity, so status does not come
from performance alone.

## Acceptance criteria

- [ ] Seed rows for: first workout logged, 10, 25, 50, 100, 250 sessions
  (from logged entries), first Rx workout, first PR, PR count milestones,
  first pull-up class of moves if the data supports it, membership
  anniversary, first supportive reaction, first comment, 10 supportive
  interactions, helped welcome a new member, challenge completion, challenge
  winner.
- [ ] Each row has code, name, Hebrew-facing name, description, category,
  trigger type, threshold, repeatable, icon.
- [ ] Attendance-streak and attendance-milestone rows are seeded with
  `enabled` false, tied to COMM-P03.
- [ ] Community achievements are marked secondary and do not fire on trivial
  spammy repetition.
- [ ] Seed is idempotent on re-run.

## Frontend states

Not applicable. Data seed.

## Client calls and contracts

- None. Rows read by `ach_evaluate` and the achievements UI.

## Validation rules and limits

- `category` in the allowed set. `code` lower snake case.

## Migration outline

- Seed inserts in a migration, `on conflict (code) do update`.

## Dependencies

- COMM-004.
- Attendance rows parked disabled, see COMM-P03.
