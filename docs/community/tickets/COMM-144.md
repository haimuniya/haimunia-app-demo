# COMM-144 Notification preferences per type

Phase: 1
Agent: notifications
Status: todo
Attendance-blocked: no

## User outcome

A member decides, per kind of notification, whether it reaches them by push,
in-app, or not at all.

## Acceptance criteria

- [ ] A Preferences panel in Account lists each type: comments, replies,
  mentions, reactions, achievements, friend achievements, challenges, events,
  announcements, weekly recap.
- [ ] Each type has Push, In-app, Off. In V1 Push is shown as "coming soon"
  and disabled, In-app and Off work.
- [ ] Off suppresses the in-app row for that type, except operational
  announcements which always show in-app.
- [ ] Defaults: everything In-app.
- [ ] Changes persist per member and apply immediately.

## Frontend states

- Loading: skeleton rows.
- Error: "Could not save that preference." with the control reverted.
- Populated: current choices.

## Client calls and contracts

- Upsert into `notification_preferences` under own-row RLS.

## Validation rules and limits

- `channel` in push, in_app, off.
- Unknown type is ignored.

## Migration outline

- None. Uses COMM-005.

## Dependencies

- COMM-005.
