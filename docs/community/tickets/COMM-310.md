# COMM-310 Admin community analytics dashboard, full metric set

Phase: 3
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

An admin or a `community.analytics.view` holder sees the club's health at a
glance — WCAM, posting activity, engagement, feed reach, and every
additional metric `docs/community/metrics.md` already defines — in one
dashboard, instead of hand-querying `analytics_events`.

## Acceptance criteria

- [ ] A new admin-only dashboard screen renders every "Core metric" and
  "Additional metric" already defined in `docs/community/metrics.md`
  (spec sections 78 and 79): WCAM and WCAM share, posting members per week,
  engagement per post, feed reach, open rate per surface, filter use,
  sub-tab split, notification effectiveness, social graph growth, challenge
  and leaderboard pull, moderation load, share intent split, recap
  pull-through, discovery split, coach reach, push adoption. No metric is
  invented beyond that list — this ticket is the surface for numbers the
  event schema already supports, per that file's own closing note that
  section 79's full list was reconciled against the shipped schema, not
  the other way around.
- [ ] Every figure is computed server-side by a definer function (or a
  small set of them, one per metric family) reading `analytics_events` and
  the community tables directly, never by shipping raw `analytics_events`
  rows to the client — `analytics_events`'s own RLS already restricts read
  to a `community.analytics.view` holder, and this ticket does not widen
  that grant, it adds an aggregate read path on top of it.
- [ ] A week or month selector re-queries the same figures for a chosen
  period, matching the weekly/monthly cadence the underlying metrics are
  already defined in terms of.
- [ ] No figure in this dashboard is broken out to an individual member —
  every number is a club-wide or per-surface aggregate, matching the
  "aggregate only, never per-member" posture `weekly_recaps` and
  `monthly_club_recaps` (COMM-309) already established for the same class
  of data.
- [ ] Gated by `community.analytics.view` or real `is_admin`, matching every
  other analytics-holder surface already in this schema.

## Frontend states

- Empty: a period with zero rows (a genuinely quiet week, or before the
  module had data) renders honest zeros, not an error.
- Loading: skeleton metric cards.
- Error: "לא ניתן היה לטעון את הנתונים."
- Populated: metric cards/sections grouped to match `metrics.md`'s own
  "Core metrics" / "Additional metrics" split.

## Client calls and contracts

- New: `analytics_dashboard(p_period_start date, p_period_end date) returns
  jsonb` — security definer, `community.analytics.view` or real `is_admin`
  required, one object carrying every metric named above, keyed by name.
  One call per dashboard load rather than one RPC per metric card, matching
  `coach_celebrate_feed`'s "one call for the whole list" shape.

## Validation rules and limits

- `p_period_start`/`p_period_end` bounded to a maximum lookback (for
  example 1 year) so a pathological range cannot force a full-table scan
  from the dashboard.
- No new rate limit: a staff-only dashboard read, not a member-facing
  action.

## Migration outline

- `analytics_dashboard(p_period_start date, p_period_end date) returns
  jsonb` — security definer, `community.analytics.view` or `is_admin()`
  gated, reading `analytics_events` plus `post_comments`, `reactions`,
  `workout_posts`, `notifications`, `reports`, `push_subscriptions` for the
  cross-checks `metrics.md` already names as the "not the source, the
  cross-check" pattern.
- No new table.

## Dependencies

- COMM-013, COMM-170, COMM-233, every Phase 1/2 producer the metrics list
  already depends on.
