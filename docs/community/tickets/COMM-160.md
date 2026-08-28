# COMM-160 Coach identity across the community

Phase: 1
Agent: coach-tools
Status: todo
Attendance-blocked: no

## User outcome

A member can always tell when they are looking at a coach, on posts,
comments, and profiles.

## Acceptance criteria

- [ ] A coach or head coach shows a badge on their post cards, their
  comments, and their profile header.
- [ ] The badge carries text, not color alone.
- [ ] The role is read from the server role set, not inferred client-side.
- [ ] A coach post uses POST_COACH so the feed can weight it and the Coach
  Posts filter can find it.
- [ ] Removing a coach role removes the badge everywhere on next load.

## Frontend states

- Populated: badge visible on all three surfaces.

## Client calls and contracts

- Role from the profile join already present in feed and comment reads.

## Validation rules and limits

- None.

## Migration outline

- None.

## Dependencies

- COMM-008, COMM-101, COMM-124.
