# Session handover — 2026-09-08

Written for whoever (human or Claude session) picks this up next. This
repo is being worked on by **multiple concurrent Claude sessions sharing
one working tree** — read the "Active sibling sessions" section before
running anything, especially anything destructive.

## What this session actually did

1. Ran a full pre-production audit (`docs/audit/PRE_LAUNCH_AUDIT.md`,
   `LAUNCH_CHECKLIST.md`, `TEST_MATRIX.md`, `ROLLBACK_PLAN.md` — all new
   this session). Verdict: **CONDITIONAL**, score 78/100 as of 2026-09-07.
   Zero P0/P1 open inside the repo; remaining gaps are external
   (dashboard/device access this sandbox doesn't have) plus one real FAIL
   (alert wiring, since closed — see below).
2. Found and independently verified a live CI-breaking bug on `main`
   (`install-dock-hit-test.mjs` matching Node's default test glob) —
   already fixed and merged by the time it mattered.
3. Wrote `docs/audit/GO_LIVE_GUIDE.md` — the ordered, actionable "what to
   do before real members go in" doc. **This is the one file to hand the
   human user directly** if they ask "what's left."
4. Built and locally tested the alert-wiring piece from that guide:
   `scripts/check-scheduled-job-health.mjs` +
   `.github/workflows/scheduled-job-alert.yml`. Needs three GitHub repo
   secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ALERT_WEBHOOK_URL`) to go live — no code work remains, and it has a
   documented, deliberate blind spot (see its own header comment) around
   VAULT-1 that a future session should close properly via a new migration
   exposing `net._http_response`, not by editing the existing one.
5. Reviewed (not executed) the open Dependabot bump for
   `@supabase/supabase-js` (2.57.4 → 2.115.0) — real behavioral changes
   exist (realtime protocol v2, a Storage API rename, GoTrueClient locking
   change); recommend doing it as its own isolated, fully-tested PR.
6. Coordinated extensively with two sibling sessions
   (`haimunia-app-demo-publish-6d`, `-a1`) sharing this working tree —
   caught and corrected an overstated claim about Vault secrets before it
   went into the permanent record, and had a similar blind-spot caught in
   my own alert script by the sibling in return. Both corrections are
   already folded into the docs above; the exchange is a useful model for
   how this multi-session setup is meant to work (verify before recording,
   correct in the open, don't just trust a peer's summary).

## What's still queued, blocked on a file lock

- **`deleteMeasureType` needs a delete confirmation** (app.js, training
  log) — the fix pattern to follow is already identified (`8afbc57`'s
  `askAppConfirm` `{subject}` token, name the count of measurements that
  would be deleted). **Blocked**: `app.js` has been actively edited by
  `haimunia-app-demo-publish-6d`'s agent all session. Pick this up once
  they signal it's free.

## Active sibling sessions as of this writing — check `ListAgents` for current state, this snapshot will go stale fast

| Session | State (last seen) | What it's doing |
|---|---|---|
| `haimunia-app-demo-publish-6d` | busy | Building the club-WOD-board client in `cloud.js`; has touched `app.js` too (currently diagnosing 4 test failures there); reserving `index.html` (feed-card markup still to land). Has been the primary coordination partner this session — reliable, self-correcting, verifies before asserting. |
| `haimunia-app-demo-publish-a1` | busy | A read-only Playwright screenshot tour for a design handoff (mock backend only, never production) — explicitly instructed not to modify tracked files. Left some `tmp-shot-*.mjs` scratch files under `scripts/browser-check/` — not reviewed by this session, presumably cleanup-pending on their end. |
| `pre-release security audit` | busy (background) | Not in contact this session; shown busy in `ListAgents`. |
| `haimunia-app-demo-publish-c1` | idle | Not in contact this session. |

**Working tree is currently dirty** (as of this write): `app.js`, `cloud.js`
modified (both `-6d`'s in-flight work), plus three test files
(`community-destructive-symmetry`, `community-inline-compare`,
`community-state-namespaces`). **Do not run `git reset`, `git checkout <path>`,
`git restore`, `git stash`, or `git clean`** while any of that is dirty —
this exact hazard destroyed a completed pass earlier in the branch's
history (per `-6d`'s own account). If you need a clean baseline to compare
against, use a disposable `git worktree add <tmp-dir> <ref> --detach`
instead — used successfully several times this session with zero risk to
the shared tree.

**Current branch:** `feat/feed-writes-itself` (not `main` — `main` was
merged/pushed earlier this session at `53a8106`, then moved further ahead;
current `main`-equivalent history includes at least `0e97746` and `cc33dfc`,
both critical — see below).

## Two commits from this session's tail that matter a lot — read these before trusting anything about account deletion or Vault

- **`cc33dfc` "Vault secrets are set; the jobs are not yet proven"**
  (2026-09-08 06:55) — sets the two Vault secrets `recap-weekly` /
  `purge-abandoned-profiles` need, and **deliberately does not claim this
  is resolved**, for exactly the reason this audit flagged: a job reports
  `succeeded` whether or not it actually reached its Edge Function.
  Closes only once a scheduled run is observed healthy
  (`purge-abandoned-profiles` daily 03:31 UTC, `recap-weekly` Mondays
  05:11 UTC) — check `net._http_response` after either has passed.
- **`0e97746` "Merge urgently: stop the purge job deleting members'
  training logs"** — a real, serious data-loss bug, corrected mechanism
  from what was first reported to this session: cloud backup opens an
  anonymous `auth.users` account **silently** on a member's first saved
  set, so any offline-only member who ever logged one workout already
  meets part of the "abandoned account" predicate; `private_records` (the
  entire offline training log) cascades from `auth.users`; the purge never
  excluded a user with real data. Because the Vault secrets were set at
  06:55 the same morning and this job runs daily at 03:31 UTC, **the bug
  was genuinely live-armed for part of a day** — the fix was deployed to
  production ahead of its own git merge because of that window. Fixed:
  an account holding any training data is now excluded outright,
  permanently. Verified per the commit: pgTAP 91 files/3127 assertions,
  `npm test` 1471/1471. **Explicitly still open per the commit's own
  words**: `PRIVACY.md`/`privacy.html` (both languages) still describe the
  old behavior, and a test asserts that stale copy — needs to ship
  together, hasn't yet.

Both are folded into `LAUNCH_CHECKLIST.md` (items 19 and 25) and
`GO_LIVE_GUIDE.md`'s open-items list already. Flagging again here because
they're the single most safety-relevant facts from this whole session and
easy to miss buried in a 250-line checklist.

## Recommended next actions, in order

1. If you're a Claude session: check `ListAgents` for current sibling
   state before touching `app.js`, `cloud.js`, or `index.html` — this
   handover's snapshot above will be stale by the time you read it.
2. Pick up `deleteMeasureType` once `app.js` is free (see above).
3. Ship the `PRIVACY.md`/`privacy.html` copy fix for the abandoned-account
   purge behavior change (`0e97746`'s "still to follow").
4. If you're the human user: the concrete, external, non-code actions are
   all in `docs/audit/GO_LIVE_GUIDE.md` §A — a ~15-minute real-phone smoke
   test, a few dashboard checks, and three GitHub secrets for the alert
   workflow already built.
5. Don't close VAULT-1 in any doc until a scheduled run is actually
   observed healthy in `net._http_response` — see `cc33dfc`'s own stated
   closing condition above.
