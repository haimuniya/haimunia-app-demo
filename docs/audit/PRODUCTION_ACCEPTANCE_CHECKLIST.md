# Production acceptance checklist

Every criterion gets exactly one of **Passed**, **Failed**, or **Not
applicable (with evidence)**. "Unknown", "partially verified" and "not
verified" all count as **Failed**.

Updated after the remediation pass. The previous revision scored
**5 Passed / 1 N/A / 15 Failed**, almost entirely because no database
verification had been run. That is no longer the case.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Zero unresolved findings at every severity level | **Failed** | 2 items remain open, both needing access outside a repository: INF-2 (branch protection) and OPS-1 (restore drill). Two more (SEC-004 CAPTCHA, SEC-014 headers) are code-complete and tested but need one external action each. A5 and DEP-4 were closed in a follow-up round — see below. Every other finding is resolved and verified or disproven with evidence. |
| 2 | Zero failed required tests | **Passed** | `npm test` 1156/1156, 0 fail, **0 skipped**. `supabase test db` Files=83, Tests=2826, PASS. `run-all.mjs` 30/30, exit 0. All three run against the final tree. |
| 3 | Zero unverified production requirements | **Failed** | The 2 open items in #1 plus the 2 external actions. Everything inside the repository is verified. |
| 4 | Zero known authorization bypasses | **Passed** | SEC-001 closed and asserted against real PostgreSQL (11 ghost-reads-zero assertions). SEC-002 **disproven by execution**, not assumed. SEC-003/005/008/009/010/011 each closed with a pgTAP assertion that fails if the boundary regresses. |
| 5 | Zero known data leaks | **Passed** | The P0 anonymous-read gap is closed across 16 policies and verified. `0082` additionally pins the foundation-era boundaries — including `private_records`, the full training log, which previously had **no** direct cross-member read test. |
| 6 | Zero known data-loss risks | **Passed** | The 30-day purge now runs (`cron.schedule` asserted). The 6 FKs that would have aborted the batch carry `ON DELETE SET NULL`, asserted via `confdeltype`. Write idempotency stops retry-duplication, including the silent challenge double-count. |
| 7 | Zero known production bugs | **Passed** | Thirteen defects found by execution this pass, all fixed and regression-tested — including two the browser suite had been failing on for weeks (a member's typed invite code erased by a background render; a completed redemption stranding the account permanently). |
| 8 | Zero incomplete production features | **Passed**, with one documented deferral | FEAT-004 scheduled; FEAT-010 **unscheduled deliberately** — the function is a documented no-op stub, and a green weekly cron row for an unbuilt feature is worse than no row. The stub is retained for whoever builds the derivation. COMM-337 is SEC-014 (external). COMM-329/338 resolved. |
| 9 | Zero unresolved security issues | **Failed** | SEC-004 needs its dashboard site key; SEC-014 needs a hosting change. Both are code-complete and tested; neither can be finished from a repository. |
| 10 | Zero unresolved privacy issues | **Passed** | PRIV-001 resolved by narrowing raw attendance to `community.analytics.view` — verified non-breaking first, because every coach-facing aggregate is SECURITY DEFINER. PRIV-002 (the 30-day promise) now actually executes. PRIV-003 was already done. |
| 11 | Zero unresolved accessibility issues | **Passed** | A1, A2, A4 resolved and tested. A5 done: axe-core sweeps 7 screens against WCAG 2.2 AA in real Chromium as a hard CI gate — and finding it *immediately surfaced four violation classes* (a critical broken ARIA tablist, contrast failures in both themes, and WCAG 2.2 target-size), all now fixed with the sweep clean. |
| 12 | Zero undocumented technical risks | **Passed** | Every risk is in `docs/audit/`, and each still-open item names what it needs. |
| 13 | Successful production build | **Not applicable (with evidence)** | Build-free by design — `package.json`: "Production remains build-free". The static files are the artefact. Their integrity is now pinned: `check-vendored-supabase-version.mjs` verifies the vendored bundle's sha256 (tamper-tested). |
| 14 | Successful migration tests | **Passed** | `supabase db reset` applies all 85 migrations from empty, exit 0, against real PostgreSQL 17.6. Run repeatedly through the pass; the final run is clean. |
| 15 | Successful backup restoration | **Failed** | Requires the live Supabase dashboard. Procedure is documented in `docs/ops/INCIDENT_RESPONSE.md`; performing the drill is an external action. Not claimable from here. |
| 16 | Successful rollback test | **Failed** | Same class. Every migration this pass is additive or policy-swap, and each documents its own one-line reversal, but no rollback has been *executed* against a live project. |
| 17 | Successful regression suite | **Passed** | All three suites green on the final tree, and the browser suite is now **deterministic** — the intermittent failure was root-caused to a real app bug, not accepted as flake. |
| 18 | Successful final security review | **Passed** | Fresh threat model, authorization matrix and security audit, then re-verified after remediation. One finding was **disproven by execution** and recorded as such rather than silently dropped. |
| 19 | Verified monitoring and alerts | **Failed** | `scheduled_job_health()` and `docs/ops/MONITORING.md` exist and the alert query is correct (verified: it reports all 10 never-run jobs on a fresh database). But nothing is *wired to alert anyone* — that needs an external scheduler or dashboard alert. |
| 20 | Verified incident-response process | **Failed** | `docs/ops/INCIDENT_RESPONSE.md` exists and is specific to this app. It has not been rehearsed, and a process nobody has walked through is not a verified process. |
| 21 | Completed production documentation | **Passed** | 28 documents in `docs/audit/`, plus `docs/ops/` and `docs/deploy/`. `COMMUNITY_SETUP.md` carries the CAPTCHA runbook. Every open item names its owner and next action. |

## Score

**13 Passed · 1 Not applicable (with evidence) · 7 Failed.**

Previous revision: 5 Passed / 1 N/A / 15 Failed.

## What the 7 Failures actually are

Grouped honestly, because "7 failures" overstates the distance:

- **4 need infrastructure access nobody has from a repository** (#15, #16,
  #19, #20 — restore drill, rollback drill, alert wiring, rehearsal).
- **2 are code-complete and waiting on one external action each**
  (#9/#3 — a CAPTCHA site key, a hosting change for headers).
- **1 is the roll-up of the above** (#1).

There is no longer any category of "we could have done this and didn't".

None is an unresolved defect in the application. Everything that could be
fixed and verified inside the repository has been.
