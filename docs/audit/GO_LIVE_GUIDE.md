# Go-live guide

Ordered, actionable steps to move from the current **CONDITIONAL**
verdict (`PRE_LAUNCH_AUDIT.md`, score 78/100) to **READY**, and what to do
once real members are actually in. Nothing here duplicates the audit
itself — this is the "now go do it" version. Each item names who can do it
(you, from a phone/laptop with dashboard access — none of these need a
developer, and none are things I can do from this sandbox).

## A. Must do before letting real members in

These are the items keeping the verdict at CONDITIONAL. All are external
to the repository — nothing here is a code fix.

### 1. Real device smoke test (~15 minutes, do this first)

No device has run this app outside Chromium. Do this on your own phone,
installed as a PWA, before anyone else's:

1. Open the site in Safari (iPhone) → Share → **Add to Home Screen**.
   Confirm it installs with the right icon and name, opens full-screen
   (no Safari chrome), and the splash matches `manifest.json`'s
   `background_color`.
2. Log a set from a completely fresh app (Add tab). Confirm it saves and
   shows in History.
3. Turn on Airplane Mode. Log another set, edit one, delete one. Confirm
   nothing errors and the UI doesn't hang.
4. Turn Airplane Mode off. Confirm the app doesn't lose or duplicate
   anything, and (if you have Community configured) that any queued sync
   goes through.
5. Join/open Community: view feed, make a post, react, comment, RSVP to an
   event if one exists, join a challenge, change a notification
   preference.
6. Fully close the app (swipe away), reopen from the home screen icon.
   Confirm it comes back to a working state, not a blank/stuck screen.
7. Repeat steps 1–6 once on an Android phone in Chrome. iOS PWA behavior
   is the more failure-prone of the two — Android is the cheaper
   confirmation, not a substitute for it.

If anything breaks here, it's a real finding this audit could not surface
— report it back before going further down this list.

### 2. Confirm GitHub Pages deploy mechanism (~5 minutes)

GitHub repo → **Settings → Pages**. Confirm:
- What branch/folder Pages actually builds from (this determines whether
  pushing to `main` is itself a production deploy, or whether a separate
  step is needed).
- Repo → **Settings → Branches** → confirm branch protection on `main`
  requires the `node-tests`, `browser-checks`, `migration-check`, and
  `edge-function-lockfiles` CI jobs before merge. If it doesn't, a future
  merge could ship broken code without anyone noticing — this is the one
  structural gate keeping `main` trustworthy.

### 3. Confirm Supabase Auth dashboard settings mirror the repo (~2 minutes)

Supabase dashboard → **Authentication → Providers/Settings** for project
`jajmlyrjlkhclgphbfbb`:
- Minimum password length **10**, complexity **lowercase + uppercase +
  digits** — must match `supabase/config.toml` (`minimum_password_length`,
  `password_requirements`), which is documented as local/CI-only and does
  **not** by itself configure the live project.
- Confirm CAPTCHA (Turnstile/hCaptcha) is intentionally left off — this was
  a deliberate decision (`cloud-config.js:51-59`), not something to "fix"
  unless you're reversing that call.

### 4. Confirm the two Vault-gated cron jobs (~5 minutes)

**Do not check whether the two secret *names* exist** —
`202609050005_scheduled_jobs.sql:170-181` creates both, with committed
placeholder values, on every stack including a fresh local one, so their
mere presence proves nothing. Check the *values* against the exact
placeholders `cron_invoke_edge_function()` itself checks for
(`:206-210`):

```sql
select name,
       decrypted_secret not like '%PROJECT-REF-NOT-SET%' as base_url_set,
       decrypted_secret <> 'SERVICE-ROLE-KEY-NOT-SET'    as key_set
from vault.decrypted_secrets
where name in ('edge_functions_base_url', 'edge_functions_service_role_key');
```

Both columns must read `true` for the jobs to actually fire — one row with
either column `false` means the gate is still refusing, silently, by
design (a `NOTICE`, not an error).

Even that only proves the values were *changed*, not that a request has
actually gone out. The decisive, no-guessing check: after the next
scheduled run (`purge-abandoned-profiles` fires daily at 03:31 UTC),

```sql
select * from net._http_response order by created desc limit 20;
```

A row here means the secrets are real and the transport works. Still
empty after a scheduled run has passed means the gate is refusing —
treat that as VAULT-1 still open, regardless of what the query above
reported.

