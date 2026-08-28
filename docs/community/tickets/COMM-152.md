# COMM-152 Admin moderation queue

Phase: 1
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

A reviewer sees every reported item in one queue with the context to decide.

## Acceptance criteria

- [ ] The queue lists: content preview, reported member, reporter count,
  reason, date, status.
- [ ] Statuses: Open, Reviewing, Action Taken, Dismissed.
- [ ] Filter by status. Default Open.
- [ ] "View context" opens the post or comment in place with its thread.
- [ ] The queue is visible only to holders of the moderation permission and
  real `is_admin` for the reported-post bypass, matching migration
  202608270009.
- [ ] Reporter identities are visible to the reviewer, not to other members.

## Frontend states

- Empty: "Nothing to review."
- Loading: skeleton rows.
- Error: "Could not load the queue." with Retry.
- Populated: rows with actions from COMM-153.

## Client calls and contracts

- `mod_queue(status text, cursor timestamptz, limit int) returns setof
  mod_queue_item`.

## Validation rules and limits

- `limit` capped at 50.

## Migration outline

- `mod_queue` function. schema lands it.

## Dependencies

- COMM-008, COMM-151.
