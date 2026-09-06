# Infrastructure & CI/CD Audit

Scope: `.github/workflows/`, `.githooks/`, `scripts/setup-hooks.mjs`, `supabase/config.toml`, `supabase/functions/`, deployment model.

Audited 2026-09-06 from a static checkout, branch `community/phase-0`. No live credentials, no dashboard access, no Docker, no Supabase CLI.

---

## 0. What infrastructure actually exists (and what does not)

**This app has no server, no container, no orchestration layer, and no IaC.** Stating that explicitly rather than inventing findings for it:

- **No Dockerfile, no docker-compose, no Kubernetes manifests, no Helm charts, no Terraform/Pulumi/CloudFormation** anywhere in the repo.
- **No application server.** The app is a build-free static site: `index.html` plus `app.js`, `cloud.js`, `sw.js`, `theme-init.js`, `vendor/supabase.js`, icons and a manifest, served as files. `README.md` confirms deployment to GitHub Pages at `haimuniya.github.io`, on its own path, sharing an origin with the production `haimunia-app` but with distinct IndexedDB name, localStorage prefix and Cache Storage name.
- **No reverse proxy, WAF, CDN config, TLS config or DNS config in this repo.** All of that is GitHub Pages' own, and none of it is expressible from here (there is no `CNAME` file and no `.nojekyll`).

The real infrastructure surface is therefore exactly three things:

1. **GitHub Actions** (`.github/workflows/test.yml`) — the only automation in the repo. §1.
2. **The Supabase managed project** — Postgres + Auth + Storage + Edge Functions + (as of `202609050005`) pg_cron/pg_net. §3.
3. **GitHub Pages hosting** — configured entirely outside the repo. §2.

---

## 1. GitHub Actions — `.github/workflows/test.yml`

One workflow, `test`, with three jobs. Read in full.

### Workflow-level configuration

```yaml
on:
  push:
  pull_request:
permissions:
  contents: read
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Assessment — **this header is well built**, and three separate things are right:

- `permissions: contents: read` is an explicit least-privilege token scope at workflow level. Without it the job would inherit the repository default, which on many repos is still read/write. Good.
- `concurrency` with `cancel-in-progress` prevents queue pile-up and superseded runs.
- `on: push` with no branch filter plus `on: pull_request` means every branch and every PR is covered — no path filters or branch filters that could let a change slip past the gate. (Minor cost: a PR from a branch in the same repo triggers both events and runs the suite twice.)

No `workflow_dispatch`, no `schedule`, no `pull_request_target` (good — `pull_request_target` is the dangerous variant and it is correctly absent).

### Job: `node-tests`

| Property | Value |
| --- | --- |
| Trigger | push, pull_request |
| Runner | `ubuntu-latest` |
| Steps | checkout → setup-node (22, `cache: npm`) → `npm ci` → `npm test` |
| `continue-on-error` | **absent — a failure genuinely blocks the job** |
| Secrets used | none |

`npm test` is `node --test`, running the 121 `.mjs` files under `test/`. Node 22 matches `engines: { node: ">=22" }`.

### Job: `browser-checks`

| Property | Value |
| --- | --- |
| Trigger | push, pull_request |
| Runner | `ubuntu-latest` |
| Steps | checkout → setup-node (22, `cache: npm`) → `npm ci` → `npx playwright install --with-deps chromium` → `node run-all.mjs` (all in `scripts/browser-check`) |
| `continue-on-error` | **absent — a failure genuinely blocks the job** |
| Secrets used | none |

`run-all.mjs` discovers checks from disk rather than a hardcoded list (its header records that a hardcoded list had silently stopped covering `roadmap.mjs`, `text-scale.mjs` and `benchmarks.mjs`), runs all 29 `.mjs` scenarios even after one fails, prints a PASS/FAIL summary, and exits non-zero if any failed. **That is exactly the right design for a gate** — it neither hides later scenarios behind an early failure nor swallows the exit code.

### Job: `migration-check`

| Property | Value |
| --- | --- |
| Trigger | push, pull_request |
| Runner | `ubuntu-latest` |
| Steps | checkout → `supabase/setup-cli` (`version: latest`) → `supabase start` → `supabase test db` |
| `continue-on-error` | **absent — a failure genuinely blocks the job** |
| Secrets used | none |

`supabase start` applies all 101 migrations in order against a throwaway local stack; `supabase test db` runs the 76 pgTAP files. The step comments in the workflow are unusually good and explain precisely why the pgTAP suite exists alongside the JS mocks ("the JS mock has no policy engine").

### CI findings

#### CI-1 (MEDIUM) — `supabase/setup-cli` is pinned by SHA but installs `version: latest`

```yaml
- uses: supabase/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520 # v3.0.0
  with:
    version: latest
