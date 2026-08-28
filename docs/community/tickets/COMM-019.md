# COMM-019 One RLS test per new table

Phase: 0
Agent: qa
Status: todo
Attendance-blocked: no

## User outcome

Every new table proves its boundary with an automated test, so a later policy
change that widens exposure fails CI.

## Acceptance criteria

- [ ] One test file per new Phase 0 table: posts columns, post_media,
  feed_impressions, feed_interactions, achievement_definitions,
  member_achievements, notifications, notification_preferences,
  push_subscriptions, challenges set, events set, roles, permissions,
  role_permissions, admin_actions, analytics_events, coach_engagement_flags,
  profiles privacy columns.
- [ ] Each test asserts: an unrelated member cannot read a private row, cannot
  write another member's row, and the owner or authorized role can.
- [ ] Tests use `test/helpers/mockSupabase.mjs` kept faithful to the real
  policies, or run against a local stack in the migration-check job.
- [ ] `npm test` stays green. The migration-check job stays green.

## Frontend states

Not applicable. Test suite.

## Client calls and contracts

- Exercises the contracts from COMM-001 through COMM-013.

## Validation rules and limits

- A table with no policy is a test failure, not a skip.

## Migration outline

- None.

## Dependencies

- COMM-001 through COMM-013. Runs as those land, not all at the end.
