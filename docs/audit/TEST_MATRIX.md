# Test matrix

Major product areas against test type. This maps what exists (as of
2026-09-07, commit `abee1a1`), not what an ideal suite would look like —
gaps are called out explicitly rather than left implicit.

Columns: **Unit** (jsdom + `node:test`, `test/*.test.mjs` — 133 files),
**DB** (pgTAP against real PostgreSQL, `supabase/tests/*.sql` — 90 files,
3096 assertions), **Browser** (Playwright + real Chromium,
`scripts/browser-check/*.mjs` — 23 scenarios), **Manual/Device** (requires
a human and/or a real device — this audit's honest NOT VERIFIED bucket),
**Offline** (specifically exercises the no-network / IndexedDB path).

Legend: ✅ covered · ➖ not applicable to this area · ❌ gap (named, not
implied).

| Feature area | Unit | DB | Browser | Manual/Device | Offline |
|---|---|---|---|---|---|
| **Training log core** (log/edit/delete a set, exercises, PR detection) | ✅ `weight-floor-barbell-only`, `medals` (PR), `import`/`import-export-ui`, `stepper-tap-type` | ➖ | ✅ `benchmarks`, `boot-smoke` | ❌ real-device long-term-use not tested | ✅ IndexedDB-backed, `fake-indexeddb` |
| WOD builder (EMOM, ladder, superset, duration, extras, tags) | ✅ `emom`, `superset-blocks`, `duration-entries`, `wod-*` (6 files) | ➖ | ✅ `emom.mjs`, `ladder.mjs`, `superset.mjs`, `duration.mjs`, `wod-builder-duration.mjs`, `wod-extras.mjs` | ❌ | ✅ |
| Calendar / history | ✅ `calendar.test.mjs` | ➖ | ✅ (via `boot-smoke`, benchmarks) | ❌ | ✅ |
| Bodyweight / measurements | ✅ `bodyweight-measurements` | ➖ | ➖ | ❌ | ✅ |
| Import/export, backup rollback | ✅ `import.test.mjs`, `import-export-ui`, `community-backup-sync` | ➖ | ➖ | ❌ manual corrupt-file testing not performed | ✅ |
| Storage integrity (quota, corrupt JSON, schema migration) | ✅ `storage-quota-exceeded`, `storage-isolation`, `clear-data` | ➖ | ➖ | ❌ real quota-exhaustion on a real device | ✅ |
| Service worker / cache correctness | ✅ `sw-precache.test.mjs` | ➖ | ✅ `update-flow.mjs`, `install-dock-hit-check.mjs`, `install-prompt.test.mjs` | ❌ real "stale SW after deploy" on a device | ✅ (this **is** the offline path) |
| PWA manifest / install | ✅ `install-prompt.test.mjs` | ➖ | ✅ `install-dock-hit-check.mjs` | ❌ real home-screen install, all target OSes | ➖ |
| **Feed / posts** (12 types, photos, visibility) | ✅ `community-post-cards`, `community-composer`, `community-post-actions` | ✅ `0023_post_create_test.sql`, `0004_post_types_and_columns_test.sql` | ✅ `community-post-composition.mjs` | ❌ | ➖ (requires Supabase) |
| Reactions / threaded comments / mentions | ✅ `community-engagement*` (3 files) | ✅ `0016_comment_threads_test.sql`, `0021_comment_mentions_and_self_delete_test.sql` | ✅ (via post-composition, coach-congratulate) | ❌ | ➖ |
| Events / RSVP / capacity | ✅ `community-events.test.mjs` | ✅ `0010_events_test.sql`, `0017_event_rsvp_idempotency_key` (via migration file) | ✅ `community-event-rsvp.mjs` | ❌ | ➖ |
| Challenges (incl. team, cooperative) | ✅ `community-challenges`, `community-challenge-team-management`, `community-weekly-challenge` | ✅ `0009_challenges_test.sql`, `0049_challenge_team_management_test.sql` | ✅ `community-challenge-lifecycle.mjs` | ❌ | ➖ |
| Achievements (31) | ✅ `achievements.test.mjs`, `community-achievement-engine`, `community-pr-share-prompt` | ✅ `0007_achievements_test.sql`, `0020_achievement_claim_and_seed_test.sql` | ➖ | ❌ real-data 31-achievement sweep | ➖ |
| Notifications (all types, preferences, batching) | ✅ `community-notifications.test.mjs`, `community-web-push` | ✅ `0008_notifications_test.sql`, `0018_notification_batches_test.sql`, `0026_notif_create_test.sql`, `0027_notif_trigger_set_test.sql`, `0028_notif_batch_flusher_test.sql`, `0029_event_cancelled_notification_test.sql`, `0035_challenge_progress_notifications_test.sql` | ✅ `community-notification-center.mjs` | ❌ real web-push delivery to a device | ➖ |
| Weekly / monthly recaps | ✅ `community-recaps`, `community-monthly-club-recap` | ✅ `0031_recaps_and_onboarding_test.sql`, `0046_monthly_club_recap_test.sql`, `0047_recap_classmates_and_onboarding_classes_test.sql` | ✅ `community-recap.mjs`, `community-monthly-recap-publish.mjs`, `community-recap-classmates.mjs` | ❌ real Edge Function invocation against production (Vault-gated, see `PRE_LAUNCH_AUDIT.md`) | ➖ |
| Coach tools (Celebrate, Welcome, Engage) | ✅ `community-coach-tools.test.mjs` | ✅ `0032_coach_tools_test.sql`, `0044_coach_engagement_decline_test.sql` | ✅ `community-coach-congratulate.mjs`, `community-coach-engage.mjs` | ❌ | ➖ |
| Announcements | ✅ `community-announcement-priority-expiry` | ✅ (covered inside `202609060013` product-decisions migration's own test) | ➖ | ❌ | ➖ |
| Leaderboards / suggestions | ✅ `community-leaderboards-and-suggestions` | ✅ `0034_feed_leaderboard_and_suggestions_test.sql`, `0019_feed_ranking_test.sql` | ➖ | ❌ | ➖ |
| Moderation / reports / audit log | ✅ `community-moderation.test.mjs`, `community-member-roles-and-profile-reports` | ✅ `0002_admin_actions_test.sql`, `0024_reports_target_and_status_test.sql`, `0025_moderation_reshape_test.sql`, `0085_audit_log_identity_test.sql` | ✅ `community-report-moderation.mjs` | ❌ | ➖ |
| Analytics dashboard / health score / cohorts | ✅ `community-admin-analytics-dashboard`, `community-analytics-surfaces`, `community-health-score`, `community-retention-correlation-views`, `community-phase2-analytics` | ✅ `0012_analytics_events_test.sql`, `0050_analytics_dashboard_test.sql`, `0051_member_segments_test.sql`, `0052_retention_cohorts_test.sql`, `0053_community_health_score_test.sql` | ➖ | ❌ | ➖ |
| Member of the week | ✅ `community-member-of-week.test.mjs` | ✅ `0045_member_of_week_test.sql` | ✅ `community-member-of-week-publish.mjs` | ❌ | ➖ |
| Invite codes / redemption / reclaim | ✅ `community-invite-*` (4 files), `community-incomplete-signups` | ✅ `0013_invite_actor_throttle_test.sql`, `0086_incomplete_signups_and_invite_reclaim_test.sql` | ✅ `community-person-invite-lifecycle.mjs` | ❌ | ➖ |
| Role matrix / permissions (6 roles) | ✅ `community-coach-tier`, `community-coach-identity`, `grant-coach-by-handle` | ✅ `0001_clubs_and_rbac_test.sql`, `0054_member_roles_test.sql`, and role predicates threaded through nearly all 90 files | ➖ (no dedicated 6-role browser walkthrough) | ❌ **no end-to-end walkthrough of all six roles exists as one scenario** — see gap below | ➖ |
| Club isolation | ➖ | ✅ `clubs_guard_single_row` invariant (single-club by design, not multi-tenant) | ➖ | ➖ | ➖ |
| Feature flags / module switches | ✅ `community-club-features.test.mjs` | ✅ (club_feature_enabled gate threaded through relevant migrations) | ➖ | ❌ toggling a real production flag and observing live behavior | ➖ |
| Account deletion / privacy purge | ✅ (indirectly, via profile/RLS tests) | ✅ `0003_profile_privacy_and_recovery_test.sql`, `0048_purge_abandoned_profiles_test.sql`, plus DB-H1/H2/H3 assertions in `0077` | ➖ | ❌ a real 30-day-elapsed purge has never been observed against live data (by design — nothing is 30 days overdue on a healthy system) | ➖ |
| RLS / anonymous-read gate | ✅ `community-rls-boundaries*` (2 files), `community-anonymous-auth`, `community-attendance-log-rls` | ✅ `0082_foundation_era_rls_test.sql` (17 assertions incl. `private_records`), plus the anonymous-read gate across most files | ➖ | ➖ | ➖ |
| Rate limiting / abuse controls | ✅ `community-rate-limiting`, `community-actor-throttle`, `community-captcha` | ✅ `0013_invite_actor_throttle_test.sql` | ➖ | ❌ real sustained-load abuse test | ➖ |
| Realtime / search | ✅ `community-realtime-and-search`, `community-realtime-search-rls` | ✅ `0036_realtime_and_search_runtime_test.sql` | ✅ `community-search.mjs` | ➖ | ➖ |
| Sync / outbox / idempotency | ✅ `community-outbox`, `community-outbox-rpc-contract`, `community-sync-ordering`, `sync-robustness`, `community-deploy-order-safety` | ✅ `0080_write_idempotency_test.sql` (32 assertions) | ➖ | ❌ real multi-tab/multi-device race not manually reproduced | ✅ (outbox is the offline-write path) |
| Accessibility (WCAG 2.2 AA) | ✅ `community-a11y-structure`, `heading-outline`, `tablist-keyboard`, `chart-accessible-name`, `brass-contrast`, `theme-token-parity`, `text-scale.test.mjs` | ➖ | ✅ `a11y-axe-scan.mjs` (7 screens, axe-core), `app-dialog-keyboard.mjs`, `text-scale.mjs` | ❌ real screen-reader walkthrough (VoiceOver/NVDA/TalkBack) never performed | ➖ |
| RTL / bidi / mixed-script text | ✅ `community-hebrew-handles` | ➖ | ✅ `bidi-rtl-geometry.mjs`, `chart-rtl-orientation.mjs` | ❌ | ➖ |
| Desktop / responsive layout | ✅ `design-sync-audit-app-core` | ➖ | ✅ `desktop-layout.mjs` | ❌ real device matrix (small/large phone, tablet, landscape) never run | ➖ |
| Deployment / version integrity | ✅ `version-sync`, `vendored-supabase-version`, `production-not-demo`, `sanitizers`, `security-hardening`, `app-innerhtml-sinks` | ➖ | ➖ | ➖ (script-based checks, not device-dependent) | ➖ |

## Named gaps (not padded, not hidden)

1. **No single end-to-end scenario walks all six roles (member → coach →
   head coach → staff → admin → owner) through one shared story.** Role
   behavior is thoroughly covered *per capability* (dozens of pgTAP files
   assert individual role/permission boundaries), but there is no one test
   file that says "here is what changes as a session's role changes,
   start to finish." `docs/audit/AUTHORIZATION_MATRIX.md` is the closest
   thing — a static table, now backed by the 3096 passing pgTAP
   assertions, but not a single narrative test.
2. **Role change / club-membership removal mid-session** — the client's
   behavior when a role changes or membership is revoked while a session is
   already open is not covered by an explicit test found in this pass. This
   is a real gap for §38 of the launch checklist (session lifecycle) and is
   worth a dedicated test, not a code fix — the RLS layer already protects
   the data regardless of what the client believes its role is, so this is
   a UX-staleness gap, not a security one.
3. **Real device/browser matrix** (iOS Safari, Safari macOS, Firefox, Edge,
   actual phone/tablet hardware) is the largest single gap across nearly
   every row above. Every ❌ tied to "real-device" or "manual" in this table
   reduces to the same root cause: no such environment exists in this
   sandbox.
4. **Screen-reader walkthrough** — axe-core catches structural/contrast
   violations mechanically but does not confirm meaning is conveyed
   correctly when actually heard.
