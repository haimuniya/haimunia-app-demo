# Corrections completed this pass

All changes below are in the working tree, uncommitted (git commits were
intentionally left to the user — see `STATUS.md`). Each entry names the
finding it closes, the file(s) changed, and how it was verified.

## Database migrations

### `supabase/migrations/202609060011_close_launch_readiness_gap_findings.sql`

1. **SEC-001 (P0)** — extended the anonymous-read gate
   (`public.is_community_member()`) to 14 relations left ungated after
   `202609060001`: `challenge_teams_read`, `challenge_participants_read`,
   `challenge_progress_read`, `event_attendees_read`, `events_read`,
   `challenges_read`, `member_achievements_read`, `member_of_week_read`,
   `weekly_challenges_read`, `pins_read`, `clubs_read`, `roles_read`,
   `permissions_read`, `role_permissions_read`, `achievement_definitions_read`,
   `monthly_club_recaps_published_select`. A credential-free
   `signInAnonymously()` session could previously read the full member-UUID
   roster, challenge participation, achievement unlocks, and the club
   calendar.
2. **SEC-002 / SEC-005** — new `workout_posts_guard_moderated_fields()`
   trigger (BEFORE UPDATE OF `status, deleted_at, score_value,
   score_direction, comparison_key, published_at, is_pinned`) blocking an
   author from reversing a moderator's `post_delete()` or forging comparison-
   board/feed-ranking signals via direct PATCH. `post_delete()`,
   `request_account_deletion()`, and `admin_remove_member()` recreated
   byte-identical to their originals except for the transaction-local GUC pin
   each now sets around its own legitimate write (diffed against the
   pre-migration source to confirm no other behavior changed).
3. **Un-numbered finding** — `posts_delete_self` (a raw RLS DELETE policy
   pre-dating the moderator-aware `post_delete()` RPC) dropped, and the
   standing `DELETE` grant on `workout_posts` revoked from `authenticated`.
   Previously a member could hard-DELETE their own reported post, which
   cascade-deleted the `reports` row filed against it (`reports.post_id ON
   DELETE CASCADE`) — destroying moderation evidence.
4. **DB audit, HIGH** — `purge_due_accounts()` (existed since
   `202608260001`, never scheduled) now runs daily at 03:59 UTC via
   `cron.schedule('purge-due-accounts', ...)`. This is the mechanism behind
   `PRIVACY.md`'s 30-day account-erasure promise (see `PRIVACY_AUDIT.md`
   PRIV-002).
5. **DB audit, HIGH** — five foreign keys to `auth.users`/`profiles` with no
   `ON DELETE` clause fixed to `SET NULL` (`invites.created_by/revoked_by/redeemed_by`,
   `onboarding_step_content.updated_by`, `intro_carousel_content.updated_by`,
   plus `reports.reviewed_by → profiles`, found while fixing the first five).
   Any of these would have aborted `purge_due_accounts()`'s single bulk
   DELETE statement for the entire batch, not just the blocked row.

   **Correction to this migration's first draft:** the original text used
   `public.person_invites` — the actual table (defined in the
   `202609030001_person_invites.sql` migration *file*) is named
   `public.invites`. Caught during a systematic re-verification of every
   `public.X` identifier in both new migrations against real `CREATE TABLE`
   statements, before this document was written — the corrected version is
   what ships.

### `supabase/migrations/202609060012_close_abuse_and_amplification_findings.sql`

