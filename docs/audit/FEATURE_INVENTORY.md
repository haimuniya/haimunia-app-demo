# Feature inventory and cruft sweep

Production-readiness audit, feature-completeness stream. Scope: general feature
completeness, code quality and cruft. **Authorization / RLS correctness is owned
by a separate parallel stream and is deliberately out of scope here** — where a
finding below touches a policy, it is about a *client/server gate disagreement*
or a *missing surface*, not about whether the policy itself is right.

Sources read: `docs/community/contracts.md` (7177 lines), `docs/community/backlog.md`
(3850 lines), `docs/community/tickets/` (177 files, latest `COMM-381.md`),
`supabase/migrations/` (90 files), `supabase/tests/` (76 pgTAP files + helpers),
`cloud.js` (12501 lines), `app.js` (4467 lines), `test/` (120 files).

Finding IDs: `FEAT-NNN`. Status is `open` for all.

---

## 1. Feature area inventory

Status column reflects the **backlog phase tables**, which are the file's own
stated source of truth. "Wired" is verified by grepping `cloud.js` for the
render function / RPC name and reading it.

| Area | Purpose | Target role | Backlog status | Wired into UI? |
|---|---|---|---|---|
| **Feed** | Ranked club activity feed: `feed_page()` ranking, diversity, cursor pagination, impression/interaction telemetry, top area (classmates card, pinned strip, announcements) | member | Phase 1 table says `todo` (stale — see FEAT-001); Phase 3 rows COMM-301/302/303/306/307 `review` | Yes. `loadFeed()` cloud.js:3188, `renderPostCard()` cloud.js:6428, `trackFeedInteraction()` cloud.js:3290, `renderClassmatesTodayCard()` cloud.js:8713 |
| **Posts / composer** | 13 post types with per-type cards, composer with up to 4 photos + alt text, visibility, own-post edit/visibility/delete menu | member | Phase 1 `todo` (stale) | Yes. `renderPostComposer()` cloud.js:9217, 13 per-type card renderers cloud.js:6247-6401, `postSaveCaption()`/`postApplyVisibility()` cloud.js:9302/9320 |
| **Reactions / comments** | One reaction per post, 2-level comment threads, mentions, edit/delete own, coach comment priority, block effects | member | Phase 1 `todo` (stale) | Yes. `toggle_reaction` cloud.js:3490, `renderComments()` cloud.js:5029, `add_post_comment` cloud.js:3612, `comment_edit`/`comment_delete` cloud.js:3692/3661 |
| **Achievements** | 27 seeded definitions across 6 categories + 4 attendance ones, engine, PR detection, share prompt, unlock celebration | member | Phase 1 `todo` (stale); COMM-305 `review` | Yes. `renderMyAchievements()` cloud.js:9636, `renderPrSharePrompt()` cloud.js:9413, `renderAchievementUnlockCelebration()` cloud.js:9614, `ach_claim`/`ach_share` cloud.js:9535/9591 |
| **Notifications** | Notification centre, per-type preferences, immediate vs batched, deep links, web push | member | COMM-140/141/142/144 `review`, **COMM-143 `partial`** | Yes. `renderNotificationCenter()` cloud.js:10773, `renderNotifPrefsPanel()` cloud.js:10814, `notif_list`/`notif_mark_read`/`notif_unread_count` cloud.js:10296/10338/10082 |
| **Challenges** | Six challenge types incl. cooperative + team, progress, join/leave, detail overlay, team management | member / coach | Phase 2 `done`; COMM-308 `review` | Yes. `renderChallengeViewOverlay()` cloud.js:7959, `renderTeamManagementPanel()` cloud.js:7775, `chal_record_progress`/`chal_reassign_team`/`chal_set_captain` cloud.js:6941/6773/6783 |
| **Events** | Event list/detail, RSVP, types, capacity, map link, event comments, companion post | member / coach | Phase 2 `done` | Yes. `renderEventViewOverlay()` cloud.js:8538, `renderEventForm()` cloud.js:8558, `event_rsvp` cloud.js:8346 |
| **Moderation** | Report flow (post / comment / **profile**), moderation queue, 5 decisions, context view, audit log, pins | member (report) / staff (queue) | Phase 1 `todo` (stale) | Yes, **with two defects** — `renderModeration()` cloud.js:5079, `renderReportSheet()` cloud.js:10912, `reportProfile()` cloud.js:4005. See FEAT-006 and CQ-001/CQ-002 |
| **Admin tools** | Member management + search, roles, password reset, analytics dashboard, member segments, retention correlations, community health score, club modules, audit log | admin / staff | Phase 3 `review`, Phase 4 `done` | Mostly. `window.renderManageApp` cloud.js:11383 (7 sub-tabs). **`renderCommunityHealthScore()` cloud.js:6044 is permanently empty** — FEAT-004. **No restriction-lift UI** — FEAT-005 |
| **Recaps** | Weekly recap Edge Function, monthly club recap with admin preview/publish, member-facing recap overlay | member / staff | COMM-309/316 `review` | Yes. `renderRecapViewOverlay()` cloud.js:8928, `renderCoachMonthlyRecapSection()` cloud.js:7560, `recap_monthly_publish` cloud.js:2216 |
| **Onboarding** | 5-step onboarding sequence (welcome / first week / first month / first class / third class) + staff-editable copy; 3-screen first-run intro carousel + its own editor | member / staff | COMM-222/316 `review`, COMM-373/378 `done`; carousel is post-Phase-4 and **unticketed** (FEAT-002) | Yes. `renderOnboardingStep()` cloud.js:1364, `renderOnboardingContentEditor()` cloud.js:1434, `renderIntroCarousel()` cloud.js:1051, `renderIntroCarouselContentEditor()` cloud.js:1506 |
| **Invites / registration** | Shared per-role codes + per-person single-use invites, admin create/list/revoke for both, redemption with actor throttle, registration-funnel analytics | member (redeem) / coach+admin (issue) | Phase 4 `done` | Yes. `renderInviteManagement()` cloud.js:2619, `renderSharedCodesPanel()` cloud.js:2530, `renderPersonInvitesPanel()` cloud.js:2571, `redeemCode()` cloud.js:1088, `renderRegistrationFunnel()` cloud.js:5677 |
| **Member roster** | Paginated browse over the whole club, shared row renderer with admin search | staff (read) / admin (act) | COMM-374/377 `done` | Yes. `renderMemberRoster()` cloud.js:5281, `admin_member_roster` cloud.js:5259. Documented pagination gap at cloud.js:5266-5279 (intentional) |
| **Club modules** | 11 admin toggles that turn Community features off club-wide (6 RLS-backed, 5 client-only) | admin | COMM-321 `done`; the 5 coach/directory keys are post-Phase-4 and **unticketed** (FEAT-002) | Yes. `renderClubModulesPanel()` cloud.js:5318, `isModuleEnabled()` cloud.js:678, `admin_set_club_feature` cloud.js:4135 |
| **Coach tools** | Celebrate, Welcome, Engage (attendance-decline), Member of the Week, monthly recap preview | coach / head_coach | Phase 2 `done`; COMM-304/315 `review` | Yes. `renderCoachTab()` cloud.js:7656 and its 5 sections cloud.js:7363/7403/7495/7560/7644 |

