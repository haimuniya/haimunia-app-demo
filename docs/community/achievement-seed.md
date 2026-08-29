# Achievement definitions seed, non-attendance

COMM-131. This is the seed content for every non-attendance
`achievement_definitions` row. schema inserts it in a migration as an
`on conflict (code) do update` block so a re-run is idempotent. The four
attendance rows already shipped in 202608280007 and stay `enabled = false`
until COMM-P03, they are not repeated here.

## Rules the rows follow

- `code` is lower snake case and matches `^[a-z][a-z0-9_]{2,63}$`.
- `category` is one of consistency, performance, progress, community,
  challenge, club. Performance is not the only status source, so the set
  spreads across all six.
- `trigger_type` is one of the eight values the 202608280007 CHECK allows.
  Client-computable milestones ride `WORKOUT_COMPLETED`, `PR_CREATED`, or
  `MEMBER_JOINED` with the real metric named in `config`.
- `config.client_claimable = true` marks a row `ach_claim` will accept from
  the browser, because the offline app already has the exact number and the
  count cannot be inflated from the client. Community, challenge, and club
  activity rows are left `false`: those unlock only through `ach_evaluate` on
  the service-role event-bus path, where the server owns the count.
- `config.secondary = true` marks the community rows so the feed and
  notifications can de-emphasize them. They are threshold-based and
  non-repeatable, so trivial spammy repetition earns nothing after the first.
- Consistency week rows tolerate a three-times-per-week pattern. A week
  counts toward the streak when the member logged any training in that ISO
  week. Training three times in a week satisfies it exactly as training
  daily does. `config.metric = "week_streak"` and the offline
  `longestWeekStreak()` is the number fed to `ach_claim`.
- "First pull-up" and a per-move first-rep family are deliberately not
  seeded. The offline log has no bodyweight-progression model, so there is no
  honest number to threshold against. Revisit when that data lands.

## Seed rows

