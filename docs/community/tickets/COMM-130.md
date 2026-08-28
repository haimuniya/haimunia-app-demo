# COMM-130 Achievement engine, non-attendance triggers

Phase: 1
Agent: achievements
Status: todo
Attendance-blocked: partial

## User outcome

The system detects when a member earns an achievement and records it once,
from real training and community activity.

## Acceptance criteria

- [ ] `ach_evaluate(user_id, trigger, payload)` runs on these triggers:
  WORKOUT_COMPLETED, PR_CREATED, MEMBER_JOINED, COMMENT_CREATED,
  REACTION_CREATED, CHALLENGE_COMPLETED.
- [ ] It returns the codes newly unlocked and inserts `member_achievements`,
  once per non-repeatable definition.
- [ ] Session-count achievements use logged workout and WOD entries, not
  verified attendance.
- [ ] ATTENDANCE_RECORDED is accepted but performs no evaluation yet, tied to
  COMM-P03.
- [ ] Consistency logic tolerates a three-times-per-week pattern and does not
  reset a streak for a non-daily schedule.
- [ ] An `ACHIEVEMENT_UNLOCKED` event is emitted for each new unlock.
- [ ] Re-running the same trigger with the same payload is idempotent.

## Frontend states

Not applicable. Server engine. Surfaced through COMM-134.

## Client calls and contracts

- `ach_evaluate(user_id uuid, trigger text, payload jsonb) returns setof
  text`.
- Consumes the event bus from COMM-012.

## Validation rules and limits

- Evaluation is service role only, never called directly by the browser.

## Migration outline

- `ach_evaluate` function. schema lands it alongside COMM-004.

## Dependencies

- COMM-004, COMM-012.
- Attendance-triggered rules parked, see COMM-P03.
