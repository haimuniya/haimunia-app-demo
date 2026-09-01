# COMM-313 Retention correlation views

Phase: 3
Agent: admin-moderation
Status: review — both halves shipped (schema + cloud.js client)
half (the cohort chart, the two overlay toggles and the Hebrew error copy)
still open
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

### Dependency note — COMM-312 is NOT one, and the order is reversed

Checked while building rather than followed. **COMM-313 reads nothing
COMM-312 produces**: neither the acceptance criteria above nor the client
contracts mention `community_health_scores` or any COMM-312 function, and
the only thing this ticket takes from that one is the *wording of the
permission gate* ("matching COMM-312's narrower bar"), which is copied by
writing `is_admin()`, not by depending on code.

**COMM-312 genuinely depends on COMM-313**: its score names "a retention
signal (COMM-313, once it exists)" as one of its four weighted inputs. So
the dependency runs the other way and COMM-313 first is the only order in
which either ticket can be built. That is the order taken — COMM-313
shipped in `202609010008`, and `retention_cohorts()` plus the private
`retention_member_weeks()` are available to COMM-312 as its retention input.

`backlog.md`'s "COMM-310 through COMM-313, in that order — each later one in
that cluster reads the one before it" holds for 310 → 311 → 313 and is
wrong for the 312/313 pair; corrected there.

## Open question — RESOLVED 2026-08-31

Confirmed with the user: build against the proposed shape as-is. The schema
half did, and shipped in `202609010008` (three public functions, one private
helper, one constant function, no new table), with pgTAP coverage in
`supabase/tests/0052_retention_cohorts_test.sql`. Four things the proposed
shape does not decide had to be decided by judgment while building. All four
are written out in full in `docs/community/contracts.md` under "## Needs from
schema, retention correlation views (COMM-313, Phase 3)"; the two that are
reversible are one line each.

- **The cohort window is 6 months by default, clamped 1..24**, exactly as the
  signature above says, and the two correlations use the same 6 as a named
  constant because their contract gives them no parameter.
- **The minimum-cohort-size floor is 5**, the ticket's own example; nothing
  in the repo grounds a different number. What five buys concretely: no
  figure this feature emits can move more than 20 percentage points when one
  person changes their mind, and no share can read 0% or 100% off fewer than
  five people. **It is applied twice** — the ticket's rule (a small cohort
  month folds into `other`) and an extension of the same reason (a
  `(group, week)` cell under five members is not emitted at all, which always
  truncates the tail of a line and never gaps one). The extension is the
  decision here most worth a second opinion; deleting one `where` clause per
  function reverses it and ships every cell with its own `member_count`.
- **A "week" is 7×24h from the member's own join instant, not an ISO week.**
  Forced by "their first 12 weeks of membership": a cohort is a calendar
  month, so its members join on different days, and on an ISO grid a Sunday
  joiner would get a one-day week 1 and read as a week-1 dropout for no
  reason but the day they signed up. Which events qualify is unchanged —
  `analytics_wcam_events()`, no second copy of the list.
- **The third correlation is the one this ticket names**, coach Welcome
  within two weeks, with one honest gap: `member_contact_log` has no
  kind/type column, so "a Welcome" is really "any coach contact inside 14
  days". If that needs to be exact, the fix is a `kind` column on that table,
  not a heuristic here.

Two consequences a client build must know: **soft-deleted members stay in
their cohort** (the clearest churn there is — excluding them would compute
every curve over survivors only), and **a week counts for a member only once
it has fully elapsed**, so a young cohort returns a short line, or no line at
all, rather than a row of zeroes.
