# COMM-108 Post action menu

Phase: 1
Agent: posts
Status: todo
Attendance-blocked: no

## User outcome

A member can manage their own posts and control what they see from others.

## Acceptance criteria

- [ ] More menu on any post: Save, Hide post, Report, Block member.
- [ ] Own post adds: Edit caption, Change visibility, Delete.
- [ ] Save adds the post to a personal saved list. Toggling removes it.
- [ ] Hide removes the post from that member's feed only, immediately, and
  persists.
- [ ] Edit caption updates only the body. Other fields are read only.
- [ ] Change visibility updates `visibility` and re-checks who can see it.
- [ ] Delete uses the existing single confirm dialog, sets `deleted_at`, and
  removes the card. Content is not hard deleted immediately.
- [ ] Report opens the reason flow from COMM-151.
- [ ] Block hides that member's posts and comments per COMM-125.

## Frontend states

- Loading: the tapped action shows a spinner.
- Error: "Could not complete that action. Try again."
- Populated: the feed reflects the change without a full reload.

## Client calls and contracts

- `post_set_visibility(post_id, visibility)`, `post_edit_caption(post_id,
  body)`, `post_delete(post_id)`.
- `post_hide(post_id)` writes to `hidden_posts`.
- `post_save(post_id)` toggles `saved_posts`.

## Validation rules and limits

- Caption max 1000 characters.
- Only the author or a `community.post.delete_any` holder can delete.

## Migration outline

- New migration: `hidden_posts` and `saved_posts` tables, own-row RLS. Feed
  read filters out hidden rows. schema lands it. Phase 0 schema list omitted
  these two, logged in backlog open questions.

## Dependencies

- COMM-001, COMM-110, COMM-125, COMM-151.
