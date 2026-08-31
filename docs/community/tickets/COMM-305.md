# COMM-305 Attendance milestone posts and achievements activation

Phase: 3
Agent: achievements
Status: review — shipped as 202608310007, schema only (no client change)
Attendance-blocked: was — unblocked by COMM-300

Closes the parked COMM-P03. The four `ATTENDANCE_RECORDED` achievement
definitions (`attendance_first_class`, `attendance_25_classes`,
`attendance_100_classes`, `attendance_weekly_streak`) have shipped seeded and
`enabled = false` since 202608280007. `POST_ATTENDANCE_MILESTONE` has
existed as a post_type enum label and a client card contract
(`renderPostCard`'s `POST_ATTENDANCE_MILESTONE` metadata shape:
`milestone_label`, `count`) since Phase 1, "parked, never produced yet." This
ticket produces both for the first time.

## User outcome

A member's first class, 25th class, 100th class, and each new weekly
training streak get their own celebration — a real achievement unlock and,
for the count milestones, a feed post — the same way a PR or a challenge
completion already does, instead of staying inert badges nobody can earn.

## Acceptance criteria

- [ ] The four `ATTENDANCE_RECORDED` `achievement_definitions` rows flip to
  `enabled = true` in this ticket's migration.
- [ ] Crossings are evaluated server-side directly off `attendance_log`
  (COMM-300), not through the still-unbuilt generic `ach_evaluate` event-bus
  path (see "Needs from schema, achievements" in
  `docs/community/contracts.md` — it remains not built and this ticket does
  not build it either; it follows the same precedent
  `challenge_progress_apply`'s cooperative milestone post already set,
  where a direct AFTER INSERT trigger on the source table does the
  evaluation inline rather than waiting on a generic consumer). A trigger
  on `attendance_log` inserts, on crossing 1 / 25 / 100 total distinct
  `occurred_on` days for the member, the matching `member_achievements`
  row exactly once (the existing partial unique index on non-repeatable
  definitions is the backstop, same as every other unlock path).
  `attendance_weekly_streak` (`repeatable`, threshold 4) fires again each
  time a fresh 4-consecutive-ISO-week streak is reached, using the same
  streak arithmetic `consistency_week_streaks()`/COMM-306 compute, so the
  two cannot disagree about what a "streak" is.
- [ ] These four crossings are never client-claimable — `ach_claim` already
  refuses any code whose `trigger_type = 'ATTENDANCE_RECORDED'`
  (202608280020), and this ticket does not touch that refusal. Attendance
  achievements are the one category in this schema that is purely
  server-derived, never client-trusted.
- [ ] The AFTER INSERT trigger on `member_achievements` (`ACHIEVEMENT_UNLOCKED`
  consumer, "Needs from schema, achievements") already fires for every new
  row regardless of source, so an attendance unlock notifies exactly like a
  PR or challenge unlock does today, with no new notification code.
- [ ] For the two count milestones only (25 and 100 classes — a first class
  is celebrated as an achievement unlock, not also duplicated as a feed
  post, matching how a first PR is celebrated once, not twice), the same
  trigger posts one authorless `POST_ATTENDANCE_MILESTONE` `workout_posts`
  row per crossing, `metadata = {milestone_label, count}` matching the
  client contract already shipped in Phase 1, gated by the member's own
  `show_attendance` toggle: a member with `show_attendance` off still gets
  the achievement (achievements have their own `show_achievements` toggle,
  already respected) but no public milestone post.
- [ ] "Already posted this milestone" is answered the same way
  `challenge_progress_apply`'s cooperative milestone check already is — by
  querying `workout_posts` itself for an existing
  `POST_ATTENDANCE_MILESTONE` row carrying that member and that count in
  `metadata` — not a second piece of state that could drift from what was
  actually posted.
- [ ] `POST_ATTENDANCE_MILESTONE_target` visibility is `club`, matching
  every other authorless celebratory post (`POST_NEW_MEMBER`,
  `POST_CHALLENGE` milestones).

## Frontend states

- No new client work: `renderPostCard`'s `POST_ATTENDANCE_MILESTONE` branch
  and the achievement unlock celebration UI (COMM-134) already exist and
  render real data unchanged, once the server starts producing it.

## Client calls and contracts

- No new client call. `member_achievements`, `workout_posts`, and the
  existing achievement/celebration read paths (COMM-130 to COMM-134) are
  unchanged in shape.

## Validation rules and limits

- Milestone thresholds (1, 25, 100 classes; a 4-week streak) are exactly the
  values already seeded in `achievement_definitions.threshold` —this ticket
  reads them from the table rather than hard-coding a second copy.
- `attendance_weekly_streak` firing again on a later fresh streak follows
  the same "repeatable definitions write a fresh row each qualifying event"
  rule `ach_claim` already documents for its own repeatable codes.

## Migration outline

- `update achievement_definitions set enabled = true where trigger_type =
  'ATTENDANCE_RECORDED'`.
- One AFTER INSERT trigger on `attendance_log`, security definer: computes
  the member's total distinct `occurred_on` count and current streak,
  inserts a `member_achievements` row on a genuine crossing, and, for the
  two count milestones, an authorless `POST_ATTENDANCE_MILESTONE` post —
  same shape as `challenge_progress_apply`'s cooperative milestone insert
  (202608290004).

## Dependencies

- COMM-004, COMM-007 (post_type enum, `POST_ATTENDANCE_MILESTONE` label,
  201608280004), COMM-130 to COMM-134, COMM-300.
