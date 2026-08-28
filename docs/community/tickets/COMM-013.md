# COMM-013 Analytics event helper and Weekly Community Active Members definition

Phase: 0
Agent: platform
Status: todo
Attendance-blocked: no

## User outcome

Every tracked product action is recorded with a stable schema, and the core
health metric has one agreed definition.

## Acceptance criteria

- [ ] `analytics_track(event_name, props)` writes to an `analytics_events`
  table: `id` uuid pk, `user_id` uuid null, `event_name` text, `props` jsonb,
  `created_at` timestamptz default now, `schema_version` smallint.
- [ ] RLS on `analytics_events`: insert own-row, read by
  `community.analytics.view` holders only.
- [ ] The helper subscribes to the event bus and maps product events to
  analytics events where the mapping is one to one.
- [ ] The tracked event names from spec section 77 are defined as constants.
- [ ] Weekly Community Active Members is documented in
  `docs/community/metrics.md`: a unique member who in a calendar week did at
  least one of post, comment, react, join challenge, participate in event,
  share achievement, or interact with a coach or community item.
- [ ] Adding a prop is additive. Removing or renaming bumps `schema_version`.

## Frontend states

Not applicable. Infrastructure.

## Client calls and contracts

- `analytics_track` is a client helper writing under own-row RLS. No RPC.

## Validation rules and limits

- `event_name` must be one of the defined constants.
- `props` is capped at 4 KB serialized.

## Migration outline

- `create table analytics_events` with own-row insert and analytics-holder
  read RLS. schema agent lands this alongside COMM-013.

## Dependencies

- COMM-012 event bus.
- COMM-008 for `has_perm`.
