# COMM-230 Following system surface and states

Phase: 2
Agent: engagement
Status: todo
Attendance-blocked: no

## User outcome

A member can see who they follow, who follows them, and manage it from one
place, not only from the search picker.

## Acceptance criteria

- [ ] A "Following" view on the member's own profile lists `follower_count`
  and `following_count` with expandable lists of who is on each side.
- [ ] The same view on another member's community profile is available only
  when `visible_to_club` passes for that member, matching
  `community_profile`'s existing gating for those two counts.
- [ ] Follow and unfollow use the existing `follow()` toggle from every
  surface that lists a member: search, directory (COMM-231), the follower
  and following lists themselves.
- [ ] The Follow button is hidden, not merely disabled, for a target whose
  `allow_follows` is off, mirroring `community_profile`'s `allow_follows`
  key.
- [ ] No "Message" affordance exists anywhere on this surface. Direct
  messaging was removed from scope entirely on 2026-08-30; WhatsApp remains
  the private-contact path.
- [ ] Unfollowing has no confirmation step, since it is low-stakes and
  reversible.
- [ ] The feed's existing `scope=following` filter (COMM-111) is validated
  end-to-end against real follow edges created from this surface.

## Frontend states

- Empty: no followers or following yet shows "עדיין אין עוקבים" or "עדיין
  לא עוקבים אחרי אף אחד."
- Loading: skeleton member rows.
- Error: "לא ניתן היה לעדכן את המעקב. נסו שוב."
- Populated: the follower/following list with working Follow/Unfollow
  controls.

## Client calls and contracts

- Direct RLS read on `follows` (existing policy, both directions).
- The existing `follow(userId)` toggle. No new contract.

## Validation rules and limits

- A follow insert targeting a member with `allow_follows` off is rejected
  server-side by `follows_insert_self`, not only hidden client-side.

## Migration outline

- None new.

## Dependencies

- COMM-018, COMM-110, COMM-111, COMM-180.
