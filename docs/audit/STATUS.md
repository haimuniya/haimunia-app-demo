# Audit status

> **SUPERSEDED for open/closed tracking.** This document records the state
> at the end of the *first* audit pass. A remediation pass has since run and
> its ledger is `REMEDIATION_STATUS.md`, which is authoritative. The verdict
> and test counts below are stale and are corrected here:
>
> | | Then | Now |
> |---|---|---|
> | Verdict | Release blocked, verification incomplete | Release blocked, **external** verification required |
> | Score | 58/100 | **86/100** |
> | `npm test` | 1108 (1 skipped) | **1156, 0 skipped** |
> | `supabase test db` | never run | **Files=83, Tests=2826, PASS** |
> | `run-all.mjs` | not re-run | **29/29, exit 0** |
>
> The single biggest change: the database work is now verified against live
> PostgreSQL, and running it found nine real defects static review had
> missed. See `EXECUTIVE_SUMMARY.md`.

**Last updated:** 2026-09-06, end of this audit session.
**Branch:** `community/phase-0`. **HEAD at start of this pass:** `d2e6408`
("Close every finding from the full launch-readiness audit" — a separate,
concurrent audit pass that landed mid-session; see the note in
`RISK_REGISTER.md` and `REMEDIATION_ROADMAP.md`'s closing process note).
**Working tree:** modified, uncommitted (see `git status` — 14 files
modified, 2 new migrations, 2 new pgTAP files, 1 new npm-test file entry via
edits, all of `docs/audit/` new). Commits were intentionally left to the
user, per this session's operating rules.

## Current phase

Phase 16 (release-gate evaluation) reached. Phases 1–15 of the requested
17-phase audit were executed via 5 parallel research streams (reconciliation
of prior audits; security/threat-model; database/dependency/infra; feature
inventory/code quality; reliability/performance/accessibility) followed by a
direct implementation pass fixing the highest-priority findings.

## Findings tally (by source document — see each for detail; some overlap
## across documents is called out explicitly, e.g. SEC-009 = PRIV-001)

| Document | Findings | Notes |
|---|---:|---|
| `SECURITY_AUDIT.md` | 19 (1 P0, 3 P1, 8 P2, 7 P3) + 4 already-mitigated | Fresh, independent security pass |
| `RISK_REGISTER.md` | 194 rows reconciled from 3 prior audits → 56 distinct still-open/partial after dedup | Written **before** this pass's fixes — not yet re-reconciled against them |
| `DATABASE_AUDIT.md` | 13 (4 HIGH, 4 MEDIUM, 5 LOW/INFO) | |
| `DEPENDENCY_AUDIT.md` | 0 vulnerabilities; ~7 process gaps | |
| `INFRASTRUCTURE_AUDIT.md` | ~7 items, mostly unverifiable-from-this-sandbox flags | |
| `FEATURE_INVENTORY.md` | 10 (FEAT-001…010) | |
| `CODE_QUALITY_AUDIT.md` | 14 (CQ-001…014 incl. 004b) | |
| `ACCESSIBILITY_AUDIT.md` | 5 (A1…A5) | |
| `RELIABILITY_AUDIT.md` | ~12 discrete items | |
| `PERFORMANCE_AUDIT.md` | ~10 discrete items | |
| `PRIVACY_AUDIT.md` | 3 (PRIV-001…003) | PRIV-001 = SEC-009 |
| `UX_UI_AUDIT.md` | 5 fixed this pass (UX-001…005 = A3/CQ-001/002/003/006) + pointers to others | |

**No single unified finding-ID space exists across documents** — each
research stream numbered independently. This is recorded honestly rather
than papered over with a false total; `REMEDIATION_ROADMAP.md` is the
consolidated, de-duplicated punch list of what remains open.

## Resolved this pass (see `CORRECTIONS_COMPLETED.md` for full detail)

- The single P0 (SEC-001).
- 3 of 3 fresh-pass P1 security findings with a code-level fix available
  (SEC-002, SEC-003, SEC-005's shared root cause; SEC-011's rate-limit half).
- 4 P2 security findings (SEC-006, SEC-007, SEC-008, SEC-012).
- 2 P3 security findings (SEC-013, SEC-017).
- 2 DB HIGH findings (purge scheduling, 6 FK ON DELETE fixes).
- 4 code-quality P1 findings (CQ-001, CQ-002, CQ-003, CQ-006).
- 1 accessibility HIGH finding (A3).
- 3 CI/infrastructure process gaps (version checks + npm audit wired into CI).

## Explicitly NOT resolved, and why (see `REMEDIATION_ROADMAP.md` for the full list)

- **Everything requiring a live Supabase CLI/Docker/dashboard** — this
  sandbox has none of the three. Both new migrations and both new pgTAP
  files are drafted, internally cross-checked against the schema, but
  **unexecuted**.
- **SEC-004 (CAPTCHA)** — requires a live dashboard site key.
- **Reliability idempotency gaps** — require a client+server design
  decision, not a mechanical fix.
- **Product-decision items** (SEC-009/PRIV-001, SEC-010) — require the
  product owner to confirm intent before a behavior change ships.
- **Everything in `RISK_REGISTER.md`'s 56-item punch list not independently
  re-surfaced by this pass's own fresh streams** — that list was produced by
  a separate reconciliation stream and has not yet been cross-checked
  against this pass's fixes for overlap. Treat it as a second, only
  partially-merged source of truth until a follow-up pass reconciles the two.

## Last completed test run

`npm test`: **1108 / 1108 pass, 1 pre-existing skip, 0 fail** (re-run after
every source change through this session — see `FINAL_REGRESSION_REPORT.md`
for the full sequence, including intermediate failures caught and fixed).
Browser-check (Playwright) and `supabase test db` (pgTAP) were **not** run
against the final state of this session's changes — see
`PRODUCTION_ACCEPTANCE_CHECKLIST.md`.

## Remaining work before a clean release gate

See `PRODUCTION_ACCEPTANCE_CHECKLIST.md` and `LAUNCH_CHECKLIST.md` for the
formal, itemized list. In short: live-environment verification of both new
migrations, a live CAPTCHA rollout, the reliability idempotency work, and
the P2/P3 backlog in `REMEDIATION_ROADMAP.md`.

## Current release verdict

**Release blocked, verification incomplete.** Not "unresolved findings
remain" in the sense of untouched work — the highest-severity findings were
fixed — but this pass's own fixes are not yet verified in a real
environment, which this document and `PRODUCTION_ACCEPTANCE_CHECKLIST.md`
state plainly rather than assume. See `EXECUTIVE_SUMMARY.md` for the
full reasoning and score.
