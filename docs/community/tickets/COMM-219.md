# COMM-219 Announcement notification toggle and urgent path

Phase: 2
Agent: notifications
Status: todo
Attendance-blocked: no

## User outcome

A member controls whether announcements notify them, except an urgent one
always reaches them regardless of that choice.

## Acceptance criteria

- [ ] The existing "announcements" row in the Preferences panel (COMM-144)
  keeps working unchanged for `normal` priority announcements: Off suppresses
  the in-app row.
- [ ] `important` priority stays operational exactly as it behaved in Phase
  1: it always produces an in-app row regardless of the member's preference.
- [ ] `urgent` priority is also operational, and additionally gets the
  strongest in-app treatment (the visual distinction from COMM-218), but is
  routed through the same `notif_create` immediate path, not a second
  mechanism.
- [ ] Escalating an announcement normal to important, normal to urgent, or
  important to urgent notifies only the members who were not already reached
  at the lower tier (the members holding an explicit `off` row), so nobody
  gets two rows for the same announcement no matter how many times its
  priority changes.
- [ ] A member with `off` on announcements still receives every `important`
  and `urgent` announcement, and this is stated plainly in the preferences
  UI copy so it is not a surprise.

## Frontend states

Not applicable beyond COMM-144's existing preferences UI, which needs no new
row for this ticket.

## Client calls and contracts

- No new client call. Server-side: `notif_is_operational` and the
  `announcements` AFTER UPDATE trigger, widened from `important` to
  `priority`. See "Needs from schema, notifications (Phase 2)" in
  `docs/community/contracts.md`.

## Validation rules and limits

- Operational always overrides `off`; no client-side way to suppress an
  `important` or `urgent` announcement.

## Migration outline

- `notif_is_operational` predicate change and the widened AFTER UPDATE
  trigger column list. See "Needs from schema, notifications (Phase 2)" and
  "Needs from schema, admin-moderation (Phase 2)". schema lands both as one
  migration alongside COMM-218's column change.

## Dependencies

- COMM-218, COMM-026, COMM-027, COMM-144.