---

## 2. Backlog: parked / todo / in-progress items

### 2a. Parked bucket — all closed

`docs/community/backlog.md:1368-1451` lists seven `COMM-P0x` rows. The section's
own trailing paragraph (line 1449) states: *"All seven rows in the parked bucket
are now closed — this table is complete as a historical record."* Verified
against the closure notes at lines 1394, 1400, 1410, 1421, 1430, 1442.

| ID | Closed by | Verified |
|---|---|---|
| COMM-P01 Feed class-connection score | COMM-302 / 202608310003 | yes |
| COMM-P02 Consistency leaderboard | COMM-306 / 202608310004 | yes |
| COMM-P03 Attendance-milestone posts | COMM-305 / 202608310007 | yes |
| COMM-P04 Coach Engage + decline detection | COMM-304 / 202608310008 | yes |
| COMM-P05 Post-class trained-with-you card | COMM-307 / 202608310005 | yes |
| COMM-P06 Weekly recap classmates line | COMM-316 / 202609010003 | yes |
| COMM-P07 Onboarding 1st/3rd class steps | COMM-316 / 202609010003 | yes |

**Zero live parked items.** One *sub-feature* remains deliberately parked and is
not a bucket row: the `my_classes` feed scope (backlog.md:193, :1965) returns
empty by construction because `attendance_log` records days, not class identity.
The client renders that chip disabled (cloud.js FEED_SCOPES, ~line 3130). This
is documented as intentional — **not** an incomplete-production-feature.

