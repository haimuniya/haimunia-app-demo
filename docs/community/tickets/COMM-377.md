# COMM-377 Member roster screen

Phase: 4
Agent: admin-moderation
Status: done
Attendance-blocked: no

## User outcome

A coach or admin can browse the full membership list — role and join date
for everyone — not only search for one member by name, and can still
promote or demote a member's role from the same place the existing search
already does.

## Acceptance criteria

- [ ] A new Roster view lists every member, paginated, newest-joined
  first, reusing the exact row shape and row-renderer the existing member
  search result list already has (same `rowHtml()` this module already
  ships, per COMM-374's matching return shape) — no second row template.
- [ ] Each row shows avatar, display name/handle, role label
  (`roleCodeLabel`, the existing table), and join date
  (`redeemed_at`, falling back to account creation when absent, matching
  the module's existing tenure-fallback convention).
- [ ] Role controls (promote to coach/head_coach, demote to member) are
  the exact existing `adminGrantCoach`/`adminSetRole`/`adminRevokeCoach`
  functions and `GRANTABLE_ROLES` list already wired to the search UI —
  not rebuilt, only reused from the roster row.
- [ ] Role controls render but are disabled, with a tooltip/inline note,
  for a viewer who is staff but not a real admin — the roster itself is
  staff-readable, role changes stay admin-only, matching the server gate
  (COMM-374's `is_staff()` list-read versus the unchanged `is_admin()`
  role-change RPCs).
- [ ] "Load more" pagination via the roster RPC's cursor, not a client-side
  slice of an unbounded fetch.
- [ ] The existing 2+-character search box is untouched and still works
  exactly as it does today; the roster is a new, separate browse entry
  point into the same member-management area, not a replacement.

## Frontend states

- Empty: not a real case (a club always has at least the caller), so not
  designed for; a zero-row page still renders its header and pagination
  controls, never a special empty message.
- Loading: skeleton rows on first load, a smaller inline spinner on
  "load more".
- Error: "לא ניתן היה לטעון את רשימת החברים." with retry.
- Populated: the row list described above.

## Client calls and contracts

- New: `admin_member_roster(p_cursor, p_limit)` — COMM-374.
- Reused, unchanged: `admin_grant_coach`, `admin_revoke_coach` RPCs and the
  existing `searchMembers`/`adminGrantCoach`/`adminSetRole`/
  `adminRevokeCoach`/`GRANTABLE_ROLES` client functions in `cloud.js`.

## Validation rules and limits

- None new. Role-change validation is unchanged, server-side, in the
  existing RPCs.

## Migration outline

None. Client-only ticket.

## Dependencies

- COMM-374.
