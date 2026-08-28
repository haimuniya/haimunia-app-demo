# COMM-101 Post type render dispatch

Phase: 1
Agent: posts
Status: todo
Attendance-blocked: no

## User outcome

The feed shows each kind of post with a card shaped for that kind, not one
generic block.

## Acceptance criteria

- [ ] A single `renderPostCard(post)` dispatches on `post.post_type` to a
  per-type renderer.
- [ ] Types wired in Phase 1: POST_TEXT, POST_PHOTO, POST_WORKOUT, POST_PR,
  POST_ACHIEVEMENT, POST_ANNOUNCEMENT, POST_COACH, POST_NEW_MEMBER,
  POST_SYSTEM.
- [ ] POST_CHALLENGE and POST_EVENT fall back to a compact link card until
  Phase 2.
- [ ] POST_ATTENDANCE_MILESTONE renderer exists but is never produced yet.
- [ ] Every renderer escapes user text with `safeText`.
- [ ] Unknown type renders a minimal safe card and logs a warning, never
  throws.
- [ ] Each renderer shows author, relative time, body if present, media if
  present, reaction and comment counts, and the action menu.

## Frontend states

- Empty: no card, the feed empty state handles it.
- Loading: skeleton card.
- Error: a card that failed to load shows "This post could not be shown".
- Populated: the correct per-type card.

## Client calls and contracts

- Reads rows from `feed_page`.
- No new contract.

## Validation rules and limits

- Body render cap 1000 characters. Media cap 4.

## Migration outline

- None. Uses COMM-001 and COMM-002.

## Dependencies

- COMM-001, COMM-002, COMM-110.
