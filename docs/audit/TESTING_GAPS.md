# Testing gaps

## Client-side (node/jsdom) test coverage

`CODE_QUALITY_AUDIT.md`'s test-coverage matrix checked every one of the 24
client-surface features added since the 2026-09-02 audit against `test/`.
Two have **no** dedicated test file at all:

- **`member_roles`** — the exact surface CQ-003 (this pass's fix, coach-badge
  cache poisoning on a transient error) lives in, and the only mention of
  `member_roles` anywhere in `test/` is inside `test/helpers/mockSupabase.mjs`
  (the mock's own plumbing, not an assertion about behavior).
- **`report_profile_target`** — the exact surface CQ-001/CQ-002 (this pass's
  fixes, profile-report mislabeling and the dead-end remove button) live in.
  Zero hits for `report-profile`/`reportProfile` across `test/`.

**This is not a coincidence.** All three P1 code-quality bugs fixed this pass
were found in the two areas with zero test coverage — exactly where a
regression has nothing to catch it. New tests for these two areas are the
single highest-leverage test-coverage addition available, and were not added
this pass (time went to the fix itself and to the higher-priority database
work); recorded here as the most important item in this document.

## Server-side (pgTAP) test coverage

`DATABASE_AUDIT.md` DB-M4: the pre-`clubs_and_rbac`-era migrations (roughly
the first 12, including two retroactively-edited ones) have no corresponding
pgTAP file. `supabase/tests/` otherwise tracks close to 1:1 with
`supabase/migrations/` (77 files as of the last verified clean
`supabase test db` run, pre-dating this session's two new migrations and two
new test files).

## New coverage added this pass

- `supabase/tests/0077_close_launch_readiness_gap_findings_test.sql` — ghost
  vs. real-member read boundary for all 11 newly-gated relations (SEC-001),
  the moderation-reversal and ranking-forgery guard trigger (SEC-002/005),
  the DELETE-bypass fix, the purge scheduler, and the 6 FK fixes.
- `supabase/tests/0078_close_abuse_and_amplification_findings_test.sql` —
  rate-limit exhaustion (post-insert bypass, admin password-reset), the
  avatar object cap, the payload-size CHECK, the push-subscription cap, and
  the single-club invariant.
- `test/community-dialog-focus.test.mjs` — 12th dialog (confirm sheet, A3).

**Neither pgTAP file has been executed** (see `FINAL_REGRESSION_REPORT.md`) —
listed as new coverage, not as verified-passing coverage.

## Coverage gaps against the audit's own required-test list

Checked against the standing instruction to have coverage for: registration,
login, logout, password reset, account recovery, authentication,
authorization, role changes, privacy, workout CRUD, personal records, feed
visibility, posts, comments, reactions, reporting, blocking, moderation,
administrative actions, file uploads, notifications, data export, account
deletion, error handling, concurrent updates, duplicate requests, API abuse,
database migrations, critical user journeys:

| Area | Coverage found |
|---|---|
| Registration / login / logout | `test/community-username-password-auth.test.mjs`, `test/community-anonymous-auth.test.mjs`, `test/community-session-expiry.test.mjs` |
| Password reset | **No client test** — the feature is new (`admin_reset_password`, 2026-09-05) and server-side only; no pgTAP file targets it either. A real gap given this pass added a rate limit to it (SEC-011). |
| Account recovery | `test/community-recovery-method.test.mjs` |
| Authorization / RLS boundaries | `test/community-rls-boundaries.test.mjs`, `test/community-rls-boundaries-phase1.test.mjs`, plus the full pgTAP suite (server-side, the only place a real RLS boundary can be asserted — see COMM-019's own note that the JS mock has no policy engine) |
| Role changes | `test/community-coach-tier.test.mjs`, `test/grant-coach-by-handle.test.mjs` |
| Privacy toggles | `test/community-privacy-toggles.test.mjs` |
| Workout CRUD (offline log) | Extensive — `test/wod-*.test.mjs`, `test/duration-entries.test.mjs`, `test/superset-blocks.test.mjs`, etc. |
| Personal records | `test/community-pr-detection.test.mjs`, `test/community-pr-share-prompt.test.mjs` |
| Feed visibility | `test/community-feed-ranking.test.mjs`, `test/community-feed-client.test.mjs` |
| Posts / comments / reactions | `test/community-post-actions.test.mjs`, `test/community-post-cards.test.mjs`, `test/community-engagement.test.mjs`, `test/community-engagement-ui.test.mjs` |
| Reporting / blocking / moderation | `test/community-moderation.test.mjs` — **did not cover the profile-report path** before this pass (that gap is exactly CQ-001/002); no dedicated update made to this file this pass, only to the source it exercises. |
| Administrative actions | `test/community-admin-member-management.test.mjs`, `test/community-admin-analytics-dashboard.test.mjs` |
| File uploads | `test/community-avatar-upload.test.mjs`, `test/community-avatar-photo.test.mjs` |
| Notifications | `test/community-notifications.test.mjs`, `test/community-web-push.test.mjs` |
| Data export | Covered on the offline-log side (`test/import-export-ui.test.mjs`, `test/import.test.mjs`); no equivalent for a Community-side data export, because none exists as a feature (not a gap — see `FEATURE_RECOMMENDATIONS.md`, not proposed here since GDPR export isn't named as a required feature by the product docs). |
| Account deletion | `test/community-confirm-flow.test.mjs` covers the confirm step; **no test asserts the 30-day purge actually runs** (the exact feature PRIV-002 found silently non-functional) — this can only be tested via pgTAP against `purge_due_accounts()` and `cron.job`, which the two new test files partially do (existence of the schedule) but do not simulate the 30-day wait. |
| Error handling / concurrent updates / duplicate requests | `test/sync-robustness.test.mjs`, `test/community-sync-ordering.test.mjs` — but see `RELIABILITY_AUDIT.md`: these cover the *offline outbox's* conflict handling, not idempotency on the Community RPCs identified as gaps (post_create, add_post_comment, challenge_progress, toggle_reaction). |
| API abuse / rate limiting | `test/community-rate-limiting.test.mjs`, `test/community-actor-throttle.test.mjs` — extended this pass with the two new pgTAP files for the specific triggers added. |
| Database migrations | `.github/workflows/test.yml`'s `migration-check` job — not run this session (no CLI). |
| Critical user journeys | `scripts/browser-check/*.mjs` (29 real-Chromium scenarios) — not re-run this session against the final code state. |

## Summary of highest-priority gaps

1. No client test for `member_roles`/`report_profile_target` — exactly where
   this pass's 3 P1 bugs lived.
2. No test for `admin_reset_password` at any level.
3. No test simulates the 30-day account-purge actually executing (only that
   it is scheduled).
4. No idempotency/duplicate-request test for `post_create`,
   `add_post_comment`, `challenge_progress`, or `toggle_reaction` — see
   `RELIABILITY_AUDIT.md`.
