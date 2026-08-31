# COMM-303 Personalized feed ranking and per-user weights

Phase: 3
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

Two members with very different habits — one who lives in challenges, one
who never joins one but comments on everything — each get a feed order that
reflects what they actually engage with, instead of one fixed weighting for
the whole club.

## Acceptance criteria

- [ ] `feed_page`'s fixed weight block (`v_w_recency`, `v_w_relationship`,
  `v_w_coach`, `v_w_achievement`, `v_w_challenge`, `v_w_engagement`,
  `v_w_personal`, `v_w_class`) becomes a per-user override on top of the
  same defaults, not a second scoring engine: a member with no stored
  weights gets exactly today's fixed weights, so this ticket changes no
  existing feed order until a weight is actually personalized.
- [ ] Per-user weights are derived, not member-configured: no settings
  screen where a member drags sliders. They are computed from the member's
  own `feed_interactions` history (COMM-114) — which components (coach
  content, PRs, challenge posts, achievement posts) they engage with more
  than the club average — recomputed periodically, not on every feed
  request.
- [ ] The positive weights still sum to a constant total per member (the
  existing "104, so they read as rough percentages" property), so
  personalization redistributes emphasis rather than inflating the whole
  score.
- [ ] A member who never engages enough to produce a signal (a new member,
  or one who only ever scrolls) keeps the fixed defaults — this ticket
  never produces a personalized weight set from zero data.
- [ ] `v_w_class` (COMM-302's class-connection weight) is one of the
  components personalization can move, same as any other.
- [ ] `feed_diversity` rules (COMM-112) are evaluated after personalized
  scoring, unchanged: personalization changes emphasis inside the ranked
  set, not the diversity guarantee across post types and authors.

## Frontend states

Not applicable beyond the existing feed states (COMM-110): empty, loading,
error, populated. No new UI — personalization is invisible ranking, not a
setting.

## Client calls and contracts

- `feed_page(cursor, limit, scope)` — unchanged signature. The personalized
  weights are read inside the function from a new per-user weights table,
  never passed as a parameter (a client-supplied weight would be exactly
  the kind of client-trusted ranking input the rest of this schema avoids).

## Validation rules and limits

- Recomputation is a scheduled job (same "infra not built here" shape as
  the notification batch flusher and `recap_weekly`'s own cron gap), not a
  per-request computation — `feed_page` stays a fast read.
- Weight bounds: each component clamps to a floor and ceiling (for example
  40% to 250% of its default) so personalization can shift emphasis but
  never zero out or dominate a component entirely, keeping the feed
  recognizably the same ranking system for every member.

## Migration outline

- `member_feed_weights(user_id uuid pk references profiles(id) on delete
  cascade, weights jsonb not null default '{}', computed_at timestamptz not
  null default now())`. Own-row select only, no client write grant — only
  the scheduled recomputation (service role) writes it, the same shape
  `weekly_recaps` already uses for a service-role-only writer.
- `create or replace function public.feed_page(...)` — same signature,
  reads `member_feed_weights` for the caller and falls back to the fixed
  defaults when absent.
- A `recompute_feed_weights()` service-role function or scheduled job, not
  client-reachable, mirroring `notif_batch_flush_due`'s auth shape.

## Dependencies

- COMM-110, COMM-112, COMM-114, COMM-301, COMM-302.

## Open question

The exact recomputation cadence and the per-component clamp bounds are a
product tuning decision, not something derivable from the spec text this
planner has access to. Flagged rather than guessed at a specific number.
