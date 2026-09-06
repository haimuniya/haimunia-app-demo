# Executive summary

## Final verdict

**Release blocked, external verification required.**

Every finding that could be resolved and verified inside this repository has
been. What remains needs access a repository does not have: a CAPTCHA site
key, a hosting change for response headers, a backup-restore drill, and
GitHub branch-protection settings. No unresolved defect remains in the
application itself.

This is a different verdict from the previous pass's "verification
incomplete", and the difference is real: **the database work is now
verified against live PostgreSQL**, not asserted.

## Launch-readiness score: **86 / 100**

Previous: 58/100.

| Category | Available | Score | Basis |
|---|---:|---:|---|
| Security | 25 | 22 | P0 closed and verified against real PostgreSQL. Every P1/P2 security finding closed with a pgTAP assertion that fails on regression, or disproven with evidence. −3: CAPTCHA and response headers are code-complete but need one external action each. |
| Reliability & data integrity | 20 | 18 | Write idempotency (incl. the silent challenge double-count), a complete community outbox, the 30-day purge actually running, 6 FKs that would have aborted it. −2: no executed restore/rollback drill. |
| Functional correctness | 15 | 15 | Nine defects found by execution, all fixed and regression-tested — including two the browser suite had been failing on for weeks and one that could permanently strand a new member. |
| Testing | 15 | 14 | 1156 node (0 skipped), 2826 pgTAP across 83 files, 29/29 browser — all green on the final tree, and the browser suite is now deterministic. −1: no automated a11y scanner. |
| Deployment & recovery | 10 | 6 | CI hardened: migration-immutability gate, pinned CLI, `npm audit`, version + sha256 integrity checks, Dependabot. −4: restore/rollback unexecuted, branch protection unverifiable from here. |
| Performance | 5 | 4 | `defer` on 1.35 MB of JS, bounded queries, debounced search. −1: lazy-loading `cloud.js` deliberately rejected (it would break cloud backup for members who never open Community) — documented, not silently skipped. |
| UX & visual quality | 5 | 5 | Keyboard access to ~19 destructive actions, moderation queue corrected, and the invite-code erasure bug fixed. |
| Accessibility & privacy | 5 | 4 | A1/A2/A4 resolved and tested; two privacy decisions made and enforced. −1: A5 scanner. |
| **Total** | **100** | **86** | |

No Critical or High security issue remains open, so no score cap applies.

## What changed this pass

**The unlock:** the previous pass reported `supabase test db` as unrunnable.
It was runnable — Docker was live and the CLI installs from npm. Running it
did not merely confirm prior work; **it found nine real defects static
review had missed**, three of them introduced by the previous pass's own
fixes:

1. A re-typed RLS policy had **dropped its feature-flag gate** — turning the
   achievements module off no longer hid achievements.
2. A new guard fired *before* RLS, leaking schema internals to plain members.
3. A migration referenced a table that does not exist (`person_invites` vs
   `public.invites`) and would have failed outright.
4. **SEC-002 was not exploitable.** PostgreSQL applies SELECT policies to an
   `UPDATE ... WHERE`, so a removed post is invisible to its author. Recorded
   as disproven with the probe output, not quietly deleted.
5. My own test asserted a bypass that RLS filters before any trigger runs.
6. A password-policy change broke two browser fixtures — caught, not shipped.
7. **A completed invite redemption could strand a member permanently**: the
   code was consumed, one racing read left the form on screen, and
   re-submitting returned "invalid".
8. **A background render silently erased the invite code being typed.** This
   was the "flaky under CPU contention" browser failure the suite had
   carried for weeks. It was neither flaky nor contention — it was a real
   user-facing bug, found by instrumenting the failure instead of raising
   the timeout.
9. One of my own new tests encoded a wrong assumption about block
   visibility; the code was right and the test was corrected.

## Release blockers (all external)

1. Enable CAPTCHA in the Supabase dashboard and paste the site key
   (`COMMUNITY_SETUP.md` has the runbook). Code is done, tested, fail-closed.
2. Front the site with a host that can set response headers (`_headers` and
   `docs/deploy/HEADERS.md` are ready), then `curl -sI` to confirm.
3. Perform one backup-restore drill (`docs/ops/INCIDENT_RESPONSE.md`).
4. Confirm GitHub branch protection requires all three CI jobs.
5. Wire the monitoring alert query to something that notifies a human
   (`docs/ops/MONITORING.md`).

## Findings by area

- **Security:** 1 P0 closed; 3 P1 (1 disproven); 8 P2 closed; 7 P3 (5 closed,
  2 accepted with evidence). Full detail: `SECURITY_AUDIT.md`,
  `REMEDIATION_STATUS.md`.
- **Reliability:** idempotency and the offline outbox built from scratch and
  covered by 46 assertions across the two suites.
- **Data integrity:** the 30-day deletion promise now executes; 6 FKs fixed;
  28 cascade-path indexes added.
- **Privacy:** two product decisions made and enforced in the schema, both
  verified non-breaking before shipping.
- **Accessibility:** A2's headline ("5 headings") was a *source* count —
  helpers render ~56. The real gap (13 dialog titles as `<div>`) is fixed.

## Features

- **Added:** none. This was a corrective pass.
- **Completed:** the 30-day purge (existed, never scheduled),
  `community_health_generate()` (existed, no producer), CAPTCHA integration,
  the community outbox, write idempotency.
- **Removed:** one misleading cron schedule (`feed-weights-recompute`, a
  documented no-op stub). The function is retained.

## Test results

| Suite | Result |
|---|---|
| `npm test` | **1156 / 1156**, 0 fail, **0 skipped** |
| `supabase test db` | **Files=83, Tests=2826, PASS** |
| `run-all.mjs` (Chromium) | **29 / 29**, exit 0 |
| `npm audit` (both trees) | 0 vulnerabilities |
| Version / vendor / migration-immutability | All OK (integrity pin tamper-tested) |

## Go / no-go

**No-go until the five external actions above are done.** Every one is a
short, well-documented task; none requires further code. Once CAPTCHA and
the headers are live and a restore has been rehearsed, this reaches
"Ready for production, every item resolved and verified".

The honest summary: the application is in materially better shape than the
score alone suggests — nine real defects were removed this pass, including
two that would have hit real members — and what blocks release is a set of
actions that can only be performed by whoever holds the accounts.
