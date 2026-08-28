# COMM-110 Ranked feed consumption

Phase: 1
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

The feed shows the most relevant club activity first, not a raw reverse
chronological list.

## Acceptance criteria

- [ ] `loadFeed()` calls `feed_page(cursor, limit)` and renders in the order
  returned.
- [ ] The client never re-sorts the returned rows.
- [ ] The ranking function scores recency, relationship, coach, achievement,
  challenge, engagement, personal relevance, and applies a repetition
  penalty, per spec section 15.
- [ ] The class-connection component is present in the function and returns 0
  until attendance lands, with a code comment tying it to COMM-P01.
- [ ] Engagement contribution is capped, comments weighted above reactions.
- [ ] First page renders in well under one second from a warm call with 200
  members and a few thousand posts in fixtures.

## Frontend states

- Empty: "Your Club activity will appear here."
- Loading: three skeleton cards.
- Error: "Unable to load the Club feed." with Retry.
- Populated: ranked cards.

## Client calls and contracts

- `feed_page(cursor timestamptz, limit int) returns setof feed_item`.

## Validation rules and limits

- `limit` between 1 and 40. Default 20.

## Migration outline

- `feed_page` function and supporting indexes. schema lands it.

## Dependencies

- COMM-001, COMM-003.
