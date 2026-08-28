# COMM-190 Phase 1 dialog keyboard and focus tests

Phase: 1
Agent: qa
Status: todo
Attendance-blocked: no

## User outcome

Every new dialog in V1 is usable by keyboard and screen reader, closing an
open accessibility blocker from the 2026-08-27 rescan.

## Acceptance criteria

- [ ] Tests cover the composer, the PR share prompt, the achievement
  celebration, the notification center, the report sheet, and the moderation
  action confirms.
- [ ] Each test asserts: the opener is stored, first meaningful control is
  focused, Tab and Shift+Tab are trapped, an Escape policy applies,
  background is inert, focus returns to the opener on close.
- [ ] Tests run under `npm test` with jsdom where possible, and a browser
  scenario where focus behavior needs a real engine.
- [ ] A shared dialog controller is introduced if the per-dialog code
  diverges, and the tests target it.

## Frontend states

Not applicable. Test suite.

## Client calls and contracts

- None.

## Validation rules and limits

- A dialog without focus return is a test failure.

## Migration outline

- None.

## Dependencies

- COMM-102, COMM-133, COMM-134, COMM-140, COMM-151, COMM-153.
