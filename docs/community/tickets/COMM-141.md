# COMM-141 Notification model read and mark-read wiring

Phase: 1
Agent: notifications
Status: todo
Attendance-blocked: no

## User outcome

Notifications persist per member and stay consistent across reloads and
devices.

## Acceptance criteria

- [ ] The client reads notifications only through `notif_list`, never a raw
  table select.
- [ ] Unread count refreshes on center open, on app focus, and after a mark
  action.
- [ ] Mark read is optimistic with rollback.
- [ ] A notification row carries a stable `deep_link` app route the client
  can resolve.
- [ ] Rows older than 90 days are not fetched by default, still reachable via
  a "show older" control.

## Frontend states

- Inherits from COMM-140.

## Client calls and contracts

- `notif_list`, `notif_mark_read`, `notif_unread_count` from COMM-005.

## Validation rules and limits

- Mark read accepts up to 100 ids per call.

## Migration outline

- None.

## Dependencies

- COMM-005, COMM-140.
