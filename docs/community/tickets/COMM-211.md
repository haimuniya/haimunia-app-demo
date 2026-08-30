# COMM-211 Progress leaderboard mode

Phase: 2
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

A member sees who is leading a specific challenge by progress, not only
their own standing.

## Acceptance criteria

- [ ] A "Progress" leaderboard mode ranks a single challenge's participants
  by `challenge_participants.progress_value` descending.
- [ ] Reused directly by COMM-207's challenge detail "leaderboard if
  relevant" panel for `individual_performance` and `coach` challenge types.
- [ ] Only participants passing `in_leaderboards` and `visible_to_club`
  appear; a block edge excludes a row.
- [ ] The caller's own row always renders with its real rank even outside the
  visible top list.
- [ ] `p_challenge_id` is required for this mode; a missing id raises rather
  than silently returning a club-wide ranking.
- [ ] The list caps at 20 visible rows on the challenge detail panel, 50 on a
  dedicated full leaderboard screen if one is opened.

## Frontend states

- Empty: no participants with progress yet shows "עדיין אין תוצאות לדירוג."
- Loading: skeleton leaderboard rows.
- Error: "לא ניתן היה לטעון את הטבלה. נסו שוב."
- Populated: ranked rows, caller's row visually marked.

## Client calls and contracts

- `feed_leaderboard(p_mode := 'progress', p_challenge_id := <id>, p_scope :=
  'club', p_limit := 20)`. See "Needs from schema, feed (Phase 2)".

## Validation rules and limits

- `p_limit` capped at 100 server-side.

## Migration outline

- Shared `feed_leaderboard` function from COMM-210; no additional migration.

## Dependencies

- COMM-210, COMM-201, COMM-207.
