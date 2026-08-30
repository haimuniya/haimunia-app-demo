# COMM-223 Coach dashboard shell with Celebrate

Phase: 2
Agent: coach-tools
Status: todo
Attendance-blocked: no

## User outcome

A coach opens one dashboard and immediately sees who is worth celebrating
today.

## Acceptance criteria

- [ ] A "Coach Dashboard" surface exists, reachable only to a caller for whom
  `is_staff()` is true. Sections: Celebrate (this ticket), Welcome
  (COMM-224), Challenges (a coach-scoped view of active challenges and
  participation, reusing COMM-207's data).
- [ ] Celebrate lists, in one feed sorted by recency: recent PRs (last 7
  days), anniversaries (member-since hits a year multiple this week),
  challenge completions (last 7 days).
- [ ] Birthdays are not shown: no birth date field exists, per the
  2026-08-28 decision, and this ticket does not add one.
- [ ] Attendance milestones are not shown: explicitly deferred to COMM-P03
  and COMM-305, not built here.
- [ ] Each item shows the member, what happened, when, and a Congratulate
  action, wired in COMM-225.
- [ ] A Celebrate item never shows a member's PR or achievement that member's
  own privacy toggle hides from a coach the way it would from any other
  member; Celebrate does not bypass `show_prs` or `show_achievements`.
- [ ] A non-staff caller never reaches this surface, verified server-side by
  `coach_celebrate_feed`'s `is_staff()` check, not only hidden client-side.

## Frontend states

- Empty: "אין דבר לחגוג השבוע." when the feed is genuinely empty.
- Loading: skeleton Celebrate rows.
- Error: "לא ניתן היה לטעון את לוח המאמנים. נסו שוב."
- Populated: the sorted Celebrate feed.

## Client calls and contracts

- `coach_celebrate_feed(p_days int default 7) returns setof jsonb`. See
  "Needs from schema, coach-tools" in `docs/community/contracts.md`.

## Validation rules and limits

- Staff-only, enforced server-side.
- `p_days` clamped to 1 through 30.

## Migration outline

- `coach_celebrate_feed`. See "Needs from schema, coach-tools". schema lands
  it.

## Dependencies

- COMM-008, COMM-160, COMM-101.
