# COMM-301 Relationship score from interaction history

Phase: 3
Agent: feed
Status: review
Attendance-blocked: no

## User outcome

The feed's sense of "who this member is close to" is computed the same way
everywhere it is used, instead of a private, one-off computation only
`feed_page` can see.

## Acceptance criteria

- [ ] `feed_page` (202608280019) already scores a relationship component
  inline: mutual follow (`are_friends()`) as the ceiling, a one-way follow
  as most of it, a recent (30-day) reaction or comment on the author topped
  up on top, capped at 1 before its weight applies. This ticket extracts
  that arithmetic into one internal function, `relationship_score(p_viewer
  uuid, p_other uuid) returns numeric`, and `feed_page` calls it instead of
  repeating the inline CTE — same numbers, same order, no ranking change
  for an existing feed session.
- [ ] `relationship_score` is internal (no grant to any client role, called
  only from definer functions that already cross the relevant boundaries),
  matching `consistency_week_streaks()`'s shape: a helper other Phase 3
  definer functions can call, never a second API surface a client reaches
  directly.
- [ ] `people_suggestions` (COMM-232) keeps its own, separately-stated
  priority order (challenge, then interaction, then event) unchanged. This
  ticket does not fold `relationship_score` into it: the two functions
  answer different questions (`people_suggestions` is "who to suggest
  following", `relationship_score` is "how close is this pair already"),
  and merging them would change COMM-232's shipped, tested ordering rule.
- [ ] COMM-303's per-user weight tuning (next ticket) reads
  `relationship_score`'s output as one of the components it can reweight,
  without needing to know its internals.
- [ ] A pgTAP assertion pins `relationship_score` and `feed_page`'s scored
  order to agree on a fixture pair, the same "two copies cannot drift"
  pattern `0034_feed_leaderboard_and_suggestions_test.sql` already uses for
  `consistency_week_streaks()` versus `community_profile`.

## Frontend states

Not applicable. No client-visible change: `feed_page`'s existing ranked
order is preserved bit-for-bit for any feed session that does not also
change under COMM-302 or COMM-303.

## Client calls and contracts

- No new client call. `feed_page(cursor, limit, scope)` keeps its existing
  signature (COMM-110).

## Validation rules and limits

- None new. Same weight and window constants `feed_page` already uses
  (`v_w_relationship`, `v_rel_mutual`, `v_rel_follow`, `v_rel_interaction`,
  `v_rel_window_days`), moved, not changed.

## Migration outline

- `create or replace function public.relationship_score(p_viewer uuid,
  p_other uuid) returns numeric` — the extracted arithmetic, `security
  invoker`, no grant to any client role.
- `feed_page` is re-created to call it in place of its inline CTE. No
  column, no new table.

## Dependencies

- COMM-110, COMM-112, COMM-125 (block edges the existing inline logic
  already respects and this ticket must not loosen).
