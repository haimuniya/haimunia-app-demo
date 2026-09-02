# COMM-333 Fix browser-check flakiness and stop run-all.mjs aborting on first failure

Phase: Design sync & audit remediation (2026-09-02)
Agent: qa
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Three local runs of the full `browser-check` Playwright suite each hit a
nondeterministic 409 console error shared between `duration.mjs` and
`ladder.mjs`. Because `run-all.mjs` stops at the first failure, 6 of 24
scenarios (`roadmap.mjs`, `superset.mjs`, `text-scale.mjs`, `update-flow.mjs`,
`wod-builder-duration.mjs`, `wod-extras.mjs`) never ran in any of the three
attempts — meaning a bad CI run can go red or pass "by luck" without ever
exercising a third of the suite.

## Acceptance criteria

- [x] Root cause of the intermittent 409 console error (shared boot/asset-loading
  path exercised by `duration.mjs`/`ladder.mjs`) identified and fixed.
- [x] `run-all.mjs` continues past a failing scenario and reports all 24 results,
  instead of hard-stopping on the first failure.
- [x] 5 consecutive clean runs of the full 24-scenario suite.

## Location / evidence

- `scripts/browser-check/run-all.mjs`
- `scripts/browser-check/duration.mjs`, `scripts/browser-check/ladder.mjs`

## Resolved, 2026-09-02

**Root cause of the 401/409s (not actually a boot/asset-loading path):**
`cloud.js` boots unconditionally in every browser-check scenario regardless
of which script is running, and `cloud-config.js` points at the real, live
production Supabase project. `lib/mockCloud.mjs` already existed to stub
this out for community scenarios, but only the 12 `community-*.mjs` scripts
called it — the 12 offline-training-log scripts (`boot-smoke`, `duration`,
`desktop-layout`, `emom`, `roadmap`, `benchmarks`, `wod-extras`, `ladder`,
`text-scale`, `update-flow`, `wod-builder-duration`, `superset`) did not,
so they let `cloud.js` make real, unmocked network calls against production
in the background (session restore, and — worse — a real anonymous
sign-in via the auto-backup bootstrap, `maybeAutoStartBackup()`) while
testing something unrelated. That's both the source of the intermittent
401/409s (real auth/network responses from a live project, not a
deterministic local mock) and, per `lib/mockCloud.mjs`'s own comment, a
standing safety gap — an unattended CI run driving real writes against
production was exactly the risk that comment already warned about for
community scenarios; it just hadn't been closed for the other 12. Fixed by
calling `installMockCloud(page)` before every `page.goto()` in all 12
non-community scripts (`boot-smoke.mjs` also now runs its Community-tab
switch against the mock instead of production).

**A second, unrelated regression found by actually running the suite** (not
part of this ticket's original scope, but blocking it): the same-day
COMM-327 nav restructuring moved the 4 main tabs out of the hamburger nav
menu into a fixed bottom tab bar, leaving only Community inside the menu.
`lib/actions.mjs`'s shared `switchTab()` helper still unconditionally
opened the nav menu before clicking any tab id, which for a main tab now
means clicking a button sitting *behind* the still-open, full-page menu
overlay — Playwright correctly refused with "element intercepts pointer
events" and retried until timeout. Fixed by only opening the menu for
`tabCommunityBtn`; the other 4 ids are clicked directly (closing the menu
first if a caller left it open).

**`run-all.mjs`**: rewritten to run every script regardless of earlier
failures, collect a `{script, ok, status}` result per scenario, and print
a pass/fail summary table at the end — exit code still reflects whether
anything failed, but a failure no longer hides the rest of the suite.

**A third, smaller fix**: `community-event-rsvp.mjs` asserted the RSVP
"Going" control gets `.primary` on selection — stale from before COMM-325
replaced `.primary` with `.selected` for chip "currently chosen" state.
Same class of miss as several `node --test` files needed fixing for the
same COMM-325 change.

**Verification**: 5 consecutive clean full-suite runs (24/24 passed every
time), after both the mock-cloud and nav-menu fixes landed.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