```

The *action* is SHA-pinned. The *CLI it downloads* is not. `version: latest` means the Postgres image, the pgTAP version, and the migration-application semantics that gate every schema change can change under the project with no commit, on any given Tuesday. This is the one genuinely unpinned thing in the whole pipeline, and it sits on the job that validates the database.

Two distinct failure modes: a new CLI breaks the job (visible, annoying, self-correcting) — or a new CLI *relaxes* something and a migration that would previously have been rejected now passes (invisible, and exactly what a gate is supposed to prevent). Pin an explicit CLI version and bump it deliberately.

Related: `supabase/config.toml` sets `[db] major_version = 17` with a comment to keep it in sync with the real project, but nothing verifies that. If the live project is on a different major, CI is validating migrations against a Postgres the app does not run on. **Unverifiable from this repo checkout — requires running `show server_version;` against the live project.**

#### CI-2 (MEDIUM) — nothing in CI runs the two version-drift checks the project already wrote

`package.json` defines `check-version` (APP_VERSION vs SW_VERSION) and `check-vendor-version` (`vendor/supabase.js` vs `package.json`). Both exist, both work — I ran them, both pass (`APP_VERSION and SW_VERSION both 4.3.0`; `vendor/supabase.js matches @supabase/supabase-js@2.57.4`).

Neither is invoked by any workflow job. Their only enforcement is `.githooks/pre-commit`, which is opt-in and is **not enabled in this clone** (§4). So in practice both checks are unenforced. The pre-commit hook's own comment says these are "the two version-drift mistakes this project has actually made" — the checks were written in response to real incidents and are currently not running anywhere automatically.

Fix: two `- run: npm run check-version` / `- run: npm run check-vendor-version` lines in `node-tests`. Cheap, and it makes the checks real regardless of anyone's local git config.

#### CI-3 (MEDIUM) — no security scanning of any kind in CI

`.github/` contains exactly one file: `workflows/test.yml`. There is:

- no `dependabot.yml` — nothing watches for dependency advisories (see DEPENDENCY_AUDIT.md §7; this matters most for the browser-facing `vendor/supabase.js`);
- no `npm audit` step — the current clean audit result is a snapshot, not a gate;
- no CodeQL or any SAST;
- no secret scanning in CI, and none in the pre-commit hook either (§4);
- no `--ignore-scripts` on the `npm ci` calls.

For a repo whose *entire* deployment is "the files in the default branch become the live site", the absence of a secret-scanning gate is the one worth acting on: a committed key is live the moment it merges.

#### CI-4 (LOW) — no secret can leak from these logs, because no job uses a secret

Every `run:` step was checked for secret echo. There are none — no `${{ secrets.* }}` reference appears anywhere in the workflow, no `env:` block, no `printenv`/`env`/`set -x`, no `curl` with an inline token. All three jobs run entirely on public inputs.

This is a real positive and it follows from the architecture: the app has no build-time secrets (the Supabase publishable key is a committed public value in `cloud-config.js`, correctly), and there is no deploy job that would need a token. Recorded so a future reviewer knows it was checked rather than skipped.

The corollary is that this property is fragile: the moment a deploy job or a Supabase-linked job is added, it will need `SUPABASE_ACCESS_TOKEN` / service-role credentials and this section stops being true. Add masking discipline at that point, not after.

#### CI-5 (LOW) — no `continue-on-error` anywhere; no gate is silently defeated

Explicitly checked, since it was called out as a concern: the string `continue-on-error` does not appear in the workflow. All three jobs fail loudly. There are also no `|| true` suffixes and no `if: always()` steps that would mask a failure. **All three jobs are genuine gates.**

Whether they are *enforced* as gates on merge is a different question and is a repository setting, not a repo file — see §5.

#### CI-6 (INFO) — action pinning

| Action | Pin |
| --- | --- |
| `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` | full SHA, `# v4.2.2` |
| `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` | full SHA, `# v4.4.0` |
| `supabase/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520` | full SHA, `# v3.0.0` |

**All three third-party actions are pinned to a full commit SHA with a version comment.** This is the strongest available form of action pinning — stronger than tag pinning, which is mutable — and it is applied consistently with no exceptions. Genuinely above average practice.

The only unpinned artifact in the pipeline is the Supabase CLI binary itself (CI-1), and `npx playwright install` which resolves the browser build from the lockfile-pinned `playwright` version (1.62.1) — so that one is effectively pinned.

---

## 2. GitHub Pages hosting

Deployment model: **there is no deploy workflow.** Nothing in `.github/workflows/` publishes anything. GitHub Pages must therefore be configured in the repository settings as "deploy from a branch", which means **merging to the published branch is the deploy**, with no gate, no approval, and no rollback step other than a revert commit.

Consequences worth recording:

