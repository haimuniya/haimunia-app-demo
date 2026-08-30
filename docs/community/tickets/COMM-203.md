# COMM-203 Cooperative challenge with club aggregate and contributors

Phase: 2
Agent: challenges
Status: todo
Attendance-blocked: no

## User outcome

A member watches the whole club's combined total climb toward a shared goal
and sees who has been contributing.

## Acceptance criteria

- [ ] Detail view shows the club aggregate value against `target_value`,
  percent complete, and days remaining until `end_at`.
- [ ] A recent-contributors list shows the most recent distinct members with
  a positive `challenge_progress.delta` on the challenge, most recent first.
- [ ] `chal_progress` returns `club_total` as the sum of every participant's
  deltas on the challenge.
- [ ] Crossing 25%, 50%, 75%, and 100% of `target_value` posts one system
  milestone update (`POST_CHALLENGE`, authorless) to the club feed, once per
  threshold, never repeated on a later contribution past that threshold.
- [ ] Reaching 100% does not force the challenge to `completed` status; it
  stays `active` until `end_at` or a manual archive by a challenge manager,
  since a cooperative goal can keep climbing.
- [ ] Contributors who turned `visible_to_club` off still count toward
  `club_total` but are omitted from the named contributors list.

## Frontend states

- Empty: no contributions yet shows "עדיין לא נאספה התקדמות משותפת."
- Loading: skeleton progress ring and skeleton contributor row.
- Error: "לא ניתן היה לטעון את התקדמות האתגר."
- Populated: aggregate bar, percent, days remaining, contributor list.

## Client calls and contracts

- `chal_progress(challenge_id)` for `club_total` and days remaining.
- Direct RLS read of `challenge_progress` ordered by `created_at desc` for
  the contributor list, filtered to `delta > 0`.

## Validation rules and limits

- Contributor list capped at 10 rows.
- `club_total` never counts a withdrawn participant's contributions out; a
  contribution already logged stays in the aggregate even after the member
  leaves, matching the append-only progress log.

## Migration outline

- Cooperative milestone trigger, see "Needs from schema, challenges" in
  `docs/community/contracts.md`. schema lands it.

## Dependencies

- COMM-201, COMM-006, COMM-101 for the `POST_CHALLENGE` card upgrade.
