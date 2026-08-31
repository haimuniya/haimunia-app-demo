# COMM-304 Coach Engage activation and attendance-decline detection

Phase: 3
Agent: coach-tools
Status: todo
Attendance-blocked: was — unblocked by COMM-300

Closes the parked COMM-P04. `coach_engagement_flags` has shipped empty since
Phase 0 (202608280011) with a comment naming this exact ticket: "no producer
writes to it until an attendance source exists." COMM-226 already built the
Engage section as a flag-gated, hidden shell reading this table under
existing staff RLS — this ticket turns the flag on and gives the table its
first producer.

## User outcome

A coach sees, without having to notice it themselves across dozens of
members, which members have quietly stopped showing up as often as they used
to — never labelled to the member, never shown to anyone but staff.

## Acceptance criteria

- [ ] A scheduled server-side job computes, per member, a baseline
  sessions-per-week figure (a longer trailing window, for example the prior
  8 weeks) and a recent sessions-per-week figure (a shorter trailing
  window, for example the most recent 2 weeks) from `attendance_log`
  (COMM-300), and inserts a `coach_engagement_flags` row when the recent
  figure drops enough below the baseline to cross one of the table's three
  existing `level` buckets (`mild`, `significant`, `inactive` — the labels
  already exist, this ticket is the first to fill them). The exact drop
  thresholds per bucket are a product-tuning decision this ticket states as
  a named constant, not a magic number buried in a query, so a later tuning
  pass is a one-line change.
- [ ] A member with too little history to have a meaningful baseline (a
  brand-new member, inside their first baseline window) is never flagged —
  there is no such thing as a decline with no prior baseline to decline
  from.
- [ ] A member already carrying an `open` flag is not re-flagged on every
  run: the job either updates the existing open row's figures in place or
  skips a member who already has one, never inserting a second open row for
  the same member (matching `coach_engagement_flags`'s existing shape,
  which is one row per flagged period, staff-reviewable and dismissable).
- [ ] COMM-226's feature flag (`state.featureFlags.coachEngage`) flips to
  default-on in this ticket's shipped build. The section becomes visible to
  staff without any further client-side scaffolding, exactly as COMM-226's
  own acceptance criteria promised.
- [ ] Every rule COMM-226 already pinned still holds: the flagged member
  never reads their own row, even as staff or admin (the table's own RLS
  already guarantees this and this ticket adds nothing that works around
  it); no decline label or session-count figure ever reaches a plain member
  view.
- [ ] A staff member can mark a flag `reviewed` or `dismissed` through the
  Engage section, a direct RLS update the flagged-member-exclusion policy
  already allows for any other staff member.
- [ ] `coach_congratulate_sent`'s existing one-tap pattern (COMM-225) is the
  model for any "reach out" action this section offers on a flag — no new
  "Message" affordance, per the phase's standing no-messaging resolution.

## Frontend states

- Empty: "אין חברים שדורשים תשומת לב" (COMM-226's existing empty state,
  now reachable with real data behind it for the first time).
- Loading: skeleton row (COMM-226, unchanged).
- Error: "לא ניתן היה לטעון את הנתונים." (COMM-226, unchanged).
- Populated: one row per open flag, level badge, no raw session numbers
  shown to anyone but the reviewing staff member per the existing privacy
  rule, review and dismiss controls.

## Client calls and contracts

- Direct RLS read on `coach_engagement_flags` (existing, COMM-011/COMM-226,
  no change).
- Direct RLS update on `coach_engagement_flags` for `status`, `reviewed_by`,
  `reviewed_at` — new write path this ticket needs; the existing staff
  update policy already covers it, no migration required for the grant
  itself.

## Validation rules and limits

- Baseline and recent window lengths, and the per-level drop thresholds,
  are named constants in the scheduled function, not client parameters.
- The job runs on a schedule (pg_cron or a scheduled Edge Function), the
  same "infra not built here" gap already logged for the notification batch
  flusher and `recap_weekly`.

## Migration outline

- No new table — `coach_engagement_flags` already shipped in 202608280011.
- One service-role-only function, `coach_detect_engagement_decline()`,
  reading `attendance_log` and writing `coach_engagement_flags`, same auth
  shape as `chal_notify_ending_soon()` (granted to `service_role` only,
  revoked from `public`, `anon`, `authenticated`).

## Dependencies

- COMM-011, COMM-223, COMM-225, COMM-226, COMM-300.
