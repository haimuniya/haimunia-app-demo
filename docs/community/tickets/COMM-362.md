# COMM-362 Add a session-expiry / refresh-failure auth test

Phase: Design sync & audit remediation (2026-09-02)
Agent: qa
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Auth coverage is otherwise strong (anonymous bootstrap, credential upgrade,
sign-out/sign-in, realtime teardown/reconnect), but nothing simulates a
Supabase JWT expiring or a refresh-token failure mid-session — a plausible
scenario for a gym-use PWA that's often backgrounded.

## Acceptance criteria

- [ ] A test mocks a 401 from Supabase mid-session and asserts the app re-
  authenticates or degrades to a clear signed-out state rather than silently
  failing writes.
- [ ] Coverage includes both the sync path and the realtime-subscribe path.

## Location / evidence

- `test/community-anonymous-auth.test.mjs`, `community-username-password-
  auth.test.mjs`, `community-live-sync-and-auth.test.mjs`, `platform-
  realtime.test.mjs` (existing auth coverage, no expiry case)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
