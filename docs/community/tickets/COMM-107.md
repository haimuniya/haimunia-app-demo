# COMM-107 New member and system post rendering

Phase: 1
Agent: posts
Status: todo
Attendance-blocked: no

## User outcome

The club sees when someone new joins, and system notices in the feed read as
club voice, not as a member post.

## Acceptance criteria

- [ ] POST_NEW_MEMBER card: "Welcome to the Club" style, member photo and
  name, join date, a Follow action, a Welcome action that posts a supportive
  comment.
- [ ] POST_SYSTEM card: club mark instead of an avatar, no profile link, muted
  styling, no More menu except Report is hidden.
- [ ] Both are authorless. `author_id` null renders the club identity, not a
  broken avatar.
- [ ] A new member card is created on MEMBER_JOINED only when the club setting
  "announce new members" is on. Default on.
- [ ] Reactions and comments are allowed on POST_NEW_MEMBER, disabled on
  POST_SYSTEM.

## Frontend states

- Loading: skeleton card.
- Error: minimal safe card.
- Populated: the correct card.

## Client calls and contracts

- Read via `feed_page`.
- POST_NEW_MEMBER created by a MEMBER_JOINED consumer, server-side.

## Validation rules and limits

- System body is club-authored text, still escaped on render.

## Migration outline

- Club setting flag "announce_new_members" default true, added by schema in
  the club settings row.

## Dependencies

- COMM-001, COMM-012, COMM-101.
