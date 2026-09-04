# COMM-374 Paginated member roster RPC

Phase: 4
Agent: schema
Status: done — schema shipped and verified (see docs/community/backlog.md Phase 4 section and contracts.md for final signatures; COMM-381 confirmed pgTAP 0060 asserts the byte-identical result type against admin_search_members and 0062 covers the pre-existing admin_search_members ambiguity bug this ticket surfaced and fixed)
Attendance-blocked: no

`admin_search_members(p_query text)` (202608270011, widened in
202609010013) already exists and already backs the Account tab's member
search plus role-change controls, but it requires a 2+ character query and
returns at most 20 rows — there is no way to just browse the whole
membership list. This ticket adds that browse path as its own RPC, reusing
`admin_search_members`' exact returned shape rather than inventing a
second one, so COMM-377's roster screen can share one row-rendering
function with the existing search UI.

## User outcome

A coach or admin can open a full, paginated list of every member with
their role and join date, not only search for one by name.

## Acceptance criteria

- [ ] `admin_member_roster(p_cursor timestamptz default null, p_limit int
  default 25)` returns every non-deleted profile, newest-joined first,
  cursor-paginated on join date.
- [ ] The returned shape is exactly `admin_search_members`'s columns —
  `id, handle, display_name, avatar_url, is_admin, role, redeemed_at,
  last_activity_on` — so the client can reuse one row renderer for both
  the roster and the existing search results.
- [ ] Gated on `is_staff()` — a coach can browse the roster read-only, the
  same rank the existing coach dashboard and coach-tools surfaces already
  require. Role-change actions stay exactly where they are today
  (`admin_grant_coach`/`admin_revoke_coach`, real `is_admin()` inline,
  untouched by this ticket) — a coach viewing the roster sees every row
  but the client disables the promote/demote controls unless the viewer is
  a real admin.
- [ ] `p_limit` clamps 1..100, matching the module's existing convention
  (`admin_actions_page`, `mod_queue`).
- [ ] A member with no `invite_redemptions` row (mid-signup, or a
  pre-invite-gate legacy account) still appears, with `redeemed_at` null,
  rather than being silently dropped from the roster.

## Frontend states

Not applicable. RPC only; COMM-377 builds the screen.

## Client calls and contracts

- New: `admin_member_roster(p_cursor timestamptz default null, p_limit int
  default 25) returns setof jsonb`. Full contract in
  `docs/community/contracts.md`.

## Validation rules and limits

- No new rate limit: a staff-only read.

## Migration outline

- `admin_member_roster(p_cursor timestamptz default null, p_limit int
  default 25) returns table(id uuid, handle text, display_name text,
  avatar_url text, is_admin boolean, role text, redeemed_at timestamptz,
  last_activity_on date)`: `security definer`, `set search_path = ''`,
  checks `is_staff()`, selects from `profiles left join invite_redemptions`
  exactly like `admin_search_members`'s existing query with the free-text
  `where` clause replaced by `(p_cursor is null or coalesce(ir.redeemed_at,
  p.created_at) < p_cursor)`, ordered by that same coalesced join date
  descending. `revoke all from public, anon`; `grant execute to
  authenticated`.

## Dependencies

- None on other Phase 4 tickets. COMM-377 (admin UI) calls this RPC.
