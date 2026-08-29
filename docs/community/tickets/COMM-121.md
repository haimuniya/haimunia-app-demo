# COMM-121 Comment replies, two-level threads

Phase: 1
Agent: engagement
Status: review
Attendance-blocked: no

## User outcome

A member can reply to a specific comment, and the conversation stays readable,
never deeply nested.

## Acceptance criteria

- [ ] A comment can have a reply. A reply cannot have a reply. Depth cap 2.
- [ ] `comments` gains `parent_comment_id`, null for a top-level comment.
- [ ] Replies render indented once under their parent, in time order.
- [ ] A reply count and a "view replies" toggle appear on a parent with
  replies.
- [ ] Creating a reply is optimistic and never drops the draft on failure.
- [ ] Deleting a parent with replies keeps the replies with a "comment
  removed" placeholder.
- [ ] Commenting writes a `feed_interactions` row kind comment and emits
  COMMENT_CREATED.

## Frontend states

- Empty: "Start the conversation."
- Loading: skeleton lines under the post.
- Error: "Comment failed to send." with the draft kept and a Retry.
- Populated: threaded comments, one indent level.

## Client calls and contracts

- Existing `addComment(postId, form)` extended with an optional
  `parentCommentId`.
- `deleteComment(commentId, postId)` unchanged in signature.

## Validation rules and limits

- Comment body max 1000 characters.
- Reply rejected if `parent_comment_id` already has a parent.
- Comment rate limits from migration 202608270010 respected.

## Migration outline

- `alter table comments add column parent_comment_id uuid references
  comments(id)`. RLS unchanged in spirit. schema lands it. Phase 0 schema
  list did not include this column, logged in backlog open questions.
- Landed in 202608280016 on `public.post_comments`. `parent_comment_id` is
  `on delete set null`, so a hard-deleted parent flattens its replies
  instead of destroying them. Depth 2 is enforced by the
  `post_comments_depth` trigger in both directions. Body limit widened to
  1000. Use `add_post_comment(p_post_id, p_body, p_parent_comment_id)`, the
  existing two-argument form still works unchanged.

## Dependencies

- COMM-012.
