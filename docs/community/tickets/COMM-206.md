# COMM-206 Coach custom-rules challenge

Phase: 2
Agent: challenges
Status: todo
Attendance-blocked: no

## User outcome

A coach runs a challenge that does not fit the built-in metrics, like "most
burpees in a week," and members see it and their standing like any other
challenge.

## Acceptance criteria

- [ ] `coach` challenge type stores free-form rules in
  `config.rules_text` (capped at 1000 chars) and an optional
  `config.metric_label` for display (for example "burpees").
- [ ] Progress for a `coach` challenge is entered by a challenge manager on
  behalf of each participant, never auto-detected client-side.
- [ ] `chal_record_progress(challenge_id, user_id, delta, note)` is the entry
  path, since the existing `challenge_progress_insert_self` policy only
  allows a member to write their own row.
- [ ] The entry form shows the current standing per participant so the coach
  is not guessing before logging a delta.
- [ ] Detail and leaderboard rendering reuse COMM-202's individual-performance
  view, since a coach challenge is scored the same way once progress exists.
- [ ] A member without `community.challenge.create` never sees the manual
  entry control.

## Frontend states

- Empty: no participants yet shows "אף אחד עדיין לא הצטרף לאתגר."
- Loading: skeleton entry row per participant.
- Error: "לא ניתן היה לשמור את העדכון."
- Populated: entry form plus the same progress bar/leaderboard COMM-202 uses.

## Client calls and contracts

- `chal_record_progress(p_challenge_id uuid, p_user_id uuid, p_delta numeric,
  p_note text) returns uuid`, new. See "Needs from schema, challenges".
- `chal_progress(challenge_id)` for the read side.

## Validation rules and limits

- Requires `community.challenge.create`.
- Target must be an active participant; the function raises otherwise.
- `note` capped at 500 chars.

## Migration outline

- `chal_record_progress`, see "Needs from schema, challenges" in
  `docs/community/contracts.md`. schema lands it.

## Dependencies

- COMM-201, COMM-202, COMM-008.
