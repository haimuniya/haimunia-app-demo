# COMM-016 Required recovery method at invite redemption

Phase: 0
Agent: identity-privacy
Status: todo
Attendance-blocked: no

Decision locked 2026-08-28: recoverable identity, required. Every member sets a
verified recovery method before or immediately after invite redemption.
Disposable identity is off the table.

## User outcome

Every member has a verified way back to their profile, follows, private sync
cursor, and coach role after a device change or a data clear. No member ends
up on an unrecoverable anonymous account.

## Acceptance criteria

- [x] The user picked recoverable and required. Recorded in
  `2026-08-28-community-module-plan.md`.
- [ ] Invite redemption is gated: the member cannot finish redemption without a
  verified recovery method on file. A verified email plus password is the
  method. Anonymous sign-in still bootstraps the session, but the account is
  not usable in the community until the method is verified.
- [ ] A returning member who verifies the same method on a new device reaches
  their prior profile, follows, private sync cursor, and any coach role.
- [ ] Existing username and password accounts satisfy the requirement without
  re-verification.
- [ ] The gate copy explains why the method is required, in Hebrew.
- [ ] A test covers site-data deletion, reinstall, and device change: the
  member recovers the same profile every time.

## Frontend states

- Redemption, method missing: a blocking step "Secure your account to join",
  with email entry and verification.
- Redemption, method verified: proceeds to the profile step.
- Returning member, new device: a "Recover your account" entry that verifies
  the method and restores the profile.
- Error: verification failure shows a retry and does not consume the invite.

## Client calls and contracts

- Reuses Supabase Auth. If recoverable, `auth.updateUser` for email and
  password link, or a `recovery_code` table with a hashed one-time code.

## Validation rules and limits

- A recovery code is high entropy, shown once, stored hashed.
- Linking never downgrades an existing password account.

## Migration outline

- No `recovery_codes` table. The method is verified email plus password
  through Supabase Auth. `profiles` gains a `recovery_verified_at` timestamp,
  own-row RLS, and community RLS policies require it to be non-null.

## Dependencies

- Decision resolved. Ready to build. Coordinates with `schema` on the
  `recovery_verified_at` column and the redemption-gate policy.