- CI runs on push and PR, but if Pages is set to deploy from a branch, the site updates when the branch updates — **the CI result does not stand between a commit and production** unless branch protection requires the checks. See §5.
- There is no build step, so there is nothing between the repo contents and the served bytes. `cloud-config.js` is served verbatim; the Supabase publishable key and VAPID public key in it are correctly public-safe (both are documented as such in the file, and the comment explicitly warns against ever adding a service-role key).
- Service-worker cache invalidation is handled by `SW_VERSION`/`APP_VERSION`, whose only sync check is the unenforced one from CI-2. A version-bump mistake here means returning users keep a stale app from cache — which is the exact incident the check was written for.

**Unverifiable from this repo checkout — requires GitHub repository admin access:**

- Pages source (branch vs. Actions), custom domain, and HTTPS-enforcement setting.
- Whether Pages is public or org-restricted.
- Any CDN/caching headers GitHub applies.

---

## 3. Supabase managed project

The second infrastructure surface. From the repo, three things are visible:

**Edge Functions** (`supabase/functions/`) — three, all Deno:

| Function | Auth gate | Secrets |
| --- | --- | --- |
| `recap_weekly` | `req.headers.get("Authorization") !== "Bearer " + serviceRoleKey` → reject | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` from `Deno.env` |
| `purge_abandoned_profiles` | same service-role bearer comparison | same |
| `admin_reset_password` | caller JWT forwarded to a Supabase client, admin-ness checked server-side | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` |

All three read secrets from `Deno.env` rather than hardcoding them — correct. Logging discipline is deliberate and good: every `console.error` logs a version tag and a category, never a user id, an email or a computed figure (`recap_weekly: generation failed for one member`, `purge_abandoned_profiles vN: run failed`). `admin_reset_password` logs `updateErr.message` and `auditErr.message`, which is the one place a Supabase error string could carry an identifier — worth a look, though Supabase admin-API errors are typically generic.

Note the two service-role functions gate on a **plain string comparison of the bearer token** against the service-role key. Functionally correct, but it is a non-constant-time comparison of a secret; a timing side channel here is largely theoretical over HTTPS with network jitter, but `crypto.subtle.timingSafeEqual`-style comparison costs nothing.

**Scheduling** (`supabase/migrations/202609050005_scheduled_jobs.sql`) — this is where infra crosses into schema. The migration enables `pg_cron` and `pg_net`, creates two **placeholder** Vault secrets (`edge_functions_base_url`, `edge_functions_service_role_key`), and schedules 8 cron jobs. The design is careful: `cron_invoke_edge_function()` reads both values from `vault.decrypted_secrets` at run time, **never** writes a real secret into a migration, refuses to fire while either value is still the committed placeholder (raising a `NOTICE` instead), and validates `p_slug` against `^[a-z][a-z0-9_-]{2,63}$` so the call cannot be redirected to another host. That is the right shape for secret handling in SQL.

The operational consequence: **until someone runs the two `vault.update_secret` calls on the live project, the `recap-weekly` and `purge-abandoned-profiles` jobs are silently inert.** They log a NOTICE and return NULL. Nothing alerts. **Unverifiable from this repo checkout — requires Supabase dashboard → Vault access to confirm the placeholders were replaced.** This should be an explicit pre-launch checklist item, because the failure mode is silence.

(Separately, `purge_due_accounts()` — the GDPR 30-day account purge — is not scheduled at all. That is a database finding; see DATABASE_AUDIT.md DB-H1.)

