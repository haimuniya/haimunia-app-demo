# COMM-205 Consistency challenge on non-attendance metrics

Phase: 2
Agent: challenges
Status: todo
Attendance-blocked: no

## User outcome

A member tracks a "train N times a week for M weeks" pattern using their
logged workouts, without needing verified class attendance.

## Acceptance criteria

- [ ] `consistency` challenge type config carries `{times_per_week, weeks}`.
- [ ] Each ISO week the member logs at least `times_per_week` sessions counts
  as a week hit; the count is derived from the member's own logged workout
  and WOD entries, the same non-attendance source COMM-202 and the
  achievement engine use.
- [ ] A week that falls short does not fail the whole challenge; it simply
  does not count, matching the tolerant streak logic already specified for
  achievements (COMM-130).
- [ ] `chal_progress.my_progress` reports weeks hit out of total weeks in the
  challenge window.
- [ ] The challenge is explicitly non-attendance in Phase 2, resolved
  2026-08-30: it stays this way, it is not blocked, and it is not upgraded to
  verified attendance here. COMM-306 (Phase 3) re-bases the same UI on
  verified attendance once that source exists; this ticket's data model does
  not need to change for that swap.
- [ ] Completing all required weeks marks the participant `completed`.

## Frontend states

- Empty: joined but week one not yet evaluated shows "השבוע הראשון בעיצומו."
- Loading: skeleton week-by-week tracker.
- Error: "לא ניתן היה לטעון את התקדמות העקביות."
- Populated: a week-by-week tracker, hit weeks marked, current streak called
  out.

## Client calls and contracts

- `chal_progress(challenge_id)` for weeks-hit and total weeks.
- Consumes `WORKOUT_COMPLETED` from the event bus to detect a qualifying
  session, same as COMM-202.

## Validation rules and limits

- `times_per_week` and `weeks` are positive integers, validated client-side
  at create time (COMM-201's form); the server stores them inside
  `config` jsonb with no dedicated CHECK.

## Migration outline

- None beyond `challenge_progress_apply`, shared with COMM-202, see "Needs
  from schema, challenges".

## Dependencies

- COMM-201, COMM-130, COMM-006.