- If confirmed live: `recap-weekly` and `purge-abandoned-profiles` are
  actually running, not just scheduled. Also confirm via
  `select * from cron.job_run_details where jobid in (select jobid from cron.job where jobname in ('recap-weekly','purge-abandoned-profiles')) order by start_time desc limit 5;`.
- If not live: these two jobs currently report `succeeded` while doing
  nothing (`docs/ops/MONITORING.md` §4 explains why — the cron job's SQL
  genuinely succeeds even when the gate inside it refuses). This does
  **not** block launch — recaps are a nice-to-have and the ghost-account
  sweep is a quota nuisance, not a data risk — but decide and document
  which state you're actually in, rather than leaving it ambiguous. If you
  want them live, `vault.create_secret()` (or the dashboard's Vault UI) in
  the SQL editor with the real values; the service-role key must never
  enter the repository.

### 5. Wire an actual alert — drafted and locally tested, needs your secrets

**Done, pending configuration.** `.github/workflows/scheduled-job-alert.yml`
+ `scripts/check-scheduled-job-health.mjs` now exist: a daily (06:00 UTC)
GitHub Action that calls `scheduled_job_health()` over the production
REST API and posts to a webhook if any job comes back unhealthy —
including if the check itself can't run at all (missing config, network
failure), which alerts rather than silently reporting "fine." Tested
locally against the local Supabase stack: correctly reports unhealthy jobs
(exit 1), correctly reports a broken config as its own failure (exit 2,
not success), correctly falls back to printing when no webhook is
configured yet.

**What's left is three GitHub repo secrets** (Settings → Secrets and
variables → Actions), not a developer task:
- `SUPABASE_URL` — the production REST URL
- `SUPABASE_SERVICE_ROLE_KEY` — `scheduled_job_health()` is service_role-only
  by design; never put this in a workflow file itself, only the secrets
  store
- `ALERT_WEBHOOK_URL` — a Slack or Discord incoming webhook URL (both
  accept `{"text": "..."}` as-is)

Until these are set, the workflow's own run turns red in the Actions tab
on every scheduled trigger — which is itself a visible (if less
convenient) signal, not a silent no-op. You can also trigger it manually
any time from the Actions tab (`workflow_dispatch`) to test it end-to-end
once the secrets are in.

**Known blind spot, found and documented 2026-09-08 — this alert cannot
detect VAULT-1.** `scheduled_job_health()` reports a job healthy based on
`cron.job_run_details.status = 'succeeded'`, and `cron_invoke_edge_function()`
(which backs `recap-weekly` and `purge-abandoned-profiles`) responds to
unset/placeholder Vault secrets with a `NOTICE`, not an exception — the
cron SQL completes normally either way. So those two jobs can report
healthy while doing nothing, which is exactly the state VAULT-1 describes.
The script prints an explicit note when this applies so it's visible in
the Action's log, but does not fail the check on it — closing that
properly needs a second check against `net._http_response` (not in the
REST-exposed schema; would need its own new migration exposing a narrow,
service_role-only accessor, since applied migrations are immutable).
**Named as a follow-up, not built under this pass** — until it exists, use
the manual `net._http_response` check in §A.4 after a scheduled run to get
a real answer for these two jobs specifically; don't trust this
automated alert's silence for them alone.

**Two operational notes, easy to miss:**
- GitHub disables scheduled (`on: schedule`) workflows after 60 days of
  repository inactivity — on a quiet repo, this alert going silent would
  itself be silent. Check the Actions tab occasionally rather than
  assuming "no notification" means "all clear" indefinitely.
- A `schedule` trigger only runs from the **default branch**. This isn't
  live until `.github/workflows/scheduled-job-alert.yml` is on `main` —
  don't check this item off on the strength of the file existing on a
  feature branch.

**One accepted tradeoff, stated explicitly rather than left implicit:**
the service-role key this workflow uses bypasses every RLS policy on
production member data — a large blast radius for what is otherwise a
simple health ping. This is forced by `scheduled_job_health()`'s own
design (service_role-only, by the same migrations that built it), not an
oversight in this workflow, and it's the standing tradeoff of any
service-role-backed automation. If it's ever worth narrowing: a
purpose-made Postgres role plus a `SECURITY DEFINER` function returning
only job name + healthy boolean, granted to that narrower role instead.

### 6. Confirm the real backup/retention settings (~2 minutes)

