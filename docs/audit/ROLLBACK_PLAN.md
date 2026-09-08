# Rollback plan

This app has no build step and no deploy pipeline (`package.json`:
"Production remains build-free"): the client is static files served by
GitHub Pages, the database is a separately-migrated Supabase project, and
nothing structurally forces them to move together. That absence of a
pipeline is exactly what makes rollback something that has to be planned
explicitly rather than assumed — "redeploy the last good build" is not one
button here.

## 1. Frontend rollback (`index.html`, `app.js`, `cloud.js`, `sw.js`, etc.)

**Mechanism:** GitHub Pages serves whatever `main` currently contains (exact
build source — branch vs. Actions artifact — is `docs/audit/LAUNCH_CHECKLIST.md`
item #15, NOT VERIFIED from this sandbox; confirm before relying on the
exact steps below).

**To roll back:**
1. `git revert <bad-commit>` (preferred over `git reset --hard` + force-push,
   which rewrites history other clones/sessions may already have pulled) —
   or, if several commits need undoing at once, revert the merge commit
   with `git revert -m 1 <merge-sha>`.
2. Push the revert commit to `main` through the normal path (PR + CI green,
   per branch protection — item #16 in `LAUNCH_CHECKLIST.md`).
3. **Check whether the database moved in the same release.** If the bad
   frontend deploy shipped alongside new migrations that added required RPC
   parameters or renamed a signature, reverting the frontend alone is
   enough **only if** the previous client version's calls still resolve
   against the *current* (not yet rolled back) schema. Verify with:
   ```
   node scripts/check-deploy-readiness.mjs <url> <anon-key>
   ```
   against production, using the *rolled-back* client's expected RPC set.
   If it reports NOT READY, the database also needs to roll back (§3) or
   the migration needs a compatibility shim before the frontend can safely
   go back — **do not revert the frontend alone in that case**, it will
   just move the PGRST202 failures from "new client, old schema" to "old
   client, newer schema" instead of fixing them.
4. Confirm the live site: `curl -sI https://<pages-url>/app.js` (or open
   it) shows the expected `APP_VERSION` — check
   `grep 'const APP_VERSION' app.js` locally against what loads live.

**Database changes make frontend rollback unsafe exactly when:** a
migration in the bad release changed an RPC's parameter set (PostgREST
resolves overloads by the exact named-argument shape — this has broken
things before in this repo, see `LAUNCH_CHECKLIST.md` §2b's own account of
the 5-signature change that shipped in the last major release) or dropped/
renamed a column the older client reads directly. Always run
`check-deploy-readiness` against the *target* schema state before
confirming a frontend-only rollback is sufficient.

## 2. Service worker rollback

The service worker is the one component with its own built-in safety net:
a bad `sw.js` deploy does not necessarily need a rollback to stop hurting
users, because:

- `skipWaiting()` is **not** called on install (deliberate, see `sw.js`'s
  own header comment) — a new worker parks in `waiting` and does not take
  over until the client posts `SKIP_WAITING` (on the user tapping the
  update banner) and the page reloads on `controllerchange`. **A bad new
  worker sitting in `waiting` cannot yet do damage** to a client that
  hasn't accepted the update.
- If a bad worker *has* already activated (someone already accepted the
  update banner): revert `sw.js` in the same way as §1, and bump
  `SW_VERSION` (`npm run sync-version`) so the cache name changes
  (`haimunia-demo-v${SW_VERSION}`) — this is what makes the fixed worker
  actually supersede the bad one rather than being seen as "already
  installed, nothing to do."
- **A corrupt service worker deployment** (fails to install, e.g. a
  `REQUIRED_ASSETS` fetch failing due to a bad path) fails closed by the
  Service Worker spec's own behavior: the *old* worker and its cache stay
  in control. Confirm this is actually happening (check
  `navigator.serviceWorker.controller` in devtools on an affected client)
  before assuming a rollback is even necessary — it may self-heal once the
  fixed file is pushed, since the failed install never replaced anything.
- After reverting: confirm via `sw-precache.test.mjs` locally
  (`node --test test/sw-precache.test.mjs`) before pushing, since this is
  exactly the class of bug that test exists to catch mechanically.

