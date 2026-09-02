# COMM-364 Add a quota-exceeded regression test for noteStorageError

Phase: Design sync & audit remediation (2026-09-02)
Agent: qa
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Both apps implement `noteStorageError()` to distinguish `QuotaExceededError`
from other IndexedDB failures and surface it to the user, but neither has a
test exercising this path. Community carries materially more storage pressure
(avatar photos, post photos, cached feed/analytics data) than Noam, making a
real quota-exceeded scenario more likely and the untested path riskier
specifically here.

## Acceptance criteria

- [ ] A test mocks IndexedDB rejecting with `QuotaExceededError` and asserts
  `noteStorageError` surfaces it and the app doesn't crash or silently drop the
  write.
- [ ] Test exists in both Community's and (if kept in sync) Noam's `test/`
  directories.

## Location / evidence

- `app.js:258` (Community `noteStorageError`)
- No matching test file in either `test/` directory currently

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
