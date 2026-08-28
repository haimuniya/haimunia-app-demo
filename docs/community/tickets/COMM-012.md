# COMM-012 Product event bus module and typed event list

Phase: 0
Agent: platform
Status: todo
Attendance-blocked: no

## User outcome

Features emit and consume one typed stream of product events, so achievements,
notifications, feed, analytics, and coach tools all subscribe the same way.

## Acceptance criteria

- [ ] A module in `cloud.js` (or a small `src/` file loaded by index.html)
  exposes `emit(type, payload)` and `on(type, handler)`.
- [ ] Typed events: WORKOUT_COMPLETED, PR_CREATED, ATTENDANCE_RECORDED,
  ACHIEVEMENT_UNLOCKED, CHALLENGE_JOINED, CHALLENGE_COMPLETED,
  EVENT_REGISTERED, POST_CREATED, COMMENT_CREATED, REACTION_CREATED,
  MEMBER_JOINED.
- [ ] ATTENDANCE_RECORDED is defined and accepted but has no producer yet.
- [ ] Unknown event types throw in development and are dropped with a logged
  warning in production.
- [ ] Handlers are isolated: one throwing handler does not stop the others.
- [ ] The module has no build step and no external dependency.

## Frontend states

Not applicable. Infrastructure module.

## Client calls and contracts

- No RPC. Client-only module.
- Analytics, achievements, notifications consumers attach in their own
  tickets.

## Validation rules and limits

- Payload is a plain object. The bus does not deep-clone. Producers pass
  immutable data.

## Migration outline

- None.

## Dependencies

- None. Other agents subscribe to it.
