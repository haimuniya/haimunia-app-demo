# COMM-209 Challenge realtime progress

Phase: 2
Agent: platform
Status: todo
Attendance-blocked: no

## User outcome

A member watching a challenge detail screen sees progress bars and the
leaderboard update live as other members contribute, with no manual refresh.

## Acceptance criteria

- [ ] `challenge_progress` and `challenge_participants` are added to the
  `supabase_realtime` publication.
- [ ] The challenge detail screen subscribes through `HaimuniaRealtime` to
  `challenge_progress` INSERT and `challenge_participants` UPDATE, both
  filtered `challenge_id=eq.<id>`, and re-fetches `chal_progress` on an event
  rather than trying to apply the delta client-side, so the displayed
  numbers always match the server's aggregation.
- [ ] Re-fetches are debounced so a burst of contributions triggers at most
  one refresh per short window, not one per row.
- [ ] The subscription is torn down when the member leaves the challenge
  detail view or changes the community tab, reusing the existing
  `teardownAll()` call in `setCommunityTab`.
- [ ] With no configured Realtime client, or with the channel unreachable,
  the screen falls back silently to its existing poll-on-open behavior; no
  visible error.

## Frontend states

- Not applicable beyond the existing COMM-207 states; this ticket only adds
  a live-update path on top of them.

## Client calls and contracts

- `HaimuniaRealtime.subscribe(name, { table: 'challenge_progress', event:
  'INSERT', filter: 'challenge_id=eq.<id>' }, handler)` and the equivalent
  for `challenge_participants` UPDATE.
- `chal_progress(challenge_id)` on refresh.

## Validation rules and limits

- One channel per open challenge detail, staying well under
  `HaimuniaRealtime`'s `MAX_SUBSCRIPTIONS = 10` cap.

## Migration outline

- Realtime publication membership for `challenge_progress` and
  `challenge_participants`. See "Needs from schema, platform (Phase 2)" in
  `docs/community/contracts.md`. schema lands it.

## Dependencies

- COMM-014, COMM-207.
