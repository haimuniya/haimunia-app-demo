# COMM-308 Advanced challenge team management

Phase: 3
Agent: challenges
Status: todo
Attendance-blocked: no

## User outcome

A coach running a team challenge can actually manage the teams — create
them ahead of time, move a member who signed up for the wrong one, and name
a captain — instead of only watching auto-balanced totals accrue.

## Acceptance criteria

- [ ] A `community.challenge.create` holder can create, rename, and delete
  `challenge_teams` rows for a `team` challenge before or during its run
  (COMM-204 already grants this table's write to that permission; this
  ticket is the first client UI for it, not a new grant).
- [ ] A holder can move a participant from one team to another
  (`challenge_participants.team_id`), through a coach-only path — a plain
  member's own `challenge_participants_update_self` policy (202608280009)
  still does not permit setting `team_id` to a value the member did not
  pick at join time, so this needs the same security-definer shape
  `chal_record_progress` already established for a staff action on someone
  else's participant row.
- [ ] Reassigning a member's team does not move their historical
  `challenge_progress` rows: each already-stamped `team_id` snapshot
  (202608290003/005) stays with the team it was contributed to, exactly the
  "a departed member's earlier contributions keep counting for their old
  team" rule COMM-204 and `chal_progress`'s `team_totals` already state.
  Only rows contributed after the reassignment count toward the new team.
- [ ] A `captain_id` on `challenge_teams`, nullable, settable only by a
  `community.challenge.create` holder to a member who is themselves an
  active participant on that team. The captain has no extra write
  permission in this ticket's scope — it is a label the team column
  displays, not a delegated coach role.
- [ ] Deleting a team a participant still belongs to is refused (or the
  client blocks the action) rather than silently orphaning
  `challenge_participants.team_id` rows — a team column with members must
  be emptied by reassignment first.
- [ ] Every write here is a coach/staff action against a challenge, so it
  writes an `admin_actions` row the same way `mod_restrict_member` and
  `pin_set` already do, not because the spec names it but because every
  other staff-scoped write-past-RLS function in this schema already
  carries that audit discipline.

## Frontend states

- Empty: a `team` challenge with no teams yet shows the existing
  "המאמנת עדיין לא הגדירה קבוצות" state (COMM-204), now with a "צור קבוצה"
  control for a permission holder.
- Loading: skeleton team management rows.
- Error: "הפעולה נכשלה. נסו שוב." on a failed reassignment or team write.
- Populated: team columns with edit/delete controls and a captain badge,
  visible only to a `community.challenge.create` holder; a plain member's
  view is unchanged from COMM-204.

## Client calls and contracts

- Direct RLS insert/update/delete on `challenge_teams` (existing policy,
  COMM-006/COMM-204, no change).
- New: `chal_reassign_team(p_challenge_id uuid, p_user_id uuid, p_team_id
  uuid) returns void` — security definer, `community.challenge.create`
  required, same auth shape as `chal_record_progress`. Sets
  `challenge_participants.team_id` for the target, writes one
  `admin_actions` row (`target_type = 'challenge_participant'`).
- New: `chal_set_captain(p_team_id uuid, p_user_id uuid) returns void` —
  security definer, `community.challenge.create` required, raises when the
  target is not an active participant on that team.

## Validation rules and limits

- Team name 1-80 chars, unique per challenge — existing constraint, unchanged.
- A captain must be an active participant on the team being captained;
  clearing a captain (`p_user_id null`) is always allowed.
- Deleting a team with active members is refused with `team not empty`.

## Migration outline

- `challenge_teams` gains `captain_id uuid references profiles(id) on
  delete set null`.
- `chal_reassign_team(p_challenge_id, p_user_id, p_team_id)` and
  `chal_set_captain(p_team_id, p_user_id)`, both security definer,
  `community.challenge.create` gated, both writing `admin_actions`.

## Dependencies

- COMM-006, COMM-201, COMM-204, COMM-208.
