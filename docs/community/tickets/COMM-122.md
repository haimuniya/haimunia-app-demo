# COMM-122 Comment edit and delete own

Phase: 1
Agent: engagement
Status: todo
Attendance-blocked: no

## User outcome

A member can fix a typo in their comment or remove it.

## Acceptance criteria

- [ ] An own comment shows Edit and Delete.
- [ ] Edit opens inline, saves on confirm, shows an "edited" marker with the
  edit time.
- [ ] Delete uses the shared single confirm dialog.
- [ ] A deleted comment leaves a "comment removed" placeholder when it has
  replies, otherwise it is removed from the list.
- [ ] Only the author edits. The author or a `community.comment.moderate`
  holder deletes.
- [ ] Edits and deletes are optimistic with rollback.

## Frontend states

- Editing: inline field with Save and Cancel.
- Loading: Save shows a spinner.
- Error: "Could not save the edit." with the field kept.
- Populated: updated comment with the edited marker.

## Client calls and contracts

- `comment_edit(comment_id, body)`.
- `deleteComment(commentId, postId)` existing.

## Validation rules and limits

- Body max 1000 characters.
- Edit window is unlimited for now. Revisit if abuse appears.

## Migration outline

- `comments` gains `edited_at timestamptz null`. schema lands it.

## Dependencies

- COMM-121.
