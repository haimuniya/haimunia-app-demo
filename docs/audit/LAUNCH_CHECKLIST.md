# Launch checklist

An operational, do-this-in-order runbook for whoever actually ships this
session's changes — distinct from `PRODUCTION_ACCEPTANCE_CHECKLIST.md`'s
formal pass/fail gate, which this checklist exists to help clear.

## 1. Before merging anything

- [ ] Read `docs/audit/CORRECTIONS_COMPLETED.md` in full — know what changed
      and why before reviewing the diff.
- [ ] `git diff` the two new migrations and two new pgTAP files personally;
      they were written and cross-checked carefully but never executed (see
      below) — a second pair of eyes on raw SQL before it touches a real
      database is standard practice, not distrust.

## 2. Verify the database changes for real

- [ ] In an environment with the Supabase CLI and Docker: `supabase stop`
      (clean slate) → `supabase start` → `supabase db reset` (applies all
      migrations from empty, including the two new ones, in order) → confirm
      it completes with no error.
- [ ] `supabase test db` → confirm all pgTAP files pass, specifically the two
      new ones (`0077_close_launch_readiness_gap_findings_test.sql`,
      `0078_close_abuse_and_amplification_findings_test.sql`).
- [ ] If either step fails, fix the migration — do not skip or comment out
      the failing test. `docs/community/backlog.md`'s own established
      convention (see COMM-020's note in that file) is that this gate is
      real, not advisory.

## 3. Re-run the full test matrix

- [ ] `npm ci && npm test` — expect 1108/1108 pass, 1 pre-existing skip.
- [ ] `cd scripts/browser-check && npm ci && npx playwright install chromium
      && node run-all.mjs` — expect 29/29 (last known-good count; re-count if
      new browser-check scenarios were added since).
- [ ] `npm run check-version && npm run check-vendor-version && npm audit
      --audit-level=high` — all three now also run in CI
      (`.github/workflows/test.yml`), but confirm locally first.

## 4. Live dashboard configuration (cannot be done from this repo)

- [ ] Enable Cloudflare Turnstile or hCaptcha under Supabase → Authentication
      → Bot and Abuse Protection (SEC-004). This is now the single most
      impactful open security item this session could not close.
- [ ] Confirm `minimum_password_length = 10` and
      `password_requirements = "lower_upper_letters_digits"` are mirrored on
      the **real project's** dashboard, not just `supabase/config.toml`
      (which is explicitly documented as local/CI-only).
- [ ] Confirm the two new Vault-gated cron jobs
      (`purge-abandoned-profiles`, `recap-weekly`) still have their secrets
      set, and additionally confirm the **new** `purge-due-accounts` job
      appears in `select * from cron.job;` and its first scheduled run
      (03:59 UTC) actually executes — check
      `select * from cron.job_run_details order by start_time desc limit 5;`
      the day after deploy.
- [ ] Confirm GitHub branch protection actually requires all 3 CI jobs
      (`node-tests`, `browser-checks`, `migration-check`) before merge —
      this cannot be inspected from inside the repository.
- [ ] Confirm the real project's backup schedule, retention, and
      point-in-time-recovery setting (Supabase dashboard → Database →
      Backups) — not verifiable from this repo checkout, and
      `PRODUCTION_ACCEPTANCE_CHECKLIST.md` marks this a hard Failed item
      until someone with dashboard access confirms it and, ideally,
      performs one real restore-to-a-branch test.

## 5. First 48 hours after deploy

- [ ] Watch `cron.job_run_details` for the new `purge-due-accounts` job's
      first few runs — confirm it actually deletes rows once a real
      deletion request crosses 30 days (there may be a wait before the first
      real row is due; do not close this out on "the job ran with 0 rows
      affected" alone).
- [ ] Spot-check the moderation queue for a profile-type report (if one
      exists) to confirm the label/button fixes render correctly against
      real data, not just the jsdom mock.
- [ ] Watch for any new `rate_limited` errors in whatever error tracking
      exists — SEC-003/SEC-007's new triggers are conservative by design but
      untested against real traffic patterns; a false-positive rate limit
      would appear as a real user unable to post/sync.

## 6. Follow-up work to schedule (not launch-blocking, but real)

See `REMEDIATION_ROADMAP.md` for the complete list. Highest-value next
items: write-idempotency on `post_create`/`add_post_comment`/
`challenge_progress`, and closing the two flagged product decisions
(attendance-log disclosure, announcement-edit audit trail) with the actual
product owner.
