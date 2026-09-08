# Pre-launch audit — 2026-09-07

Session scope: a final go/no-go pass, run against the repository at commit
`abee1a1` on branch `fix/audit-followups` (one commit ahead of `origin/main`
`c5f75c7`, plus an in-progress working-tree edit — see "Environment note"
below). This is **not** a first audit. It is the Nth pass over a codebase
that already carries 28 prior audit documents in `docs/audit/`, 90 pgTAP
files, and 1300+ node:test cases, most recently closed out by a real
production deployment on 2026-09-06 (`REMEDIATION_STATUS.md`) and a
26-commit "five-persona UX audit" merged to `main` on 2026-09-07 (`c5f75c7`).

A general code review and a dedicated security audit were explicitly out of
scope for this pass per the brief. This document reports only: what changed
or was newly verified in this session, what is confirmed still true from
prior passes (with the verification re-run, not just re-quoted), and what
remains honestly unverifiable from this environment.

## Environment note — read this before trusting any "current" claim below

While this audit was running, a sibling Claude session was concurrently
committing to the same shared working tree and, at one point, merged and
pushed 26 commits to `origin/main`. Two files (`cloud.js`,
`src/shared/safe-helpers.js`, later joined by four test files) were dirty
with in-progress work for the entire session. Every finding below that
depends on the working tree distinguishes:

- **Committed, on `origin/main` (`c5f75c7`) or this branch's own commit
  (`abee1a1`)** — stable, re-verifiable by anyone.
- **In the dirty working tree at time of writing** — a moving target;
  re-run the commands before relying on it.

This is itself a process finding — see P2-AUDIT-1.

---

## Executive verdict

**CONDITIONAL.** The application is not broken and `main` is already live in
production with a clean database migration history. But this pass cannot
close the loop to **READY** because several criteria the user's own launch
gate requires (§43) are either genuinely external to this repository
(dashboard configuration, real device testing, alert wiring) or depend on
a branch that was still being edited by another agent at the moment this
report was written. Nothing found in this pass is a new P0. One new
non-blocking process gap (P2-AUDIT-1) and one pre-existing, already-tracked
external gap (VAULT-1, re-verified as still open) are the most significant
items.

## Launch-readiness score: 78/100

Scoring basis: the four hard gates in §43 that are checkable from this
repository are all met (zero open P0/P1 *inside the repo*, migrations
verified against real PostgreSQL, offline/sync/club-isolation/role logic
verified, scheduled jobs verified in code and by prior production query).
`main`'s CI was found red mid-session (a test-file naming collision — see
the addendum) and is confirmed fixed, merged, and pushed as of `53a8106`,
so no points are withheld for it. Points withheld for: external dashboard
items never confirmed by anyone with access (−8), real-device/browser
testing not performed (−6), the Vault secret gap leaving two of ten cron
jobs inert in production (−4), no wired alerting beyond a SQL query someone
has to remember to run (−4).

---

## P0 findings (this session)

**None.** No new P0 was found. The one candidate investigated — whether
`origin/main` was pushed ahead of the production database schema, which
would have caused `PGRST202` on every write for real members — was
investigated and **closed**: the sibling session applied the 9 pending
migrations (`202609060019`–`0028`, `0021` deliberately skipped) to the live
project (`jajmlyrjlkhclgphbfbb`) via `supabase db push --linked`, confirmed
zero drift with `supabase migration list --linked`, and confirmed
`check-deploy-readiness` reported READY against production *before*
`git push origin main`. Independently confirmed in this session: this
branch has zero migration changes relative to `origin/main`
(`git diff --stat origin/main...HEAD -- supabase/migrations/` is empty), so
there is no new drift risk introduced since.

## P1 findings (this session)

**None new.** One previously-tracked P1-adjacent item was re-verified and
narrowed, not newly found:

