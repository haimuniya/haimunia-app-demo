# COMM-102 Composer: text post with visibility

Phase: 1
Agent: posts
Status: todo
Attendance-blocked: no

## User outcome

A member can write a short post to the club and choose who sees it.

## Acceptance criteria

- [ ] A "Share" button opens the composer.
- [ ] Fields: text area, visibility select (Club, Friends, Only Me).
- [ ] Buttons: Publish, Cancel.
- [ ] Publish with empty text and no media is disabled.
- [ ] On publish, a POST_TEXT row is created with the chosen visibility and
  appears at the top of the feed via optimistic insert.
- [ ] A failed publish keeps the composer open with the text intact and shows
  a retry.
- [ ] The composer is a dialog with focus trap, Escape to cancel with a
  confirm if text is present, and focus return to the Share button.

## Frontend states

- Empty: placeholder text in the area, Publish disabled.
- Loading: Publish shows a spinner, inputs disabled.
- Error: "Post failed to publish. Try again." above the buttons.
- Populated: the new card in the feed.

## Client calls and contracts

- Insert into `posts` under RLS, or `post_create(body, visibility, media,
  links) returns uuid` if link handling needs a function. Default to the
  function for one consistent write path.

## Validation rules and limits

- Text max 1000 characters, counter shown from 900.
- Control characters stripped, leading and trailing whitespace trimmed.

## Migration outline

- `post_create` function if adopted. schema lands it.

## Dependencies

- COMM-001.
