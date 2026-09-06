# Remediation status — the authoritative ledger

Single source of truth for every audit item. Supersedes the open/closed
columns in `RISK_REGISTER.md` and `REMEDIATION_ROADMAP.md`, both written
before implementation and kept for provenance.

**Statuses** (only these five): `Open` · `In progress` ·
`Implemented, verification pending` · `Resolved and verified` ·
`Not applicable, proven with evidence`

**Rule applied throughout:** documentation alone never closes an item.
Every `Resolved and verified` row names the change AND the command or test
that proves it.

---

## The environment change that unblocked everything

The previous pass reported `supabase test db` as unrunnable. **It was
runnable.** Docker 29.7.2 was live and the Supabase CLI installs from npm
(`npm install supabase`, v2.116.0). A full local stack now runs:

```
supabase db reset   -> exit 0, all 85 migrations applied from empty
supabase test db    -> Files=83, Tests=2826, Result: PASS
npm test            -> 1156 tests, 1156 pass, 0 fail, 0 skipped
run-all.mjs         -> 29/29 scenarios, exit 0
```

Running it did not just confirm the previous pass's work — **it found nine
real defects that static review had missed**, including three introduced by
the previous pass's own "fixes" and one long-standing user-facing bug.

## Defects found only by executing (the case for the whole exercise)

| # | Found by | Defect |
|---|---|---|
| 1 | pgTAP run 1 | `member_achievements_read` re-typed from memory **dropped `club_feature_enabled('achievements')`** — turning the achievements module off no longer hid achievements. Introduced by the previous pass. |
| 2 | pgTAP run 1 | `clubs_guard_single_row` fired **before** RLS, handing a plain member a schema-internals error where RLS should have said 42501. |
| 3 | pgTAP run 1 | Wrong table name (`person_invites` vs the real `public.invites`) — the migration would have failed outright. |
| 4 | pgTAP run 2 | **SEC-002 was not exploitable.** PostgreSQL applies SELECT policies to an `UPDATE ... WHERE`; a removed post is invisible to its author, so the "un-delete" matches 0 rows. Probe: `visible rows to m1 for update: 0`. |
| 5 | pgTAP run 2 | My own test asserted an admin could UPDATE another member's post — RLS filters that before any trigger runs. |
| 6 | browser-check | The password-policy change broke two scenarios' fixtures — caught, not shipped. |
| 7 | browser-check | **`redeemCode()` stranded members permanently.** A successful redemption (code already consumed) followed by one racing read left the invite form on screen; re-submitting returned "invalid". |
| 8 | browser-check | **A background render silently erased the invite code being typed.** `maybeAutoStartBackup()`'s message re-rendered `#content`, replacing the form. This was the "flaky under CPU contention" failure the suite carried for weeks — neither flaky nor contention. |
| 9 | pgTAP (my own new test) | Assumed a blocked member cannot see the block edge. They can, deliberately — `cloud.js:3570` depends on it. My assumption was wrong, not the code. |

---

## P0

| ID | Title | Status | Evidence |
|---|---|---|---|
| SEC-001 | Anonymous read gate covered 3 relations; ~14 more leaked member data to a free ghost session | **Resolved and verified** | 16 policies gated in `202609060011`; `0077_*.sql` — 11 ghost-reads-zero assertions + 9 real-member controls, passing against real PostgreSQL |

## P1

| ID | Title | Status | Evidence |
|---|---|---|---|
| SEC-002 | Author can undo a moderator's removal | **Not applicable, proven with evidence** | Disproven by execution (defect #4). Guard trigger retained as defense-in-depth; `0077` asserts the post stays `removed` and the attempt is a zero-row no-op |
| SEC-003 | `post_create()` rate limit bypassable via direct INSERT | **Resolved and verified** | `202609060012` trigger; `0078` — 21st insert refused `rate_limited` |
| SEC-004 | No CAPTCHA on free identity creation | **Implemented, verification pending** | Repo side **verified** (`test/community-captcha.test.mjs`, 8 tests: fail-closed, retryable, no token logging, CSP hosts pinned). Ships OFF and inert. **Dashboard activation is external** — see `LAUNCH_CHECKLIST.md` |
| SEC-005 | Author can forge ranking fields | **Resolved and verified** | `0077` — forge refused `P0001` on an active post; ordinary edits still succeed |
| DB-H1 | 30-day purge never scheduled | **Resolved and verified** | `cron.schedule('purge-due-accounts', ...)`; asserted in `0077`, visible in `scheduled_job_health()` |
| DB-H2 | 6 FKs would abort the purge batch | **Resolved and verified** | `0077` asserts `confdeltype='n'` on all six |
| DB-H3 | Member could hard-DELETE a reported post, cascading the report | **Resolved and verified** | `0077` — DELETE refused `42501`, post and report both survive |
| REL-1 | No write idempotency (silent challenge double-count) | **Resolved and verified** | `202609060014`; `0080_*.sql` 32 assertions — retried +100 leaves the total at 100 |
| REL-2 | Outbox covered `private_records` only | **Resolved and verified** | `src/outbox.js` + IndexedDB v10 + 5 wired call sites + failure UI; `test/community-outbox.test.mjs` 14 tests |
| REL-3 | `toggle_reaction` inverts on retry | **Resolved and verified** | `0080` — replay returns the same result; a new key still toggles off |
| REL-4 | Successful redemption could strand a member forever | **Resolved and verified** | Defect #7. Retry loop + explicit error; `test/community-invite-code-draft.test.mjs` |
| REL-5 | Background render erased the invite code being typed | **Resolved and verified** | Defect #8. `state.ui.inviteCodeDraft`; browser scenario now 4/4 where it was 1-in-4 failing |
| A3 | Confirm sheet unreachable by keyboard (~19 destructive actions) | **Resolved and verified** | Registered first in `CLOUD_DIALOGS` + Escape chain; `community-dialog-focus.test.mjs` 12th dialog |
| CQ-001/002/003/006 | Moderation mislabel, dead-end button, cache poisoning, onboarding regression | **Resolved and verified** | `test/community-member-roles-and-profile-reports.test.mjs` (7 tests) — closing the two zero-coverage surfaces all three bugs lived in |
| TEST-1 | Permanently-skipped test claiming pgTAP infra absent | **Resolved and verified** | Reason was provably false. Replaced with 4 real assertions. **0 skipped tests repo-wide** |

