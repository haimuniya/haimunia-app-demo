# Agent reports — 2026-09-10 lead-auditor pass

This file documents *this pass only*. It does not restate the extensive
prior-session findings in `SECURITY_AUDIT.md`, `DATABASE_AUDIT.md`,
`REMEDIATION_STATUS.md`, etc. — those were re-verified, not re-derived. See
`EXECUTIVE_SUMMARY.md`'s 2026-09-10 section for the reconciled result.

## Why this pass looked different from a from-scratch audit

The repo entering this pass already carried a 91/100-scored, pgTAP-verified,
production-deployed audit trail (`docs/audit/*`, dated 2026-08-27 through
2026-09-08) plus a separately-QA'd visual redesign (`docs/visual-qa/`,
2026-09-09, 1512/1512 tests, 72 visual-QA cases, 0 axe issues). Spinning up
a fresh 10-agent audit team to re-derive all of that from zero would have
burned significant time to re-confirm work that was already done rigorously
and honestly (including three self-corrections logged in
`SESSION_HANDOVER.md` from sessions catching their own and each other's
overclaims). The higher-value use of a lead auditor here is: verify the
current tree state fresh, red-team only the parts that changed or are
newest, and refuse to launder any external gap into a false PASS.

## Direct verification (lead, not delegated)

Run directly against the current working tree (which started this pass
with an uncommitted redesign diff, committed and pushed to `origin/main` as
`9735838` partway through by another actor sharing this working tree — see
below), not from a report:

- `npm test` — first run 1511/1512 (1 unexplained fail, output truncated by
  my own `tail`), immediate clean rerun **1512/1512, 0 fail**.
- `supabase test db` against a live local Postgres 17.6 stack (Docker,
  already running) — **Files=94, Tests=3265, PASS**, all 124 migrations.
- `scripts/browser-check/run-all.mjs` (real Chromium via Playwright) run
  concurrently with the above — 34/35, one trip-wire (`community-render-cost.mjs`)
  failed at 18.6ms vs a 16ms budget. Re-ran in isolation: **5.3ms** — the
  concurrent run was CPU-contended, not a regression. Recorded as
  contention, not a defect.
- `npm run check-version`, `check-vendor-version`, `check-migration-immutability`,
  `npm audit --audit-level=high` — all clean.
- Manual sweep: `grep` for secret patterns, TODO/FIXME/HACK/XXX, `.skip(`/`.only(`,
  ungated `console.log` — all clean, nothing found.
- Read the full `git diff` (app.js/index.html/sw.js, 43 insertions/9
  deletions, uncommitted at read time) line by line — version bump, a
  `bestPerDay()` chart-dedup fix, a history-list auto-expand fix, a
  flexbox min-width/ellipsis fix. No security, RLS, auth, or data-layer
  surface touched. This diff was committed and pushed to `origin/main` as
  `9735838` later in this pass by another actor, not this session — the
  content matches exactly what was already reviewed here.
- Checked a specific item named "still queued, blocked on a file lock" in
  the 2026-09-08 `SESSION_HANDOVER.md` (`deleteMeasureType` needed a delete
  confirmation) — found it already resolved in `d11aa9b` ("Ask before
  deleting a measure type, and give it the same undo everything else
  gets"): `askDeleteMeasureType()` now names the type and the exact count
  of measurements that will be deleted with it before calling
  `deleteMeasureType()`, which still also offers a few seconds of undo
  afterward. No action needed.
- Read `docs/audit/GO_LIVE_GUIDE.md` and `LAUNCH_CHECKLIST.md` end to end
  and reconciled them against `REMEDIATION_STATUS.md` (some rows there
  claim later resolution dates than the checklist reflects) — see the
  addendum added to `LAUNCH_CHECKLIST.md` rather than silently picking one
  version as correct.

## Delegated: independent red-team fork (agent, not lead)

**Scope given:** review the 10-15 newest Supabase migrations and all 3 Edge
Functions, explicitly instructed to distrust the existing audit docs'
"no unresolved defect" claim and try to disprove it. Independent — not
shown the lead's findings first.

**Findings:** reviewed the 13 newest migrations (`202609060022` through
`202609080005`) and `admin_reset_password` / `purge_abandoned_profiles` /
`recap_weekly`. Confirmed RLS present and correctly gated wherever
applicable, `search_path` pinned on every SECURITY DEFINER function
reviewed, no `USING (true)` on a sensitive table, no client-controlled
ownership (one function explicitly probes a client-supplied ID against the
caller's own rows rather than trusting it), and `timingSafeEqualStrings`
genuinely present in the Edge Function code (not merely claimed in a doc).
**Zero confirmed concerns. No exploit scenario could be constructed.**
Explicitly did not review migrations older than `202609060022` (already
covered by the prior pass's pgTAP counts) or attempt a live exploit request
against the running PostgREST instance (static review only).

## Conflicts between agent and lead

None. The fork's findings agreed with — and added independent evidence for
— the standing "no unresolved P0/P1" conclusion already on record.

## Decision deferred to the user, and the answer

Asked whether to run read-only verification queries against the linked
production Supabase project (`jajmlyrjlkhclgphbfbb`) to try to close two
ambiguous checklist rows (scheduled-job health, branch-protection
enforcement) — this session has working `supabase` CLI credentials for it.
**The user chose not to.** Both rows remain exactly as last recorded, not
asserted in either direction. This was the correct call to defer: touching
live production state is a decision for whoever holds the account, not
something to default into because the tooling happened to be available.

## Areas not touched this pass

- No new specialist agents spun up for security/auth/PWA/offline/perf/a11y
  as separate tracks — those tracks were re-verified directly via the test
  suites above rather than re-litigated by fresh agents, since nothing in
  the diff touched those surfaces and the existing coverage (axe-core,
  pgTAP, RLS boundary tests, outbox/idempotency tests) already exercises
  them on every run.
- Real iOS/Android device testing: not performed (no device available in
  this environment) — this was already the single largest named gap before
  this pass and remains so.
- GitHub Actions secret configuration, Supabase dashboard settings,
  Supabase PITR restore drill: not checked (external, and see the deferred
  decision above for why production wasn't queried).
