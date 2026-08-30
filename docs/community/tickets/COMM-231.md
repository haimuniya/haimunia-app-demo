# COMM-231 Members directory screen

Phase: 2
Agent: engagement
Status: todo
Attendance-blocked: no

## User outcome

A member can browse the whole club roster, not just search for someone by
name.

## Acceptance criteria

- [ ] A directory screen lists every club member with `visible_to_club` on,
  alphabetically by display name, with avatar, display name, role badge
  (COMM-160), and a Follow button.
- [ ] A search box filters the roster in place, reusing COMM-228's member
  search where available, falling back to the existing client-side name
  filter.
- [ ] Coach and head_coach members are visually grouped or badge-
  distinguished at the top of the list, matching COMM-160's badge treatment.
- [ ] Tapping a member opens their community profile (COMM-180).
- [ ] No "Message" button exists anywhere on the directory or in a member
  row. This is a deliberate exclusion: direct messaging was scoped out
  entirely on 2026-08-30 (the spec only ever referenced it, it was never
  built, and WhatsApp remains the private-contact path), and a directory is
  exactly the kind of surface a spec would expect one on, so it is called
  out here rather than silently added or silently omitted.
- [ ] The roster is paginated or virtualized (cursor by display name), no
  full unpaginated fetch, sized for the 200-member release-criteria target.

## Frontend states

- Empty: no visible members shows "אין חברים להצגה." (only reachable if
  every member has hidden their profile, an edge case worth testing).
- Loading: skeleton roster rows.
- Error: "לא ניתן היה לטעון את רשימת החברים. נסו שוב."
- Populated: the alphabetical, paginated roster with staff grouped at top.

## Client calls and contracts

- Direct RLS cursor-paginated read on `profiles` ordered by `display_name`
  (existing club-wide read, subject to `visible_to_club`). No new contract.
- `community_search` (COMM-228) for the in-place filter, optional fallback
  to the existing client-side filter.

## Validation rules and limits

- Page size 40, matching the general cursor-pagination convention used
  elsewhere (COMM-113).

## Migration outline

- None new.

## Dependencies

- COMM-010, COMM-160, COMM-180, COMM-228.
