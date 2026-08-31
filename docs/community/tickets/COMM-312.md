# COMM-312 Community health score, internal only

Phase: 3
Agent: admin-moderation
Status: todo
Attendance-blocked: no

Same caveat as COMM-311: no forward reference exists anywhere in this
repo's docs for this ticket. The scope below is a conservative, best-effort
reading of the title, flagged as an open question rather than treated as
settled.

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

## Open question

Neither the exact weighting formula nor which metrics belong in it is
grounded in spec text available to this session. This ticket proposes a
reasonable, narrow, admin-only shape and flags the formula itself as
something to confirm rather than build to blind.
