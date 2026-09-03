# COMM-371 Shared invite-code admin RPCs

Phase: 4
Agent: schema
Status: todo
Attendance-blocked: no

`public.invite_codes` (202608270003) has existed since before Phase 0 with
literally no client-reachable read or write path — not even a select grant.
Whoever set up a code for this box did it directly in the Supabase SQL
editor, and there is no way today to see which codes exist, whether they
are active, or how many people redeemed each one. This ticket gives an
admin that visibility and control, without changing how redemption itself
works (COMM-372 is the redemption-side change).

## User outcome

An admin can see every shared invite code, how many people joined through
each one, create a new one, and turn one on or off — all from the app,
never from the database console.

## Acceptance criteria

- [ ] `admin_invite_code_create(p_code text, p_role text)` creates a new
  shared code, active by default. A duplicate code raises a clear "code
  already exists" error rather than a bare constraint-violation message.
- [ ] `admin_invite_code_list()` returns every shared code with its role,
  active flag, created-at, and a redemption count (how many
  `invite_redemptions` rows carry that code).
- [ ] `admin_invite_code_set_active(p_code text, p_active boolean)` turns a
  code on or off. Deactivating a code stops future redemptions through
  `redeem_invite_code` (already true today, since that function already
  filters on `active`); it has no effect on anyone who already redeemed it
  — same as today, just now something an admin can see and do without SQL
  access.
- [ ] All three RPCs require `has_perm('community.invite.manage_codes')` or
  real `is_admin()` — deliberately narrower than the per-person invite
  permission (COMM-370): a shared code is club-wide and standing, not a
  one-off invitation to a named person, so creating or disabling one is
  kept admin-tier.
- [ ] Create and toggle each write one `admin_actions` row
  (`shared_code_created` / `shared_code_status_changed`, target_type
  `invite_code`, the code and new state recorded in `after_data` since
  `invite_codes`' primary key is text, not the uuid `admin_actions.target_id`
  expects).
- [ ] `invite_codes` itself keeps its existing zero client grant. These
  three RPCs are the only path in.

## Frontend states

Not applicable. Schema and RPCs only; COMM-376 builds the screen.

## Client calls and contracts

- New: `admin_invite_code_create`, `admin_invite_code_list`,
  `admin_invite_code_set_active`. Full signatures in
  `docs/community/contracts.md` under "Needs from schema, registration and
  invite management (Phase 4)".

## Validation rules and limits

- `p_code` must match the existing `invite_codes.code` CHECK
  (`^[A-Za-z0-9_-]{4,32}$`), unchanged from 202608270003 — an admin picks
  the shared code by hand (it is meant to be short and easy to say aloud or
  print on a flyer), unlike a per-person invite's server-generated code.
- `p_role` accepts only `member` or `coach`.
- No new rate limit: staff-only actions.

## Migration outline

- New permission `community.invite.manage_codes`, seeded to `admin` and
  `owner` only.
- `admin_actions.action_type` CHECK widened to add `shared_code_created`,
  `shared_code_status_changed`. `admin_actions.target_type` CHECK widened
  to add `invite_code`.
- `admin_invite_code_create(p_code text, p_role text) returns
  public.invite_codes`, `admin_invite_code_list() returns setof jsonb`,
  `admin_invite_code_set_active(p_code text, p_active boolean) returns
  void`: `security definer`, `set search_path = ''`, `revoke all from
  public, anon`, `grant execute to authenticated`.

## Dependencies

- None on other Phase 4 tickets. COMM-376 (admin UI) calls these three
  RPCs.
