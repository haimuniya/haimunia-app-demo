# COMM-306 Consistency leaderboard on verified attendance

Phase: 3
Agent: feed
Status: review
Attendance-blocked: was — unblocked by COMM-300

Closes the parked COMM-P02. `consistency_week_streaks()`'s own comment
(202608290015) already names this exact ticket as "the single place COMM-306
changes to move consistency onto verified attendance" — that promise is the
whole scope of this ticket.

## User outcome

The "טבלת עקביות" board on the Boards sub-tab, and every profile's
`current_streak` figure, count weeks a member actually trained instead of
weeks they happened to post a workout or a PR to the feed.

## Acceptance criteria

- [ ] `consistency_week_streaks()`'s body is replaced: the same "distinct
  ISO weeks, anchored on the most recent, counted back while contiguous,
  current or previous week as the anchor" arithmetic, now over
  `attendance_log.occurred_on` instead of `workout_posts.occurred_on` /
  `created_at` for `POST_WORKOUT`/`POST_PR`. `feed_leaderboard`'s
  signature, its `p_mode = 'consistency'` contract, and every rule already
  documented under "feed_leaderboard" in `docs/community/contracts.md`
  (privacy filter, tie-break, always-return-self, zero-is-real) are
  unchanged — this ticket touches exactly the one function body that
  comment already named, nothing else.
- [ ] `community_profile`'s own inline `current_streak` copy
  (202608280022) is updated the same way, in the same migration, so the two
  do not drift apart the way the existing pgTAP assertion already checks
  they cannot (`0034_feed_leaderboard_and_suggestions_test.sql`'s "the two
  agree on the same member" assertion is re-run against the new source, not
  removed).
- [ ] Ranking is gated by `can_view_profile_field(member, 'show_attendance')`
  in addition to the existing `in_leaderboards` and `visible_to_club` checks
  `feed_leaderboard` already applies — a member with `show_attendance` off
  is excluded from the consistency board's ranked set entirely (not merely
  zeroed), the same way a `visible_to_club`-off member already is. The
  caller's own row is still always returned regardless of their own toggle,
  matching the existing self-always-included rule.
- [ ] The old post-based streak arithmetic is not deleted, only stopped
  being the consistency board's source: `community_profile`'s
  `training_frequency` and `recent_workouts` fields, which read
  `workout_posts` directly for a different purpose (what a member chose to
  share), are unaffected by this ticket.
- [ ] A member who trains but never logs anything the offline app can sync
  (impossible in practice, since the log is the training app itself, but
  worth stating) reads a 0-week streak, not an error — same "zero is real"
  rule the leaderboard already documents.

## Frontend states

No client change. The Boards sub-tab's existing "טבלת עקביות" board
(COMM-210) and profile streak figure (`community_profile`) render the same
shapes with a different, more honest number behind them.

## Client calls and contracts

- `feed_leaderboard(p_mode, p_challenge_id, p_scope, p_limit)` — unchanged
  signature, COMM-210/211/212.
- `community_profile(user_id)` — unchanged signature, COMM-180.

## Validation rules and limits

- None new. Same clamp and tie-break rules `feed_leaderboard` already
  documents.

## Migration outline

- `create or replace function public.consistency_week_streaks()` — same
  signature (`table(user_id uuid, streak integer)`), body reads
  `attendance_log` instead of `workout_posts`.
- `create or replace function public.community_profile(user_id uuid)` —
  same signature, `current_streak`'s inline computation updated to match,
  and `can_view_profile_field(..., 'show_attendance')` folded into
  `feed_leaderboard`'s consistency-mode filter.
- No new table. Depends on `attendance_log` (COMM-300).

## Dependencies

- COMM-210, COMM-180, COMM-300.