Supabase dashboard → **Database → Backups**. Note (don't need to change)
the retention window and whether point-in-time recovery is enabled. This
was never independently tested (only the dump-based path was, successfully,
on 2026-09-06) — you don't need to test it before launch, but you should
know what it actually promises before you need it in an emergency.

---

## B. Should do soon after (not launch-blocking)

- **Review, don't blindly merge, the open Dependabot PR** bumping
  `@supabase/supabase-js` (2.57.4 → 2.115.0, vendored — this repo has no
  bundler, so this is a manual re-vendor, not an `npm update`). Reviewed
  2026-09-08: real behavioral changes exist between these versions
  (realtime's default serializer moved to protocol v2.0.0; a Storage API
  rename; GoTrueClient's internal locking mechanism changed) — none are
  referenced directly in this repo's code, but the realtime wire-protocol
  change can't be ruled out by grep alone. Do this as its own isolated PR
  with a full regression pass (`npm test` + `supabase test db` +
  `run-all.mjs`), not bundled into a feature release. Same for the
  lower-risk, dev-only `jsdom` bump.
- **Real screen-reader pass** (VoiceOver on iOS, or NVDA/TalkBack) — the
  automated axe-core sweep catches structural/contrast issues but not
  whether things make sense when heard.
- **Rehearse `docs/ops/INCIDENT_RESPONSE.md` once**, even as a dry run with
  no real incident — a process nobody has walked through is not a verified
  process, and the first real incident is the wrong time to discover a gap
  in it.
- `deleteMeasureType` still cascades away every measurement of that type
  with no confirmation step — in progress, currently blocked by a
  concurrent edit to `app.js` in the shared working tree.
- ~~A restricted member having no UI surface for their restriction's
  reason/expiry~~ — **done**, see `PRE_LAUNCH_AUDIT.md`.
- `challengeKeyExists()` being device-relative for unpublished custom WODs
  — still open, unowned.
- **New, from commit `0e97746` (2026-09-08):** `PRIVACY.md`/`privacy.html`
  (both languages) still describe the pre-fix abandoned-account purge
  behavior — the fix (an account holding any training data is now excluded
  outright) changed what actually happens, and a test asserts the old
  copy. The commit says this explicitly as "still to follow" — needs the
  copy update + test update to ship together before this is fully closed.
- Two newly-named, unowned items from 2026-09-08: the consent card
  promising device-change recovery an anonymous account can't yet deliver,
  and `admin_incomplete_signups.purgeable_after_reclaim` going stale now
  that the purge guard landed (needs a migration). Ask the team currently
  in `cloud.js`/`app.js` for exact wording before touching either — it's
  in their session transcript.

---

## C. Launch-day sequence (once A is done)

1. **Take a backup first, always:** `supabase db dump --linked -f pre-launch-$(date +%Y%m%d).sql`
   even if nothing is changing that day — cheap insurance.
2. **Confirm schema/client alignment one more time:**
   `node scripts/check-deploy-readiness.mjs <prod-url> <prod-anon-key>` →
   must say READY before inviting anyone in.
3. **Send the first real invite code to yourself or one trusted person
   first**, not the whole club at once. Walk through sign-up → invite
   redemption → first post, exactly as a real member would, on a real
   phone.
4. Only once that one real signup works end-to-end, open invites to the
   rest of the club.

## D. First 48 hours after real members are in

- Watch `cron.job_run_details` for the next `purge-due-accounts` and
  `notif-batch-flush` runs — confirm they're actually executing, not just
  registered.
- Watch for `rate_limited` errors — the abuse-prevention triggers are
  conservative by design but untested against real traffic; a real member
  hitting one reads as "the app won't let me post," which is worth
  catching fast.
- Check the moderation queue (`select count(*) from public.reports where status = 'open';`)
  daily — a report that sits unanswered is a duty-of-care problem, not just
  a metrics one.
- Re-run `select * from public.scheduled_job_health() where not healthy;`
  daily until item A.5's automated alert is actually in place.

## E. Ongoing (monthly-ish)

- Re-check `npm outdated` and review Dependabot PRs — don't let the
  vendored Supabase client drift further without a deliberate look.
- Re-read `docs/ops/MONITORING.md` §5 (moderation backlog) and §2
  (auth/abuse) once a month even without a specific trigger — these are
  the two signals nothing else surfaces automatically.
