# COMM-017 Actor-level invite throttle outside the anonymous user ID

Phase: 0
Agent: identity-privacy
Status: todo
Attendance-blocked: no

## User outcome

Someone cannot bypass the invite-guess limit by discarding and recreating an
anonymous session.

## Acceptance criteria

- [ ] Invite redemption is rate limited by a stable actor signal, not only the
  Auth user id. Signal options: a client-persisted device key plus IP hash,
  or a proof-of-work token. Pick one and document why.
- [ ] The current limit stays: five attempts per fifteen minutes. Now it holds
  across session replacement in a test.
- [ ] A wrong code returns the same generic error and count regardless of
  whether the actor is new.
- [ ] The limit is enforced server-side in `redeem_invite_code`, not in the
  client.
- [ ] High-entropy invite codes from migration 202608270006 are unchanged.

## Frontend states

- Error: "Too many attempts. Try again later." with no hint about remaining
  count.

## Client calls and contracts

- `redeem_invite_code(code text, actor_key text) returns redemption`.

## Validation rules and limits

- `actor_key` is opaque, capped at 128 characters, never logged in clear with
  the code.
- Throttle state expires after the window.

## Migration outline

- New migration: an `invite_attempts` table keyed by `actor_key` with a
  window timestamp, or an extension of the existing throttle store. schema
  lands it. Update `redeem_invite_code`.

## Dependencies

- Pairs with COMM-016. Blocks Phase 0 exit for this agent.
