# COMM-120 Reaction display and toggle

Phase: 1
Agent: engagement
Status: todo
Attendance-blocked: no

## User outcome

A member can give one supportive reaction to a post and see who else did.

## Acceptance criteria

- [ ] One reaction type. Tap adds, tap again removes.
- [ ] The button reflects the member's own state immediately, optimistic, and
  rolls back on failure.
- [ ] The card shows the first few reactor avatars and the total count.
- [ ] `reaction_type` stays `SUPPORT` in the database.
- [ ] The UI label is a single club term, taken from one place, unchanged
  until the user names it.
- [ ] Reacting writes a `feed_interactions` row kind react.
- [ ] Reaction rate limits from migration 202608270010 are respected.

## Frontend states

- Empty: "Be the first to react" affordance is not shown, the button alone is
  enough.
- Loading: no spinner, optimistic only.
- Error: the button reverts and a small toast "Could not react".
- Populated: avatars and count.

## Client calls and contracts

- Existing `react(postId)` extended to toggle and to emit REACTION_CREATED on
  the event bus.

## Validation rules and limits

- One reaction per member per post.
- Avatar strip shows at most 5, then a plus count.

## Migration outline

- None.

## Dependencies

- COMM-012, COMM-114.
