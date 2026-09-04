# COMM-372 redeem_invite_code accepts a per-person invite

Phase: 4
Agent: schema
Status: done — schema shipped and verified (see docs/community/backlog.md Phase 4 section and contracts.md for final signatures; COMM-381 confirmed pgTAP 0058 covers the anti-enumeration property and the single-use UPDATE ... RETURNING claim, and re-verified the same lifecycle end to end in scripts/browser-check/community-person-invite-lifecycle.mjs)
Attendance-blocked: no

`redeem_invite_code` currently only ever looks at `invite_codes`, the
shared per-role code. This ticket widens it to also accept a code minted by
COMM-370's per-person `invites` table, so a member typing either kind of
code into the same, unchanged signup field gets the same result: a role and
a joined club. This is the one ticket in this cluster that touches the
existing, already-hardened redemption path, which is why it is scoped on
its own rather than folded into COMM-370.

## User outcome

Someone who was sent a personal invite code redeems it exactly the way
every member already redeems a shared code today — same field, same
button, same copy — and the admin who created that invite sees it flip to
redeemed.

## Acceptance criteria

- [ ] `redeem_invite_code(p_code text, p_actor_key text default null)`
  keeps its exact existing signature and its exact existing behavior for a
  shared `invite_codes` match (checked first, unchanged order, so nothing
  about today's dominant path moves).
- [ ] When `p_code` matches no active shared code, the function then checks
  `invites` for a row with that code, `revoked_at is null`, `redeemed_at is
  null`, and (`expires_at is null` or `expires_at > now()`). A match grants
  that invite's `role`, exactly like a shared-code match does today.
- [ ] A successful per-person redemption stamps `invites.redeemed_at =
  now()` and `invites.redeemed_by = auth.uid()` in the same transaction as
  the `invite_redemptions` insert, and links the two:
  `invite_redemptions.invite_id` is set to the matched invite's id (null
  for a shared-code redemption, unchanged for every existing row).
- [ ] A code that matches neither table, or matches a per-person invite
  that is already redeemed, revoked, or expired, returns the exact same
  generic `'invalid'` a plain wrong guess returns today — preserving the
  existing property that a caller cannot tell "this code never existed"
  apart from "this code existed but is spent," which is what stops
  `invite_attempts`' throttle from becoming a status oracle. See "Open
  questions" in the backlog for the alternative this rules out.
- [ ] The five-attempts-per-fifteen-minutes throttle (`invite_attempts`,
  COMM-017) applies identically regardless of which table eventually
  matches — a per-person code is guessable the same way a shared code is,
  and gets the same protection.
- [ ] The one-argument `redeem_invite_code(p_code text)` wrapper keeps
  resolving and keeps passing a null actor key, unchanged.
- [ ] An existing shared-code redemption path (every row in
  `invite_redemptions` today) is entirely unaffected: this ticket adds a
  second lookup branch, it does not touch the first one's logic or the
  rows it already produced.

## Frontend states

No new state. The existing redemption screen's success/failure/loading
states (COMM-016) are unchanged; a per-person invite behaves identically to
a shared code from the client's point of view. See COMM-380 for the one
copy adjustment this cluster does make.

## Client calls and contracts

- Widened: `redeem_invite_code(p_code text, p_actor_key text default
  null) returns text`. Signature unchanged, body widened. Full contract in
  `docs/community/contracts.md`.

## Validation rules and limits

- No new validation surface: the existing code-format-agnostic lookup (the
  function tries a match, it does not validate a shape before trying) is
  kept, since a per-person code (8 uppercase alphanumeric) and a shared
  code (`^[A-Za-z0-9_-]{4,32}$`) already overlap in shape and neither needs
  a client-side format hint.

## Migration outline

- `invite_redemptions` gains `invite_id uuid references public.invites(id)`,
  nullable, no default — every existing row keeps it null.
- `redeem_invite_code(p_code text, p_actor_key text default null)`:
  `create or replace`, same signature, body widened with the second lookup
  branch described above, still `security definer`, still `revoke all from
  public, anon`, still `grant execute to authenticated`.
- No RLS change on `invite_redemptions`: the existing own-row select policy
  already covers the new column.

## Dependencies

- COMM-370 (`invites` table must exist first).
