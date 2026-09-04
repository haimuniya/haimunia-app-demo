# COMM-379 Registration funnel analytics screen

Phase: 4
Agent: admin-moderation
Status: done
Attendance-blocked: no

## User outcome

An admin sees, for a chosen period, how many people were invited, how many
redeemed, how many finished their profile, and how many verified — with the
drop-off between each step, in the same dashboard area the rest of
community analytics already lives in.

## Acceptance criteria

- [ ] A new section (in or alongside COMM-310's existing admin analytics
  dashboard, sharing its period selector rather than adding a second one)
  renders `registration_funnel`'s response: shared-code activity,
  per-person invite counts, and the four-step funnel (issued, redeemed,
  profile completed, verified) with a drop-off percentage between each
  consecutive step.
- [ ] The funnel is rendered as an ordered set of steps with a real number
  and a real percentage-of-previous-step at each stage, not just four
  independent counters — the whole point is seeing where people fall off.
- [ ] `invites_issued`'s per-person-only scope (COMM-375) is labeled
  clearly enough that an admin does not read it as "everyone who could
  have joined" — shared-code activity is shown as its own line, not folded
  silently into the funnel's first step.
- [ ] A null ratio (zero denominator) renders an em dash, matching the
  module's existing convention for `analytics_dashboard`, never a
  misleading `0%` or `NaN%`.
- [ ] Gated on `community.analytics.view` or real `is_admin()`, matching
  the RPC's own gate — a coach without that permission does not see the
  nav entry.

## Frontend states

- Empty: a period with zero invites of either kind renders honest zeros
  and em-dash rates, not an error.
- Loading: skeleton metric cards, matching COMM-310's existing pattern.
- Error: "לא ניתן היה לטעון את נתוני ההרשמה."
- Populated: the funnel and the two supporting panels described above.

## Client calls and contracts

- New: `registration_funnel(p_period_start, p_period_end)` — COMM-375.

## Validation rules and limits

- Same period bound as `analytics_dashboard` (366 days), enforced
  server-side; the client's period selector should not offer a wider
  range than the server will accept.

## Migration outline

None. Client-only ticket.

## Dependencies

- COMM-375, COMM-310 (shares its dashboard shell and period selector).
