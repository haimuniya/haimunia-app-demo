# COMM-224 Coach Welcome section

Phase: 2
Agent: coach-tools
Status: todo
Attendance-blocked: no

## User outcome

A coach sees every new member and whether they have been personally welcomed
yet, without digging through the roster.

## Acceptance criteria

- [ ] Lists members who joined within the last 30 days (by
  `invite_redemptions.redeemed_at`): name, logged-session count as the
  non-attendance stand-in for "sessions attended" (attendance itself is not
  a data source in Phase 2, this substitutes the same logged-workout count
  used everywhere else in this phase), days since joining, and coach
  interaction status (contacted or not).
- [ ] Actions: Welcome, View profile, Assign coach (optional), Mark
  contacted.
- [ ] Welcome is one tap and posts a coach comment on the new member's
  `POST_NEW_MEMBER` card via `add_post_comment`, reusing COMM-124's coach
  visual priority. It is a public, community-visible action, never a
  private message: direct messaging was removed from scope entirely on
  2026-08-30, and this ticket does not add a "Message" affordance anywhere.
- [ ] View profile opens `community_profile(user_id)`.
- [ ] Assign coach (optional) sets `profiles.assigned_coach_id` to the
  calling coach or another staff member picked from a list, staff-only.
- [ ] Mark contacted writes a `member_contact_log` row and is never visible
  to the member themselves; it exists only to coordinate coaches.
- [ ] A member who leaves the 30-day window drops out of the list
  automatically on next load, no manual removal needed.

## Frontend states

- Empty: "אין חברים חדשים בחודש האחרון."
- Loading: skeleton member rows.
- Error: "לא ניתן היה לבצע את הפעולה. נסו שוב."
- Populated: rows with the four actions.

## Client calls and contracts

- Direct RLS read of `profiles` joined with `invite_redemptions` for new
  members (existing club-wide read subject to `visible_to_club`).
- `add_post_comment` for Welcome.
- `community_profile(user_id)` for View profile.
- Direct RLS update on `profiles.assigned_coach_id` for Assign coach.
- Direct RLS insert into `member_contact_log` for Mark contacted.

## Validation rules and limits

- Welcome comment uses the existing 1000-char comment cap and existing
  comment rate limit; no special-casing for staff.
- Assign coach and Mark contacted are staff-only.

## Migration outline

- `profiles.assigned_coach_id`, `member_contact_log` table. See "Needs from
  schema, coach-tools" in `docs/community/contracts.md`. schema lands it.

## Dependencies

- COMM-121, COMM-124, COMM-107 (POST_NEW_MEMBER), COMM-180.
