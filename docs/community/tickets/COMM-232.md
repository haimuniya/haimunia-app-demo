# COMM-232 People you train with suggestions, non-attendance fallback

Phase: 2
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

A member gets suggested people to connect with, based on real interaction
overlap, since attendance-based classmate suggestions are not available yet.

## Acceptance criteria

- [ ] Suggestions rank candidates by, in order: shared active challenge
  participation, feed interactions (comment or react) on the same posts, and
  shared events RSVP'd `going` to, over a trailing 60-day window.
- [ ] Existing follows (either direction) and blocks (either direction) are
  excluded from the candidate set, along with the caller.
- [ ] Every candidate passes `can_view_profile_field(candidate,
  'visible_to_club')` and `can_view_profile_field(candidate,
  'allow_follows')`.
- [ ] Surfaced as a "אנשים שאולי תכירו" strip on the directory (COMM-231)
  and, optionally, on the member's own profile.
- [ ] Explicitly labeled and implemented as the non-attendance fallback:
  COMM-302 and COMM-307 (Phase 3) add a verified-attendance recurring-
  classmate score to the same ranking behind the same function name, so this
  ticket's UI slot does not change when that lands.
- [ ] A member with no qualifying interaction history yet (very new account)
  sees an honest empty state, not a broken or generic list.

## Frontend states

- Empty: "עדיין אין המלצות. התחילו לבלות בקהילה כדי לקבל הצעות."
- Loading: skeleton suggestion row.
- Error: the strip is simply omitted rather than showing a broken state.
- Populated: a short row of suggested members with a Follow button each.

## Client calls and contracts

- `people_suggestions(p_limit int default 10) returns setof jsonb`. See
  "Needs from schema, feed (Phase 2)" in `docs/community/contracts.md`.

## Validation rules and limits

- `p_limit` capped at 20 server-side.

## Migration outline

- `people_suggestions`. See "Needs from schema, feed (Phase 2)". schema
  lands it.

## Dependencies

- COMM-006, COMM-230, COMM-231.