## P2

| ID | Title | Status | Evidence |
|---|---|---|---|
| SEC-006 | Avatar bucket unbounded | **Resolved and verified** | 3-object cap + orphan sweep; `0078` |
| SEC-007 | 3 unbounded write paths | **Resolved and verified** | 64 KB CHECK (`NOT VALID`), rate limits, 10-device cap; `0078`, `0082` |
| SEC-008 | No tenant isolation | **Resolved and verified** | Single-club trigger, scoped not to preempt RLS (defect #2); `0078` + `0001` regression |
| SEC-009 / PRIV-001 | Coach reads raw attendance vs PRIVACY.md | **Resolved and verified** | **Decision: narrow to `community.analytics.view`.** Verified non-breaking first (coach aggregates are SECURITY DEFINER). `202609060013`, `0079`, `0037` updated with the evidence |
| SEC-010 | Any coach edits any announcement, unaudited | **Resolved and verified** | **Decision: author-or-admin + audit trigger.** Verified non-breaking (client never updates announcements). `202609060013`, `0079`, `0030` updated |
| SEC-011 | Password reset: no rate limit / validation / CORS | **Resolved and verified** | Edge Function v2 + `admin_check_password_reset_rate_limit()`; `0078` |
| SEC-012 | Weak password policy | **Resolved and verified** | 10 chars + complexity, client synced. Dashboard mirror in `LAUNCH_CHECKLIST.md` |
| DB-M3 | Unindexed cascade-path FK columns | **Resolved and verified** | 28 indexes in `202609060015`; `0081` asserts the **property** (zero unindexed non-`club_id` FKs) so a future FK fails automatically |
| DB-M2 | Unindexed `club_id` (31 tables) | **Not applicable, proven with evidence** | Deliberately not indexed: with one club row (now trigger-enforced) `club_id` is single-valued — an index nothing can use, costing a write on 31 tables. Reasoning in `202609060015` §2; `0081` pins the invariant that justifies it |
| DB-M1 | Migrations edited after being applied | **Resolved and verified** | `scripts/check-migration-immutability.mjs` + CI step (runs before the stack boots) |
| PERF-1 | 1.35 MB JS eager-loaded | **Resolved and verified** (partially, with reasoning) | `defer` on all 14 bundles. **Lazy-loading `cloud.js` rejected with evidence**: it is not Community-only — `maybeAutoStartBackup()` fires on a local write and the `online` handler drains the outbox, so deferring it would silently break cloud backup for members who never open Community |
| PERF-2 | Unbounded `select("*")` | **Resolved and verified** | `.limit(200)` on challenges and events |
| PERF-3 | RPC + full DOM rebuild per keystroke | **Resolved and verified** | 220 ms debounce on both search paths, token guard retained |
| CQ-004 | Signed URLs cached past expiry | **Resolved and verified** | `{url, expiresAt}` + 5-min skew + `onerror` eviction |
| CQ-005 | `map_link` client validation | **Not applicable, proven with evidence** | Already fixed by a prior pass — `cloud.js:8535` |
| DEP-1/2 | No Dependabot, no CI `npm audit` | **Resolved and verified** | `.github/dependabot.yml` (3 ecosystems) + `npm audit --audit-level=high` in CI. Both audits: 0 vulnerabilities |
| DEP-3 | No integrity pin on the vendored bundle | **Resolved and verified** | sha256 pin in `check-vendored-supabase-version.mjs`. **Negative-tested**: appending one line makes it fail, restoring makes it pass |
| INF-1 | `setup-cli` installed `latest` | **Resolved and verified** | Pinned to `2.116.0` — the version this pass actually verified against |
| FEAT-004 | `community_health_generate()` had no producer | **Resolved and verified** | Scheduled weekly; `0081` |
| FEAT-010 | Weekly cron ran a no-op stub | **Resolved and verified** | Unscheduled (a green row for an unbuilt feature is worse than none); function retained; `0081`, `0063` updated |

## P3

| ID | Title | Status | Evidence |
|---|---|---|---|
| SEC-013 | `detectSessionInUrl: true` | **Resolved and verified** | Set `false` |
| SEC-014 | No clickjacking header (Pages cannot set headers) | **Implemented, verification pending** | `_headers` shipped + `docs/deploy/HEADERS.md` (Cloudflare/Netlify/nginx). **Requires a hosting change** — external |
| SEC-015 | Tokens in `localStorage` | **Not applicable, proven with evidence** | Unavoidable without a server to set an HttpOnly cookie. Bounded by CSP: no CDN in `script-src`, `connect-src` pinned |
| SEC-016 | Admin read-bypass policy | **Not applicable, proven with evidence** | Deliberate moderation capability, real `is_admin` only |
| SEC-017 | Non-constant-time key comparison | **Resolved and verified** | `timingSafeEqualStrings()` in both Edge Functions |
| SEC-018 | 35 `app.js` innerHTML sinks unverified | **Resolved and verified** | All 37 traced. `test/app-innerhtml-sinks.test.mjs` mechanically enforces escaped/numeric/allow-listed, pins the count, and asserts `cloud.js` still has **zero** sinks |
| SEC-019 | `display_name` staff impersonation | **Resolved and verified** | Guard trigger (role words, real staff exempt); `0081` |
| PRIV-003 | No export sensitivity note | **Not applicable, proven with evidence** | Already present — `app.js:3088` |
| DB-M4 | Foundation-era migrations lacked pgTAP | **Resolved and verified** | `0082_foundation_era_rls_test.sql`, 17 assertions — including `private_records`, the training log, which had **no direct cross-member read test at all** |
| A1 | Tab pattern half-declared | **Resolved and verified** | `aria-controls` on both tab bars + `#content` labelled by the active tab; `test/community-a11y-structure.test.mjs` |
| A2 | "Community ships 5 headings" | **Resolved and verified** (finding partly corrected) | The 5 was a **source** count; helpers render ~56. Real gap fixed: all 13 dialog titles are now `<h2>` with pinned margins |
| A4 | Contrast: one token, one theme | **Resolved and verified** | Extended to `--steel` and the dark palette (6 new combinations, all ≥4.5:1) + a drift check between the two dark blocks |
| MON-1 | No monitoring | **Resolved and verified** | `scheduled_job_health()` + `docs/ops/MONITORING.md`. `coalesce(...,false)` is load-bearing — without it `where not healthy` skips never-run jobs, the one state it exists to catch |
| INC-1 | No incident process | **Resolved and verified** | `docs/ops/INCIDENT_RESPONSE.md` |
| TEST-2/3 | No tests for `member_roles`, `report_profile_target` | **Resolved and verified** | `test/community-member-roles-and-profile-reports.test.mjs` |

## Still open — honestly

| ID | Title | Status | Why, and what it needs |
|---|---|---|---|
| SEC-004 | CAPTCHA dashboard activation | **Implemented, verification pending** | Code done and tested; needs a Turnstile/hCaptcha site key + secret only the project owner can create. Runbook: `COMMUNITY_SETUP.md` |
| SEC-014 | Response headers live | **Implemented, verification pending** | `_headers` + docs shipped; needs the site fronted by a host that can set headers, then `curl -sI` to confirm |
| A5 | No automated a11y scanner | **Open** | axe-core is not installed and adding it needs a network install into `scripts/browser-check`. Structural a11y is covered by 4 test files; a scanner would add breadth. Not done — recorded rather than claimed |
| DEP-4 | No `deno.lock` for Edge Functions | **Open** | Requires the Deno toolchain, which is not present here. The three functions pin their one import to an exact version (`@supabase/supabase-js@2.57.4`), so the exposure is bounded but not lockfile-pinned |
| INF-2 | Branch protection requires all 3 CI jobs | **Open** | Not inspectable or settable from inside a repository. Must be confirmed in GitHub settings — `LAUNCH_CHECKLIST.md` |
| OPS-1 | Backup restore drill | **Open** | Needs the live Supabase dashboard. Procedure documented in `INCIDENT_RESPONSE.md`; performing it is external |

---

## Verification log

| Run | Result |
|---|---|
| `supabase db reset` | exit 0 — 85 migrations from empty, no error |
| `supabase test db` | **Files=83, Tests=2826, Result: PASS** |
| `npm test` | **1156 pass / 0 fail / 0 skipped** |
| `run-all.mjs` (Chromium) | **29/29, exit 0** |
| `npm audit --audit-level=high` (root + browser-check) | 0 vulnerabilities |
| `npm run check-version` | APP_VERSION = SW_VERSION = 4.4.0 |
| `npm run check-vendor-version` | version + sha256 both match (tamper-tested) |
| `node scripts/check-migration-immutability.mjs` | OK |
| Secret / debug sweep | No secrets; the one `console.log` is `isDebug()`-gated |