### 2b. Live `todo` / `partial` rows in the latest phase sections

Latest phase sections are "Design sync & audit remediation (2026-09-02)"
(backlog.md:3026) and "Community promoted to the bottom tab bar (2026-09-04)"
(backlog.md:3799, no ticket table).

| ID | Title | Status | line | Incomplete-production-feature candidate? |
|---|---|---|---|---|
| COMM-337 | Move hosting off GitHub Pages (or add an edge layer) for clickjacking headers | **todo** | 3047 | **Yes** — P1, infra. `frame-ancestors` in a meta tag is inert; there is no real clickjacking defence in production today |
| COMM-329 | Heading elements and landmark regions in the app shell | partial | 3039 | **Yes** — P0 accessibility, only partly closed |
| COMM-338 | Run pgTAP in CI + multi-role live smoke test before deploy | partial | 3048 | **Partly** — the CI half is done (`supabase test db` runs in `.github/workflows/test.yml`, verified). The *live* multi-role pre-deploy smoke test is not built |
| COMM-351 | Reconcile `--shadow-card` formula across repos | partial | 3061 | No — cosmetic cross-repo drift |
| COMM-353 | Align `.page-title` typography | partial | 3063 | No — cosmetic |
| COMM-354 | Reconcile `--steel` token value | partial | 3064 | No — cosmetic |
| COMM-368 | Extract shared safety helpers into a real package/submodule | partial | 3078 | **Partly** — `src/shared/safe-helpers.js` exists with a version/propagation protocol (`src/shared/README.md`), but it is a vendored copy, not a published package. Drift between repos is still possible, just now visible |
| COMM-143 | Phase 1 notifications wired | partial | 227 | No — the `partial` marker is superseded; the server trigger set it names was delivered by 202608280021/026/027/028 (backlog.md:236-240 says so) |

**Count: 1 `todo`, 7 `partial`, 0 `in-progress` in the live tables. 3 of the 8
are genuine incomplete-production-feature candidates (COMM-337, COMM-329,
COMM-338); COMM-368 is a partial mitigation.**

### 2c. Findings on the backlog / ticket system itself

---

### FEAT-001 — Ticket and Phase-1 backlog statuses are systematically stale
- **Category:** documentation integrity
- **Priority:** P1
- **Evidence:**
  - `docs/community/backlog.md:178-259` marks all 38 Phase-1 tickets (COMM-101…COMM-191) `todo`, and `:52-70` marks all 20 Phase-0 tickets `review`.
  - 112 of the 177 files in `docs/community/tickets/` carry `Status: todo`, including `COMM-101.md:5`, `COMM-110.md:5`, `COMM-150.md:5`.
  - Every one of those features is shipped and wired. COMM-101's acceptance criterion is *"a single `renderPostCard(post)` dispatches on `post.post_type`"* — that function is at `cloud.js:6428` and dispatches to 13 renderers. COMM-110's is `loadFeed()` calling `feed_page` — `cloud.js:3188`, `cloud.js:3160`. COMM-150's is permission-string gating — `hasPerm()` at `cloud.js:654`, `my_permissions` at `cloud.js:657`.
  - Phase-0 files and the Phase-0 backlog table also disagree with each other (`COMM-001.md` says `todo`, backlog row says `review`).
