# COMM-124 Coach comment visual priority

Phase: 1
Agent: engagement
Status: todo
Attendance-blocked: no

## User outcome

A member can tell at a glance when a coach has replied.

## Acceptance criteria

- [ ] A comment from a member with a coach or head coach role shows a coach
  badge, the role label, and a slight visual emphasis, for example a tinted
  left border.
- [ ] Emphasis does not rely on color alone. The badge text carries the
  meaning.
- [ ] Coach comments still follow normal comment permissions and rate limits.
- [ ] A coach comment is not auto-pinned or reordered. It stays in time
  order.
- [ ] The role is read from the server role, not a client guess.

## Frontend states

- Populated: coach comment with badge and emphasis.
- All other states inherit from COMM-121.

## Client calls and contracts

- Role comes from the profile join already present in the comment read.

## Validation rules and limits

- None beyond the base comment rules.

## Migration outline

- None.

## Dependencies

- COMM-008, COMM-121.
