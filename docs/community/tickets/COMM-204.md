# COMM-204 Team challenge with per-team totals

Phase: 2
Agent: challenges
Status: todo
Attendance-blocked: no

## User outcome

A member sees the two or more team totals compared side by side and always
knows which team they are on.

## Acceptance criteria

- [ ] `challenge_teams` rows render as columns, each showing its aggregate
  `challenge_progress` total from its members.
- [ ] Joining a `team` challenge shows a team picker when teams are open, or
  auto-balances the new joiner to whichever team currently has fewer active
  participants when the challenge config marks teams as auto-assigned.
- [ ] A member belongs to exactly one team per challenge, held in
  `challenge_participants.team_id`.
- [ ] `chal_progress` returns `team_totals` as `[{team_id, name, total}]`,
  plus which team is the caller's own.
- [ ] The team leaderboard highlights the caller's own team without hiding
  the others.
- [ ] Leaving the challenge clears the member's `team_id` (row deleted per
  the existing leave policy) but their prior `challenge_progress` rows stay
  in the team total, since progress is append-only and not owned by the
  membership row.

## Frontend states

- Empty: no teams configured yet shows "המאמנת עדיין לא הגדירה קבוצות."
- Loading: skeleton team columns.
- Error: "לא ניתן היה להצטרף לקבוצה. נסו שוב."
- Populated: team columns with totals, caller's team marked.

## Client calls and contracts

- `chal_progress(challenge_id)` for `team_totals`.
- Direct RLS insert/update on `challenge_participants` for team assignment
  (existing policy, own row).
- Direct RLS read of `challenge_teams` (existing policy).

## Validation rules and limits

- Team name 1-80 chars, unique per challenge, enforced by the existing table
  constraint.
- A member cannot set `team_id` to a team from a different challenge; the
  client validates before calling, the server has no cross-challenge
  reference to check since `challenge_teams.challenge_id` is the only link.

## Migration outline

- None new. Uses `challenge_teams` and `challenge_participants.team_id` from
  202608280009.

## Dependencies

- COMM-201, COMM-006.
