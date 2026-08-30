# COMM-208 Challenge notifications (ending soon, joined, completed)

Phase: 2
Agent: notifications
Status: todo
Attendance-blocked: no

## User outcome

A joined member is told when their challenge is about to end, and the rest
of a challenge's ripple (someone else joining or finishing) reaches
participants without ever notifying every single contribution.

## Acceptance criteria

- [ ] `challenge_ending_soon`: an immediate notification to every active
  participant of a challenge whose `end_at` falls within 48 hours, sent once
  per challenge per participant. Matches the routing table entry already
  recorded in Phase 1's contracts.
- [ ] Design decision, since the spec title names "joined" and "completed"
  without a dedicated notification type for either: both fan out as the
  existing batched `challenge_update` type to the other active participants
  of the same challenge, not to the joiner or completer themselves. A member
  joining or completing sees their own confirmation client-side (the
  existing toast plus, for completion, the same local celebration pattern
  COMM-134 uses for achievements), never a notification about their own
  action.
- [ ] A join by member X enqueues `challenge_update` for every other active
  participant.
- [ ] A completion by member X enqueues `challenge_update` for every other
  active participant.
- [ ] Every fan-out respects the existing block-edge filter and the
  recipient's `challenge_update`-mapped preference.
- [ ] No notification exists for a single `challenge_progress` contribution;
  only join and completion enqueue.

## Frontend states

Not applicable. Routing logic, surfaced through the existing notification
center (COMM-140).

## Client calls and contracts

- Notifications are created server-side only. `notif_on_challenge_join`,
  `notif_on_challenge_complete`, `chal_notify_ending_soon()`, see "Needs from
  schema, notifications (Phase 2)" in `docs/community/contracts.md`.

## Validation rules and limits

- `challenge_ending_soon` is sent at most once per `(challenge_id, user_id)`
  pair, enforced by `challenges.ending_soon_notified_at` gating the whole
  challenge's fan-out rather than a per-user flag, since all joined
  participants are notified in the same pass.

## Migration outline

- `notif_on_challenge_join`, `notif_on_challenge_complete`,
  `chal_notify_ending_soon()`, `challenges.ending_soon_notified_at`. See
  "Needs from schema, notifications (Phase 2)" and "Needs from schema,
  challenges". schema lands both. The `chal_notify_ending_soon` scheduler
  (pg_cron or an Edge Function) is infra, not built by this ticket, same
  open item as the Phase 1 batch flusher scheduler.

## Dependencies

- COMM-201, COMM-207, COMM-142, COMM-005.
