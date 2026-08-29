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
- Landed in 202608280017. One change from the outline: the cap of 3 is a
  `slot` column bounded to 0 through 2 with a unique `(club_id, slot)`
  rather than a row-count trigger, because a counting trigger reads a
  snapshot and two concurrent pins can both see 2. `slot` doubles as the
  display order of the pinned strip. Read is open to every member, and there
  is no write grant at all: `pin_set(p_target_type, p_target_id, p_note)`
  and `pin_clear(p_target_type, p_target_id)` check `community.content.pin`
  and write `admin_actions` in the same transaction. Auto-unpin on a
  deleted, removed, cancelled, or archived target is already wired.

## Dependencies

- COMM-008, COMM-009.
