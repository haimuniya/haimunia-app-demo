# COMM-311 Member engagement segmentation

Phase: 3
Agent: admin-moderation
Status: review — both halves shipped (schema + cloud.js client)
half (the segment cards, the period selector and the drill-down list) still
open
Attendance-blocked: no

No forward reference for this ticket exists anywhere in
`docs/community/contracts.md` or `docs/community/backlog.md` today, unlike
the attendance-gated cluster. The acceptance criteria below are this
planner's best-effort reading of the title against the metrics and RLS
patterns already shipped, not a transcription of spec text this session had
access to. **Confirmed with the user 2026-08-31: build against this shape
as-is rather than waiting for real spec text.**

## User outcome

Staff sees the club's membership grouped into a small number of meaningful
buckets — highly active, steady, declining, dormant, new — instead of one
undifferentiated member list, so outreach and programming decisions can
target a segment rather than guessing.

## Acceptance criteria

- [ ] Every member is assigned to exactly one segment per computation run,
  from a fixed, named set (proposed: `new` — inside their first 30 days;
  `highly_active` — WCAM-qualifying in each of the last 4 weeks;
  `steady` — WCAM-qualifying in at least half of the last 8 weeks;
  `declining` — carries an open `coach_engagement_flags` row (COMM-304);
  `dormant` — no WCAM-qualifying activity in the last 8 weeks and not
  `new`). This bucket set and its thresholds are a product decision this
  ticket states as named constants, open to a later tuning pass without a
  reshaped output.
- [ ] A dashboard view (admin-moderation surface, reusing COMM-310's
  dashboard shell) shows the count and share of members per segment, with
  a period selector.
- [ ] Drilling into a segment lists the members in it by name — this is the
  one place in this ticket's scope where individual attribution is
  intentional (unlike COMM-310's aggregate-only dashboard), since acting on
  a segment means knowing who is in it. Still respects `visible_to_club`
  the same way any other staff-facing member list already does.
- [ ] Segmentation never exposes a `declining` label to the member it
  describes, matching `coach_engagement_flags`'s own rule — the segment
  view is staff-only end to end, gated by `community.analytics.view` or
  `is_admin`.

## Frontend states

- Empty: fewer than one member in a segment for the chosen period shows
  "0" for that segment, not an omitted row.
- Loading: skeleton segment cards.
- Error: "לא ניתן היה לטעון את הפילוח."
- Populated: segment cards with counts, expandable to a member list.

## Client calls and contracts

- New: `member_segments(p_as_of date default current_date) returns setof
  jsonb`, one row per member: `{user_id, display_name, handle, segment}`.
  `security definer`, `community.analytics.view` or `is_admin` required.

## Validation rules and limits

- Segment thresholds are named constants in the function, not client
  parameters.

## Migration outline

- `member_segments(p_as_of date)` — security definer, reads
  `analytics_events` (WCAM), `invite_redemptions` (tenure for `new`), and
  `coach_engagement_flags` (for `declining`). No new table.

## Dependencies

- COMM-013, COMM-170, COMM-233, COMM-304, COMM-310.

## Open question — RESOLVED 2026-08-31

Confirmed with the user: build against the proposed shape as-is. The schema
half did, and shipped in `202609010007`. Two gaps in the proposed shape had
to be closed by judgment while building; both are written out in full in
`docs/community/contracts.md` under "## Needs from schema, member engagement
segmentation (COMM-311, Phase 3)" and both are one-line reversible.

- **The five named buckets are not exhaustive**, and the first acceptance
  criterion requires that they be. A member WCAM-qualifying in 1, 2 or 3 of
  the last 8 weeks, with no open flag and more than 30 days of tenure, is
  not `new`, not `highly_active` (needs 4 of the last 4), not `steady`
  (needs 4 of 8), not `declining`, and **not `dormant` either** — `dormant`
  is defined as *no* qualifying activity. A sixth bucket, `occasional`, was
  added rather than stretching `dormant` over people who were in the app
  three weeks out of eight.
- **No precedence is stated** between buckets a member can match at once.
  Resolved as `new` > `declining` > `highly_active` > `steady` >
  `occasional` > `dormant`. `declining` above `highly_active` is the one
  departure from the order the acceptance criteria list the buckets in, and
  is argued in the migration header and the contract: the flag is verified
  attendance decline and WCAM is app engagement, so a member who stopped
  training but still opens notifications must not be hidden.

Neither reshapes the output; `segment` is one text value either way, which is
the later-tuning latitude this ticket's first criterion already grants.
