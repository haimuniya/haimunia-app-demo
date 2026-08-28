# COMM-014 Supabase Realtime harness and subscription helper

Phase: 0
Agent: platform
Status: todo
Attendance-blocked: no

## User outcome

Features can subscribe to live changes on a table or channel through one
helper that cleans up on view change, so no subscription leaks.

## Acceptance criteria

- [ ] A helper `subscribe(channelName, opts, handler)` returns an
  `unsubscribe` function.
- [ ] A registry tracks open subscriptions. `teardownAll()` closes every one
  and is called on community sub-tab change.
- [ ] The helper uses the vendored Supabase client Realtime API. No new
  dependency.
- [ ] Reconnect after a dropped socket is automatic and does not duplicate
  handlers.
- [ ] In Phase 0 the helper ships with zero active subscriptions. Wiring
  comments, reaction counts, and challenge progress happens in Phase 2.

## Frontend states

Not applicable. Infrastructure.

## Client calls and contracts

- No RPC. Uses Realtime channels on existing tables.

## Validation rules and limits

- Maximum open subscriptions per session is 10. Opening an 11th logs a
  warning and reuses the oldest slot.

## Migration outline

- None. Realtime replication settings for specific tables are set in Phase 2
  by schema when those subscriptions land.

## Dependencies

- None.