- **Impact:** the two documents that are supposed to answer "what is left to build" both answer wrongly, in opposite directions, for ~65% of the ticket corpus. Any release-readiness judgement made from them is worthless, and a future agent following the file's own "agents work only tickets assigned to them in the current phase" instruction would rebuild shipped features.
- **Proposed fix:** one mechanical pass setting Phase-0/1/2/3 ticket-file and backlog-table statuses to `done`, matching what Phase 4 already does correctly. If a per-ticket re-verification is too expensive, at minimum add a dated note at the top of each stale table saying the column is not maintained and pointing at the phase narrative paragraphs, which *are* accurate.
- **Status:** open

---

### FEAT-002 — 14 migrations and a UI redesign shipped after Phase 4 with no tickets and no backlog section
- **Category:** process / traceability
- **Priority:** P1
- **Evidence:**
  - Latest ticket file is `docs/community/tickets/COMM-381.md`; the backlog's last table ends at COMM-381 (`backlog.md:2684`).
  - 14 migrations dated after it have no ticket and no backlog row: `202609050001_password_reset_audit_label` … `202609060010_feed_interaction_session_scope`. Grepping `docs/` for `intro_carousel`, `scheduled_jobs`, `anonymous_read_gate`, `club_modules`, `password_reset_audit` returns hits in `docs/community/contracts.md` **only**.
  - The same is true of the client work in commits `c39f640` ("Manage tab, feature flags, intro carousel"), `60158de` and `d2e6408` ("Close all 14 / every finding from the full launch-readiness audit") — a whole new top-level **Manage** tab with 7 sub-tabs (`cloud.js:11383-11423`), the intro carousel, 5 new club-module toggles.
  - Nine of those migrations cite *"Launch-readiness audit, finding N"* in their headers (e.g. `202609060001_anonymous_read_gate.sql:3`, `202609060004:3`, `202609060007:3`, `202609060008:3`). **That audit document does not exist in the repo** — `docs/` contains only `audit/` (empty before this pass) and `community/`.
- **Impact:** the most recent, least-reviewed third of the schema has no acceptance criteria, no ticket, no phase gate, and its originating audit is unreproducible. There is no artefact that says what "finding 3" or "finding 7" were, so it cannot be confirmed all findings were closed.
- **Proposed fix:** file the launch-readiness audit as `docs/audit/2026-09-05-launch-readiness.md` with its numbered findings, and add a "Phase 5, launch readiness + redesign" backlog section covering the 14 migrations and the Manage-tab client work.
- **Status:** open

---

### FEAT-003 — CHANGES.md is stale again by five commits and three days
- **Category:** documentation integrity
- **Priority:** P2
- **Evidence:** `CHANGES.md:1` top entry is dated **2026-09-01**. `git log` shows five later commits (`cc646ca` 09-04, `60158de`, `8742369`, `c39f640`, `d2e6408` 09-05/06) delivering the Manage tab, feature flags, intro carousel, bottom-tab promotion and 14 migrations. This is the exact condition COMM-369 (`backlog.md:3079`, marked `done`) existed to fix a week earlier.
- **Impact:** the user-facing changelog omits every feature shipped in the final week before launch.
- **Proposed fix:** backfill 2026-09-04 → 2026-09-06. Consider a CI check comparing `CHANGES.md`'s top date against the newest commit date, since the manual discipline has now failed twice.
- **Status:** open

---