| ID | Finding | Status this session |
|---|---|---|
| VAULT-1 (carried forward) | `recap-weekly` and `purge-abandoned-profiles` cron jobs reach their Edge Functions through `cron_invoke_edge_function()`, which silently no-ops (`succeeded` with zero effect) while `edge_functions_base_url` / `edge_functions_service_role_key` in Supabase Vault are still their committed placeholders. | **Confirmed still open; scope corrected.** Read `supabase/migrations/202609060011_close_launch_readiness_gap_findings.sql:339-343`: `purge-due-accounts` (the member-initiated 30-day deletion promise in `PRIVACY.md`, the product-critical one) calls `public.purge_due_accounts()` directly via `$$select public.purge_due_accounts()$$` — **plain SQL, no Edge Function, no Vault dependency**. Only the weekly recap and the abandoned-*ghost*-account sweep are affected by VAULT-1. This is a real correction to how the gap was described to me mid-session (see cross-session log) — it is smaller in blast radius than "the deletion workflow may not work," which it does not affect. **Cannot verify Vault secret state on the live project from this sandbox — NOT VERIFIED, needs a `select * from vault.decrypted_secrets` (or dashboard check) by someone with production access.** |

## P2 findings

| ID | Finding | Evidence | Disposition |
|---|---|---|---|
| P2-AUDIT-1 (new, escalated 2026-09-08) | No file-lock or branch-coordination mechanism exists for concurrent agent sessions sharing one working tree — and this stopped being theoretical. **Two real incidents on 2026-09-08, reported directly by the sessions that hit them:** (1) a commit landed on the wrong branch because the shared working tree's checked-out branch changed under the committing session; (2) a `supabase db push` from the shared checkout nearly shipped another session's *unmerged* migrations to production, because `supabase db push` reads `supabase/migrations/` off the filesystem, not git state — it doesn't know or care what's actually committed or which branch is checked out (see `ROLLBACK_PLAN.md` §2a for the mitigation now documented). Separately, a duplicate pgTAP file number (two files both named `0091_*`) reached `main` before being caught and coordinated away. All three were shared-state accidents between cooperating sessions, not disagreements — coordination happened entirely through ad hoc cross-session chat, which worked here specifically because every session asked before acting on another's files. | Observed directly this session (branch moved twice under me, `main` gained a merge+push while I was mid-read) plus two independently-reported incidents from sibling sessions the same day. | Still a process recommendation, not a code fix — but the two 2026-09-08 incidents mean this is no longer a hypothetical worth deferring. Minimum concrete mitigation now in place: `ROLLBACK_PLAN.md` §2a's rule (always `--dry-run` a `db push` and read the list; prefer a disposable `git worktree` over the shared checkout for anything that reads the filesystem as ground truth). A lightweight lock convention (a file naming the session and paths in flight) would close the rest of the gap if multi-agent sessions on one clone stay routine. |
| P2-TEST-1 (new) | A handful of `node:test` cases (`community-field-validation`, `community-member-of-week`, `community-retention-correlation-views`) flaked under concurrent host load (a `supabase db reset` running in parallel) with "waitFor timed out" rather than a real assertion failure, then passed cleanly in isolation and in a second full clean run. `waitFor`'s timeout (`test/helpers/boot.mjs`) is a fixed wall-clock value, not adjusted for host contention. | Reproduced: full suite run #1 (concurrent with `supabase db reset`) showed these as failures; isolated re-run and full suite run #2 (no concurrent load) both showed 0 failures in these files. | Low severity — CI runners are typically not contended like a dev box running two agents. Worth knowing if CI ever shows an intermittent, non-reproducing failure in these specific files: it is very likely host load, not a real regression, before assuming otherwise. |
| DEP-vendor (re-confirmed) | `@supabase/supabase-js` vendored at 2.57.4; latest is 2.115.0 (58 minor releases behind). Dependabot already has an open PR (`origin/dependabot/npm_and_yarn/supabase/supabase-js-2.114.0`). `jsdom` (dev-only) is at 25.0.1 vs latest 30.0.1, matched by another open Dependabot PR. | `npm outdated`, `git branch -a` | Deliberately not upgraded in this pass — the vendored bundle carries a pinned sha256 in `scripts/check-vendored-supabase-version.mjs` and a version bump requires re-pinning and full regression, which is a dedicated task, not a side effect of an audit. Recommend merging the Dependabot PR as its own reviewed change, soon, not blocking this launch. |
| VAULT-1 | See P1 table above — carried at P1-adjacent severity because it silently disables two of ten scheduled jobs, but demoted from "P1" in the strict sense because neither affected job is a safety/privacy-critical path (weekly recap is a nice-to-have; abandoned-ghost-account cleanup is a quota nuisance per SEC-004's own accepted-risk reasoning, not a data-exposure risk). | `docs/audit/REMEDIATION_STATUS.md` "Still open" table; migration text confirmed this session | Needs a production Vault check before it can close. |
| INF-2 (carried forward) | GitHub branch protection requiring all CI jobs is not inspectable from inside the repository (`gh` CLI unavailable in this sandbox). | Attempted `gh auth status` / `gh api repos/.../pages` — command not found | **NOT VERIFIED**, unchanged from prior audits. |
| Pages deploy mechanism (new, narrower than a finding) | Whether GitHub Pages auto-builds from `main` on push, or requires a separate action, could not be confirmed from this sandbox (no `gh`, no dashboard access). The ordering hazard this would otherwise create is closed regardless (see P0 section — schema landed before the push), so this is a **gap in verification, not a live risk** right now. | `gh` unavailable | **NOT VERIFIED** — worth a 30-second dashboard check so the next release doesn't have to re-derive this. |

## P3 findings

Everything in `docs/audit/REMEDIATION_STATUS.md`'s own P3 table stands;
re-reading it against the current schema/tests did not surface a
regression in any P3 item. Not re-litigated here — see that document.

Two items the sibling session flagged as open on its own follow-up branch,
noted here for completeness since they are genuine, undisputed, and not
mine to fix (the file is locked to their in-flight edit):

- Custom (unpublished) WODs remain device-relative for `challengeKeyExists()` —
  a challenge built on an unpublished custom WOD looks broken to everyone
  else. The club WOD catalogue (`202609060028`) closes this for *published*
  WODs only.
- ~~A member under a posting restriction has no UI surface showing the
  restriction's reason or expiry~~ — **resolved 2026-09-07**, shipped in
  `84754ad`/merged `9549548`: `renderMyRestrictionPanel()` on the Account
  tab, verified against the real RLS boundary (two members restricted via
  `mod_restrict_member()`, read back over REST as themselves; confirmed a
  restricted member's own SELECT returns exactly one row, her own).
- `deleteMeasureType` cascades away every measurement of that type with no
  confirmation step. **Still open** — queued for this session, blocked by
  a concurrent sibling-session edit to `app.js`; will follow the pattern
  `8afbc57` already established for training-entry deletion
  (`askAppConfirm`'s `{subject}` token) once the file is free.

## Addendum — 2026-09-08: Dependabot review, and a new production finding

**`@supabase/supabase-js` bump reviewed, not executed.** Checked the
project's changelog for breaking/behavioral changes between the vendored
2.57.4 and latest 2.115.0. Found real ones worth knowing before bumping:
realtime's default serializer moved to protocol v2.0.0 (v2.91.0, a wire-
format change between client and Realtime server, not something a code
grep can rule out); `StorageAnalyticsApi` renamed to `StorageAnalyticsClient`
(v2.87.0); GoTrueClient's navigator-locks mutex replaced by a commit-guard
pattern (v2.107.0); Node 20 support dropped (v2.110.0, irrelevant here —
this repo already requires Node ≥22). Grepped `cloud.js` and
`src/realtime.js` for direct references to the renamed/internal symbols:
none found, which lowers but does not eliminate risk — the realtime
protocol change is invisible to a code search since nothing in this repo
calls the serializer directly. **Recommendation at the time: do this as
its own isolated, fully-regression-tested change, not as a drive-by.**

**Update, later the same day:** a sibling session picked this up for
real — a dedicated pass, not a drive-by. Reported findings: `jsdom` 25→30
breaks this repo's own test boot (jsdom 30 made `window.crypto` a
getter-only accessor; `test/helpers/boot.mjs`'s plain assignment to it
throws, taking down every test that boots the app — a one-line
`Object.defineProperty` fix restores 1505/1505), confirming the caution
above was warranted rather than theoretical. The `@supabase/supabase-js`
re-vendor also broke the DEP-3 version-detection heuristic in
`check-vendored-supabase-version.mjs` — the new build's minifier dropped
the structural pattern (`exports.version`) that check's regex relied on,
since Supabase now versions its sub-packages as one monorepo unit.
Reportedly fixed, with the sha256 pin retained as the actually
load-bearing control (a version string proves what's claimed; the hash
proves what's really shipped). The vendored bundle grew 131KB→212KB
(+62%) — a real cost question for §17 (first-load size on this app's
low-end-mobile audience), not a correctness one, still being weighed as
of this writing. See `GO_LIVE_GUIDE.md` for current status — not
independently re-verified by this audit while the files are in another
session's active edit.

**New finding, reported by a sibling session and recorded here with the
appropriate caveats (not independently re-queried against production —
no production access from this sandbox):** `purge_abandoned_profiles` had
a real data-loss bug — `private_records` (the offline training log)
cascades from `auth.users`, and the purge's abandonment predicate never
excluded a user with real logged workouts, so a member who used the app
locally and never joined the community would have had their entire
training history deleted on day 31. Fixed in migration `202609070001`
(`PURGE_VERSION` → 2), deployed to production. Separately, a claim that
this bug had been "live and armed" via newly-set Vault secrets was
**walked back after verification**: the check used to claim the secrets
were "set" only confirmed the secret *names* exist, which is true even in
the unconfigured placeholder state (`202609050005_scheduled_jobs.sql:170-181`).
`GO_LIVE_GUIDE.md` §A.4 and `LAUNCH_CHECKLIST.md` item 19 have been
corrected accordingly — VAULT-1 is NOT VERIFIED, not resolved. What's
actually established: the bug was real in the deployed code, independent
of whether the Edge Function transport was ever reachable.

---

## What was verified this session (with evidence)

### Database / migrations (§7, §43 "all migrations executed against real PostgreSQL")

```
supabase db reset   -> exit 0, all 118 migrations applied from empty, PostgreSQL 17.6 (local)
supabase test db    -> Files=90, Tests=3096, Result: PASS
```

This is a genuine from-empty run in this session, not a re-quote of the
2026-09-06 figures (which were Files=83/Tests=2826 on 85 migrations — the
schema has grown by 33 migrations and 270 pgTAP assertions since, all still
green). Confirms: correct ordering, no hidden manual-object dependency, no
duplicate definitions, no missing-column/function/trigger errors.

**Club isolation (§10) — re-scoped, not skipped.** The schema enforces
**exactly one row** in `public.clubs` via a guard trigger
(`clubs_guard_single_row`, referenced in
`supabase/migrations/202609060015_indexes_impersonation_and_dormant_jobs.sql`),
and `club_id` is deliberately left unindexed on 31 tables *because* it is
single-valued today (`DB-M2`, accepted with evidence in
`REMEDIATION_STATUS.md`). This matches the product brief handed to me:
"private, invite-only, scoped to one club." **Testing two clubs and
asserting no cross-club leakage, as the generic checklist requests, does
not apply to this product's actual architecture** — there is structurally
only one club, enforced at the database level, not a multi-tenant boundary
this app draws at runtime. Marking §10 **Not applicable, proven with
evidence** rather than either skipping it silently or fabricating a
two-club test that would not reflect how this app is deployed. If Haimunia
ever serves a second box, the current design implies a second, separate
Supabase project/deployment, not a second row in this table — worth stating
explicitly since it is easy for a future reader to mistake the missing
`club_id` index for an oversight.

**Deploy-readiness, local:**
```
node scripts/check-deploy-readiness.mjs http://127.0.0.1:54321 <local-anon-key>
  -> READY (post_create, add_post_comment, toggle_reaction, chal_record_progress, event_rsvp all resolve 42501, not 42883)
```

**Migration immutability:**
```
node scripts/check-migration-immutability.mjs -> OK (compared against origin/main at c5f75c7)
```

### Account deletion / privacy purge (§22)

Read `public.purge_due_accounts()`
(`supabase/migrations/202608260001_community_foundation.sql:157-166`):

```sql
with due as (select user_id from public.account_deletion_requests where purge_after <= now()),
removed as (delete from auth.users u using due d where u.id = d.user_id returning u.id)
select count(*) into affected from removed;
```

**Idempotency confirmed by inspection, not assumption:** a second run finds
either zero `due` rows (if the FK cascade already removed the deletion
request along with the user) or zero matching `auth.users` rows (if it did
not) — both paths return `affected = 0` with no error, on any number of
repeated runs. This satisfies §20/§22's "run the purge job twice, the second
run should not corrupt state or fail" requirement by construction, and is
scheduled daily at 03:59 UTC (`cron.schedule('purge-due-accounts', ...)`,
`202609060011`). This function does **not** depend on the Vault secrets
gap (VAULT-1) — see the P1 table above.

### Test suites (§2, §3)

```
node --test          -> 1328/1328 pass, 0 fail, 0 skipped (clean run, no concurrent host load)
                         (a prior run showed 10 failures under concurrent supabase db reset load;
                          fully explained below, not a defect)
node run-all.mjs      -> 22/23 scenarios passed; 1 failure (community-coach-engage.mjs) explained below
npm run check-version         -> OK: APP_VERSION and SW_VERSION both 4.5.0
npm run check-vendor-version  -> OK: vendor/supabase.js matches pinned sha256
npm audit --audit-level=high  -> found 0 vulnerabilities
```

**Every failure observed this session was root-caused, not just counted:**

1. Six `node:test` failures (5× `community-coach-tools.test.mjs` —
   Celebrate/Welcome empty states, coach-engagement-flag review/dismiss —
   plus 1× `shared-safe-helpers.test.mjs`'s VERSION/package.json sync
   check) and one `run-all.mjs` scenario failure
   (`community-coach-engage.mjs`, a Playwright timeout) all trace to the
   **same in-progress, uncommitted edit** to `cloud.js` /
   `src/shared/safe-helpers.js` a sibling session was actively making
   during this audit. Verified by creating a disposable
   `git worktree add <tmp> HEAD --detach` (touches nothing in the shared
   working tree) and re-running the exact same files: **31/31 node:test
   cases and the browser scenario all pass on the last commit
   (`abee1a1`).** These are not shipped defects.
2. Four other `node:test` failures in an earlier full run
   (`community-field-validation`, `community-member-of-week`,
   `community-retention-correlation-views`) were caused by this session's
   own concurrent `supabase db reset` contending for CPU with the
   `waitFor`-based test helper's fixed timeout. Reproduced clean in
   isolation and in a full re-run with no concurrent load. See P2-TEST-1.
3. By the time of the final clean `node --test` run (after the sibling
   session's edit had progressed further), all 1328 tests passed,
   including the ones in (1) — the sibling's fix landed mid-session. This
   is reported as history, not as something to re-verify indefinitely;
   whoever merges `fix/audit-followups` should re-run `npm test` on the
   final commit before doing so, per standard practice, not because this
   audit found a live problem.

### Accessibility (§16) and browser behavior (§14, §37)

`run-all.mjs`'s `a11y-axe-scan.mjs` sub-scenario: **7/7 screens, 0
serious/critical WCAG 2.2 AA violations** (Add, History, Calendar, WOD,
Community/Feed, Community/Boards, Community/Account), axe-core against real
Chromium, re-run this session. `app-dialog-keyboard.mjs`: full focus-trap,
Escape-chain, and return-focus behavior confirmed for the confirm-sheet
pattern this app uses for all ~19 destructive actions. `bidi-rtl-geometry.mjs`:
confirmed this session that the sibling's in-progress bidi fix (a Hebrew
`3×5 @ 60`-style line with an embedded LTR run painting correctly
left-to-right-embedded-in-RTL) already works on the dirty tree, even before
it is committed — a real, positive, verified result, not just a claim.

This exercises Chromium only. **Safari (iOS/macOS), Firefox, and Edge were
not tested — no such runtime is available in this sandbox. NOT VERIFIED,**
per the instruction to not mark unavailable checks as passing. Given the
product brief calls out "special attention to iOS PWA behavior," this is
the single largest verification gap this audit could not close, and it
should be the first thing done on a real device before broad rollout.

### Offline-first architecture (§4, §6) — verified by code + existing coverage, not re-executed live

`sw.js` cleanly separates `REQUIRED_ASSETS` (the offline training log:
`index.html`, `app.js`, `theme-init.js`, `src/shared/safe-helpers.js`,
`src/constants.js`, `src/format.js`, `src/sanitize.js`, `src/db.js` — a miss
on any of these fails the whole install, by design, so the app never
activates a shell missing a core dependency) from `OPTIONAL_ASSETS`
(`cloud.js` and everything Community-only — a miss degrades only that
feature). This is the correct shape for the offline guarantee in the
product brief and matches what `app.js` actually depends on unconditionally
(traced, not assumed — the comment in `sw.js:14-24` names the exact call
sites). Extensive existing coverage
(`clear-data.test.mjs`, `community-outbox.test.mjs`,
`community-backup-sync.test.mjs`, and the IndexedDB-schema-version tests) is
part of the 1328 passing tests above, using `fake-indexeddb` — this proves
the logic, not an actual airplane-mode browser session. **Actual
offline-toggle-in-a-real-browser testing (DevTools "Offline", or a real
network drop mid-write) was not performed in this session. NOT VERIFIED as
a live browser behavior**, though the underlying code path and its
idempotent-retry design (`REL-1` through `REL-5` in
`REMEDIATION_STATUS.md`) are verified at the unit and pgTAP level.

---

## Addendum — 2026-09-07, later the same session: a real finding on `main` this audit initially missed

After the sections above were written, the sibling session (now idle, all
its agents done) reported and I **independently verified** a live defect on
`origin/main` itself:

**`npm test` — i.e. exactly what `.github/workflows/test.yml`'s
`node-tests` job runs — currently fails on a clean checkout of `main`
(`c5f75c7`).** `scripts/browser-check/install-dock-hit-test.mjs` (added in
`dc24b30`) matches Node's default `node --test` discovery glob
(`*-test.mjs`), so plain `node --test` from the repo root sweeps it in as a
unit test. It is a Playwright browser-check that needs a locally served
app; without one running it fails. Verified in a disposable
`git worktree add <tmp> origin/main --detach`, clean `npm ci`-equivalent
node_modules, no server running: **1321 tests, 1320 pass, 1 fail** —
matching the sibling's independently-obtained numbers exactly. This is
worse than an ordinary flaky test: it passed for every author because
their dev machine happened to have a static server already running on the
right port from other work, so it read green through the entire authoring
process and only turns red in a genuinely clean environment — exactly what
CI is.

**This means CI on `main` is red right now**, which blocks branch
protection (if enabled, per the still-NOT-VERIFIED item #16) from doing its
job on any subsequent PR, and is a materially worse "production readiness"
signal than anything else in this report.

**Already fixed, not yet merged:** `fix/audit-followups` (HEAD `e013bed`)
renames the file to `install-dock-hit-check.mjs` in commit `fdf8c85`
("Stop node --test running a browser-check and failing CI on main");
`run-all.mjs` discovers browser-check scenarios by directory listing, not
by this naming convention, so the scenario still runs there. Re-verified
this session on `e013bed`, clean: **`node --test` → 1367/1367, 0 fail.**
No migrations were added on this branch (`git diff --stat
origin/main...HEAD -- supabase/migrations/` is empty), so the 3096/3096
pgTAP result earlier in this report still applies unchanged — there is
nothing new for that suite to exercise.

**Resolved.** The user authorized the merge; by the time this session acted
on it, the sibling session had already merged and pushed
(`53a8106`, "Merge the audit follow-ups, and turn CI back green") in the
same shared working tree. Re-verified independently rather than trusted:
local `main` matches `origin/main` exactly at `53a8106`, the renamed file
(`install-dock-hit-check.mjs`) is present, and a clean `node --test` on
this exact pushed commit gives **1367/1367, 0 fail**. `main`'s CI is fixed
as of this commit. Score and `LAUNCH_CHECKLIST.md` item 4 updated
accordingly.

## What remains (honest, not padded)

1. **iOS Safari / Safari macOS / Firefox / Edge real testing** — no runtime
   available here. Do this before wide rollout; this is the biggest gap.
2. **GitHub Pages build/deploy mechanism and branch protection** — needs
   dashboard or `gh`-authenticated access this sandbox does not have.
3. **Production Vault secret state** for `recap-weekly` /
   `purge-abandoned-profiles` — needs someone with production SQL access to
   run `select name, decrypted_secret is distinct from 'REPLACE_ME' as set from vault.decrypted_secrets where name like 'edge_functions_%'`
   (adjust to the actual placeholder value used) or check the dashboard.
4. **Alert wiring** — `scheduled_job_health()` and the monitoring queries in
   `docs/ops/MONITORING.md` are correct and tested, but nothing pages a
   human. This needs an external cron/dashboard-alert integration.
5. **A real Supabase dashboard PITR restore test** — the dump-based restore
   was performed and verified 2026-09-06 (`REMEDIATION_STATUS.md`, OPS-1);
   Supabase's own point-in-time recovery mechanism is a separate system and
   remains untested.
6. **`fix/audit-followups` should not be merged until its own author
   confirms a final clean test run on their last commit** — not because
   this audit found a defect in it (it did not; every failure traced to
   in-progress work, and the final observed state was 1328/1328 green,
   22/23 browser scenarios green with the one failure explained), but
   because "was green while someone else was watching mid-edit" is not the
   same bar as "green on the commit that ships."

## Tests added this session

None added as new files. This session's contribution was **verification
depth**: running the full DB-from-empty + pgTAP suite fresh (not re-quoting
2026-09-06's numbers), running the full browser-check suite fresh, and
root-causing every failure observed rather than reporting a raw count. No
new gap in coverage was found that would justify a new test file — the
existing 1328 node:test cases + 3096 pgTAP assertions + 23 browser
scenarios already cover the areas this session touched. Where a real gap
exists (iOS Safari, dashboard config, Vault state), it is a testing
*environment* gap, not a missing test file, and adding a test that cannot
run here would not close it.

## Database verification summary

| Check | Result |
|---|---|
| `supabase db reset` (118 migrations, empty → full) | PASS, exit 0 |
| `supabase test db` | Files=90, Tests=3096, PASS |
| `check-deploy-readiness` vs local reset stack | READY, all 5 RPCs resolve |
| `check-migration-immutability` | OK |
| Migrations pending relative to `origin/main` | None (0) |
| Production schema vs `origin/main` | **In sync, re-confirmed twice on 2026-09-08.** First: migration `202609080003` applied to production, `supabase db push --dry-run` reported the remote up to date (run at `d300a1a`; `main` moved to `1e93e63` immediately after via a migration-free rename, checked directly via `git show --stat`, not assumed — conclusion still held). Second, later the same day: migration `202609080004` (the club-WOD-board restriction fix) — reported by the authoring session as applied via `supabase db push --linked`, then `check-deploy-readiness` READY, then a direct probe of all six `club_wod_*` RPC signatures returning `42501` (exists, correctly access-denied) rather than `PGRST202`, then `supabase migration list --linked` showing zero drift at 123 migrations, **only then** `git push origin main` — verified by comparing `git rev-parse` locally vs `origin/main` rather than trusting the push's exit code. Both reports are sourced and dated, not independently re-run by this audit, per the README's "never test against it" instruction. |

## Offline verification summary

Code-path and unit/integration-level verified (required-vs-optional asset
split in `sw.js`, IndexedDB-backed outbox with retry, idempotent RPCs).
Live browser offline-toggle behavior **NOT VERIFIED** this session.

## Sync verification summary

Idempotency for `post_create`, `add_post_comment`, `toggle_reaction`,
`chal_record_progress`, `event_rsvp` is enforced server-side via
`request_idempotency` / `idem_begin` (pgTAP-asserted, re-run this session as
part of the 3096-assertion pass — specifically `0080_write_idempotency_test.sql`,
32 assertions, ok). Client-side retry-on-`PGRST202` is documented and
tested (`LAUNCH_CHECKLIST.md` §2b). Real multi-tab / multi-device
concurrent-write races were not manually reproduced this session (would
require a live multi-client harness this sandbox does not have set up);
the server-side idempotency key design makes the specific failure modes in
§5 (duplicate posts/reactions/notifications on retry) structurally
prevented rather than merely untested, which is the stronger guarantee.

## PWA verification summary

Manifest, service worker required/optional asset split, and update flow
(`skipWaiting` deferred to an explicit `SKIP_WAITING` message +
`controllerchange` reload, not automatic) reviewed and match documented
intent in `sw.js`'s own comments. **Real install / second-launch /
update-while-installed behavior on a device: NOT VERIFIED.**

## Browser verification summary

Chromium: verified (23 browser-check scenarios, axe-core a11y sweep, dialog
keyboard/focus-trap suite, bidi/RTL geometry). Safari (iOS/macOS), Firefox,
Edge: **NOT VERIFIED** — no runtime available.

## Performance verification summary

Not independently re-measured this session (no evidence of new
regressions; prior audit's PERF-1/2/3 items are marked resolved and their
fixes — `.limit(200)`, debounce, `defer` on bundles — are still present in
the code read this session). Given "hundreds of members," and no new
heavy-query code path introduced since the last verified pass, this was not
re-run as a dedicated load test.

## Accessibility verification summary

Automated axe-core sweep re-run this session: 7/7 screens, 0 serious/
critical WCAG 2.2 AA violations, 24-26 rules passed per screen. Manual
screen-reader walkthrough **NOT VERIFIED** (no screen reader available in
this sandbox).

## Scheduled-job verification summary

All 10 jobs' `cron.schedule` calls read from migrations and cross-checked
against `docs/ops/MONITORING.md`'s own table. Production execution
(`cron.job_run_details`, all 10 active, `purge-due-accounts` confirmed
scheduled) was verified by the prior session on 2026-09-06 and not
independently re-queried against production by this session (no production
DB access from this sandbox, by design). Vault-gated jobs' actual secret
state: **NOT VERIFIED** (see P1 table).

## Privacy / deletion verification summary

`purge_due_accounts()` read, confirmed idempotent by construction, confirmed
independent of the Vault gap, confirmed scheduled. Not independently
re-executed against a seeded "due" row in this session (would require
seeding a local `account_deletion_requests` row with a past `purge_after`
and manually invoking the function — reasonable follow-up, not done here
for time; the pgTAP suite this session re-ran does exercise the DB-H1/H2/H3
findings that closed the FK-abort risk for this exact function).

## Backup / recovery verification summary

Dump-based restore: verified 2026-09-06, re-cited not re-performed (a
restore drill is expensive to repeat every audit pass and nothing changed
that would invalidate it — the schema only grew additively). Dashboard
PITR: **NOT VERIFIED**, unchanged.

## Production configuration verification summary

| Item | Status |
|---|---|
| `cloud-config.js` points at production project, no localhost/dev URL | **Verified** — read directly, matches `jajmlyrjlkhclgphbfbb` |
| No hardcoded secrets/service-role keys in repo | **Verified** — only publishable key + public VAPID key present, by design |
| `supabase/config.toml` password policy (10 chars, complexity) | **Verified in repo**; mirrored on the real dashboard — **NOT VERIFIED** (external) |
| GitHub Pages build source / branch protection | **NOT VERIFIED** (no `gh` access) |
| CAPTCHA dashboard configuration | Deliberately OFF, accepted risk per owner decision 2026-09-07 (`cloud-config.js:51-59`) — **verified as intentional**, not an oversight |
| Vault secrets for 2 of 10 cron jobs | **NOT VERIFIED**, see P1 |
