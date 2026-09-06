# Privacy audit

Scope: `PRIVACY.md` / `privacy.html` (last updated 2026-09-05) against the actual
schema and client code. Cross-references `THREAT_MODEL.md`, `SECURITY_AUDIT.md`
(SEC-009), and `DATABASE_AUDIT.md` rather than re-deriving their findings.

## Data collected — matches the schema

`PRIVACY.md`'s "Information we collect" section was checked line-by-line against
`supabase/migrations/`. It is accurate and current: account/sign-in data, invite
data, training-log data (posts only — the private IndexedDB log is disclosed
separately as never leaving the device unless explicitly migrated), community
social graph (follows/blocks/reactions/comments), attendance and booking data,
technical/device metadata, 90-day engagement analytics, and the attendance-based
coach engagement signal are all real, all currently collected, and none of the
real categories (photos, avatar images, achievement unlocks, challenge
participation, push-notification endpoints) is missing from the policy — each
of those is named elsewhere in the document. This is a material improvement
over the version the 2026-09-02 cross-repo audit reviewed, which it scored
2/10 for omitting shipped categories.

## PRIV-001 (P2) — The coach engagement-signal disclosure promises less than the schema grants

- **File:** `PRIVACY.md:60-70` vs. `supabase/migrations/202608310001_attendance_log.sql:151-152`
- **Finding:** the policy states the attendance-based coach signal shows
  coaches/admins "your baseline rate and your recent rate, **not a detailed
  log**." The actual RLS policy (`attendance_log_staff_select`) grants any
  `is_staff()` account (every coach, not only admins) `SELECT` on the raw
  `attendance_log` table directly — every row, every date, with no aggregation
  and no gate on the member's `show_attendance` toggle. This is SEC-009 in
  `SECURITY_AUDIT.md`, referenced here specifically for the written-policy
  mismatch: the promise "not a detailed log" is not enforced anywhere in the
  schema. Today nothing in the shipped client actually queries
  `attendance_log` directly (only the aggregated signal is rendered), so the
  gap is latent, not exploited — but it means the privacy policy currently
  describes the *client's* behavior, not a *guarantee the database enforces*.
  If any future admin tool, export feature, or direct API query ever reads
  `attendance_log`, the written promise breaks silently.
- **Fix:** either narrow `attendance_log_staff_select` to
  `has_perm('community.analytics.view')` (admin/owner only, matching the
  written "coaches and admins" language down to which of the two actually gets
  the raw table) or rewrite the disclosure to state plainly that coaches hold
  raw read access at the database level, independent of what today's UI
  chooses to render. Recorded as a product decision in `SECURITY_AUDIT.md`
  SEC-009 — not resolved by this audit pass, since it changes what a coach can
  do, not just what the client shows.
- **Status:** open, P2 (latent — no client surface currently exposes it)

## PRIV-002 (P1, now closed) — The 30-day deletion promise was not actually executing

- **File:** `PRIVACY.md:153-154` ("your profile and posts are hidden
  immediately and the account and its content are permanently deleted after
  30 days")
- **Finding:** `public.purge_due_accounts()` implements exactly this, and has
  since the foundation migration (`202608260001`) — but no scheduler ever
  called it. `202609050005_scheduled_jobs.sql` scheduled six other jobs and
  silently omitted this one. Every account-deletion request since launch was
  therefore honored for the "hidden immediately" half and never honored for
  the "permanently deleted after 30 days" half — a live, ongoing violation of
  the policy's own words for as long as the app has had users making deletion
  requests.
- **Fix applied this pass:** `supabase/migrations/202609060011_...sql`
  schedules `purge-due-accounts` via `cron.schedule`, daily at 03:59 UTC, and
  fixes five foreign keys (`invites.created_by/revoked_by/redeemed_by`,
  `onboarding_step_content.updated_by`, `intro_carousel_content.updated_by`,
  `reports.reviewed_by`) that had no `ON DELETE` clause and would have
  aborted the bulk purge statement for every pending deletion in the batch
  the moment it hit one blocked row.
- **Status:** fixed this pass — **unverified in this environment** (no
  Supabase CLI/Docker to run the migration against a real Postgres; see
  `COMMANDS_AND_TEST_RESULTS.md`). A `docs/community/abandoned-profile-purge-runbook.md`-style
  post-run verification (confirm `cron.job_run_details` shows a successful
  run, then confirm a test deletion request older than 30 days is actually
  gone from `auth.users`) is required before this can be marked verified.

## PRIV-003 (P3) — Exported/backed-up data has no in-UI sensitivity note

- Carried over from `CHANGES.md`'s own "Left for you" list (pre-dates this
  audit): the local JSON export/backup contains the full plaintext training
  log (name, bodyweight history, session notes). This is normal and expected
  for a personal backup, not a defect, but there is still no line of UI text
  next to the export button reminding a member the file is unencrypted
  plaintext if they intend to share or store it somewhere public. Low
  priority, cheap to add.
- **Status:** open, P3, unchanged from the prior audit trail.

## Consent, minimization, and default visibility — reviewed, no new findings

- Default visibility: `show_workout_results`, `show_prs`, `show_achievements`,
  `show_attendance`, `show_in_attendee_lists` all default appropriately per
  `202608280003_profile_privacy_and_recovery.sql` — `show_attendance` defaults
  **false** (the more private default), the social-sharing toggles default
  **true** (matching a community app's actual purpose: joining implies intent
  to be visible to the club by default, with an explicit opt-out).
- Consent for cloud sync is explicit and reversible (`syncCloudDialogFocus`'s
  own consent gate, unchanged by this pass).
- Minimization: `private_records` (the offline-sync channel) intentionally
  requires no profile and no invite redemption to write — this is a
  deliberate, documented product choice (offline-first is the whole premise),
  not a minimization failure, and SEC-007's rate-limit fix (this pass) bounds
  its abuse surface without adding a membership gate that would break that
  design.
- Retention: the 90-day analytics purge (`retention_purge_telemetry()`) is
  real, scheduled, and was verified present in `202609050005`.

## Legal review flag

`PRIVACY.md`'s "Who runs this" section explicitly disclaims operating as a
registered legal entity and does not claim any jurisdiction's law governs it.
That is an intentional, informed choice for a single-club community tool, not
an oversight — but it is exactly the kind of statement that should get a real
lawyer's eyes before public launch if the club operates in a jurisdiction with
mandatory data-controller registration or minor-data rules (see "Children's
privacy" section, `PRIVACY.md:180`). Flagged for qualified legal review, not
resolved by this audit.

## Summary

| ID | Finding | Priority | Status |
|---|---|---|---|
| PRIV-001 | Attendance disclosure promises "not a detailed log"; schema grants raw table access to every coach | P2 | open — product decision needed, see SEC-009 |
| PRIV-002 | 30-day deletion promise had no scheduler | P1 | **fixed this pass**, unverified in this environment |
| PRIV-003 | No in-UI sensitivity note on the plaintext export | P3 | open, pre-existing |
| — | Legal entity / jurisdiction disclaimer | — | flagged for qualified legal review |
