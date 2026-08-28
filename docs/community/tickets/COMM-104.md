# COMM-104 Workout post card

Phase: 1
Agent: posts
Status: todo
Attendance-blocked: no

## User outcome

When a member shares a workout, the card shows the training detail without the
member typing any of it.

## Acceptance criteria

- [ ] POST_WORKOUT card fields: member photo and name, timestamp, workout
  name, workout date, result, score type, Rx or scaled or level when
  relevant, PR badge when the linked result is a record, optional caption,
  optional photo, reaction count, comment count.
- [ ] Actions: React, Comment, Open workout, Open profile, More.
- [ ] More menu: Save, Hide post, Report, Block member. Own post adds Edit
  caption, Change visibility, Delete.
- [ ] The card links to the underlying workout via `source_type` and
  `source_id`.
- [ ] Sharing is only created after the member confirms the share prompt.
  Never auto-published.
- [ ] Training numbers come from the linked record, not free text.

## Frontend states

- Loading: skeleton card.
- Error: "This workout could not be shown" with Open profile still working.
- Populated: full card.

## Client calls and contracts

- Read via `feed_page`.
- Create via the existing `publishWorkout(type, id, visibility, photoFile)`
  path, extended to set `post_type` POST_WORKOUT and write `post_media`.

## Validation rules and limits

- Caption max 1000 characters.

## Migration outline

- None. Uses COMM-001 and COMM-002.

## Dependencies

- COMM-001, COMM-002, COMM-101.
