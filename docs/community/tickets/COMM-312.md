# COMM-312 Community health score, internal only

Phase: 3
Agent: admin-moderation
Status: in progress — schema half shipped (202609010009 + pgTAP 0053); client
half (the score card, the component breakdown and the trend line, with the
Hebrew error copy) still open
Attendance-blocked: no

Same caveat as COMM-311: no forward reference exists anywhere in this
repo's docs for this ticket. The scope below is a conservative, best-effort
reading of the title. **Confirmed with the user 2026-08-31: build against
this shape as-is.**

## User outcome

The product team has one composite number tracking whether the club's
community layer is healthy or slipping, without needing to read every
individual metric in `docs/community/metrics.md` separately.

## Acceptance criteria

- [ ] A single `community_health_score`, 0-100, computed weekly from a
  fixed, named combination of already-defined metrics: WCAM share, an
  engagement-per-post figure, a moderation-load figure (inverse — more
  reports lowers the score), and a retention signal (COMM-313, once it
  exists). Weights are named constants, not tuned in this ticket beyond a
  reasonable starting split, and are expected to move.
- [ ] "Internal only" means this ticket adds no member-facing surface at
  all, and no general-staff surface either — real `is_admin` (not merely
  any `community.analytics.view` holder) is the read gate, narrower than
  every other admin dashboard ticket in this phase, since this figure is
  interpretive and easy to misread out of context.
- [ ] The score and its component breakdown are stored per computed week,
  so a trend line is possible without recomputing history.
- [ ] No score is ever shown to a member, a coach without admin rank, or
  surfaced in any notification, recap, or post.

## Frontend states

- Empty: fewer than 2 computed weeks shows the latest score with no trend
  line rather than a broken chart.
- Loading: skeleton score card.
- Error: "לא ניתן היה לטעון את הציון."
- Populated: the current score, its component breakdown, and a trend line
  over stored history.

## Client calls and contracts

- New: `community_health_history(p_weeks int default 12) returns setof
  jsonb`, `{week_start, score, components}`. `security definer`, real
  `is_admin` required (not `community.analytics.view` alone).

## Validation rules and limits

- `p_weeks` clamps to 1..52.
- Component weights are named constants in the computing function.

## Migration outline

- `community_health_scores(id uuid pk, club_id uuid not null default
  default_club_id(), week_start date not null unique, score numeric not
  null, components jsonb not null default '{}', computed_at timestamptz not
  null default now())`. RLS: real-`is_admin`-only select, no client write
  grant — only a scheduled service-role job writes it.
- `community_health_history(p_weeks int)` as above.

## Dependencies

- COMM-013, COMM-170, COMM-233, COMM-310, COMM-313.

### Dependency note — COMM-313 was built FIRST, and had to be

The cluster does not run 310 → 311 → 312 → 313. **COMM-312 reads COMM-313**
(the retention signal above is one of the four weighted inputs) and
**COMM-313 reads nothing COMM-312 produces** — it borrows only the wording of
this ticket's permission gate, which is copied by writing `is_admin()`, not
by depending on code. So the real order is 310 → 311 → 313 → 312, which is
the order taken. Recorded here, in `backlog.md`, in `contracts.md` and in
`202609010008`'s own header rather than left as a silent reordering.

## ~~Open question~~ — RESOLVED

~~Neither the exact weighting formula nor which metrics belong in it is
grounded in spec text available to this session. This ticket proposes a
reasonable, narrow, admin-only shape and flags the formula itself as
something to confirm rather than build to blind.~~

**Confirmed with the user 2026-08-31: build against this shape as-is.** The
schema half shipped in `202609010009` with pgTAP `0053`. The weighting
formula was therefore a decision made while building, not a blind guess, and
it is written out in full in `docs/community/contracts.md` under "Needs from
schema, community health score (COMM-312, Phase 3)". In brief:

- **Weights: WCAM share 0.40, engagement per post 0.25, retention 0.25,
  moderation load 0.10 (inverse).** Reach is the largest single input, but
  the two quality inputs together (0.50) outweigh it, so a spike in activity
  with no depth behind it cannot carry the score. Moderation is smallest and
  deliberately non-zero: it is a penalty signal that a healthy club sits at
  the top of permanently, so a bigger weight would be free points, while 0.10
  still lets a real crisis take a visible ten points off.
- **Two normalisation constants this ticket does not mention at all**, both
  needed because two of the four metrics are not naturally 0..1: **3.0**
  interactions per post for full engagement marks, and **10.0** reports per
  100 members per week for a zero on moderation.
- All six are **a starting split, expected to move**, exactly as this ticket
  frames them — and they are stored inside every row's `components`, so a
  trend line spanning a weight change is readable as such rather than as a
  change in the club.

Three things the proposed shape did not specify, resolved by judgement:

- **Which COMM-313 output is "a retention signal":** the pooled week-4
  retained share out of the **private** `retention_member_weeks(6)`. It is
  the only one of COMM-313's functions a service-role job can call, because
  the other three raise on a null `auth.uid()`. Week 4 because week 1 barely
  distinguishes retention from signup and week 12 would lag the score by a
  quarter; pooled because a single small cohort would make a weekly number
  jump for reasons unrelated to the week.
- **A component with no data drops out and the remaining weights are
  renormalised**, rather than being scored zero — otherwise a week with no
  posts is punished twice for the same quietness.
- **The scheduled writer**, which the migration outline implies but does not
  name, shipped as `community_health_generate(p_week_start date default null)
  returns uuid`, service-role only, **idempotent per week** via `on conflict
  (week_start) do update` (forced by the outline's own `week_start unique`),
  refusing a week that has not finished.

**One open item came out of the build, and it belongs to COMM-313, not
here:** `retention_member_weeks()` is anchored on `now()` and takes no as-of
parameter, so this score's retention component is measured as of the run and
not as of the scored week. Harmless on a weekly schedule; misleading in a
backfill, where every generated week gets the same value. The fix is an as-of
parameter on that function.
