# COMM-113 Cursor pagination

Phase: 1
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

The feed loads more as the member scrolls, smoothly, without duplicates or
gaps when new posts arrive.

## Acceptance criteria

- [ ] First load fetches 20 items. Each next page fetches 20.
- [ ] The cursor is an opaque token derived from the last item rank and
  timestamp, not an offset.
- [ ] Inserting a new post while paginating does not duplicate or skip items
  on later pages.
- [ ] A "load more" sentinel triggers the next page near the end of the list.
- [ ] Reaching the end shows a quiet end marker, not an error.
- [ ] Pull to refresh or a refresh control starts a fresh feed session.

## Frontend states

- Loading more: a small spinner at the list end.
- Error on a page: "Could not load more." with Retry, earlier items kept.
- End: "You are all caught up."

## Client calls and contracts

- `feed_page(cursor, limit, scope)` returns rows plus a `next_cursor`.

## Validation rules and limits

- `limit` capped at 40.
- A null or stale cursor restarts from the top.

## Migration outline

- `feed_page` returns `next_cursor`. schema updates the function and
  contracts.md.

## Dependencies

- COMM-110.
