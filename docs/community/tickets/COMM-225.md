# COMM-225 One-tap congratulate action

Phase: 2
Agent: coach-tools
Status: todo
Attendance-blocked: no

## User outcome

A coach celebrates a member's PR, anniversary, achievement, or challenge
completion in one tap, without writing a fresh message every time.

## Acceptance criteria

- [ ] Congratulate on a Celebrate item with a source post (a shared PR,
  achievement, or challenge) posts a short templated coach comment on that
  post via `add_post_comment`, sent immediately on tap with a prefilled
  Hebrew template, no confirmation dialog beyond the tap itself.
- [ ] Congratulate on a Celebrate item with no source post (an anniversary,
  or a challenge completion the member never shared) creates a short
  `POST_COACH` post via `post_create` naming the member in plain text; no
  mention marker or notification is generated for this case beyond the
  post being visible in the normal feed.
- [ ] Congratulating the same item twice is a no-op the second time: the
  client tracks which items have already been congratulated by the calling
  coach and disables the control, backstopped by the existing comment and
  post rate limits server-side.
- [ ] Every Congratulate write goes through `add_post_comment` or
  `post_create`, no new RPC; a restricted or unverified coach account (an
  edge case) is refused the same way any member would be.
- [ ] The action never posts on the coach's behalf without this explicit
  tap; there is no automated or scheduled congratulate.

## Frontend states

- Loading: the tapped Congratulate control shows a spinner.
- Error: "לא ניתן היה לשלוח ברכה. נסו שוב."
- Populated: the control becomes a disabled "ברכתם" state after a successful
  send.

## Client calls and contracts

- `add_post_comment(p_post_id, p_body, p_parent_comment_id)` for the
  source-post path.
- `post_create(body, visibility, media, links)` for the no-source-post path.

## Validation rules and limits

- Template text stays under the existing 1000-char comment/post caps.
- Subject to the existing `add_post_comment` and `post_create` rate limits;
  no widened limit for coaches.

## Migration outline

- None new.

## Dependencies

- COMM-223, COMM-121, COMM-124, COMM-102.
