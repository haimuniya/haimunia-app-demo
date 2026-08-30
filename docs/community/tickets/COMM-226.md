# COMM-226 Coach Engage section scaffold, hidden

Phase: 2
Agent: coach-tools
Status: todo
Attendance-blocked: partial

## User outcome

The Engage section exists in the codebase as an inert, hidden shell, so
Phase 3 can populate it with attendance-decline data with no further nav or
scaffolding work.

## Acceptance criteria

- [ ] An Engage section is defined inside the coach dashboard shell
  (COMM-223) but renders only behind a feature flag that defaults off (for
  example `state.featureFlags.coachEngage`), so it is invisible in the
  shipped Phase 2 build.
- [ ] The section reads `coach_engagement_flags` (COMM-011) under the
  existing staff RLS. The table stays empty in Phase 2: no producer is added
  by this ticket.
- [ ] No decline label, level, or session-count figure from this table is
  ever rendered to a plain member view, and no code path reaches it outside
  the flag-gated staff surface, matching coach-tools.md's rule to never
  expose decline labels to members.
- [ ] Turning the flag on locally with an empty table renders a clean
  "אין פריטים לבדיקה" state, tested, so flipping the flag on for real later
  needs no further UI work, only real rows.
- [ ] The flagged member's own row is never readable even by themselves as
  staff, which the table's own RLS already guarantees (`user_id <>
  auth.uid()` on every policy); this ticket adds no client-side workaround
  around that.

## Frontend states

- Empty: "אין פריטים לבדיקה." (only reachable with the flag on).
- Loading: skeleton row, only reachable with the flag on.
- Error: "לא ניתן היה לטעון את הנתונים." only reachable with the flag on.
- Populated: not reachable in Phase 2, since the table ships empty.

## Client calls and contracts

- Direct RLS read on `coach_engagement_flags` (existing policies, COMM-011).
  No new contract.

## Validation rules and limits

- Flag defaults off in every shipped build until COMM-304 turns it on.

## Migration outline

- None. `coach_engagement_flags` already shipped empty in 202608280011.

## Dependencies

- COMM-011, COMM-223.
