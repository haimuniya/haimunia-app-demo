# COMM-313 Retention correlation views

Phase: 3
Agent: admin-moderation
Status: todo
Attendance-blocked: no

Same caveat as COMM-311 and COMM-312: no forward reference exists anywhere
in this repo's docs for this ticket. The scope below is a conservative,
best-effort reading of the title. **Confirmed with the user 2026-08-31:
build against this shape as-is.**

## User outcome

Staff can see whether the things the product already tries to do early — the
onboarding sequence (COMM-222), a first-week challenge nudge, an early
coach Welcome — actually correlate with a member still being active months
later, instead of assuming they help.

## Acceptance criteria

- [ ] A cohort view groups members by join month (`invite_redemptions
  .redeemed_at`) and reports, per cohort, the share still WCAM-qualifying
  in each of their first 12 weeks of membership — a standard retention
  curve, not a single number.
- [ ] A second correlation cuts the same cohorts by whether each completed
  onboarding step (COMM-222's `onboarding_progress` columns:
  `welcomed_at`, `first_week_shown_at`, `first_month_shown_at`, plus the
  two class-attendance steps COMM-316 adds) was ever stamped, so staff can
  see whether a member who saw the step retained differently from one who
  did not. This is a correlation, explicitly not presented as causation
  anywhere in the surface's own copy.
- [ ] A third cut correlates whether a member received a coach Welcome
  (`member_contact_log`, COMM-224) in their first two weeks against the
  same retention curve.
- [ ] Every figure here is a cohort aggregate, never a per-member retained/
  churned label shown next to a name — this stays one step more aggregate
  than COMM-311's segmentation, on purpose, since "did this member churn"
  is a much more sensitive framing than "which bucket are they in today".
- [ ] Gated by real `is_admin`, matching COMM-312's narrower bar rather than
  the broader `community.analytics.view` bar COMM-310 and COMM-311 use,
  since a retention curve is close to COMM-312's "easy to misread out of
  context" concern.

## Frontend states

- Empty: a cohort with fewer than a minimum member count (for example 5, to
  avoid a curve built from 1-2 people) is grouped into "other" rather than
  shown as its own unstable line.
- Loading: skeleton chart.
- Error: "לא ניתן היה לטעון את נתוני השימור."
- Populated: cohort retention curves, with the two correlation cuts as
  toggle-able overlays.

## Client calls and contracts

- New: `retention_cohorts(p_cohort_months int default 6) returns setof
  jsonb`, one row per `(cohort_month, week_number, retained_share,
  member_count)`. `security definer`, real `is_admin` required.
- New: `retention_onboarding_correlation()` and
  `retention_welcome_correlation()`, same auth shape, each returning the
  two-group comparison described above.

## Validation rules and limits

- `p_cohort_months` clamps to 1..24.
- A cohort under the minimum member count is folded into "other", never
  shown as its own line.

## Migration outline

- Three security-definer functions as named above, real-`is_admin`-gated,
  reading `invite_redemptions`, `analytics_events` (WCAM), and
  `onboarding_progress`/`member_contact_log`. No new table.

## Dependencies

- COMM-013, COMM-170, COMM-233, COMM-222, COMM-224, COMM-312, COMM-316.

## Open question

The exact cohort window, the minimum-cohort-size floor, and whether a third
correlation (or a different one entirely) is what the spec actually asks
for are not grounded in text available to this session. Flagged rather than
guessed at specifics beyond the shape above.
