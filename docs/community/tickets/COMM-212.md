# COMM-212 Friends leaderboard mode and hide-my-result

Phase: 2
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

A member can compare against just the people they follow back, and can watch
a leaderboard without seeing their own row if that is more comfortable.

## Acceptance criteria

- [ ] A "Friends" scope on any leaderboard mode (consistency or progress)
  restricts the ranked set to `are_friends()` edges with the caller, always
  still including the caller's own row.
- [ ] "Hide my result" is a client-only display toggle, not a privacy
  setting: the server always returns the caller's row from `feed_leaderboard`,
  and this control only stops the client from drawing it. It does not touch
  `in_leaderboards`, which is the separate, real, server-enforced opt-out
  already shipped in COMM-018.
- [ ] The toggle's state persists locally per device (not synced), and
  defaults to showing the caller's row.
- [ ] Switching between club and friends scope does not require a full page
  reload, only a re-fetch of `feed_leaderboard` with the new `p_scope`.
- [ ] An empty friends scope (no mutual follows yet) shows a state pointing
  the member at the directory (COMM-231) or search (COMM-228) to find people,
  not a bare empty table.

## Frontend states

- Empty: no mutual follows shows "עקבו אחרי חברים כדי להשוות תוצאות."
- Loading: skeleton leaderboard rows.
- Error: "לא ניתן היה לטעון את הטבלה. נסו שוב."
- Populated: ranked rows scoped to friends, caller's row hidden or shown per
  the local toggle.

## Client calls and contracts

- `feed_leaderboard(p_mode, p_challenge_id, p_scope := 'friends', p_limit)`.

## Validation rules and limits

- Friends scope still applies `in_leaderboards` and `visible_to_club` on top
  of the mutual-follow filter; opting out of leaderboards holds even among
  friends.

## Migration outline

- None new beyond COMM-210's `feed_leaderboard`.

## Dependencies

- COMM-210, COMM-211, COMM-018.
