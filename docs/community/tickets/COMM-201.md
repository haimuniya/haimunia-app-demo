# COMM-201 Challenge model generalization from the weekly challenge

Phase: 2
Agent: challenges
Status: todo
Attendance-blocked: no

## User outcome

A coach creates any of the six challenge types through one form, and the old
single hardcoded weekly challenge is retired in favor of it.

## Acceptance criteria

- [ ] A coach or admin create form covers all six `challenge_type` values
  (individual_target, individual_performance, cooperative, team, consistency,
  coach) with type-specific config fields: target metric and value, team
  names for `team`, custom rules text for `coach`.
- [ ] The same form edits an existing challenge and can archive or cancel it.
- [ ] `chal_progress(challenge_id)` exists and returns a single
  `challenge_progress_view` shape shared by every type; type-specific math is
  filled in by COMM-202 to COMM-206, this ticket wires the function and the
  fields common to every type (my_progress, my_status, participant_count,
  ends_at).
- [ ] `loadWeeklyChallenge`, `setWeeklyChallenge`, and `weeklyLeaderboard`
  stop being the write and read path for new challenges. The legacy
  `weekly_challenges` table is left as-is (read-only, no migration of old
  rows) so historical data is not lost.
- [ ] A `draft` challenge is visible only to its creator and to a
  `community.challenge.create` holder, matching the existing `challenges_read`
  policy, and is not offered a Join button.
- [ ] Create, edit, join, and leave are direct RLS writes under the existing
  policies from 202608280009; this ticket adds no new write RPC.

## Frontend states

- Empty: no active challenges shows "אין אתגרים פעילים כרגע."
- Loading: skeleton create form and skeleton list row.
- Error: "לא ניתן היה לשמור את האתגר. נסו שוב."
- Populated: the create/edit form and the general challenge list read from
  `challenges`.

## Client calls and contracts

- Direct RLS insert/update/delete on `challenges` and `challenge_teams`
  (existing policies, COMM-006).
- `chal_progress(challenge_id uuid) returns challenge_progress_view`, new,
  see `docs/community/contracts.md` "Needs from schema, challenges".

## Validation rules and limits

- Title 1-120 chars, description up to 2000 chars, matching the table CHECKs.
- `end_at > start_at`, enforced by the table CHECK.
- Creation and edit require `community.challenge.create`.

## Migration outline

- None new by this ticket beyond what schema documents under "Needs from
  schema, challenges": the `challenge_progress_view` composite type and the
  `chal_progress` function body. `challenges`, `challenge_teams`,
  `challenge_participants`, `challenge_progress` already shipped in
  202608280009.

## Dependencies

- COMM-006, COMM-008.
