# COMM-155 Pinned content

Phase: 1
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

Staff can keep up to three important items at the top of the club surface.

## Acceptance criteria

- [ ] Staff with `community.content.pin` can pin an announcement, a
  challenge, an event, or a post.
- [ ] At most 3 pinned items at once. Pinning a fourth is rejected with a
  clear message.
- [ ] Pinned items show in a pinned strip at the top of the Club home, above
  the feed top area.
- [ ] Unpin removes it. Pin and unpin write `admin_actions`.
- [ ] A deleted or removed target is auto-unpinned.

## Frontend states

- Empty: no pinned strip.
- Loading: skeleton chips.
- Error: "Could not update pins."
- Populated: up to three pinned chips with an unpin control for staff.

## Client calls and contracts

- `pin_set(target_type text, target_id uuid) returns void`.
- `pin_clear(target_type text, target_id uuid) returns void`.

## Validation rules and limits

- `target_type` in announcement, challenge, event, post.
- Hard cap 3 enforced by a trigger.

## Migration outline

- `pins` table with a row-count trigger and RLS keyed to
  `community.content.pin`. schema lands it. Phase 0 schema list omitted
  `pins`, logged in backlog open questions.

## Dependencies

- COMM-008, COMM-009.
