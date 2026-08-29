# COMM-125 Block member effects

Phase: 1
Agent: engagement
Status: review
Attendance-blocked: no

## User outcome

When a member blocks someone, they stop seeing that person across the
community, and the blocked person is not told.

## Acceptance criteria

- [ ] A blocked member's posts do not appear in the blocker's feed, profile
  views, or search.
- [ ] A blocked member's comments are hidden from the blocker where possible,
  with a neutral "comment hidden" placeholder in threads.
- [ ] The blocked member cannot mention the blocker into a notification.
- [ ] No notification or signal is sent to the blocked member.
- [ ] Blocking is enforced in `feed_page` and the comment reads, not only in
  the client.
- [ ] Unblock restores visibility.

## Frontend states

- Populated: blocked content absent or placeholdered.
- Error on block: "Could not block. Try again." with no partial state.

## Client calls and contracts

- Existing `block(userId)` extended so `feed_page` and comment reads join the
  block table.

## Validation rules and limits

- A member cannot block a coach out of a coach announcement channel. Coach
  announcements still show. Coach feed posts are hidden.

## Migration outline

- Block edges exist. `feed_page` and comment policies updated to respect
  them. schema owns those function and policy changes.

## Dependencies

- COMM-110, COMM-121.