6. **SEC-003** — new `workout_posts_guard_insert_rate_limit()` trigger
   (BEFORE INSERT) enforcing `post_create()`'s existing `check_rate_limit`
   budget on any direct insert into `workout_posts` (the path
   `cloud.js:3072`/`4211`'s upsert calls still use). `post_create()` pins a
   GUC around its own insert so a real composed post spends one rate-limit
   token, not two — recreated byte-identical to the original apart from that
   pin (diffed to confirm the photo-count cap and `links` metadata-merge
   logic, both present in the original, were preserved — an earlier draft of
   this edit had dropped both, caught by the same diff check before this
   document was written).
7. **SEC-006** — `can_write_own_avatar()` gained a 3-object cap (mirroring
   `can_upload_post_photo()`'s existing 20-object cap on the sibling
   bucket); previously unbounded. Added `list_orphaned_avatar_photos()`,
   mirroring the existing `list_orphaned_post_photos()`.
8. **SEC-007** — `private_records` gained a 64 KB payload-size CHECK (added
   `NOT VALID` deliberately — see inline comment — so an unknown-size legacy
   row on the real project cannot abort this migration) and a 1000-per-10-minute
   rate limit via trigger; `analytics_events` gained a 500-per-10-minute rate
   limit; `push_subscriptions` gained a 10-active-device cap. None of the
   three had any volume limit before.
9. **SEC-008** — `clubs_guard_single_row()` trigger refuses a second `clubs`
   row outright, converting the "no multi-tenant filtering exists anywhere"
   latent risk into a loud failure instead of a silent one.
10. **SEC-011 (rate-limit half)** — new `admin_check_password_reset_rate_limit()`
    RPC (5 resets/60 min per admin), called by the Edge Function before any
    password is changed.

### pgTAP coverage added

- `supabase/tests/0077_close_launch_readiness_gap_findings_test.sql` —
  ghost-vs-real-member read assertions for all 11 newly-gated relations,
  moderation-guard-trigger reversal attempts, the DELETE-bypass
  reproduction, and the FK/scheduler fixes.
- `supabase/tests/0078_close_abuse_and_amplification_findings_test.sql` —
  rate-limit exhaustion tests (post_create direct-insert path, admin
  password-reset check), the avatar cap, the payload-size CHECK, the push-
  subscription cap, and the single-club trigger.
- **Both files are drafted and internally cross-checked against the real
  schema (table/column names verified via grep against every referenced
  `CREATE TABLE`) but have NOT been executed** — no Supabase CLI or running
  Docker container in this sandbox. Required before merge: a cold
  `supabase db reset` followed by `supabase test db`.

## Edge Functions

- `supabase/functions/admin_reset_password/index.ts` — added an OPTIONS/CORS
  preflight branch (scoped to `haimuniya.github.io` + local dev origins,
  SEC-011), UUID-format + real-non-deleted-member validation on
  `target_user_id` (SEC-011), and wired the new rate-limit RPC before calling
  `auth.admin.updateUserById()` (SEC-011). Version bumped to 2.
- `supabase/functions/recap_weekly/index.ts` and
  `supabase/functions/purge_abandoned_profiles/index.ts` — replaced `!==`
  service-role-key comparison with a constant-time byte comparison
  (`timingSafeEqualStrings`, SEC-017).

## Client (`cloud.js`)

- `detectSessionInUrl: true → false` (SEC-013) — no OAuth/magic-link flow in
  this app ever needed it; left on, it made a crafted
  `#access_token=...` URL a session-fixation vector.
- Password policy raised to match the new `config.toml` minimum (10 chars +
  upper/lower/digit, SEC-012) in the client-side `communityCredentials`
  validation, so a member gets an inline message instead of a raw server
  rejection.
- Moderation-queue profile-report mislabeling and dead-end "remove content"
  button fixed (`MOD_TARGET_LABEL`, `MOD_DECISIONS` filter,
  `modActionErrorText()` — CQ-001/CQ-002).
- `loadMemberRoles()` no longer permanently poisons the coach-badge cache on
  a transient RPC error (CQ-003).
- `loadProfile()`/`loadRedemption()` now distinguish "failed to load" from
  "doesn't exist," with a retry screen instead of silently re-running
  new-member onboarding on a returning member (CQ-006).
- The confirm sheet (`renderConfirmSheet()`) is now a registered dialog
  (`data-cloud-dialog="confirmSheet"`, first entry in `CLOUD_DIALOGS`, and
  first in the Escape-key chain) — fixes the accessibility HIGH finding A3:
  keyboard users could not reach Confirm/Cancel on ~19 destructive actions
  when the sheet stacked on another open dialog.

## CI / infrastructure

- `.github/workflows/test.yml` — wired `npm run check-version`,
  `npm run check-vendor-version`, and `npm audit --audit-level=high` into
  the `node-tests` job. All three scripts already existed and already
  passed; none had ever actually run in CI (`INFRASTRUCTURE_AUDIT.md`).
- **Not fixed, documented instead:** `supabase/setup-cli@<pinned-SHA>` still
  installs `version: latest` — the action itself is SHA-pinned but the CLI
  binary it fetches is not. Left unpinned deliberately rather than guessing
  a version number with no way to verify compatibility from this sandbox;
  recorded in `REMEDIATION_ROADMAP.md` as requiring a human with a working
  Supabase CLI to confirm the current stable version before pinning it.

## Test-suite corrections made necessary by the above

- Six test files' hardcoded fixture password (`"correcthorse"`, 12 lowercase
  chars) updated to `"CorrectHorse9"` to satisfy the new password policy —
  8 tests were failing on this before the fix (caught by running the full
  suite after the `config.toml` change, per this session's own practice of
  verifying after every change rather than assuming).
- `test/community-state-namespaces.test.mjs` — `profileLoadError`/
  `redemptionLoadError` added to the `ROOT_SCALARS` allow-list (a deliberate,
  documented architectural convention this file itself invites for exactly
  this case) and the `CLOUD_DIALOGS` entry-count assertion updated from 11 to
  12 for the new confirm-sheet registry entry.
- `test/community-dialog-focus.test.mjs` — new 12th test case for the
  confirm sheet, using the existing shared 5-point contract helper.

## Verification

`npm test`: **1108 tests / 1108 pass / 1 pre-existing skip / 0 fail**, run
repeatedly through this session after every source change (not just once at
the end) — see `FINAL_REGRESSION_REPORT.md` for the full history of
intermediate failures caught and fixed along the way. Browser-check
(Playwright/Chromium) and the pgTAP suite were **not re-run after these
changes** — no Docker/Supabase CLI in this sandbox for pgTAP, and the
browser-check suite was last run clean by the reliability research stream
*before* these code changes landed; re-running it is listed as required,
unverified work in `PRODUCTION_ACCEPTANCE_CHECKLIST.md`.
