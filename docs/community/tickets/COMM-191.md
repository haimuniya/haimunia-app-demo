# COMM-191 Phase 1 coverage sweep and CI gate

Phase: 1
Agent: qa
Status: todo
Attendance-blocked: no

## User outcome

V1 ships with every acceptance criterion covered and all three CI jobs green.

## Acceptance criteria

- [ ] Every Phase 1 ticket has at least one test mapping to each acceptance
  criterion, or a written note why a criterion is not machine-testable.
- [ ] `npm test` count rises from 266 with no pre-existing test removed or
  weakened.
- [ ] The Playwright browser suite gains scenarios for: create a text post,
  share a workout, comment and reply, react, open the notification center,
  file a report.
- [ ] `migration-check` applies every new migration clean.
- [ ] A short release checklist in `docs/community/v1-release.md` maps to
  spec section 89 and is all ticked.

## Frontend states

Not applicable. Test suite and checklist.

## Client calls and contracts

- Exercises every Phase 1 contract.

## Validation rules and limits

- A red job blocks the V1 tag.

## Migration outline

- None.

## Dependencies

- All Phase 1 tickets.