**Local/CI config** (`supabase/config.toml`) is clearly marked as local/CI-only, with the real project configured through the dashboard. Notable values that mirror production intent: `enable_anonymous_sign_ins = true`, `enable_confirmations = false`, `minimum_password_length = 6`, `password_requirements = ""`, `[api] schemas = ["public", "graphql_public"]` (correctly excluding `auth`, which the purge migration's header comment relies on), `max_rows = 1000`, storage `file_size_limit = "50MiB"`.

`minimum_password_length = 6` with no complexity requirement is weak, and the comment says it matches the real project. Whether that is acceptable depends on the recovery model (sign-in is invisible/anonymous-first per `README.md`), which the security stream owns — flagged here only because it is a config value, not code.

### Unverifiable from this repo checkout — requires Supabase dashboard/admin access

- Connection pooling mode and limits (PgBouncer/Supavisor), and whether the pool can absorb the 8 cron jobs plus Edge Function traffic.
- Backup schedule, retention period, and whether **point-in-time recovery is enabled**. Given DB-H3/DB-H4 in the database audit (member- and admin-reachable hard deletes that cascade), PITR is the only compensating control that exists, and its status is unknown. **This is the single most important unverified item in this document.**
- Whether `pg_cron` and `pg_net` are actually enabled on the live project (the migration's `create extension` assumes the Supabase image; a managed project may require dashboard enablement).
- Whether the two `edge_functions_*` Vault secrets hold real values or the committed placeholders.
- Whether the three Edge Functions are deployed at all, and at what version — nothing in CI deploys them.
- Auth settings on the live project: JWT expiry, refresh-token rotation, rate limits, allowed redirect URLs, CAPTCHA.
- Storage bucket public/private state on the live project. `202609060003` sets `avatar-photos` to `public = false` in a migration, but bucket state can also be changed from the dashboard.
- Log retention, alerting, and whether anyone is paged when a cron job or Edge Function fails.
- API/DB rate limiting and abuse protection.

### Unverifiable from this repo checkout — requires GitHub repository admin access

- **Branch-protection rules on `main`** — specifically whether the three CI jobs are *required* status checks. Without that, CI-5's "all three jobs are genuine gates" is true of the jobs but not of the merge. Given that merging is the deploy (§2), this is the difference between a tested deploy and an untested one.
- Required reviews, linear history, force-push and deletion protection.
- Repository Actions permissions (default `GITHUB_TOKEN` scope, whether forks can run workflows).
- Whether GitHub secret scanning / push protection is enabled on the repo.
- Environments, deployment protection rules, and who can trigger a Pages deploy.

---

## 4. Local git hooks — `.githooks/` and `scripts/setup-hooks.mjs`

`.githooks/` contains exactly one file, `pre-commit` (649 bytes):

```sh
set -e
echo "pre-commit: checking APP_VERSION/SW_VERSION are in sync..."
npm run check-version --silent
echo "pre-commit: checking vendor/supabase.js matches package.json..."
node scripts/check-vendored-supabase-version.mjs
```

`scripts/setup-hooks.mjs` does one thing: `git config core.hooksPath .githooks`.

**What the hooks actually do:** two version-drift checks and nothing else.

**What they do not do:** no secret scanning, no linting, no formatting, no test run, no commit-message validation. There is no `pre-push`, no `commit-msg`, no `prepare-commit-msg`.

Findings:

#### HOOK-1 (MEDIUM) — the hook is opt-in and is not enabled in this clone

`git config core.hooksPath` returns nothing here, so **`.githooks/pre-commit` is not running.** This is by design and the design is defensible — the script's own comment notes that `core.hooksPath` is a local, per-clone setting that is "never committed, never applied silently", which is the correct security posture (a repo that could silently install hooks would be a code-execution vector on clone).

But the consequence is that a check with two documented real-world incidents behind it is enforced nowhere: not by the hook (off), not by CI (CI-2). The fix is not to make the hook mandatory — it is to add the same two commands to CI, where they cannot be opted out of.

#### HOOK-2 (LOW) — no secret scanning at the commit boundary

Given that this repo (a) has no build step, (b) deploys by merge, and (c) legitimately commits public-looking key material in `cloud-config.js` (a Supabase publishable key and a VAPID *public* key, both correctly public), the risk of a real secret being committed by mistake is above average — the repo has already normalised "keys live in a committed JS file". A `gitleaks`/`trufflehog` pre-commit step, or GitHub push protection at the org level, would be a proportionate control. `cloud-config.js`'s own comment ("Never put a Supabase secret/service-role key in this repository") is currently the only enforcement, and it is a comment.

#### HOOK-3 (INFO) — `set -e` is present

The hook uses `set -e`, so a failing check actually aborts the commit rather than printing an error and continuing. Correct.

---

## 5. Summary — top findings

Ranked by what would actually change outcomes:

1. **Branch protection is unverifiable, and merging is the deploy.** With Pages deploying from a branch and no deploy workflow, the three CI jobs only gate production if they are configured as *required* status checks in repository settings. That setting cannot be read from this checkout. If it is off, a red build ships. Verify first, before any of the code-level fixes below.
2. **`supabase/setup-cli` installs `version: latest`** (CI-1). The one unpinned component in an otherwise SHA-pinned pipeline, and it sits on the job that validates all 101 migrations. Pin it.
3. **Two written, working version-drift checks run nowhere** (CI-2 + HOOK-1). `check-version` and `check-vendor-version` are enforced only by an opt-in pre-commit hook that is not enabled in this clone. Two lines in `test.yml` fixes it. The vendor check in particular guards the Supabase client that every user's browser executes.

Then: no dependency/secret/SAST scanning of any kind (CI-3); PITR and backup retention unknown while the schema has member-reachable cascading hard deletes (§3); and the two Edge Function cron jobs are silently inert until Vault placeholders are replaced on the live project (§3).

**What is genuinely good and should not be regressed:** all three actions SHA-pinned; `permissions: contents: read` at workflow level; no `continue-on-error` and no `|| true` anywhere; no secrets in any job, so no log-leak surface; `run-all.mjs` runs every scenario and reports honestly; `npm ci` with committed lockfiles in both projects; and the Vault-based secret handling in the scheduler migration, which keeps real credentials out of SQL entirely.