### FEAT-004 — Community health score has no producer; the admin card is permanently empty
- **Category:** incomplete feature
- **Priority:** P1
- **Evidence:**
  - `public.community_health_generate()` is defined at `supabase/migrations/202609010009_community_health_score.sql:409` and is the only writer of `community_health_scores`.
  - It is called by **nothing**: not from `cloud.js` (grep for the name returns 0 hits), not from `supabase/functions/`, and it is **not** in the eight `cron.schedule()` calls in `supabase/migrations/202609050005_scheduled_jobs.sql:252-306` (`notif-batch-flush`, `recap_monthly`, `feed-weights-recompute`, `chal-notify-ending-soon`, `coach-engagement-decline`, `purge-abandoned-profiles`, `recap-weekly`, `telemetry-retention-purge`).
  - `cloud.js:6044` `renderCommunityHealthScore()` therefore always takes its 0-weeks empty branch, which its own comment at `cloud.js:6040` still describes as *"no scheduler wired yet is the expected common case until one exists"* — a comment that was true before 202609050005 and is now stale, because a scheduler exists and this job was simply left out of it.
- **Impact:** COMM-312 ships an admin dashboard headline number that can never be populated in production. It is the *first* card on the Manage → Dashboard sub-tab (`cloud.js:11360` `renderManageDashboard`), so the admin's landing screen leads with a permanently blank metric.
- **Proposed fix:** add `select cron.schedule('community-health', '<weekly>', $$select public.community_health_generate()$$)` in a new migration, and correct the stale comment at `cloud.js:6040`.
- **Status:** open

---

### FEAT-005 — `purge_due_accounts()` is not scheduled: account-deletion requests are never executed
- **Category:** incomplete feature / privacy commitment
- **Priority:** P0
- **Evidence:**
  - `request_account_deletion()` (`supabase/migrations/202608260001_community_foundation.sql:145-151`) writes an `account_deletion_requests` row with `purge_after = now() + interval '30 days'` and soft-deletes the profile and posts. It is wired in the client at `cloud.js:4259`.
  - `purge_due_accounts()` (same file, `:157-166`) is the function that actually deletes the `auth.users` row after the grace period. Its own comment says *"Invoke daily from a trusted scheduler/Edge Function using the service role."*
  - It is **not** among the eight jobs in `202609050005_scheduled_jobs.sql:252-306`, has no Edge Function under `supabase/functions/` (only `admin_reset_password`, `purge_abandoned_profiles`, `recap_weekly` exist), and is not called from `cloud.js`. The scheduler migration's own line 43 lists `purge_due_accounts` as one of the things that *"has an existing purge"* — it has an existing purge **function**, not an existing purge **job**.
  - `COMMUNITY_SETUP.md:197` instructs the operator to *"Confirm account deletion immediately unpublishes posts and the scheduled purge removes the Auth user after 30 days."* There is no scheduled purge to confirm.
- **Impact:** every member who requests account deletion has their content hidden but their `auth.users` row, credentials and identity retained indefinitely. `PRIVACY.md` promises a 30-day deletion the system cannot perform. This is the highest-severity gap found in this stream.
- **Proposed fix:** add a daily `cron.schedule('purge-due-accounts', …, $$select public.purge_due_accounts()$$)`, note the grant (`service_role` only — the job owner may need an explicit grant), and add a pgTAP assertion that the job exists in `cron.job`.
- **Status:** open

---

### FEAT-006 — `mod_lift_restriction()` has no client surface: a posting restriction can never be lifted from the app
- **Category:** incomplete feature
- **Priority:** P1
- **Evidence:**
  - `public.mod_lift_restriction(p_restriction_id uuid, p_reason text)` exists at `supabase/migrations/202608280015_posting_restrictions.sql:167` and is granted to `authenticated` (`:201`).
  - `cloud.js` never calls it, and never reads the `posting_restrictions` table at all — grep for `posting_restrictions` in `cloud.js` returns one hit, a comment at `cloud.js:2237`.
  - The client *does* render the `member_unrestrict` audit-action label (`cloud.js:5121`) and lists it in `AUDIT_ACTION_TYPES` (`cloud.js:5154`), so the audit log has a label for an action the UI cannot produce.
  - The queue only offers `restrict_temp` / `restrict_permanent` (`MOD_DECISIONS`, `cloud.js:2264-2270`).
