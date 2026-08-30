# COMM-210 Consistency leaderboard mode, non-attendance

Phase: 2
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

A member sees who in the club is training most consistently, ranked without
needing verified class attendance.

## Acceptance criteria

- [ ] A "Consistency" leaderboard mode ranks club members by their current
  non-attendance streak, the same consecutive-ISO-weeks-with-a-logged-session
  computation `community_profile`'s `current_streak` already uses.
- [ ] Only members who pass `in_leaderboards` and `visible_to_club` appear,
  and a block edge in either direction excludes a row, resolved through
  `feed_leaderboard`.
- [ ] The caller's own row always renders, even outside the visible top list,
  with its real rank.
- [ ] Ties break by longer club tenure, then alphabetically by display name,
  documented and tested.
- [ ] Explicitly non-attendance in Phase 2: this mode is not blocked and is
  not upgraded to verified attendance data by this ticket. COMM-306 (Phase 3)
  swaps the data source behind the same `feed_leaderboard(mode='consistency')`
  call, so the client slot does not change.
- [ ] The list caps at 50 visible rows.

## Frontend states

- Empty: nobody qualifies yet shows "עדיין אין מספיק נתונים לטבלת עקביות."
- Loading: skeleton leaderboard rows.
- Error: "לא ניתן היה לטעון את הטבלה. נסו שוב."
- Populated: ranked rows, caller's row visually marked.

## Client calls and contracts

- `feed_leaderboard(p_mode := 'consistency', p_challenge_id := null, p_scope
  := 'club', p_limit := 50)`. See "Needs from schema, feed (Phase 2)".

## Validation rules and limits

- `p_limit` capped at 100 server-side, the client requests 50.

## Migration outline

- `feed_leaderboard` function and `leaderboard_row` composite type. See
  "Needs from schema, feed (Phase 2)" in `docs/community/contracts.md`.
  schema lands it.

## Dependencies

- COMM-018, COMM-006 not required (club-wide, no challenge tie).
