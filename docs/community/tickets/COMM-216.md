# COMM-216 Event comments

Phase: 2
Agent: events
Status: todo
Attendance-blocked: no

## User outcome

Members discuss an event underneath it, the same way they discuss a post.

## Acceptance criteria

- [ ] Design decision, since `post_comments` has no path to an `events` row
  directly: publishing an event creates one companion `POST_EVENT` post via
  `post_create` with `links.event_id` set, and the event detail's comment
  thread is that post's comment thread. This reuses the entire engagement
  stack with zero schema change instead of adding a polymorphic comment
  target.
- [ ] Comment create, reply (two-level threads), edit own, delete own,
  mentions, and coach visual priority all behave exactly as specified for
  COMM-121 to COMM-125, with no event-specific exception.
- [ ] Cancelling or unpublishing the event does not delete the companion
  post; its comment thread stays intact and readable from the event detail.
- [ ] The companion post itself is not surfaced twice: it does not also
  appear as a separate feed card competing with COMM-217's event card and
  COMM-213's event card, since `POST_EVENT`'s own feed card already points
  at the event.

## Frontend states

- Empty: no comments yet, same "אין תגובות עדיין" state comments already use.
- Loading: skeleton comment rows.
- Error: same retry affordance `renderComments` already provides.
- Populated: the standard comment thread under the event detail.

## Client calls and contracts

- `post_create(body, visibility, media, links)` at publish time to create the
  companion post (events agent calls it, not a member-facing action).
- `add_post_comment`, `comment_edit`, `comment_delete`, exactly as documented
  under "Engagement" in `docs/community/contracts.md`.

## Validation rules and limits

- Same 1000-char comment body cap, same depth-2 cap, same posting-restriction
  gate as every other comment thread.

## Migration outline

- None. See "Needs from schema, events" in `docs/community/contracts.md` for
  the design note on why no schema change is needed.

## Dependencies

- COMM-213, COMM-121, COMM-122, COMM-123, COMM-124.
