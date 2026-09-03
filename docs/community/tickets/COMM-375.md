# COMM-375 Registration funnel analytics RPC

Phase: 4
Agent: schema
Status: review — schema shipped (see docs/community/backlog.md Phase 4 section and contracts.md for final signatures)
Attendance-blocked: no

Reads across the tables this whole ticket cluster touches
(`invite_codes`, `invites`, `invite_redemptions`, `profiles`) to answer one
question the admin dashboard (COMM-310) does not: of everyone invited, how
many actually joined, finished their profile, and verified their account —
and where does the drop-off happen. Follows `analytics_dashboard`'s
established shape (COMM-310): one call, a validated (never clamped)
period, `community.analytics.view` or real `is_admin()` gated, aggregate
only.

## User outcome

An admin sees, for a chosen period, how many invites went out, how many
were redeemed, how many of those finished their profile, and how many
verified — as a funnel with a real drop-off number at each step, instead
of hand-querying four tables.

## Acceptance criteria

- [ ] `registration_funnel(p_period_start date, p_period_end date) returns
  jsonb` computes, for the given inclusive period: shared-code redemptions,
  per-person invites created/redeemed/revoked, and the same three
  downstream steps every registration goes through regardless of invite
  type — redeemed, profile completed, verified.
- [ ] "Profile completed" is a `profiles` row existing (`profiles.created_at`
  in the period) — the flow this schema already enforces is redeem, then
  set username/password, then the profile form, then `profiles` insert, so
  a profile row is the server-observable marker of that step finishing.
- [ ] "Verified" is `profiles.recovery_verified_at` set within the period.
- [ ] The funnel's `invites_issued` figure and its derived redemption rate
  cover per-person invites only — a shared code has no "issued" event to
  divide by, since it is a standing, reusable code rather than a one-off
  sent to someone. Shared-code activity is reported alongside (`active`
  count, redemptions in period) but is not folded into the same
  denominator. `redeemed`/`profile_completed`/`verified` count every
  account regardless of which invite type it came through, so `redeemed`
  can legitimately exceed `invites_issued` in a club still mostly using
  the shared code.
- [ ] Gated on `has_perm('community.analytics.view')` or real `is_admin()`
  — the same pair, same order, as `analytics_dashboard`.
- [ ] Same period-handling rules as `analytics_dashboard`: `p_period_end`
  inclusive, span capped at 366 days, both bounds required, refused (never
  clamped) on `'period required'` / `'period end before start'` /
  `'period exceeds 366 days'`.
- [ ] Ratios are `null`, never `0`, over a zero denominator, matching the
  module's standing "an honest zero and an undefined rate are different
  claims" rule.
- [ ] No individually-attributable data in the response — every value is a
  count or a ratio, the same "aggregate only" posture `analytics_dashboard`
  and the monthly recap already hold.

## Frontend states

Not applicable. RPC only; COMM-379 builds the screen.

## Client calls and contracts

- New: `registration_funnel(p_period_start date, p_period_end date)
  returns jsonb`. Full response shape in `docs/community/contracts.md`
  under "Needs from schema, registration and invite management (Phase 4)".

## Validation rules and limits

- Same lookback cap as `analytics_dashboard` (366 days), for the same
  reason: a pathological range should not force a full-table scan from an
  analytics screen.

## Migration outline

- `registration_funnel(p_period_start date, p_period_end date) returns
  jsonb`: `security definer`, `stable`, `set search_path = ''`, gated
  identically to `analytics_dashboard`, reading `invite_codes`,
  `invites`, `invite_redemptions`, and `profiles` only — no new table.

## Dependencies

- COMM-370 and COMM-371 (the tables this reads must exist). COMM-379
  (admin UI) calls this RPC.
