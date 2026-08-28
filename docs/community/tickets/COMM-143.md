# COMM-143 Phase 1 notifications wired

Phase: 1
Agent: notifications
Status: todo
Attendance-blocked: no

## User outcome

The notifications that matter in V1 actually fire: comment, reply, mention,
and achievement.

## Acceptance criteria

- [ ] A reply to your comment creates an immediate notification with a deep
  link to the thread.
- [ ] A mention creates an immediate notification, subject to
  `allow_mentions`.
- [ ] An achievement unlock creates an immediate notification.
- [ ] A reaction on your post creates a batched notification.
- [ ] A new comment on your post creates an immediate notification. A new
  comment on a post you also commented on is batched.
- [ ] Each notification carries the right category and deep link.
- [ ] No duplicate notification for the same event.

## Frontend states

- Verified through the center from COMM-140.

## Client calls and contracts

- Server-side consumers of COMMENT_CREATED, REACTION_CREATED,
  ACHIEVEMENT_UNLOCKED, and the mention list from COMM-123.

## Validation rules and limits

- A member never gets a notification for their own action.

## Migration outline

- Trigger or consumer functions per event. schema lands them.

## Dependencies

- COMM-121, COMM-123, COMM-130, COMM-142.
