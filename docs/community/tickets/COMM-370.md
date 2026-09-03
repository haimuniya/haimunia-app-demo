# COMM-370 Per-person invite table and admin create/list/revoke RPCs

Phase: 4
Agent: schema
Status: todo
Attendance-blocked: no

Today `public.invite_codes` is a single shared code per role (`member`/
`coach`), reusable indefinitely, with zero client grant — nobody can even
read it, let alone see who redeemed it. This ticket adds the second invite
model the product owner asked for alongside it: a per-person, one-time
invite an admin or coach generates, optionally tagged with a name, phone
number, or note, that can be tracked to pending/redeemed and revoked before
it is used. It does not touch `invite_codes` (see COMM-371) and does not
touch redemption (see COMM-372).

## User outcome

A staff member can generate a named invite for one specific person, see
whether it has been used yet, and revoke it if it was sent by mistake or is
no longer needed — without ever touching the Supabase SQL editor.

## Acceptance criteria

- [ ] A new `invites` table exists: one row per generated invite, a unique
  server-generated code, an optional label, the granted role, who created
  it, an optional expiry, and revoked/redeemed timestamps.
- [ ] `admin_invite_create(p_role text, p_label text default null,
  p_expires_at timestamptz default null)` generates a fresh unique code
  server-side (the client never supplies or sees a code before creating it)
  and returns the created row, including the code, so the caller can hand
  it to the invitee once.
- [ ] `p_role` accepts only `member` or `coach`; anything else raises.
  `p_label` is capped at 120 characters. `p_expires_at`, when given, must be
  in the future; a past value raises.
- [ ] `admin_invite_list(p_status text default 'all', p_cursor timestamptz
  default null, p_limit int default 25)` returns every invite (or only
  `pending`, `redeemed`, `revoked`, or `expired`, per `p_status`), newest
  first, cursor-paginated, with the redeeming member's display name and
  handle attached when known.
- [ ] `admin_invite_revoke(p_invite_id uuid)` marks an unredeemed invite
  revoked. Revoking an already-redeemed invite raises a clear error, never
  silently no-ops and never un-redeems anyone. Revoking an already-revoked
  invite is a no-op, not an error.
- [ ] All three RPCs require `has_perm('community.member.invite')` or real
  `is_admin()`; a plain member is refused.
- [ ] Every create and revoke writes one `admin_actions` row
  (`invite_created` / `invite_revoked`, target_type `invite`), the same
  audit discipline every other staff action in this schema already has.
- [ ] `invites` itself carries no client grant of any kind — the three RPCs
  above are the only path in or out, the same "definer functions are the
  API, the table is not" shape `invite_codes` already established.

## Frontend states

Not applicable. Schema and RPCs only; COMM-376 builds the screen.

## Client calls and contracts

- New: `admin_invite_create`, `admin_invite_list`, `admin_invite_revoke`.
  Full signatures, return shapes, and error strings in
  `docs/community/contracts.md` under "Needs from schema, registration and
  invite management (Phase 4)".

## Validation rules and limits

- Code format: 8 uppercase alphanumeric characters, generated server-side
  with a retry loop on a unique-constraint collision (astronomically rare
  at this alphabet size, but the retry exists rather than trusting it).
- `p_label` max 120 characters, free text, no format requirement — it is a
  note for the admin, never shown to the invitee or matched against
  anything.
- No new rate limit on these three RPCs: staff-only actions, not a
  member-facing surface a stranger can spam.

## Migration outline

- `invites(id uuid pk default gen_random_uuid(), club_id uuid not null
  default default_club_id() references clubs(id), code text not null
  unique check (code ~ '^[A-Z0-9]{8}$'), role text not null default
  'member' check (role in ('member','coach')), label text check
  (char_length(label) <= 120), created_by uuid not null references
  auth.users(id), created_at timestamptz not null default now(), expires_at
  timestamptz, revoked_at timestamptz, revoked_by uuid references
  auth.users(id), redeemed_at timestamptz, redeemed_by uuid references
  auth.users(id), check (revoked_at is null or redeemed_at is null))`.
- RLS enabled, zero grant to `authenticated` or `anon` — no select, insert,
  update, or delete policy for any client role.
- New permission `community.member.invite`, seeded to `coach`,
  `head_coach`, `staff`, `admin`, `owner` (not plain `member`) — the same
  "coach and above" tier `community.member.restrict` already uses, since
  inviting a new person is a normal coach task in a small gym, not an
  admin-only one.
- `admin_actions.action_type` CHECK widened to add `invite_created`,
  `invite_revoked`. `admin_actions.target_type` CHECK widened to add
  `invite`. Same drop-and-recreate pattern every earlier phase used
  (202609010001, 202609010002, 202609010005, 202609010012).
- `admin_invite_create`, `admin_invite_list`, `admin_invite_revoke`:
  `security definer`, `set search_path = ''`, `revoke all from public,
  anon`, `grant execute to authenticated`.

## Dependencies

- None on other Phase 4 tickets. COMM-372 (redemption) reads this table;
  COMM-376 (admin UI) calls these three RPCs.
