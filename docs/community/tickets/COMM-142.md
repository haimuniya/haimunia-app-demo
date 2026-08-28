# COMM-142 Immediate versus batched routing

Phase: 1
Agent: notifications
Status: todo
Attendance-blocked: no

## User outcome

A member gets told right away about things that need them, and everything else
arrives grouped, not as a stream of pings.

## Acceptance criteria

- [ ] Immediate: reply to your comment, mention, coach mention, achievement
  unlocked, important announcement, event cancellation, challenge ending soon
  if joined.
- [ ] Batched: reactions, friend achievements, challenge updates, general
  feed activity. Batched items roll up into one notification per type per
  window.
- [ ] Never generate: a notification for every post, every workout, every
  leaderboard movement.
- [ ] V1 delivers in-app only. Push send is behind a flag, default off, no
  push in V1.
- [ ] The batching window is documented and testable, default 6 hours.
- [ ] Operational announcements always create an in-app row regardless of
  preferences.

## Frontend states

Not applicable. Routing logic. Verified through the center and tests.

## Client calls and contracts

- Notifications are created server-side by event-bus consumers and triggers.
  The client does not create them.

## Validation rules and limits

- A muted type per COMM-144 produces no in-app row, except the operational
  override.

## Migration outline

- Consumer functions or triggers that write `notifications`. schema lands the
  trigger set. Batching state in a small `notification_batches` table.

## Dependencies

- COMM-005, COMM-012, COMM-144.
