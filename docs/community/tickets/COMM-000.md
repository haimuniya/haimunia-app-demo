# COMM-000 Convert spec P0 and P1 sections into tickets

Phase: 0
Agent: planner
Status: done
Attendance-blocked: no

## User outcome

Every P0 and P1 section of the product spec exists as a buildable ticket with
testable acceptance criteria, so feature agents never guess scope.

## Acceptance criteria

- [x] `docs/community/tickets/` holds one file per Phase 0 and Phase 1 ticket.
- [x] Each ticket has title, phase, agent, user outcome, acceptance criteria,
  frontend states, client calls and contracts, validation rules, migration
  outline, dependencies, attendance-blocked flag.
- [x] `backlog.md` Phase 1, 2, 3 sections list real ticket tables.
- [x] Every function a Phase 0 or Phase 1 ticket calls exists in
  `contracts.md`.
- [x] Gaps against the spec are logged in `backlog.md` "Open questions for the
  user".

## Frontend states

Not applicable. Documentation only.

## Client calls and contracts

None.

## Validation rules and limits

None.

## Migration outline

None.

## Dependencies

- Inputs: the product spec, the research report, the Hebrew research doc,
  `2026-08-28-community-module-plan.md`.
