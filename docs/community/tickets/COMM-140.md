# COMM-140 Notification center

Phase: 1
Agent: notifications
Status: todo
Attendance-blocked: no

## User outcome

A member has one place to see what happened while they were away, grouped so
it is scannable.

## Acceptance criteria

- [ ] A notification icon in the Club header shows an unread count.
- [ ] Opening it shows a list grouped by category: Community, Training,
  Challenges, Events, Club.
- [ ] Each row has an icon, title, body, relative time, read state, and opens
  its deep link on tap.
- [ ] Opening the center marks visible rows seen. Tapping a row marks it
  read.
- [ ] A "mark all read" control exists.
- [ ] Paginates 20 at a time.
- [ ] The center is a dialog with focus trap, Escape to close, focus return.

## Frontend states

- Empty: "No notifications yet."
- Loading: skeleton rows.
- Error: "Could not load notifications." with Retry.
- Populated: grouped rows, unread emphasized.

## Client calls and contracts

- `notif_list(cursor timestamptz, limit int) returns setof notification`.
- `notif_mark_read(ids uuid[]) returns void`.
- `notif_unread_count() returns int`.

## Validation rules and limits

- `limit` capped at 40.

## Migration outline

- None. Uses COMM-005.

## Dependencies

- COMM-005.
