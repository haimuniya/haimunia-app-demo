# COMM-321 Club Modules: per-club feature toggles

Phase: post-hoc, own track (not part of the original 17 Phase 1-3 titles —
a user-requested admin capability, planned and scoped directly with the
user rather than through the usual planner pass)
Agent: schema (half A, shipped) / admin-moderation or platform (half B,
client resolver + admin panel UI, shipped)
Status: done — schema half (202609010012_club_features.sql, commit
6e22d31), client half (commit 437dfe6). Directory left out of v1 by
deliberate choice, not deferred as an open item (see Resolution).
Attendance-blocked: no

## User outcome

An admin can turn a Community feature off for the whole club from the
account/admin area: no tab, card, button, or notification for that feature
appears to any member, and the underlying data is genuinely unqueryable
(RLS-enforced), not just hidden by the client. Toggling it back on restores
the feature immediately for a fresh page load.

## Scope, confirmed with the user

Single implicit club (`default_club_id()`) — the current app's structure,
one toggle per feature members already see. Multi-club / platform-level
super-admin is explicitly deferred, not part of this ticket.

Six toggles, not the larger original wishlist of ~11: **announcements,
events, challenges, achievements, feed, leaderboards**. Comments/reactions/
workout-sharing ride along with feed (no independent RLS entry point of
their own — they key off `workout_posts`' own visibility). Directory and
notifications are explicitly out of scope for this ticket (see Resolution).

## Acceptance criteria

- [x] `club_features` table + `club_feature_enabled()` read-path predicate,
  world-readable, no direct write policy — the only write path is the
  admin RPC below.
- [x] `admin_set_club_feature(module_key, enabled, config)` — security
  definer, gated on a new `community.club.manage_modules` permission
  (admin/owner tier), writes the row, logs to `admin_actions` with
  `action_type = 'club_feature_toggle'`.
- [x] Each of the six modules' read path extended: `announcements_read`,
  `events_read`, `challenges_read`, `member_achievements_read`, and
  `posts_feed_select` gain an additive `and club_feature_enabled(...)`
  clause (every existing OR-branch included, so "off" is genuinely off,
  not just off for ordinary members); `feed_leaderboard()`'s function body
  gains an early raise when its module is off, since it reads under its
  own security definer rights with no base-table policy to extend.
- [x] Client resolver (`cloud.js`): `state.clubFeatures`/`clubFeaturesLoaded`,
  `loadClubFeatures()` wired into both boot paths, `isModuleEnabled(key,
  subKey)`, sign-out reset.
- [x] `renderClubModulesPanel()` — one checkbox row per toggle, gated on
  `hasPerm(PERM.CLUB_MANAGE_MODULES) || isAdmin()`, appended into
  `accountTab` near `renderMemberManagement()`. Optimistic write + rollback
  on error, matching `savePrivacyField`.
- [x] Real UI gates wired in: section-level guards inside `boardsTab`'s
  bundled challenges/events/leaderboard sections, `renderMyAchievements()`,
  and the announcements composer form.
- [ ] Directory tab visibility toggle — dropped from v1 (see Resolution),
  not carried forward as an open item.
- [ ] Each toggle's notification-producing paths audited so a disabled
  module also stops notifying — not done in this pass, flagged as
  necessary follow-up if a real gap surfaces in use.

## Frontend states

- Admin, module on: checkbox checked, section/tab/card renders normally
  for every member.
- Admin, module off: checkbox unchecked; toggling shows an optimistic
  flip, rolls back with a message on RPC failure (same shape as
  `savePrivacyField`).
- Non-admin: the panel section does not render at all (`hasPerm` gate
  returns `""`).
- Any member, module off: no tab/card/button for that feature; a stale
  in-memory copy from before the toggle flipped may persist until the next
  natural reload/reconnect — documented as an accepted limitation, not
  solved with a realtime subscription in this ticket (see Risks below).

## Client calls and contracts

- New: `loadClubFeatures()` — `client.from("club_features").select
  ("module_key,enabled,config")`, populates `state.clubFeatures`.
- New: `isModuleEnabled(key, subKey?)` — defaults to `true` before load and
  for any key with no row (RLS is the real backstop either way).
- New: `admin_set_club_feature(p_module_key, p_enabled, p_config?)` RPC,
  called from the admin panel's toggle handler.

## Validation rules and limits

- `module_key` constrained `^[a-z][a-z0-9_]{2,31}$` at the table and
  re-checked inside the RPC.
- `admin_set_club_feature` requires `has_perm('community.club.
  manage_modules')` — admin/owner tier only, seeded directly (mirrors
  `community.analytics.view`'s seeding, not staff/coach).

## Migration outline (shipped, 202609010012_club_features.sql)

- `club_features (club_id, module_key, config, enabled, updated_by,
  updated_at)`, primary key `(club_id, module_key)`. RLS: `select` open to
  `authenticated`, no write policy at all — same shape `invite_redemptions`
  already has for `role`, written only through `admin_grant_coach()`.
- `club_feature_enabled(p_module_key, p_sub_key default null)` — security
  definer, `stable`, `true` when no row exists so an ungated module is
  never accidentally hidden. `config`/`p_sub_key` exist for a future
  sub-toggle; no module uses one today (leaderboards ships as one boolean,
  not split into per-mode sub-switches — the earlier research draft's
  three-way split didn't match what `feed_leaderboard()` actually has,
  which is two modes, consistency and progress, not three).
- Seeds all six module keys, `enabled = true` — never ships a migration
  that silently disables something live.
- New permission `community.club.manage_modules`, seeded to `admin`/`owner`.
- `admin_set_club_feature()` — mirrors `admin_grant_coach`'s shape but
  checks `has_perm()` rather than the legacy inline `is_admin` literal
  (cloud.js already flags that inline-check list as legacy; new code
  follows the current permission-string convention instead of extending
  it).
- `admin_actions_action_type_check` extended with `'club_feature_toggle'`.
- Five RLS policies re-created with an additive `and club_feature_enabled
  (...)` clause; `feed_leaderboard()` (live version, 202608310004)
  recreated in full with one added early-raise gate, otherwise
  byte-identical.

## Resolution, schema half (202609010012, commit 6e22d31)

- **Six toggles, not eleven.** Research against the live schema found
  comments/reactions/workout-sharing have no independent RLS entry point
  (they key off `workout_posts`' own visibility check), directory reads
  straight off `profiles_read_authenticated` — the single most
  foundational read policy in the schema, too invasive to gate for the
  value gained — and notifications already has its own per-type toggle
  system (`notification_preferences`); a club-wide switch on top of that
  would be a second, overlapping control plane. Directory gets a
  client-only tab hide in the client half; notifications is dropped
  entirely.
- **One migration, not six.** The user's explicit direction after an
  initial plan proposed a staged one-migration-per-module rollout: ship
  the current app's toggle set in one straightforward pass, not staged
  over many releases.
- **Leaderboards as a single boolean**, not the three-way sub-config an
  earlier research draft proposed (`workout`/`attendance`/`challenges`) —
  `feed_leaderboard()`'s real modes are `consistency` and `progress`, not
  three independent features; inventing sub-toggles that don't match the
  app's actual structure would have contradicted the "current structure"
  scoping the user asked for.
- **`grant select on public.club_features to authenticated` was missing
  on the first pass** — RLS policies alone don't grant table-level access;
  caught by the pgTAP run itself (`permission denied for table
  club_features`), not by review. Fixed before commit.

## Dependencies

- `PERM` object, `hasPerm()`, `isAdmin()` (`cloud.js:376-404`).
- `PRIVACY_FIELDS`/`savePrivacyField` (`cloud.js:2888-2911`) — the
  optimistic-write pattern the toggle handler follows.
- `accountTab` assembly and the four existing admin-section precedents
  (`cloud.js:9070`, `3793-4242`).

## Resolution, client half (commit 437dfe6)

- **Directory dropped from v1, not shipped as a client-only toggle.** The
  original plan draft floated a "client-only hide" for directory (no RLS
  backing, since `profiles_read_authenticated` is too foundational to
  gate). Building it anyway would have meant one toggle in the panel that
  behaves fundamentally differently from all six real ones — enforced
  nowhere server-side, purely cosmetic — while looking identical in the
  UI. That's a worse trap than not having the toggle at all: an admin
  turning it off would reasonably assume the same enforcement every other
  toggle in the same list provides. Left out entirely rather than shipped
  half-true.
- **Leaderboards' `config` sub-toggle went unused.** The schema supports a
  `p_sub_key` (`club_feature_enabled(key, subKey)`) for a future module
  needing finer control, but `feed_leaderboard()`'s actual two modes
  (`consistency`/`progress`) don't map onto the three-way split
  (`workout`/`attendance`/`challenges`) the earlier research draft
  guessed at before reading the real function — ships as one boolean,
  matching the "current structure" the user asked to reflect rather than
  an imagined one.
- **Notification-path audit not done.** Per-module notification producers
  (challenge/event/achievement notifications, specifically) were not
  traced and gated in this pass — a disabled module still stops all
  reads/renders, but a background notification trigger for content
  created before the toggle flipped could theoretically still fire. Not
  reproduced or confirmed as a real gap; flagged rather than guessed at.
- **`community-coach-tier.test.mjs` caught a real regression before
  commit**: gating the announcements composer with a naive `staff &&
  isModuleEnabled(...)` condition dropped the test's literal count of
  `staff ?` ternaries in the render function from 4 to 3. Fixed by nesting
  the new gate inside the existing `staff ? ... : ""` shape instead of
  replacing its condition.
- **One test-only bug, not a product bug**: the achievements on/off test
  first asserted on the section's own Hebrew header text, which is a
  substring of an unrelated static button already in `index.html` (the
  solo-tracker's own "לכל המדליות וההישגים שלי"). Fixed by asserting on
  the feature's unique empty-state string instead — the gate itself was
  correct throughout, only the test's assertion was wrong.

`isModuleEnabled()` is never reachable before `isCommunitySignedIn()`
gates rendering in practice (every real call site sits behind it), matching
the plan's own note — not re-verified with a dedicated regression test in
this pass.
