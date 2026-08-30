# COMM-218 Announcement priority levels and expiry

Phase: 2
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

A coach marks how urgent an announcement is, and it automatically stops
showing once it is no longer relevant.

## Acceptance criteria

- [ ] `announcements.priority` is one of `normal`, `important`, `urgent`,
  replacing the plain boolean `important` added in Phase 1 as the client-
  facing control (the boolean itself stays as a generated mirror, see
  migration outline).
- [ ] `announcements.expires_at` is optional; an expired announcement drops
  out of the feed top area and the pinned strip at read time, with no cron
  and no backfill needed.
- [ ] `urgent` is visually distinct from `important` (stronger color or
  banner treatment), never by color alone.
- [ ] Only staff can set `priority` or `expires_at`, unchanged from the
  existing `important` write gate.
- [ ] The pin cap and pin behavior (COMM-155) are unaffected by priority or
  expiry; an expired announcement that is still pinned stays pinned until a
  staff member unpins it, since pinning is a separate, explicit action.
- [ ] Escalating an announcement's priority (normal to important, normal to
  urgent, important to urgent) never produces a duplicate notification for a
  member already reached at a lower tier; see COMM-219.

## Frontend states

- Empty: not applicable, this is a composer field.
- Loading: the composer shows a spinner on save.
- Error: "לא ניתן היה לשמור את ההודעה. נסו שוב."
- Populated: the priority badge on the announcement in the feed top area.

## Client calls and contracts

- Direct RLS insert/update on `announcements` (existing policies, widened
  columns).

## Validation rules and limits

- `priority` one of normal, important, urgent.
- `expires_at`, when set, should be after `created_at`; enforced client-side,
  no server CHECK since a staff member editing an already-posted
  announcement's expiry is a legitimate correction.

## Migration outline

- `announcements.priority text not null default 'normal' check (priority in
  ('normal','important','urgent'))`, `announcements.expires_at timestamptz`.
  `important` stays as a generated/mirrored column so no other Phase 1
  trigger or policy needs an edit beyond `notif_is_operational` (COMM-219).
  See "Needs from schema, admin-moderation (Phase 2)" in
  `docs/community/contracts.md`. schema lands it.

## Dependencies

- COMM-005, COMM-155, COMM-026, COMM-027.
