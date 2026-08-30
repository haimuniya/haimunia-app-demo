# COMM-227 Realtime for comments and reaction counts

Phase: 2
Agent: platform
Status: todo
Attendance-blocked: no

## User outcome

A member watching a post sees new comments and reaction counts appear
without refreshing the feed.

## Acceptance criteria

- [ ] `post_comments`, `reactions`, and `notifications` are added to the
  `supabase_realtime` publication.
- [ ] A feed card with its comment thread open subscribes to `post_comments`
  INSERT filtered `post_id=eq.<id>` and appends new rows live, applying the
  same block-edge and moderation-status handling the initial load already
  applies.
- [ ] Reaction counts update live for currently visible cards through one
  shared subscription per feed session (not one channel per card), since
  `postgres_changes` filters support only `eq` and `HaimuniaRealtime` caps at
  `MAX_SUBSCRIPTIONS = 10`. The client filters incoming rows against the
  currently rendered post ids itself.
- [ ] The notification badge (COMM-140) updates live via the own-row
  `notifications` subscription that was already coded and previously a
  documented no-op; this ticket is what makes it live.
- [ ] All subscriptions opened by this ticket are torn down on tab change via
  the existing `teardownAll()` call in `setCommunityTab`.
- [ ] With Realtime unreachable, every affected surface falls back silently
  to its existing poll/refresh behavior; no visible error.

## Frontend states

- Not applicable beyond the existing states for comments (COMM-121), reaction
  counts (COMM-120), and the notification badge (COMM-140); this ticket only
  adds a live-update path on top of them.

## Client calls and contracts

- `HaimuniaRealtime.subscribe('feed-comments', { table: 'post_comments',
  event: 'INSERT' }, handler)`, client-filtered by visible post id.
- `HaimuniaRealtime.subscribe('feed-reactions', { table: 'reactions', event:
  '*' }, handler)`, client-filtered the same way.
- The existing own-row `notifications` subscription from COMM-140.

## Validation rules and limits

- At most a small fixed number of channels per open feed session, well under
  the 10-channel cap, since this ticket uses shared unfiltered-table
  channels rather than one per post.

## Migration outline

- Realtime publication membership for `post_comments`, `reactions`, and
  `notifications`. See "Needs from schema, platform (Phase 2)" in
  `docs/community/contracts.md`. schema lands it.

## Dependencies

- COMM-014, COMM-120, COMM-121, COMM-140.