```sql
insert into public.achievement_definitions
  (code, name, description, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values
  -- consistency: logged sessions, from logged entries not verified attendance
  ('first_workout',        'האימון הראשון',       'רשמת אימון ראשון ביומן',                 'consistency', 'WORKOUT_COMPLETED', 1,   false, 'club', '🔥', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_10',          '10 אימונים',          '10 ימי אימון מתועדים',                    'consistency', 'WORKOUT_COMPLETED', 10,  false, 'club', '🔥', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_25',          '25 אימונים',          '25 ימי אימון מתועדים',                    'consistency', 'WORKOUT_COMPLETED', 25,  false, 'club', '🔥', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_50',          '50 אימונים',          '50 ימי אימון מתועדים',                    'consistency', 'WORKOUT_COMPLETED', 50,  false, 'club', '🥉', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_100',         '100 אימונים',         '100 ימי אימון מתועדים',                   'consistency', 'WORKOUT_COMPLETED', 100, false, 'club', '🥈', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_250',         '250 אימונים',         '250 ימי אימון מתועדים',                   'consistency', 'WORKOUT_COMPLETED', 250, false, 'club', '🥇', true, '{"client_claimable": true, "metric": "session_count"}'),

  -- consistency: week streak, tolerant of a 3x per week pattern
  ('consistency_weeks_4',  'חודש ברצף',           'רישום אימון בכל שבוע, ארבעה שבועות ברצף',  'consistency', 'WORKOUT_COMPLETED', 4,   false, 'club', '📅', true, '{"client_claimable": true, "metric": "week_streak"}'),
  ('consistency_weeks_12', 'רבעון ברצף',          'רישום אימון בכל שבוע, שנים עשר שבועות ברצף','consistency', 'WORKOUT_COMPLETED', 12,  false, 'club', '📅', true, '{"client_claimable": true, "metric": "week_streak"}'),
  ('consistency_weeks_26', 'חצי שנה ברצף',        'רישום אימון בכל שבוע, עשרים ושישה שבועות ברצף','consistency','WORKOUT_COMPLETED', 26, false, 'club', '📆', true, '{"client_claimable": true, "metric": "week_streak"}'),
  ('consistency_weeks_52', 'שנה ברצף',            'רישום אימון בכל שבוע, חמישים ושניים שבועות ברצף','consistency','WORKOUT_COMPLETED', 52, false, 'club', '🏆', true, '{"client_claimable": true, "metric": "week_streak"}'),

  -- performance: personal records and first Rx
  ('first_pr',             'השיא הראשון',         'שיא אישי ראשון',                          'performance', 'PR_CREATED',        1,   false, 'club', '⭐', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('pr_10',                '10 שיאים',            '10 שיאים אישיים',                         'performance', 'PR_CREATED',        10,  false, 'club', '⭐', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('pr_25',                '25 שיאים',            '25 שיאים אישיים',                         'performance', 'PR_CREATED',        25,  false, 'club', '🌟', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('pr_50',                '50 שיאים',            '50 שיאים אישיים',                         'performance', 'PR_CREATED',        50,  false, 'club', '🌟', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('pr_100',               '100 שיאים',           '100 שיאים אישיים',                        'performance', 'PR_CREATED',        100, false, 'club', '💫', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('first_rx',             'Rx ראשון',            'רישום ראשון של אימון כ-Rx',               'performance', 'WORKOUT_COMPLETED', 1,   false, 'club', '🏋️', true, '{"client_claimable": true, "metric": "rx_count"}'),

  -- progress: well rounded across the movement families
  ('well_rounded',         'אתלט שלם',            'שיא לפחות בכל אחת מחמש קבוצות התרגילים',   'progress',    'PR_CREATED',        5,   false, 'club', '🧩', true, '{"client_claimable": true, "metric": "pr_category_spread"}'),

  -- club identity: membership tenure
  ('anniversary_year_1',   'שנה במועדון',         'שנה מתאריך ההצטרפות',                     'club',        'MEMBER_JOINED',     365,  false, 'club', '🎉', true, '{"client_claimable": true, "metric": "tenure_days"}'),
  ('anniversary_year_2',   'שנתיים במועדון',      'שנתיים מתאריך ההצטרפות',                  'club',        'MEMBER_JOINED',     730,  false, 'club', '🎉', true, '{"client_claimable": true, "metric": "tenure_days"}'),
  ('anniversary_year_3',   'שלוש שנים במועדון',   'שלוש שנים מתאריך ההצטרפות',               'club',        'MEMBER_JOINED',     1095, false, 'club', '🎉', true, '{"client_claimable": true, "metric": "tenure_days"}'),
  ('anniversary_year_5',   'חמש שנים במועדון',    'חמש שנים מתאריך ההצטרפות',                'club',        'MEMBER_JOINED',     1825, false, 'club', '🎖️', true, '{"client_claimable": true, "metric": "tenure_days"}'),

  -- community: secondary, server-owned, never client-claimed
  ('first_cheer',          'עידוד ראשון',         'שלחת עידוד ראשון לחבר/ה',                 'community',   'REACTION_CREATED',  1,   false, 'club', '👏', true, '{"secondary": true}'),
  ('first_comment',        'תגובה ראשונה',        'כתבת תגובה ראשונה',                       'community',   'COMMENT_CREATED',   1,   false, 'club', '💬', true, '{"secondary": true}'),
  ('supportive_10',        '10 עידודים',          '10 עידודים ותגובות תומכות',               'community',   'REACTION_CREATED',  10,  false, 'club', '🤝', true, '{"secondary": true, "metric": "support_actions"}'),
  ('welcomed_member',      'קבלת פנים',           'עזרת לקבל חבר/ה חדש/ה במועדון',           'community',   'COMMENT_CREATED',   1,   false, 'club', '🙌', true, '{"secondary": true, "metric": "welcome_comment"}'),

  -- challenge: repeatable, server-owned
  ('challenge_finisher',   'סיום אתגר',           'השלמת אתגר מועדון',                       'challenge',   'CHALLENGE_COMPLETED', 1, true,  'club', '🏁', true, '{}'),
  ('challenge_winner',     'מנצח/ת אתגר',         'מקום ראשון באתגר מועדון',                 'challenge',   'CHALLENGE_COMPLETED', 1, true,  'club', '🥇', true, '{"metric": "rank_1"}')
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  trigger_type = excluded.trigger_type,
  threshold = excluded.threshold,
  repeatable = excluded.repeatable,
  visibility = excluded.visibility,
  icon = excluded.icon,
  enabled = excluded.enabled,
  config = excluded.config;
```

## Client mirror

`communityMilestoneCodes()` in `app.js` evaluates the `client_claimable`
subset against on-device data:

- `session_count` from `totalSessions()`
- `week_streak` from `longestWeekStreak()`
- `pr_count` from the sum of `categoryPRCounts()`
- `pr_category_spread` from `isWellRounded()`
- `rx_count` from `earnedRxWodIds().size`
- `tenure_days` from `daysSinceBoxStart()`

The Hebrew display copy for the celebration lives in
`COMMUNITY_ACHIEVEMENT_META` in `cloud.js`, keyed by the same code. Keep the
two in step with this file when a row is added.
