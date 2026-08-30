# COMM-207 Challenge list, detail, join and leave

Phase: 2
Agent: challenges
Status: todo
Attendance-blocked: no

## User outcome

A member browses active and past challenges, opens one, and joins or leaves
it.

## Acceptance criteria

- [ ] List shows active challenges (`status = 'active'`) sorted by soonest
  `end_at`: card with title, progress bar or aggregate figure per type,
  start/end dates, participant count, personal progress if joined, Join
  button if not.
- [ ] Detail shows header, description, rules, dates, my progress, the
  club/team/leaderboard panel matching the challenge's type (COMM-202 to
  COMM-206), participant list, comments (the reused engagement component),
  and Join, Leave, Share Progress actions.
- [ ] Join is a direct RLS insert into `challenge_participants` (existing
  policy), only on an `active` challenge, only with `is_community_member()`,
  and emits `CHALLENGE_JOINED`.
- [ ] Leave is a direct RLS delete under the existing `_leave_self` policy;
  the member's prior `challenge_progress` rows are not deleted (append-only,
  no cascade from `challenge_participants`).
- [ ] Past challenges (`completed` or `archived`) render read-only, final
  standing shown, no Join button.
- [ ] Share Progress calls `post_create` with `links.challenge_id` set,
  producing a `POST_CHALLENGE` post.
- [ ] `renderPostCard`'s POST_CHALLENGE renderer is upgraded from the
  COMM-101 fallback link card to a real challenge card showing progress at
  time of share.

## Frontend states

- Empty: no active challenges shows "אין אתגרים פעילים כרגע."
- Loading: skeleton list and skeleton detail.
- Error: "לא ניתן היה לטעון את האתגר. נסו שוב."
- Populated: list and detail as specified.

## Client calls and contracts

- Direct RLS insert/delete on `challenge_participants` (existing policy).
- `chal_progress(challenge_id)`.
- `post_create(body, visibility, media, links)` for Share Progress.

## Validation rules and limits

- Join only on an `active` challenge with a verified recovery method.
- Leave available at any time to the participant themselves or a challenge
  manager.

## Migration outline

- None new beyond what COMM-201 to COMM-206 land.

## Dependencies

- COMM-201, COMM-202, COMM-203, COMM-204, COMM-205, COMM-206, COMM-101,
  COMM-120 to COMM-125 for the comment reuse.
