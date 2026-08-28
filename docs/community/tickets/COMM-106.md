# COMM-106 Achievement post card

Phase: 1
Agent: posts
Status: todo
Attendance-blocked: no

## User outcome

When a member shares an achievement, the card shows the badge, the title, and
why it was earned.

## Acceptance criteria

- [ ] POST_ACHIEVEMENT card fields: badge icon, achievement title, date, short
  explanation, optional member caption.
- [ ] The card is created only from the share action in COMM-134, never
  automatically.
- [ ] The card links to the `member_achievements` row via `source_id`.
- [ ] Achievements marked visibility private cannot be shared to the feed.

## Frontend states

- Loading: skeleton card.
- Error: "This achievement could not be shown".
- Populated: full card with badge.

## Client calls and contracts

- Read via `feed_page`.
- Create via `ach_share(member_achievement_id, caption, media) returns uuid`.

## Validation rules and limits

- Caption max 1000 characters.

## Migration outline

- None. Uses COMM-004.

## Dependencies

- COMM-004, COMM-101, COMM-134.
