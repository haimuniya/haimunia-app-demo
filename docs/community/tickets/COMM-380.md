# COMM-380 Signup screen supports per-person invite codes

Phase: 4
Agent: identity-privacy
Status: done — see docs/community/backlog.md Phase 4 section for what shipped
Attendance-blocked: no

`redeem_invite_code` (COMM-372) is widened server-side to accept either
invite model with no signature change, so the existing code-entry field
needs no new input or branch to keep working. This ticket is the client
half of that widening: the copy and error-handling adjustments a real
per-person invite surfaces that a shared code never did.

## User outcome

Someone redeeming a personal invite sees the same simple code-entry step
every member already sees, and gets an honest, specific message if their
invite was already used or has expired, instead of the generic "invalid
code" copy written for a mistyped shared code.

## Acceptance criteria

- [ ] The existing invite-redemption screen (COMM-016) needs no new field:
  one code input, one submit, unchanged.
- [ ] `redeem_invite_code`'s existing three-way return (`role text` on
  success, `'invalid'`, `'rate_limited'`) is unchanged, so the client's
  existing success/failure branching needs no new case — a per-person
  invite behaves exactly like a shared code from this screen's point of
  view, by design (COMM-372's own anti-enumeration acceptance criterion).
- [ ] The generic `'invalid'` copy is reviewed once against the new
  reality that it now also covers "this invite was already used," "this
  invite was revoked," and "this invite expired" — confirm the existing
  Hebrew copy ("קוד הצטרפות לא תקין") still reads honestly for all four
  cases, or adjust wording if it does not, without adding a fourth branch
  the server does not distinguish.
- [ ] A test covers redemption through a per-person invite end to end
  (mocked): entering a valid per-person code grants the same role and the
  same post-redemption flow (set password, profile form,
  `mark_recovery_verified`) a shared-code redemption already has, with no
  new code path in the profile-setup steps that follow.

## Frontend states

- Unchanged from COMM-016: entry, loading (spinner on submit), error
  (generic invalid/rate-limited copy, retry allowed, invite not consumed),
  success (proceeds to the profile step).

## Client calls and contracts

- `redeem_invite_code(p_code, p_actor_key)` — unchanged signature
  (COMM-372).

## Validation rules and limits

- None new on this side; server-side limits are COMM-370/372's.

## Migration outline

None. Client-only ticket.

## Dependencies

- COMM-372.
