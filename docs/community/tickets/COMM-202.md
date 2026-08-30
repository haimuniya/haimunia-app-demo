# COMM-202 Individual target and individual performance challenges

Phase: 2
Agent: challenges
Status: todo
Attendance-blocked: no

## User outcome

A member sees their personal progress toward a target, whether it is a
session count to hit or a performance number to chase.

## Acceptance criteria

- [ ] `individual_target` shows a progress bar: `progress_value` over
  `target_value` (for example, 12 sessions this month).
- [ ] `individual_performance` shows a running numeric total against
  `target_value` (for example, 20 km rowing) and can exceed 100%; the bar
  caps visually at 100% but the number keeps counting.
- [ ] Progress is written as a `challenge_progress` insert (own row, active
  participant, existing policy) whenever the member logs a qualifying
  workout, PR, or manual entry, sourced from the same client-side detection
  `ach_claim` already uses for non-attendance milestones.
- [ ] The `challenge_progress_apply` trigger (see contracts, "Needs from
  schema, challenges") keeps `challenge_participants.progress_value` in sync
  and flips `status` to `completed` with `completed_at` stamped the first
  time `progress_value >= target_value`.
- [ ] Reaching the target does not remove the challenge from the member's
  list; it shows a completed state and a Share Progress action.
- [ ] `CHALLENGE_COMPLETED` is emitted once, on the transition to completed,
  never again on a later contribution.

## Frontend states

- Empty: joined but no contribution yet shows "עדיין לא נרשמה התקדמות."
- Loading: skeleton progress bar.
- Error: "לא ניתן היה לעדכן את ההתקדמות."
- Populated: progress bar plus the numeric value and target.

## Client calls and contracts

- Direct RLS insert into `challenge_progress` (existing policy).
- `chal_progress(challenge_id)` for the read side.
- Consumes `WORKOUT_COMPLETED` and `PR_CREATED` from the event bus (COMM-012).

## Validation rules and limits

- `delta` in `challenge_progress` is append-only; a correction is a
  compensating negative delta, never an update.
- Insert requires `is_community_member()` and an active participant row,
  enforced server-side already.

## Migration outline

- `challenge_progress_apply` trigger, see "Needs from schema, challenges" in
  `docs/community/contracts.md`. schema lands it.

## Dependencies

- COMM-201, COMM-006, COMM-012.
