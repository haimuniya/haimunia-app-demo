# COMM-170 Analytics events for Phase 1 surfaces

Phase: 1
Agent: platform
Status: todo
Attendance-blocked: no

## User outcome

The team can measure whether members use the V1 social layer, from real usage
data.

## Acceptance criteria

- [ ] These events fire through `analytics_track`: club_tab_viewed,
  feed_viewed, post_impression, post_opened, post_created, workout_shared,
  achievement_shared, reaction_added, comment_created, profile_opened,
  report_submitted, notification_opened.
- [ ] Each event has a stable prop shape documented in
  `docs/community/metrics.md`.
- [ ] Events fire once per real action, no double counting on re-render.
- [ ] A dev switch logs events to the console instead of writing.
- [ ] Weekly Community Active Members can be computed from the stored events
  plus the community tables.

## Frontend states

Not applicable. Background instrumentation.

## Client calls and contracts

- `analytics_track(event_name, props)` from COMM-013.

## Validation rules and limits

- `props` under 4 KB. `event_name` in the defined set.

## Migration outline

- None. Uses COMM-013.

## Dependencies

- COMM-013, and the surfaces from COMM-101 through COMM-153.
