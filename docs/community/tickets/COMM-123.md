# COMM-123 Member mentions

Phase: 1
Agent: engagement
Status: review
Attendance-blocked: no

## User outcome

A member can name another member in a comment and that member is notified.

## Acceptance criteria

- [ ] Typing an at sign in a comment opens a member picker filtered by name.
- [ ] A selected mention renders as a link to the member profile.
- [ ] The mentioned member gets an immediate notification per COMM-142.
- [ ] A mention of a member whose `allow_mentions` is false renders as plain
  text and sends no notification.
- [ ] A blocked member cannot be mentioned into a notification.
- [ ] Mentions resolve by member id, not by display string, so a later name
  change keeps the link.

## Frontend states

- Picker open: a short list of matches, keyboard navigable.
- Loading: "Searching members".
- Error: the picker closes and the at sign stays as text.
- Populated: the mention chip in the composed comment.

## Client calls and contracts

- `searchPeople(query)` existing, reused for the picker.
- Mention storage: markers in the comment body plus a resolved list passed to
  the create call. No separate table for V1.

## Validation rules and limits

- Max 10 mentions per comment.

## Migration outline

- None for V1. A `comment_mentions` table is a later option if analytics need
  it.

## Dependencies

- COMM-018 for `allow_mentions`, COMM-121, COMM-142.