- **Impact:** an admin who applies a permanent posting restriction — deliberately or by mis-tap — cannot reverse it without direct SQL-editor access to the production database. There is also no screen anywhere listing who is currently restricted.
- **Proposed fix:** add a "restricted members" list to the Manage → Moderation sub-tab reading `posting_restrictions`, with a lift button calling `mod_lift_restriction`.
- **Status:** open

---

### FEAT-007 — The two Edge-Function cron jobs are inert on any project where the Vault secrets are unset, and setup docs never mention them
- **Category:** deployment gap
- **Priority:** P1
- **Evidence:**
  - `cron_invoke_edge_function()` (`202609050005_scheduled_jobs.sql:196-230`) reads `edge_functions_base_url` and `edge_functions_service_role_key` from `vault.decrypted_secrets` and **returns NULL with a `raise notice`, making no request**, while either is missing or still its committed placeholder (`:209-215`). It is the transport for the `recap-weekly` and `purge-abandoned-profiles` jobs (`:290`, `:298`).
  - `COMMUNITY_SETUP.md` never mentions Vault, `pg_cron`, `pg_net`, or either secret name — grep for `vault|Vault|edge_functions_base_url|pg_cron|cron` over that file returns **zero** hits. "Required launch checks" (`COMMUNITY_SETUP.md:164-201`) has no step for it.
- **Impact:** a correct-looking deploy silently ships with weekly recaps and abandoned-profile purging permanently disabled, with no error surfaced anywhere a human looks — the only signal is a `NOTICE` in the Postgres log.
- **Proposed fix:** add a "Set the scheduler secrets" step to `COMMUNITY_SETUP.md`'s required launch checks, with the two `vault.create_secret()` calls and the `select jobname, schedule, active from cron.job` / `select * from cron.job_run_details` verification the migration itself documents at `:246-248`.
- **Status:** open

---

### FEAT-008 — Release notes stop at v4.0.0 while APP_VERSION is 4.3.0
- **Category:** incomplete feature / release hygiene
- **Priority:** P2
- **Evidence:** `app.js:18` `APP_VERSION = "4.3.0"` (matched correctly by `sw.js:5` `SW_VERSION = "4.3.0"`). `RELEASE_NOTES` (`app.js:823-844`) has `4.0.0` as its newest entry, whose date is `2026-09-01` and carries a comment at `:824-826` saying *"Date is a placeholder … update it to the real ship date."* `newReleaseNotes()` (`app.js:868`) filters `compareVersions(r.version, lastSeenVersion) > 0`, so a member upgrading 4.0.0 → 4.3.0 sees the "אין עדכונים עדיין" empty state (`app.js:874`).
- **Impact:** the entire final week of work — the Manage tab, feature flags, intro carousel, member roster, per-person invites — ships with no in-app "what's new". The placeholder date also ships as-is.
- **Proposed fix:** add a 4.3.0 entry and set a real date. `test/version-sync.test.mjs` already pins APP_VERSION/SW_VERSION parity; extend it to assert `RELEASE_NOTES[0].version === APP_VERSION`.
- **Status:** open

---

