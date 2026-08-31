# COMM-317 Phase 3 QA sweep

Phase: 3
Agent: qa
Status: todo
Attendance-blocked: no

## User outcome

Phase 3 ships with the same CI guarantee Phase 1 and Phase 2 had: every
acceptance criterion has an assertion, and all three CI jobs stay green.

## Acceptance criteria

- [ ] Every Phase 3 ticket's acceptance criteria has a matching test,
  cross-referenced by ticket id in the PR that closes it.
- [ ] `attendance_log` (COMM-300) gets the same RLS boundary discipline
  every other new table in this module has gotten since Phase 0: own-row
  select, staff/analytics-holder select-any, no client insert/update/delete
  grant at all, and specifically a runtime pgTAP assertion (not only a
  static one) that the `private_records` trigger, not a direct insert, is
  the only path a row ever appears through — this is the single boundary
  the whole phase's gating depends on, so it gets the most scrutiny of any
  table this sweep touches.
- [ ] `coach_engagement_flags`'s single most important assertion, already
  pinned in the Phase 0 handoff ("the flagged member can never read their
  own row, even as staff or admin"), is re-verified against COMM-304's real
  producer, not just the empty-table shape it was pinned against before —
  the concern is real now that the table has rows for the first time.
- [ ] Every achievement crossing COMM-305 activates (first class, 25
  classes, 100 classes, weekly streak) gets a boundary test confirming it
  is not reachable through `ach_claim` — `ach_claim`'s existing
  `trigger_type <> 'ATTENDANCE_RECORDED'` refusal (202608280020) is
  re-asserted against a caller trying to game each of the four specific
  codes now that they are `enabled`, not only asserted in the abstract.
- [ ] `consistency_week_streaks()` and `community_profile`'s inline copy
  (COMM-306) are re-verified to still agree with each other on a fixture
  member, the same "two copies cannot drift" assertion
  `0034_feed_leaderboard_and_suggestions_test.sql` already runs, now against
  the new attendance-based body rather than the old post-based one.
- [ ] Every function this phase adds that crosses a privacy toggle
  (`show_attendance` in COMM-302, COMM-306, COMM-307, COMM-316;
  `in_leaderboards` and `show_prs` in COMM-315) gets an allow/deny pair the
  same way `feed_leaderboard`'s and `people_suggestions`'s toggles already
  do: a member with the toggle off is excluded from the relevant surface
  for every other member, and a block edge in either direction is excluded
  regardless of any toggle.
- [ ] Browser scenarios added for: logging a session and seeing the
  post-class classmates card appear (COMM-307); opening a recap and seeing
  the classmates line (COMM-316); the coach Engage section showing a real
  flagged member for the first time (COMM-304); publishing a monthly club
  recap from the admin preview (COMM-309); publishing a member-of-the-week
  pick (COMM-315).
- [ ] Every scheduled-job gap this phase logs as "infra not built here"
  (COMM-304's decline detector, COMM-309's monthly Edge Function, COMM-314's
  daily purge, COMM-303's weight recomputation) is called out in one place
  in this sweep's own summary rather than left scattered across five
  tickets' individual notes, matching how COMM-234 consolidated the
  notification-batch-flusher scheduler gap.
- [ ] No regression in the existing suite or the browser checks.
- [ ] Every open question this phase's tickets flagged (COMM-311, COMM-312,
  COMM-313, COMM-315's category/threshold uncertainty; COMM-314's retention
  window; COMM-300's "verified means self-reported, not physically
  verified" framing) is either resolved with the user before the ticket is
  built, or shipped exactly as scoped with the caveat still visible in the
  merged docs — never silently narrowed or widened by whichever agent
  happens to build it.

## Frontend states

Not applicable. This ticket is the test and CI gate for every other Phase 3
state already specified in its own ticket.

## Client calls and contracts

- No new contract. Exercises every Phase 3 contract listed in
  `docs/community/contracts.md`.

## Validation rules and limits

- A ticket is not counted done until all three CI jobs pass on it, matching
  the standing qa rule.

## Migration outline

- None directly; may prompt a schema follow-up if a boundary test finds a
  gap, same as COMM-019/COMM-020 and COMM-234's own sweep did in earlier
  phases.

## Dependencies

- Every Phase 3 ticket, COMM-300 through COMM-316.
