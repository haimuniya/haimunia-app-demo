# Commands and test results

Everything below was **actually executed** on this machine. Nothing is inferred.
Where something could not run, it is recorded as "could not execute" with the reason.

## Environment

| | |
|---|---|
| Commit under test | `d2e6408` ("Close every finding from the full launch-readiness audit") |
| Branch | `main` |
| Node | v22.23.1 (`engines.node` requires `>=22`) |
| npm | 10.9.8 |
| Playwright | 1.62.1 |
| Platform | Linux 7.1.12-200.fc44.x86_64 (Fedora) |
| Run date | 2026-09-06 (UTC) |
| Working tree | clean apart from untracked `.claude/settings.local.json` and `docs/audit/` |

### Caveat on the commit boundary

This audit stream started while `HEAD` was `c39f640` on branch `community/phase-0`.
Partway through, a **parallel process committed `d2e6408` and fast-forward-merged it
into `main`** (+7757/-335 across 54 files, including +913 lines in `cloud.js`).

All results in this document, and in the sibling `PERFORMANCE_AUDIT.md`,
`ACCESSIBILITY_AUDIT.md` and `RELIABILITY_AUDIT.md`, were **re-verified against
`d2e6408`** after that merge landed. Byte sizes of `app.js`/`cloud.js`/`index.html`/`sw.js`
were re-measured and are byte-identical to the earlier pass, confirming the source
greps were already reading post-merge content.

`node_modules/` was already present and complete at both root and
`scripts/browser-check/`, so a root `npm ci` was not needed. `npm ci` **was** run in
`scripts/browser-check/`.

---

## 1. Root unit/integration suite — `npm test`

Runner is bare `node --test` (see `package.json` `"test": "node --test"`); no
Jest/Vitest/Mocha, no coverage tooling configured.

Exact final tail of output:

```
1..1108
# tests 1108
# suites 0
# pass 1107
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 46108.566179
```

Exit code `0`.

**Result: matches the stated baseline exactly — 1108 total, 1107 pass, 1 skip, 0 fail.**
No regression, no new failures. Run twice (once pre-merge, once at `d2e6408`); both
runs produced identical counts (durations 49.9 s and 46.1 s).

### The one skip

`test/community-rls.test.mjs`-family, test #836:

```
ok 836 - TRUE RLS enforcement for two auth roles is not covered here -
needs a pgTAP suite under supabase/tests/ run by migration-check
# SKIP infra not yet in repo - see COMM-019 report; est. ~1 day to add
supabase/tests/ + one CI step
```

**The skip's stated reason is now stale.** It claims the pgTAP infrastructure is "not
yet in repo", but `supabase/tests/` now contains ~40 pgTAP files (through
`0076_feed_interaction_session_scope_test.sql`), and `.github/workflows/test.yml`
already has a third job running `supabase start` then `supabase test db`. The skip
should either be un-skipped or its message corrected — as written it under-reports the
project's actual RLS coverage. *(Flagged, not fixed — no source was modified.)*

---

## 2. Real-Chromium browser checks — `scripts/browser-check`

```
cd scripts/browser-check
npm ci                          # added 2 packages, 0 vulnerabilities, exit 0
npx playwright install chromium # exit 0
node run-all.mjs
```

Chromium **did** download — network access was available. Playwright emitted
`BEWARE: your OS is not officially supported by Playwright; downloading fallback build
for ubuntu24.04-x64.` three times (Fedora host), but the fallback build ran correctly.

### Final result (clean, idle machine)

```
run-all: everything passed
```

**29 / 29 scenarios passed. 0 failed.** Exit code 0.

Every scenario also asserts `no console errors` as its own final check, and **all of
them passed that assertion** — no uncaught console errors were surfaced anywhere in
the suite.

The one console message observed at all (captured in a manual diagnostic, not counted
as an error by the harness) is a benign browser warning:

```
The Content Security Policy directive 'frame-ancestors' is ignored when
delivered via a <meta> element.
```

This is expected — `frame-ancestors` genuinely cannot be delivered via `<meta>` and
needs a real response header; a static-host deployment cannot set one. Worth noting for
the deployment/security stream, not a failure here.