## 2a. Hazard specific to this repo's shared-working-tree setup: `supabase db push` reads the filesystem, not git

Found and reported by a sibling session, 2026-09-08, after it nearly shipped
another session's unmerged migrations to production: **`supabase db push`
reads whatever is physically in `supabase/migrations/` on disk — it does
not know or care what git branch is checked out, or whether those files
are committed.** In a shared working tree with multiple sessions on
different branches, the folder can (and did, that day) contain migrations
that exist only on someone else's unmerged feature branch. The reporting
session's own words: "the dry run listed three migrations when only one
was on `main`."

**Rule, unconditionally:** always `supabase db push --linked --dry-run`
first and actually read the listed migration filenames before the real
push — never push on the strength of "I'm on the right branch" alone,
because in this setup you might not be, or something might have been
un-committed back into the folder by another session since you last
checked. The safer alternative when in doubt: push from a disposable
`git worktree add <tmp-dir> origin/main --detach` (used successfully
several times this session for read-only verification) rather than the
shared checkout, so the filesystem state is guaranteed to match a specific
git ref.

## 3. Database / migration rollback

**There is no `supabase migration down` used in this repo's normal
workflow** — migrations here are additive or policy-swap by convention
(confirmed by reading `REMEDIATION_STATUS.md`'s own claim: "every migration
this pass is additive or policy-swap, and each documents its own one-line
reversal"). The actual rollback mechanics:

1. **Never edit an applied migration file.**
   `scripts/check-migration-immutability.mjs` (run in CI) rejects this, and
   Supabase tracks migrations by filename — an edit diverges local/CI from
   production silently even if the check didn't exist.
2. **Write a new, forward-only migration that reverses the effect** — e.g.
   `drop policy ...; create policy ... (the old predicate)`, or
   `alter table ... drop column ...` for an additive column that turned out
   to be wrong. This is the same pattern `docs/ops/INCIDENT_RESPONSE.md`
   prescribes for a leaking RLS policy under live-incident conditions.
3. **Before writing that migration, take a dump:**
   ```
   supabase db dump --linked -f rollback-pre-<date>.sql
   ```
   This is what makes the situation recoverable if the reversal migration
   itself has a problem.
4. **Apply and verify:**
   ```
   supabase db push --linked --dry-run   # confirm exactly the expected migration(s)
   supabase db push --linked             # apply
   supabase migration list --linked      # confirm pending: NONE
   node scripts/check-deploy-readiness.mjs <prod-url> <prod-anon-key>
   ```
5. **If the bad migration already destroyed data** (not just a bad
   policy/function), this is no longer a rollback, it's the restore
   procedure — see §5. A migration that ran a destructive `DELETE`/`DROP`
   against real rows cannot be undone by a compensating migration; the data
   is gone unless it's in a backup.
6. **RLS-specific rollback caution:** tightening a policy is always safe to
   revert quickly. *Loosening* a policy that turns out to be wrong is the
   dangerous direction — treat any such migration as needing the same
   dump-first discipline as a destructive one, since the exposure window
   is live between deploy and detection.

### 3a. Worked example: a fix that shipped before the bug could fire (2026-09-08)

`purge_abandoned_profiles` had a real data-loss defect: `private_records`
(the offline training log) cascades from `auth.users`, and the purge's
abandonment predicate never excluded a user with real logged workouts — a
member who used the app locally and never joined the community would have
had their entire training log deleted on day 31. This is exactly the class
of bug §3's "if the bad migration already destroyed data, this is no
longer a rollback, it's the restore procedure" warns about. It was found
and fixed (migration `202609070001`, `PURGE_VERSION` bumped to 2 so a run
under the old rule is distinguishable from one under the new rule in its
own logs) and deployed to production; no restore was needed regardless.
**Correction, 2026-09-08:** an earlier version of this entry said the bug
was "armed, then fixed within 5 minutes" of the Vault secrets being set.
That overstated what was actually proven — the claim that the secrets were
"set" rested on a check that can't distinguish a real value from the
committed placeholder (see `LAUNCH_CHECKLIST.md` item 19). What's actually
verified: **the buggy code path was live in the deployed function, and the
guard closed it**, whether or not the scheduler could reach the Edge
Function at that specific moment is unverified from this sandbox. **The
lesson for this rollback plan stands regardless of that correction:** a
job that has existed but never (confirmed) run is not proven safe by "it
hasn't caused a problem yet" — its logic needs re-review at the moment it
is actually enabled, not just at the moment it was written, and "the
secret exists" is not the same claim as "the secret has a real value" —
check the latter, always. Reported by a sibling session; not independently
re-queried against production by this audit (no production access from
this sandbox).

## 4. Edge Function rollback

Three functions: `recap_weekly`, `purge_abandoned_profiles`,
`admin_reset_password`.

1. `supabase functions deploy <name>` re-deploys whatever is in
   `supabase/functions/<name>/index.ts` in the working tree at the time —
   there is no separate Edge Function version history to "roll back to"
   other than git history of that file.
2. To roll back: `git checkout <good-commit> -- supabase/functions/<name>/`
   (on a clean, non-shared working tree — see the coordination note in
   `PRE_LAUNCH_AUDIT.md` if working in a shared clone), then
   `supabase functions deploy <name>`.
3. Each function has its own `deno.lock` — CI's `edge-function-lockfiles`
   job (`deno cache --frozen --lock=deno.lock index.ts`) will fail the
   build if the rolled-back file's import graph no longer matches the
   lockfile. Regenerate with `deno cache --lock=deno.lock --lock-write
   index.ts` if genuinely intentional, otherwise this failure is a useful
   signal that the rollback pulled in an unexpected dependency change.
4. **Bad deploy impact is bounded by design:** both `recap_weekly` and
   `purge_abandoned_profiles` are invoked only by `pg_cron` via
   `cron_invoke_edge_function()`, never reachable by a normal client
   request — a broken deploy fails the next scheduled invocation (visible
   in `scheduled_job_health()` and Edge Function logs), not live user
   traffic. `admin_reset_password` **is** reachable by an admin action; a
   broken deploy there fails password resets until rolled back — treat as
   higher urgency than the other two.

## 5. Full restore from backup (last resort, data already lost)

1. **Stop writes first** — a restore racing live traffic makes it worse
   (`docs/ops/INCIDENT_RESPONSE.md` §"Data loss").
2. Supabase dashboard → Database → Backups → restore to a **new**
   project/branch, never in place over the live one, so the restored data
   can be compared before cutover.
3. The dump-based path (`~/haimunia-backups/`, per
   `REMEDIATION_STATUS.md`'s 2026-09-06 drill) is independently verified to
   restore cleanly (0 errors, full schema + data, functional RLS) — this is
   the path actually rehearsed. Supabase's own dashboard PITR has **not**
   been rehearsed (`LAUNCH_CHECKLIST.md` #23, NOT VERIFIED) — if that is
   the path used in a real incident, budget time to discover its exact
   behavior for the first time under pressure, which is not ideal, and is
   the reason this item is flagged rather than assumed equivalent to the
   tested path.
4. Before cutting traffic to the restored database, re-run
   `check-deploy-readiness` against it and `supabase test db` if time
   allows — a restore is a schema state like any other and deserves the
   same verification before it takes live traffic.

## 6. Configuration rollback

`cloud-config.js` is committed and public by design (publishable key +
public VAPID key only — see the file's own header comment). Rolling back a
bad config change (e.g. an accidental wrong project URL) is a normal
`git revert` on that one file, same as §1 — there is no secret material in
it to rotate.

## Sequencing summary — what to roll back first

| Scenario | First action | Then |
|---|---|---|
| Bad frontend only, schema unaffected | Revert frontend (§1) | Confirm with `check-deploy-readiness` |
| Bad migration, no data loss yet | Dump (§3.3), write reversal migration (§3.2) | Re-verify with pgTAP + `check-deploy-readiness` |
| Bad migration + frontend shipped together, incompatible | Dump, reverse the migration **first** | Only then confirm/revert frontend — do not leave a client calling a signature that no longer exists |
| Data already destroyed | Stop writes | Restore from backup (§5), not a migration reversal |
| Bad Edge Function | Redeploy previous file version (§4) | Check `scheduled_job_health()` / Edge Function logs for the next scheduled run |
| Bad service worker already activated on clients | Revert + bump `SW_VERSION` (§2) | Confirm via `sw-precache.test.mjs` before pushing |
