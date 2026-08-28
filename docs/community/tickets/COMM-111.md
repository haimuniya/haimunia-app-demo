# COMM-111 Feed filters

Phase: 1
Agent: feed
Status: todo
Attendance-blocked: partial

## User outcome

A member can narrow the feed to the slice they care about right now.

## Acceptance criteria

- [ ] Filter chips: For You, Following, Achievements, Coach Posts.
- [ ] "My Classes" chip is present but disabled with a tooltip "coming soon",
  tied to COMM-P01. It activates when attendance lands.
- [ ] Default filter is For You.
- [ ] Each filter passes a `scope` argument to `feed_page`.
- [ ] Following shows posts from followed members only.
- [ ] Achievements shows POST_PR, POST_ACHIEVEMENT,
  POST_ATTENDANCE_MILESTONE.
- [ ] Coach Posts shows POST_COACH and POST_ANNOUNCEMENT.
- [ ] The chosen filter persists for the session.

## Frontend states

- Empty per filter: a filter-specific message, for example "No coach posts
  yet."
- Loading: skeleton cards.
- Error: "Unable to load the Club feed." with Retry.
- Populated: filtered ranked cards.

## Client calls and contracts

- `feed_page(cursor, limit, scope)` gains a `scope` parameter with values
  for_you, following, achievements, coach, my_classes.

## Validation rules and limits

- Unknown scope falls back to for_you.

## Migration outline

- `feed_page` signature extended. schema updates it and contracts.md.

## Dependencies

- COMM-110.
- my_classes scope is parked, see COMM-P01.