Scenarios run: `benchmarks`, `boot-smoke`, `community-challenge-lifecycle`,
`community-classmates-card`, `community-coach-congratulate`, `community-coach-engage`,
`community-directory-follow`, `community-event-rsvp`, `community-intro-carousel`,
`community-member-of-week-publish`, `community-monthly-recap-publish`,
`community-notification-center`, `community-person-invite-lifecycle`,
`community-post-composition`, `community-recap-classmates`, `community-recap`,
`community-render-cost`, `community-report-moderation`, `community-search`,
`desktop-layout`, `duration`, `emom`, `ladder`, `roadmap`, `superset`, `text-scale`,
`update-flow`, `wod-builder-duration`, `wod-extras`.

### Observed flakiness under CPU contention — `community-intro-carousel.mjs`

This is a real, measured finding and the only instability seen anywhere.

| Condition | Result |
|---|---|
| `run-all.mjs` while other heavy jobs shared the CPU | **FAILED** |
| Standalone ×3, with a `run-all.mjs` running concurrently | 2 pass / **1 FAIL** |
| Standalone ×5, idle machine | 5 pass / 0 fail |
| `run-all.mjs`, idle machine (×2) | pass / pass |

Failure mode, every time it failed:

```
page.waitForSelector: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('#communityCredentials') to be visible
    at scripts/browser-check/community-intro-carousel.mjs:47
```

Root cause is **not** an application defect. A manual diagnostic confirmed
`#communityCredentials` renders correctly and the flow completes; the scenario simply
has a hard 10 s `waitForSelector` budget on the invite-code → credentials transition
that a loaded machine can exceed. Note the scenario's own preceding waits are 5 s while
this one is 10 s, and the step is preceded by an anonymous sign-up plus invite
redemption against the in-page mock.

**Risk:** CI runners are frequently CPU-contended, so this scenario can red the whole
`browser-check` gate (`run-all` exits non-zero if any one scenario fails) for reasons
unrelated to the change under test. Suggested fix for whoever owns it: raise the
timeout, or wait on a state predicate rather than a fixed wall-clock budget.
*(Not fixed here — `scripts/browser-check/` was left unmodified.)*

---

## 3. Version consistency scripts

Script names confirmed against `package.json` `scripts` first.

### `npm run check-version` → `node scripts/sync-version.mjs --check`

```
OK: APP_VERSION and SW_VERSION both 4.3.0
```

Exit code `0`.

### `npm run check-vendor-version` → `node scripts/check-vendored-supabase-version.mjs`

```
OK: vendor/supabase.js matches the declared @supabase/supabase-js@2.57.4.
```

Exit code `0`.

Both pass. `sw.js` `SW_VERSION` was bumped `4.2.0 → 4.3.0` in `d2e6408` and is in sync
with `APP_VERSION` in `app.js`.

---

## Not executable in this environment

These are recorded as **not run**, not as passing or failing:

| Check | Why it could not run |
|---|---|
| Lighthouse / Lighthouse CI performance score | No Lighthouse dependency in `package.json`, `scripts/browser-check/package.json`, or `.github/workflows/`. Nothing to run. No score is reported anywhere in these documents. |
| axe-core / automated accessibility scan | No `axe-core` or `@axe-*` dependency anywhere in the repo. `test/heading-outline.test.mjs`'s own header comment documents this explicitly as absent. |
| Real mobile-device measurement | No physical device and no device lab available. The only device-shaped numbers reported anywhere are Chrome DevTools Protocol **CPU throttling** multipliers from `community-render-cost.mjs`, which are a CPU proxy — not a real phone, and not network/memory/thermal behaviour. |
| pgTAP suite (`supabase test db`) | Requires `supabase start` (local Postgres in Docker). The third CI job runs it; it was not run here. `supabase/tests/` contains ~40 files that this audit did **not** execute. |
| `npm run smoke-test-anon-key` | Talks to the live Supabase project. Deliberately not run — this audit does not touch production. |

## Command log

```bash
node -v && npm -v                                    # v22.23.1 / 10.9.8
npm test                                             # 1108/1107 pass/1 skip/0 fail, exit 0
cd scripts/browser-check && npm ci                   # exit 0
npx playwright install chromium                      # exit 0
node run-all.mjs                                     # 29/29 pass, exit 0
cd - && npm run check-version                        # OK 4.3.0, exit 0
npm run check-vendor-version                         # OK 2.57.4, exit 0
```
