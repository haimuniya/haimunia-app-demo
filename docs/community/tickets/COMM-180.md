# COMM-180 Member profile community section

Phase: 1
Agent: posts
Status: todo
Attendance-blocked: partial

## User outcome

A member profile answers who this person is, how long they have trained here,
what they have achieved, and what they are working toward.

## Acceptance criteria

- [ ] Profile header: photo, first name, last name, role, member since, a
  Follow button. Message is deferred to Phase 2.
- [ ] Tabs: Overview, Progress, Achievements, Posts.
- [ ] Overview: training frequency, current streak, recent workouts, active
  challenge, recent achievement. Fields the target hid via privacy are
  omitted, not shown blank.
- [ ] Progress reuses the existing PR and history views, gated by
  `show_prs`.
- [ ] Achievements shows the earned badge grid, gated by `show_achievements`.
- [ ] Posts shows that member's shared posts the viewer is allowed to see.
- [ ] Follower and following counts are not shown prominently. A small count
  is acceptable, no ranking.

## Frontend states

- Empty per tab: "No achievements yet", "No posts yet".
- Loading: skeletons per tab.
- Error: "Could not load this profile."
- Populated: header and the four tabs.

## Client calls and contracts

- A `community_profile(user_id uuid) returns community_profile_view` that
  applies `can_view_profile_field` per field.

## Validation rules and limits

- A fully private profile shows only name, role, and member since.

## Migration outline

- `community_profile` function. schema lands it.

## Dependencies

- COMM-010, COMM-018, COMM-101.
