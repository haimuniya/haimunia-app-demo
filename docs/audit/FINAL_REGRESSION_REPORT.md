# Final regression report

Covers both passes: the initial audit and the remediation pass that
followed. The headline is that the remediation pass ran the suites the
first pass could not, and **that run found nine real defects**.

## Final state — all three suites, final tree

| Suite | Command | Result |
|---|---|---|
| Node / jsdom | `npm test` | **1156 tests, 1156 pass, 0 fail, 0 skipped** |
| Database | `supabase db reset && supabase test db` | **85 migrations applied from empty, exit 0; Files=83, Tests=2826, Result: PASS** |
| Browser (real Chromium) | `cd scripts/browser-check && node run-all.mjs` | **29/29 scenarios, exit 0** |
| Dependencies | `npm audit --audit-level=high` (root + browser-check) | 0 vulnerabilities in both |
| Version sync | `npm run check-version` | APP_VERSION = SW_VERSION = 4.4.0 |
| Vendored bundle | `npm run check-vendor-version` | version + sha256 match; **tamper-tested** |
| Migration immutability | `node scripts/check-migration-immutability.mjs` | OK |

Baseline at the start of the remediation pass: 1108 node tests (1 skipped),
pgTAP never executed, browser suite intermittently failing.

## Defects found by running the suites

These are the return on actually executing, rather than reasoning about,
the work. Each was invisible to static review.

### From the first `supabase test db`

1. **A re-typed RLS policy dropped its feature-flag gate.**
   `member_achievements_read` was reproduced from memory during the first
   pass and lost `and public.club_feature_enabled('achievements')` — so a
   club that switched the achievements module off would still have had every
   member's achievements readable. Caught by `0055_club_features_test`
   (tests 20-21). Fixed by copying the policy instead of re-typing it, with
   a comment saying so.
2. **A new guard trigger preempted RLS.** `clubs_guard_single_row` raised
   before the RLS `WITH CHECK` ran, so a plain member attempting to insert a
   club got a `P0001` explaining the schema's multi-tenancy internals
   instead of a plain `42501`. Caught by `0001_clubs_and_rbac_test` (test 5).
   Fixed by deferring to RLS for anyone RLS would refuse anyway.
3. **A migration named a table that does not exist.** `public.person_invites`
   is the *filename* slug; the table is `public.invites`. The migration would
   have failed outright on first apply.

### From the second run

4. **SEC-002 was not exploitable.** The security audit predicted an author
   could `PATCH status/deleted_at` to undo a moderator's removal. Running it
   proved otherwise: PostgreSQL applies SELECT policies to an
   `UPDATE ... WHERE`, and no policy shows a removed post to its author, so
   the statement matches zero rows. Probe output:
   `visible rows to m1 for update: 0` / `UPDATE 0`. Recorded as **disproven
   with evidence** in `SECURITY_AUDIT.md` and `REMEDIATION_STATUS.md`, not
   quietly dropped. The guard trigger is retained as defense-in-depth, and
   SEC-005 — which the same trigger closes — **is** live and exploitable.
5. **One of my own tests asserted a bypass RLS already prevents** (an admin
   updating another member's post). Rewritten to test the pin on the admin's
   own post, which is what it was actually for.

### From the browser suite

6. **The password-policy change broke two scenarios' fixtures.**
   `"new-member-password"` has no uppercase and no digit. Caught before
   merge, not after.
7. **A completed invite redemption could strand a member permanently.**
   `redeemCode()` calls an RPC that *consumes* the code, then decides what to
   render from a follow-up read. One failed or racing read left the invite
   form on screen — and re-submitting the now-spent code returns "invalid".
   The account could not proceed, with no error shown. Fixed with a bounded
   retry plus an explicit error state.
8. **A background render silently erased the invite code being typed.**
   This app re-renders by replacing `#content`'s innerHTML wholesale;
   `maybeAutoStartBackup()`'s "your workouts are backed up" message fires on
   the member's first local write and, on a cold start, landed between the
   keystrokes and the submit — replacing the form with an empty one. The
   member then submitted nothing and was told the code was required.

   **This was the "flaky under CPU contention" browser failure the suite had
   carried for weeks.** It was neither flaky nor contention. Method: A/B
   against a pristine `HEAD` worktree (reproduced 1-in-4 there, so not a
   regression), then instrumenting the mock client to record every RPC —
   which showed `redeem_invite_code` was **never called** on a failing run.
   Fixed by keeping the code in `state.ui.inviteCodeDraft`, the same pattern
   the file already uses for comment drafts and report notes.

   Verification that it is genuinely fixed, not masked: raising the timeout
   to 25 s did **not** help (proving "stuck", not "slow"); after the fix the
   scenario passes 4/4 and the full suite passes 29/29 twice.

### From my own new pgTAP file

9. **A wrong assumption in a test I wrote.** I asserted a blocked member
   cannot see the block edge. They can — `blocks_self_select` names both
   sides explicitly and `cloud.js:3570` reads the table in both directions,
   because a block must be mutual in effect. The code was right; the test
   was corrected to assert the real, intended behaviour and to say why.

## Deliberate behaviour changes, and the tests updated for them

Four existing pgTAP tests failed because a product decision changed the
behaviour they asserted. Each was updated with the reasoning, not weakened:

| Test | Was asserting | Now asserts |
|---|---|---|
| `0037_attendance_log` | a plain coach can read any member's raw attendance, "what COMM-304's decline detection needs" | a coach cannot — and the stated justification was checked and found false, since every coach-facing aggregate is SECURITY DEFINER and bypasses the policy |
| `0030_announcement_priority_expiry` (7 assertions) | a coach editing an **admin-authored** announcement | the author performs the edit; the authorization boundary itself moved to `0079`, which covers it directly |
| `0063_scheduler_reports_and_retention` (2) | `feed-weights-recompute` is scheduled | it is **not** — the function is a documented no-op stub, and a green weekly cron row for an unbuilt feature is worse than none |
| `0064_deletion_requests…` | a removed member still reads the challenge board | they do not — SEC-001's gate, and a soft-deleted pending-purge account is the sharpest case for it |

Six node tests were also updated where a source-text assertion named a call
shape that moved (`client.rpc(...)` → `communityRpc(...)`, bare auth calls →
`withCaptcha(...)`, `<script src>` → `<script defer src>`). In every case the
property under test was preserved and the assertion was re-pointed, not
loosened — and where an indirection was introduced, an extra assertion was
added proving it still reaches the same underlying call.

## Test suite growth

| | Before | After |
|---|---:|---:|
| Node tests | 1108 (1 skipped) | **1156 (0 skipped)** |
| pgTAP files / assertions | 79 / 2747 | **83 / 2826** |
| Browser scenarios | 29 (intermittent) | **29 (deterministic)** |

New coverage: the community outbox lifecycle (14), write idempotency (32),
CAPTCHA (8), the invite-code bugs (6), `member_roles` + `report_profile_target`
(7 — the two zero-coverage surfaces all three P1 client bugs lived in),
`app.js` innerHTML sinks (4), a11y structure (5), contrast (3 added), and
foundation-era RLS (17, including the first direct cross-member read test on
`private_records`, the full training log).

## Confidence

High. Every claim in this report corresponds to a command whose output was
read. The database work is verified against real PostgreSQL 17.6 rather than
hand-checked; the browser suite is deterministic rather than "usually
green"; and the one finding that turned out to be wrong is recorded as wrong
with the evidence that disproved it.

The remaining unverified items are named in
`PRODUCTION_ACCEPTANCE_CHECKLIST.md` and every one of them requires access
outside this repository.