### FEAT-009 — Stale skip reason on the one skipped test; the infra it says is missing has existed for weeks
- **Category:** cruft / misleading documentation
- **Priority:** P2
- **Evidence:** `test/community-rls-boundaries.test.mjs:498`:
  ```js
  test("TRUE RLS enforcement for two auth roles is not covered here - needs a pgTAP suite under supabase/tests/ run by migration-check", { skip: "infra not yet in repo - see COMM-019 report; est. ~1 day to add supabase/tests/ + one CI step" }, () => {});
  ```
  `supabase/tests/` contains **76** pgTAP files plus `rls_helpers.sql`, and `.github/workflows/test.yml`'s `migration-check` job runs `supabase test db` as a hard gate (verified in the workflow file, with a 10-line comment block explaining exactly this).
- **Impact:** the suite's only skip advertises a coverage hole that was closed by COMM-020/COMM-332. Anyone reading test output concludes RLS is untested when it is the best-tested part of the system.
- **Proposed fix:** delete the placeholder test, or convert it to a live assertion that `supabase/tests/` is non-empty and referenced by the workflow.
- **Status:** open

---

### FEAT-010 — Personalized feed ranking is dormant: the scheduled job runs a deliberate no-op stub
- **Category:** incomplete feature
- **Priority:** P1
- **Evidence:**
  - `public.recompute_feed_weights(p_limit integer)` (`supabase/migrations/202608310006_personalized_feed_weights.sql:515-526`) has an **intentionally empty body**: `v_written integer := 0; begin … return v_written; end`. Its own inline comment at `:522-524` says *"Intentionally empty… Writing nothing is the behaviour, not an unfinished edit: every member therefore has no `member_feed_weights` row and `feed_page` falls back to its fixed defaults."* Its `comment on function` at `:533` calls it *"A DELIBERATE NO-OP STUB."*
  - The derivation it needs is the TODO at `:504-514` (cruft row #3 below), and the backlog agrees: COMM-303 is `review — **storage and reader only; the derivation is NOT built**` (`backlog.md:724`).
  - `202609050005_scheduled_jobs.sql:263-264` nevertheless schedules it weekly: `select cron.schedule('feed-weights-recompute', '17 4 * * 1', $$select public.recompute_feed_weights()$$)`.
  - The function's own comment (`202608310006:533`) still claims *"Nothing schedules it"* — stale as of 202609050005.
- **Impact:** COMM-303 "Personalized feed ranking and per-user weights" is, in production, fixed-weight ranking for everyone. The feature is live in the schema, live in `feed_page`, live in the cron table, and produces no personalization. A weekly cron job burns a slot doing nothing, which will read as "the job runs fine" to anyone checking `cron.job_run_details`.
- **Proposed fix:** either file the derivation ticket the TODO asks for, or unschedule the job and mark the feature explicitly deferred so the cron table does not imply it works. Also correct the stale "Nothing schedules it" sentence.
- **Status:** open

---

## 3. Cruft sweep

Excluded: `node_modules`, `.git`, `scripts/browser-check/node_modules`, `vendor/supabase.js` (minified third-party bundle).

### 3a. `TODO` / `FIXME` / `HACK` / `XXX` / `TEMP`

Zero `FIXME`, zero `HACK`, zero `XXX`, zero `debugger` anywhere in the repo.

| # | file:line | Text | Assessment |
|---|---|---|---|
| 1 | `supabase/migrations/202608280019_feed_ranking.sql:614` | `-- TODO COMM-115: clubs has no image column.` | **Real, minor, tracked.** A ranking-function comment noting the club mark cannot carry a logo. Pinned by a test (`test/community-feed-ranking.test.mjs:483`), so it is deliberate and visible |
| 2 | `supabase/migrations/202609060009_definer_read_gate.sql:1109` | same text, carried forward verbatim | **Real, minor.** The definer-read-gate migration re-declared the function and copied the comment. Same single issue as #1, now duplicated across two migrations — closing it needs two edits |
| 3 | `supabase/migrations/202608310006_personalized_feed_weights.sql:504` | `-- TODO (a later ticket, not COMM-303): the derivation. It has to read the …` | **Real, and the biggest of the three — escalated to FEAT-010.** The function this TODO sits above is a deliberate no-op stub that is nevertheless scheduled weekly. Pinned by `test/community-feed-ranking.test.mjs:235` |
| 4 | `.claude/agents/recaps.md:42`, `.claude/agents/feed.md:47` | agent instructions referencing TODOs tied to the parked bucket | **Stale but harmless.** Both reference the attendance parking that closed on 2026-09-01. Not shipped code |
| 5 | `2026-09-02-design-sync-and-cross-repo-audit.md:371` | audit doc discussing `TODO`/`FIXME` scanning | **False positive** — prose about the practice |
| 6 | `scripts/browser-check/roadmap.mjs:20` (`temp dir`), `supabase/tests/0001,0017,0056` (`'temp'` literal), `test/community-moderation.test.mjs:290-292` (`const temp = …` for a *temporary* restriction) | — | **False positives.** All are the English word "temporary", none is a TEMP workaround marker |

### 3b. `console.log(` — 126 total, 0 real issues

| Location | Count | Assessment |
|---|---|---|
| `vendor/supabase.js` | many | **False positive** — vendored minified Supabase bundle |
| `scripts/browser-check/**` and `scripts/*.mjs` | 122 | **False positive** — dev/CI tooling that runs in Node and is expected to print. Not served to browsers (`sw.js` precaches only `src/*`, `app.js`, `cloud.js`, `index.html`) |
| `supabase/functions/recap_weekly/index.ts:404`, `supabase/functions/purge_abandoned_profiles/index.ts:114` | 2 | **Intentional** — one structured completion line per scheduled run; this is the only observability those jobs have |
| `src/analytics.js:326` | 1 | **Intentional and gated.** Sits inside `if (isDebug())` (`src/analytics.js:325`) and short-circuits the network write. Comment at `:322-324` explains the dev switch |
| `app.js`, `cloud.js`, `sw.js`, `index.html`, `theme-init.js`, `cloud-config.js`, `src/` (non-analytics) | **0** | Clean. `app.js` uses `console.error` in three render try/catch blocks (`:3299`, `:3314`, `:3320`) — deliberate error logging, not debug output |

### 3c. `.skip(` / `.only(` in tests

- `.only(` — **zero** occurrences. No accidentally-narrowed test run.
- `.skip` — **one**: `test/community-rls-boundaries.test.mjs:498`. See FEAT-009 above. `npm test` reports 1035/1036 with 1 skip, matching.

### 3d. Large commented-out code blocks

**None.** A programmatic scan of `cloud.js`, `app.js`, `sw.js` and all of `src/`
for runs of ≥3 consecutive comment lines whose content parses as code
(statement-terminating `;`/`{`/`}` or a leading `const`/`let`/`function`/`if`/
`for`/`return`/`await`) found **zero** matches. The codebase's comment volume is
very high but it is all prose rationale, not commented-out code.

---

## Summary counts

- **Parked backlog items:** 7, **all closed**; 0 live.
- **Live `todo` / `partial` rows in current phase sections:** 1 todo + 7 partial; **3 are genuine incomplete-production-feature candidates** (COMM-337, COMM-329, COMM-338).
- **Ticket-status integrity:** 112/177 ticket files marked `todo` are actually shipped (FEAT-001).
- **Cruft:** 3 real `TODO` comments (one duplicated across two migrations), 0 FIXME/HACK/XXX/debugger, 0 real `console.log`, 0 `.only(`, 1 stale `.skip`, 0 dead commented-out code.
- **Feature gaps found:** FEAT-004 (health score has no producer), FEAT-005 (**account deletion never executes** — P0), FEAT-006 (restrictions cannot be lifted), FEAT-007 (scheduler secrets undocumented), FEAT-010 (personalized feed ranking is a scheduled no-op).
- **Total findings:** FEAT-001 … FEAT-010 (1×P0, 6×P1, 3×P2).
