# COMM-376 Invite and code management admin screen

Phase: 4
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

An admin can manage both invite models from one screen: see and toggle the
shared per-role codes, and generate, track, and revoke per-person invites
— with no Supabase SQL editor involved.

## Acceptance criteria

- [ ] A new admin-only section (gated on `community.invite.manage_codes`
  for the shared-code half and `community.member.invite` for the
  per-person half — a coach without the narrower permission sees the
  per-person half only, matching the permission split COMM-370/371 set up
  server-side) shows two panels.
- [ ] Shared codes panel: lists every `invite_codes` row
  (`admin_invite_code_list`) with role, active/inactive, created date, and
  redemption count; a form to create a new one
  (`admin_invite_code_create`); a toggle to activate/deactivate each
  (`admin_invite_code_set_active`), with inline copy that deactivating
  does not affect anyone who already redeemed it.
- [ ] Per-person invites panel: a form to generate a new invite (role,
  optional label, optional expiry) via `admin_invite_create`, showing the
  generated code once, prominently, with a copy-to-clipboard action —
  since the code is not retrievable again after this screen (mirroring
  every other "shown once" secret pattern in this codebase).
- [ ] A filterable list (`admin_invite_list`, pending/redeemed/
  revoked/expired) showing label, code, role, created date, expiry, and —
  for a redeemed row — who redeemed it and when.
- [ ] A revoke action on any pending invite (`admin_invite_revoke`), with a
  confirm step (this module's standing destructive-action pattern), and
  the server's "already redeemed" refusal surfaced as a specific message
  rather than the generic error copy.
- [ ] Every RBAC gate here is server-enforced already (COMM-370/371); this
  ticket's own client gate only hides controls the server would refuse
  anyway, per COMM-150's rule.

## Frontend states

- Empty: no shared codes yet ("אין קודי הצטרפות משותפים עדיין") / no
  per-person invites yet ("עדיין לא נוצרו הזמנות אישיות").
- Loading: skeleton rows for both panels' lists.
- Error: "לא ניתן היה לטעון את ההזמנות." with retry.
- Populated: both panels as described above.
- Just-created invite: a one-time reveal card with the code and a copy
  button, dismissible, never re-shown after navigating away.

## Client calls and contracts

- `admin_invite_code_list()`, `admin_invite_code_create(p_code, p_role)`,
  `admin_invite_code_set_active(p_code, p_active)` — COMM-371.
- `admin_invite_create(p_role, p_label, p_expires_at)`,
  `admin_invite_list(p_status, p_cursor, p_limit)`,
  `admin_invite_revoke(p_invite_id)` — COMM-370.

## Validation rules and limits

- Client mirrors the server's own limits (label ≤120 chars, shared code
  format `^[A-Za-z0-9_-]{4,32}$`) so a rejection is rare, but the server
  call is still the real gate — no client-only validation replaces it.

## Migration outline

None. Client-only ticket.

## Dependencies

- COMM-370, COMM-371.
