# Risk register — reconciled audit findings

> **Addendum, written after this document, same session.** A later
> implementation pass in this same audit session fixed several items this
> register lists as STILL_OPEN or PARTIAL — most notably
> `AUDIT0827-OPS-H4`/`RESCAN-H5` (the unscheduled `purge_due_accounts()`),
> which is now scheduled (see `CORRECTIONS_COMPLETED.md` item 4). **This
> register was not re-run against those fixes** — it reflects the state at
> the moment it was written, before the implementation pass. Treat
> `REMEDIATION_ROADMAP.md` as the current, reconciled-against-fixes source
> of truth for what remains open; use this document for its original
> purpose (verified provenance of each finding back to the 3 prior audits)
> rather than as a live open/closed tracker.

Date: 2026-09-06
Repo state audited: branch `main`, HEAD `d2e6408` ("Close every finding from the full
launch-readiness audit"), working tree clean apart from `.claude/settings.local.json`.
App version 4.3.0 (`APP_VERSION` and `SW_VERSION` in sync, `npm run check-version` OK).

Sources reconciled:

- `2026-08-27-full-application-audit.md` (`AUDIT0827-*`)
- `2026-08-27-remediation-rescan.md` (`RESCAN-*`)
- `2026-09-02-design-sync-and-cross-repo-audit.md` (`DSYNC-*`)
- `docs/community/backlog.md` + `docs/community/tickets/COMM-*.md` (open-status sweep)
- New items found while verifying (`AUDIT-RECON-*`)

Every row below was checked against the **current** code, not against the source
document's own claim. Where a document said "fixed", the current file:line was re-read;
where it said "open", the current file:line was re-read too.

## Test suite baseline

`npm test` (`node --test`, Node v22.23.1) at `d2e6408`:

```
# tests 1108
# pass 1107
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 45546
```

**Unchanged from the stated baseline** — 1108 tests, 1107 pass, 1 pre-existing skip,
0 fail. `node_modules` was already complete; no `npm ci` was needed.

The other two CI gates were **not** re-run in this pass (both need Docker/Playwright):
`migration-check` (`supabase start` + `supabase test db`, 77 pgTAP files) and
`browser-checks` (`scripts/browser-check/run-all.mjs`, 29 scenarios). `d2e6408`'s commit
message claims `Files=77, Tests=2686, PASS` and `29/29` respectively; the file counts
match what is on disk (77 files in `supabase/tests/`, 29 scenario scripts in
`scripts/browser-check/`), so the claim is structurally consistent but is **not**
independently re-verified here.

## Counts

| Status | Rows |
|---|---:|
| VERIFIED_FIXED | 72 |
| STILL_OPEN | 57 |
| PARTIAL | 50 |
| NO_LONGER_APPLICABLE | 15 |
| **Total rows reconciled** | **194** |

Of the 194 rows, 7 are newly minted `AUDIT-RECON-*` items found during verification.

The three source documents overlap heavily — the 2026-08-27 rescan restates most of the
2026-08-27 audit's open items, and the 2026-09-02 audit re-found several of both. Every
finding is kept as its own row so no source document is silently dropped, with duplicates
cross-referenced in Notes. **After deduplication the open work is 56 distinct items: 33
STILL_OPEN and 23 PARTIAL**, which is exactly what the punch list below enumerates. Use
the punch list, not the raw row counts, for planning.

## Commit-scope spot checks

| Commit | Message claim | Actual diff | Verdict |
|---|---|---|---|
| `60158de` | "Close all 14 launch-readiness audit findings" — 5 migrations, 1 Edge Function, 2 pgTAP files, client fixes, PRIVACY disclosure, 6 stale fixtures | 20 files, +2498/-37; all 5 named migrations present (`202609050001`–`0005`), `supabase/functions/admin_reset_password/index.ts` present, `0063`/`0064` pgTAP files present, `PRIVACY.md`+`privacy.html` touched, 6 test fixture files touched | **Scope matches.** Claimed test numbers (1035/1036) are superseded by the current 1108. |
| `8742369` | "Bump app version to 4.0.2 so the PWA actually ships today's fixes" | 2 files, 2 lines (`app.js`, `sw.js`) | **Scope matches.** Superseded — current version is 4.3.0. |
| `c39f640` | "Implement the redesign mockup: Manage tab, feature flags, intro carousel" | 30 files, +1560/-145; 2 migrations (`202609050006`, `202609050007`), 2 pgTAP files, `community-intro-carousel` browser scenario + node test, cloud.js +518 | **Scope matches.** |
| `d2e6408` | "Close every finding from the full launch-readiness audit" — RLS lockdown, 2 new RPCs, redesign bugs, broken features, docs/legal, offline/sync, QA backfill; 4.2.1→4.3.0 | 54 files, +7757/-335; 10 migrations (`202609060001`–`0010`), 10 new/changed pgTAP files, 20 test files, `PRIVACY.md`/`privacy.html`/`sw.js`/`contracts.md` touched | **Scope matches.** The headline claim (anonymous-read confidentiality gap) is real and closed — see `AUDIT-RECON-001`. |

Note: none of these four commits is traceable to a ticket ID in
`docs/community/backlog.md` — see `AUDIT-RECON-006`.

---

## Punch list — every STILL_OPEN and PARTIAL item

Use this as the implementation todo list. Ordered roughly by risk.

### STILL_OPEN

1. **RESCAN-H5 / AUDIT0827-OPS-H4** — `purge_due_accounts()` is still not scheduled. The
   scheduler migration (`202609050005`) wires 7 cron jobs and skips this one; only a
   manual instruction in `COMMUNITY_SETUP.md:83` covers it. PRIVACY.md promises a 30-day
   deletion window that nothing executes. **Highest-risk open item.**
2. **AUDIT0827-OPS-H1 / RESCAN-H4** — No deployment workflow. `.github/workflows/` holds
   only `test.yml`; no artifact packaging, staging, smoke test, approval, or rollback.
3. **DSYNC-SEC-2 / COMM-338** — Live/production RLS behaviour never verified against a
   real project. `scripts/smoke-test-multi-role.mjs` exists but has never been run (no
   staging project, no provisioned test accounts).
4. **AUDIT0827-QA-4** — No end-to-end community test against a live/staging environment.
5. **AUDIT0827-SEC-M4 / RESCAN-M1 / DSYNC-SEC-1 / COMM-337** — Clickjacking headers still
   inert. GitHub Pages cannot send `frame-ancestors`/`X-Frame-Options`; the meta tag is
   spec-ignored for those directives.
6. **AUDIT0827-OPS-M5 / RESCAN-M10** — Environment config still hard-coded and tracked in
   `cloud-config.js`; no staging/production discrimination, no visible staging marker.
7. **AUDIT0827-OPS-M8** — No operational monitoring: no client error reporting sink, no
   uptime/synthetic checks, no sync-failure/outbox-age/purge-status metrics, no incident
   owner. `src/analytics.js` writes product events to Postgres only.
8. **AUDIT0827-OPS-M9 / RESCAN-M11** — No service backup/recovery definition, no RPO/RTO,
   no restore drill evidence anywhere in the repo.
9. **AUDIT0827-OPS-M7 (part) / DSYNC-SEC-4** — Supply chain: no SBOM, no scheduled online
   advisory scan, no Dependabot config, no checksum/integrity check on
   `vendor/supabase.js` (only a version-string comparison).
10. **AUDIT0827-ARCH-1** — `app.js` is still a monolith: 4,467 lines / 243 KB.
11. **AUDIT0827-ARCH-2 / DSYNC-ARCH-1** — `cloud.js` is still one file mixing network,
    state, auth gates, uploads, sync and rendering: 12,501 lines / 841 KB (grew from
    10,405 / ~700 KB since the 2026-09-02 audit).
12. **AUDIT0827-ARCH-5** — No backup schema version or IndexedDB migration policy; no
    per-version backup fixtures.
13. **AUDIT0827-ARCH-6** — Frontend and database releases still uncoupled; no
    forward/backward schema compatibility rule during rollout.
14. **AUDIT0827-QA-6** — Offline recovery fault injection still thin (quota is now
    covered; partial cache, IDB denial, corrupt records, clock skew, interrupted upgrades
    are not).
15. **AUDIT0827-QA-7 / RESCAN-L5 / DSYNC-QA-1** — No cross-browser support matrix; the
    browser suite is Chromium-only.
16. **AUDIT0827-QA-5 (part)** — No axe/automated accessibility scan and no 320 CSS px or
    200% reflow browser check (`text-scale.mjs` runs at 390 px).
17. **AUDIT0827-PERF-1** — No performance budgets defined or measured anywhere.
18. **DSYNC-PERF-3** — No dynamic `import()`/code splitting; 841 KB of `cloud.js` is
    parsed synchronously on every load.
19. **DSYNC-PERF-4** — `cloud.js` is unminified with no minify step.
20. **DSYNC-PERF-5** — No unified offline/degraded-mode banner for the community layer.
21. **DSYNC-PERF-7** — 12 sequential `<script>` tags, no `async`/`defer`, fragile
    `src/*` ordering (`index.html:1087-1102`).
22. **DSYNC-PERF-9** — No manifest shortcut into `?tab=community` despite the tab now
    being a first-class bottom-bar tab.
23. **DSYNC-ARCH-3** — `isIOSDevice()` still duplicated verbatim between `app.js:4057`
    and `cloud.js:10113`.
24. **DSYNC-ARCH-4** — `render()`'s single try/catch still has no error classification or
    reporting hook beyond `console.error`.
25. **DSYNC-ARCH-7** — No documented convention for silent-catch vs. user-visible-error
    handling in `cloud.js`.
26. **AUDIT0827-UX-8 / RESCAN-M5 / DSYNC-A11Y-6** — Calendar still has no grid semantics,
    no `aria-current`, no roving focus, no Arrow-key day navigation.
27. **AUDIT0827-UX-15 / RESCAN-L2** — Essential secondary text still at 11–13 px in many
    places; no rem token scale for body copy.
28. **AUDIT0827-PROD-1** — No product success criteria/targets (activation, retention,
    backup, sync). `docs/community/metrics.md` defines community *events*, not targets.
29. **AUDIT0827-PROD-3** — Onboarding still does not explain local vs. cloud vs. public
    data before community sign-in; neither the onboarding modal nor the intro carousel
    covers it.
30. **AUDIT0827-PROD-6** — No in-app feedback/support route carrying release version and
    diagnostic context.
31. **AUDIT0827-SEC-L8 / DSYNC-CONTENT-5** — Plaintext JSON export still has no
    shared-device warning in the UI or in PRIVACY.md, and no encrypted-backup option.
32. **AUDIT-RECON-002** — Backlog/ticket status bookkeeping has drifted badly enough that
    the backlog cannot be used as a launch gate.
33. **AUDIT-RECON-003** — `events.image_url` and sibling `image_url` columns carry a
    length-only CHECK; no URL-scheme check, unlike `events.map_link` and
    `profiles.avatar_url`.

### PARTIAL

34. **AUDIT0827-QA-3 / DSYNC-QA-4** — Two-user RLS testing exists (77 pgTAP files) but
    has never been validated against the live project; storage-object policies are not
    exercised by pgTAP at all.
35. **DSYNC-A11Y-2 / COMM-329** — Headings and landmarks: `<header>`, `<nav>`, `<main>`
    and per-tab `<h1>` shipped, but there is no `<footer>` landmark, the bottom tablist
    is not inside a `<nav>`, `<main>`'s tabpanel has no `aria-labelledby`, community
    screens have only 5 headings across 12.5 K lines, and no axe scan exists.
36. **AUDIT0827-UX-5 / RESCAN-M2** — Contrast: `--brass` and `--steel` were fixed and
    `brass-contrast.test.mjs` pins `--brass`, but there is still no test covering *every*
    theme token pair as the rescan asked.
37. **AUDIT0827-UX-3 / RESCAN-M3** — Text enlargement still uses CSS `zoom`
    (`index.html:190`), not rem-based type tokens; `#app` still carries
    `overflow-x:hidden` (`index.html:212`).
38. **AUDIT0827-ARCH-7 / RESCAN-L1** — Desktop: a `@media (min-width:900px)` block and a
    desktop sidebar shipped, but content is still capped at 480 px inside it; history,
    charts and coach tools have no wide layout.
39. **AUDIT0827-ARCH-4 / DSYNC-ARCH-1** — `cloud.js` state is now namespaced (COMM-365)
    but is still one flat mutable object with no store/controller boundary.
40. **AUDIT0827-ARCH-3 / DSYNC-ARCH-2 / COMM-366** — Full-tree `innerHTML` rerender was
    spiked and deliberately kept; the manual focus-restoration subsystem it forces still
    exists.
41. **AUDIT0827-UX-10 / RESCAN-M7** — Photo alt text works on the `post_media` path
    (composer captures it, `cloud.js:6211`), but the legacy single-photo fallback card
    still renders `alt=""` (`cloud.js:11151`).
42. **AUDIT0827-UX-11 / RESCAN-M8 / COMM-359** — Charts got `role="img"` + a computed
    Hebrew summary, but still have no adjacent data table/list alternative.
43. **AUDIT0827-UX-9 / RESCAN-M6** — Form errors: `field()` wires
    `aria-invalid`/`aria-describedby` in `cloud.js:4377-4385`, but app.js's WOD builder
    only sets `aria-invalid` with no `aria-describedby`, and first-error focus is not
    universal.
44. **AUDIT0827-UX-1 / RESCAN-H2 / DSYNC-A11Y-1** — All 10 app dialogs are registered on
    `APP_DIALOGS` with Escape + Tab trap + focus restore, but background regions are
    never marked `inert` (zero `inert` usage in the codebase).
45. **AUDIT0827-UX-2 / RESCAN-H3 / DSYNC-A11Y-3** — Tablist keyboard support shipped for
    every `role="tablist"`, but the desktop-sidebar rows (`app.js:195`) carry
    `role="tab"` without roving `tabindex` and without a `role="tablist"` parent.
46. **AUDIT0827-OPS-M7 (actions)** — GitHub Actions are SHA-pinned and CI cancels
    superseded runs; the rest of the supply-chain program (item 9 above) is not done.
47. **AUDIT0827-PROD-4** — Recovery: a staleness banner (`app.js:3046`), auto-backup
    before destructive actions and private cloud sync all shipped, but there is still no
    explicit statement of whether cloud sync is a recovery feature.
48. **DSYNC-DT-4 / COMM-353** — `.page-title` typography reconciliation is one-sided;
    Community is correct, `crossfit-pwa-Noam` never got the backport.
49. **DSYNC-DT-2 / COMM-351** — `--shadow-card` formula reconciliation: same, Noam-side
    only.
50. **DSYNC-DT-5 / COMM-354** — `--steel` reconciliation: same, Noam-side only.
51. **DSYNC-ARCH-6 / COMM-368** — Shared safety helpers extracted to
    `src/shared/safe-helpers.js` inside this repo, but there is still no shared
    package/submodule reaching `crossfit-pwa-Noam`.
52. **DSYNC-COMM-3 / COMM-347** — CSS-class extraction landed for the high-traffic
    components, but `cloud.js`'s inline `style="` count went **up**, 722 → 780.
53. **COMM-143** — Phase 1 notification trigger set: the client renders every type, but
    the backlog still records the server trigger set as partial.
54. **AUDIT0827-QA-9** — Backup compatibility fixtures: sanitizer/import tests are strong
    but there are no per-schema-version backup fixtures.
55. **DSYNC-FEAT-6** — The ~11 smaller `crossfit-pwa-Noam` 2026-09-02 bug fixes were
    never individually re-verified against Community's diverged UI.
56. **AUDIT-RECON-005** — Legal documents are placeholder-free and honest, but the
    ticket's own acceptance criterion (recorded legal sign-off) is explicitly still
    outside the repo.

---

## Full register

### Source: 2026-08-27 full application audit — Product

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| AUDIT0827-PROD-1 | AUDIT0827 | High | Product | No measurable success criteria | `docs/community/metrics.md:1-40` defines tracked events + WCAM but no activation/retention/backup targets | STILL_OPEN | Event taxonomy is real and disciplined; the *targets* half was never written. |
| AUDIT0827-PROD-2 | AUDIT0827 | High | Product | Coach model is global, not roster-scoped | `supabase/migrations/202608280001_clubs_and_rbac.sql:38,238`; `admin_member_roster` (COMM-377) is admin-scoped, not coach-to-class | NO_LONGER_APPLICABLE | RBAC ranks + permission strings replaced the flat "coach" tier. Class-to-coach scoping is Arbox's domain by explicit product boundary, not this app's. |
| AUDIT0827-PROD-3 | AUDIT0827 | Medium | Product | Onboarding does not explain local vs. cloud vs. public data | `index.html` onboarding modal lists 5 screens with no data-location copy; `supabase/migrations/202609050007_intro_carousel_content.sql:44-53` seeds welcome/rules/getting-started, none about data | STILL_OPEN | `privacy.html` exists and is linked from Settings (`app.js:3093`), but nothing sits before community sign-in. |
| AUDIT0827-PROD-4 | AUDIT0827 | Medium | Product | Recovery depends on user-managed JSON exports | `app.js:3046` staleness banner; `app.js:1653,1708` auto-backup before destructive ops; private cloud sync shipped | PARTIAL | Visible backup status and guidance landed; the "is cloud sync a recovery feature" decision is still unstated. |
| AUDIT0827-PROD-5 | AUDIT0827 | Medium | Product | Moderation workflow incomplete | `cloud.js:2253` `REPORT_REASONS`, `cloud.js:5074` mod queue, `cloud.js:11912` queue actions, `admin_actions` audit table | VERIFIED_FIXED | Reasons, queue, review/resolve/dismiss and audit writes all ship (COMM-151..154). Appeals/sanctions policy is still a product decision, not a code gap. |
| AUDIT0827-PROD-6 | AUDIT0827 | Medium | Product | No formal feedback channel | No feedback/support route in `app.js` or `cloud.js`; PRIVACY.md points at "contact your coach directly" | STILL_OPEN | The human channel is documented; the in-app route with version + diagnostics is not built. |

### Source: 2026-08-27 full application audit — Architecture

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| AUDIT0827-ARCH-1 | AUDIT0827 | High | Architecture | `app.js` is a 228 KB / 4,000-line monolith | `app.js` is now 243,730 bytes / 4,467 lines | STILL_OPEN | Some helpers were extracted to `src/*.js`, but the domain split never happened. Got slightly larger. |
| AUDIT0827-ARCH-2 | AUDIT0827 | High | Architecture | `cloud.js` mixes network, state, authz, uploads, sync, rendering | `cloud.js` is now 841,432 bytes / 12,501 lines | STILL_OPEN | Grew ~20% since the 2026-09-02 audit measured 10,405 lines. |
| AUDIT0827-ARCH-3 | AUDIT0827 | Medium | Architecture | Large DOM regions replaced via `innerHTML` | `docs/community/2026-09-03-render-architecture-spike.md`; `cloud.js` rerender pattern retained | PARTIAL | COMM-366 spiked scoped rendering and deliberately kept the full rerender, with measurements (`scripts/browser-check/community-render-cost.mjs`). Documented decision, not an oversight — but the focus-restoration subsystem it forces still exists. |
| AUDIT0827-ARCH-4 | AUDIT0827 | Medium | Architecture | Global mutable state drives most screens | `cloud.js:135-237` — state is namespaced by domain (COMM-365) but still one flat object | PARTIAL | Namespacing landed; no store/controller boundary. |
| AUDIT0827-ARCH-5 | AUDIT0827 | Medium | Architecture | No schema version strategy for local records | No `schemaVersion`/`BACKUP_VERSION` anywhere in `src/sanitize.js` or `src/db.js` | STILL_OPEN | Sanitizers are strong; versioning/migration policy is absent. |
| AUDIT0827-ARCH-6 | AUDIT0827 | Medium | Architecture | Frontend and database releases not coupled | `.github/workflows/test.yml` has no deploy stage; no compatibility rule documented | STILL_OPEN | |
| AUDIT0827-ARCH-7 | AUDIT0827 | Low | Architecture | Desktop screens capped at 480 px | `index.html:212` `#app{max-width:480px}`; `index.html:408` `@media (min-width:900px)` block + `#desktopSidebar` (`index.html:767`) | PARTIAL | A desktop shell and sidebar shipped (with `scripts/browser-check/desktop-layout.mjs` coverage); the content column is still 480 px. |

### Source: 2026-08-27 full application audit — Security

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| AUDIT0827-SEC-H1 | AUDIT0827 | High | Security | Cross-user photo disclosure through `photo_path` | `supabase/migrations/202608270006_security_hardening.sql:175-186` (backfill + `workout_posts_photo_owner` trigger enforcing `split_part(photo_path,'/',1) = author_id`), `:210` storage read policy joins the same predicate | VERIFIED_FIXED | Re-verified directly, not taken from the rescan's claim. |
| AUDIT0827-SEC-H2 | AUDIT0827 | High | Security | Coach invite codes allow privilege escalation | `202608270006_security_hardening.sql:9-20` (`code_hash` sha256, unique, `expires_at`, `max_uses` 1..1000), `:75-77` atomic redemption, `:95-99` creation guards; `202608280013_invite_actor_throttle.sql:24-48` actor-key throttle; coach promotion is a separate service-role function | VERIFIED_FIXED | |
| AUDIT0827-SEC-M3 | AUDIT0827 | Medium | Security | Unbounded upload path for any authenticated user | `202608270006_security_hardening.sql` storage policies require an active profile + redemption; 20-object post-photo quota | VERIFIED_FIXED | Aggregate byte budget still absent — tracked as RESCAN-L4. |
| AUDIT0827-SEC-M4 | AUDIT0827 | Medium | Security | Clickjacking defense ineffective on the static host | `index.html:19-31` documents the limitation; `index.html:48` `frame-ancestors 'none'` present in meta (spec-ignored there) | STILL_OPEN | Needs a hosting/edge change. Ticket COMM-337, status `todo`. |
| AUDIT0827-SEC-M5 | AUDIT0827 | Medium | Security | Reporting lacks trusted moderator status transitions | `202608270006_security_hardening.sql:226-244` `review_report()`; later reshaped by `202608280025`; client queue `cloud.js:5074`, `cloud.js:11912` | VERIFIED_FIXED | |
| AUDIT0827-SEC-M6 | AUDIT0827 | Medium | Legal | Privacy and terms are launch drafts | `PRIVACY.md`/`TERMS.md` — zero matches for draft/to-do/placeholder/TBD/bracketed language; `privacy.html`/`terms.html` shipped; `test/community-legal-pages.test.mjs` pins the facts | VERIFIED_FIXED | See AUDIT-RECON-005 for the residual (external legal sign-off). |
| AUDIT0827-SEC-L7 | AUDIT0827 | Low | Security | CSP permits every Supabase project | `index.html:41-42` — `img-src`/`connect-src` name the exact project host `jajmlyrjlkhclgphbfbb.supabase.co` (+ `wss:`) | VERIFIED_FIXED | CSP reporting endpoint still absent (low). |
| AUDIT0827-SEC-L8 | AUDIT0827 | Low | Privacy | Device data and JSON backups remain plaintext | `app.js:1574,1591` `downloadBackup()` with no warning; no plaintext/shared-device language in `PRIVACY.md` or `privacy.html` | STILL_OPEN | Also flagged independently as DSYNC-CONTENT-5. |
| AUDIT0827-SEC-L9 | AUDIT0827 | Low | Security | Staff status enumerable for arbitrary user IDs | `202608280001_clubs_and_rbac.sql:238` `is_staff()` takes no argument; `:242-243` revoked from public/anon | VERIFIED_FIXED | |

### Source: 2026-08-27 full application audit — UI, UX and accessibility

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| AUDIT0827-UX-1 | AUDIT0827 | High | Accessibility | Modal behaviour inconsistent for keyboard users | `app.js:3710-3739` `APP_DIALOGS` + Escape/Tab-trap handler; `app.js:3814-3859` registers all 10 overlays; opener storage + focus restore present (40 `openerEl` references) | PARTIAL | Escape policy, focus trap, initial focus and restore all ship (COMM-328/349). Background `inert` was asked for and never implemented — zero `inert` usages repo-wide. |
| AUDIT0827-UX-2 | AUDIT0827 | High | Accessibility | Tab controls lack expected keyboard behaviour | `app.js:3760-3795` generic tablist handler (Arrow/Home/End, RTL-aware, re-finds selected tab after rerender); roving `tabindex` at `app.js:128`, `app.js:3613-3615`, `cloud.js:11141`, `:11328`, `:11414`; `test/tablist-keyboard.test.mjs` | PARTIAL | Community subtabs are now real tabs too. Remaining gap: the desktop-sidebar rows (`app.js:195`) carry `role="tab"` without roving `tabindex` or a `role="tablist"` parent. |
| AUDIT0827-UX-3 | AUDIT0827 | High | Accessibility | Text enlargement uses CSS `zoom` with hidden overflow | `index.html:190` `html[data-text-scale="large"]{zoom:var(--text-scale)}`; `index.html:212` `#app{...overflow-x:hidden}` | PARTIAL | `--text-scale` restored to 1.2 (COMM-352), `overflow-x:hidden` removed from `body`/`.app-shell` with a documented rationale (`index.html:166-177`), and `text-scale.mjs` checks overflow. Still `zoom`-based, and no 320 px / 200% reflow check. |
| AUDIT0827-UX-4 | AUDIT0827 | Medium | Accessibility | Focus styles do not cover all interactive elements | `index.html:191` — `button, input, textarea, select, a, [tabindex]` all get `:focus-visible` outline | VERIFIED_FIXED | |
| AUDIT0827-UX-5 | AUDIT0827 | Medium | Accessibility | Secondary text contrast fails WCAG AA | `index.html:99` `--steel:#57627A` light, `:135`/`:148` `#A8B3C9` both dark paths; `index.html:105` `--brass:#956529` (5.03:1); `test/brass-contrast.test.mjs` | PARTIAL | Both named failures fixed and one is test-pinned. The rescan's "test which checks every theme token pair" was not built. |
| AUDIT0827-UX-6 | AUDIT0827 | Medium | Accessibility | Core landmarks and headings missing | `index.html:767` `<nav id="desktopSidebar">`, `:769` `<header>`, `:791` `<main>`, `:817` `<nav class="modal-list">`; `app.js:205-209` `renderTabHeader()` emits `<h1 class="page-title">`; `test/heading-outline.test.mjs` | PARTIAL | See DSYNC-A11Y-2 / COMM-329 for the exact residue (no `<footer>`, tablist outside `<nav>`, unlabelled tabpanel, community screens uncovered). |
| AUDIT0827-UX-7 | AUDIT0827 | Medium | Accessibility | Dynamic screen changes lack focus movement or announcements | `index.html:791` `#content` has `role="tabpanel"` and `aria-controls` from each tab; per-tab `<h1>` gives a landing target | PARTIAL | Tabpanel has no `aria-labelledby` back to the selected tab and there is no live-region policy. Rolled into the DSYNC-A11Y-2 punch-list entry. |
| AUDIT0827-UX-8 | AUDIT0827 | Medium | Accessibility | Calendar lacks grid semantics and full accessible dates | `app.js:2646-2683` `renderCalendarGrid()` emits bare `<button class="cal-cell">` with `aria-label` = day number + status; no `role="grid"`, no `aria-current`, no arrow keys | STILL_OPEN | `aria-label` improved (day + "יש נתונים"/"שיא אישי"), but the grid pattern the finding asked for is absent. |
| AUDIT0827-UX-9 | AUDIT0827 | Medium | Accessibility | Form errors lack persistent field-level descriptions | `cloud.js:4377-4385` `field()` splices `aria-invalid` + `aria-describedby`; `app.js:2058` sets `aria-invalid` on the WOD builder name and focuses it, with no `aria-describedby` | PARTIAL | Community forms route through `field()`; app.js core forms do not. |
| AUDIT0827-UX-10 | AUDIT0827 | Medium | Accessibility | Shared photos always use empty alt text | `cloud.js:9231` composer alt-text input (`ALT_TEXT_MAX`), `cloud.js:6211` renders `alt="${alt}"` with explicit decorative opt-out; but `cloud.js:11151` legacy card still `alt=""` | PARTIAL | The shipped `post_media` path is fixed; the legacy `photo_path` fallback card is not. |
| AUDIT0827-UX-11 | AUDIT0827 | Medium | Accessibility | SVG charts lack accessible name and data alternative | `app.js:2306-2314` — `role="img"` + a computed Hebrew trend summary (range, endpoints, PR count); `test/chart-accessible-name.test.mjs` | PARTIAL | Accessible name done (COMM-359). The adjacent data table/list the finding also asked for was not built. |
| AUDIT0827-UX-12 | AUDIT0827 | Medium | UX | Numeric inputs visually cleared on focus | Stepper uses `select()` instead of clearing; `test/stepper-tap-type.test.mjs` | VERIFIED_FIXED | |
| AUDIT0827-UX-13 | AUDIT0827 | Low | UX | Icon targets too small for mobile | `index.html:243` `.tabbtn{min-height:44px}`; calendar/icon targets raised | VERIFIED_FIXED | |
| AUDIT0827-UX-14 | AUDIT0827 | Low | UX | Community photo picker is an emoji with title text | Composer has a visible-text picker plus per-photo alt field (`cloud.js:9228-9231`) | VERIFIED_FIXED | |
| AUDIT0827-UX-15 | AUDIT0827 | Low | UX | Essential secondary text at 9–13 px | `index.html:263,281,284,291,292` — `.stat-label` 11 px, `.bar-caption` 11 px, `.stepper-label` 11 px, `.section-label` 12 px, `.empty` 13 px | STILL_OPEN | No rem token scale for body copy. |

### Source: 2026-08-27 full application audit — QA

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| AUDIT0827-QA-1 | AUDIT0827 | High | QA | Browser checks do not run in CI | `.github/workflows/test.yml` `browser-checks` job installs Playwright Chromium and runs `run-all.mjs` | VERIFIED_FIXED | |
| AUDIT0827-QA-2 | AUDIT0827 | High | QA | Aggregate browser runner omits existing scripts | `scripts/browser-check/run-all.mjs:15` auto-discovers every scenario and runs all regardless of earlier failures; 29 scenarios on disk | VERIFIED_FIXED | Also closes DSYNC-QA-2 (abort-on-first-failure). |
| AUDIT0827-QA-3 | AUDIT0827 | High | QA | No automated two-user RLS suite | 77 files in `supabase/tests/`; `migration-check` job runs `supabase start` + `supabase test db` with no `continue-on-error` | PARTIAL | The suite is real, large and a hard gate. It has never been validated against the live project, and it creates no storage objects, so storage policies are still untested (`docs/community/backlog.md:160-164`). |
| AUDIT0827-QA-4 | AUDIT0827 | High | QA | No end-to-end community test against staging | `scripts/smoke-test-multi-role.mjs` exists, deliberately outside CI, never executed (no staging project, no test accounts) | STILL_OPEN | Same root cause as DSYNC-SEC-2 / COMM-338. |
| AUDIT0827-QA-5 | AUDIT0827 | Medium | QA | Accessibility automation absent | `test/tablist-keyboard.test.mjs`, `test/community-dialog-focus.test.mjs`, `test/heading-outline.test.mjs`, `test/chart-accessible-name.test.mjs`, `test/brass-contrast.test.mjs` exist; no axe dependency in `package.json`; no 320 px/200% reflow check | PARTIAL | Targeted a11y tests shipped; the scanner-based half did not. |
| AUDIT0827-QA-6 | AUDIT0827 | Medium | QA | Offline recovery needs fault injection | `test/storage-quota-exceeded.test.mjs` covers quota; nothing covers partial cache, IDB denial, corrupt records, clock skew, interrupted upgrades | STILL_OPEN | |
| AUDIT0827-QA-7 | AUDIT0827 | Medium | QA | Cross-browser coverage undefined | `scripts/browser-check/*` import `chromium` only; no matrix documented | STILL_OPEN | |
| AUDIT0827-QA-8 | AUDIT0827 | Medium | QA | Performance budgets absent | Only `scripts/browser-check/community-render-cost.mjs` (a spike instrument, not a budget gate) | STILL_OPEN | Merged with AUDIT0827-PERF-1 in the punch list. |
| AUDIT0827-QA-9 | AUDIT0827 | Medium | QA | Backup compatibility needs version fixtures | `test/sanitizers.test.mjs`, `test/import.test.mjs` cover shape/prototype pollution; no per-version backup fixtures | PARTIAL | Import safety is strong; version-forward compatibility is untested. |
| AUDIT0827-QA-10 | AUDIT0827 | Low | QA | Offline advisory scan is not current threat intel | No scheduled online scan; no Dependabot config in `.github/` | STILL_OPEN | Folded into the supply-chain punch-list item. |

### Source: 2026-08-27 full application audit — DevOps

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| AUDIT0827-OPS-H1 | AUDIT0827 | High | DevOps | No deployment pipeline or release gate | `.github/workflows/` contains only `test.yml` | STILL_OPEN | Same as RESCAN-H4. |
| AUDIT0827-OPS-H2 | AUDIT0827 | High | DevOps | Real-browser checks excluded from CI | `test.yml` `browser-checks` job | VERIFIED_FIXED | |
| AUDIT0827-OPS-H3 | AUDIT0827 | High | DevOps | Migrations depend on manual SQL execution | `test.yml` `migration-check` job runs `supabase start` (applies all 101 migrations) + `supabase test db` on a disposable stack | VERIFIED_FIXED | Validation is automated; *deployment* of migrations to production is still manual — covered by OPS-H1. |
| AUDIT0827-OPS-H4 | AUDIT0827 | High | DevOps | Account purge not implemented as versioned infrastructure | `supabase/migrations/202609050005_scheduled_jobs.sql:252-306` schedules 7 jobs — `notif-batch-flush`, `feed-weights-recompute`, `chal-notify-ending-soon`, `coach-engagement-decline`, `purge-abandoned-profiles`, `recap-weekly`, `telemetry-retention-purge` — and **not** `purge_due_accounts()`, which is named only in a comment at `:43`; the sole instruction remains `COMMUNITY_SETUP.md:83` | STILL_OPEN | **Most concerning open item.** The scheduler that would have closed this shipped and skipped the one job PRIVACY.md makes a 30-day promise about. |
| AUDIT0827-OPS-M5 | AUDIT0827 | Medium | DevOps | Environment config hard-coded in a tracked file | `cloud-config.js:5-6` — production Supabase URL and publishable key committed; no template, no deploy-time generation, no staging marker | STILL_OPEN | Key is non-secret by design; the risk is target confusion, exactly as the rescan framed it. |
| AUDIT0827-OPS-M6 | AUDIT0827 | Medium | DevOps | Service worker accepts an incomplete app shell | `sw.js:24` `REQUIRED_ASSETS` / `:43` `OPTIONAL_ASSETS`; `:91` required assets fail install as one atomic group, `:93` optional assets tolerate failure | VERIFIED_FIXED | `sw.js:44` also has `./cloud.js` in OPTIONAL — closes DSYNC-PERF-1/COMM-330. |
| AUDIT0827-OPS-M7 | AUDIT0827 | Medium | DevOps | Supply-chain controls incomplete | `test.yml` pins all 3 actions by SHA; `scripts/check-vendored-supabase-version.mjs` compares version strings only; no SBOM, no license review, no scheduled online scan, no Dependabot | PARTIAL | Pinning done; SBOM/scan/checksum not. |
| AUDIT0827-OPS-M8 | AUDIT0827 | Medium | DevOps | Monitoring and health checks missing | `src/analytics.js` writes product events to `public.analytics_events` only; no error sink, no uptime/synthetic check, no purge/outbox metrics | STILL_OPEN | |
| AUDIT0827-OPS-M9 | AUDIT0827 | Medium | DevOps | Service backup and recovery not defined | No RPO/RTO or restore-drill document anywhere under `docs/` or the repo root | STILL_OPEN | |
| AUDIT0827-OPS-L10 | AUDIT0827 | Low | DevOps | Runtime and contributor setup under-specified | `package.json` `engines.node: ">=22"`; no `packageManager` field | PARTIAL | Node version declared (closes the main half); `packageManager` still absent — see RESCAN-L3. |
| AUDIT0827-OPS-L11 | AUDIT0827 | Low | DevOps | CI lacks cancellation for superseded changes | `test.yml` `concurrency: group ... cancel-in-progress: true` | VERIFIED_FIXED | |

### Source: 2026-08-27 full application audit — Performance and data/privacy

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| AUDIT0827-PERF-1 | AUDIT0827 | Medium | Performance | No performance budgets set or measured | No budget doc; only the COMM-366 render-cost spike instrument | STILL_OPEN | |
| AUDIT0827-PRIV-1 | AUDIT0827 | Medium | Privacy | Data inventory, retention, deletion, consent recording | `PRIVACY.md` + `privacy.html` now enumerate photos, comments, follows, visibility toggles, admin directory, attendance signal; `retention_purge_telemetry()` 90-day window scheduled; 30-day deletion window documented | PARTIAL | Inventory and retention largely written and partly enforced. The one enforcement hole is the unscheduled `purge_due_accounts()` (OPS-H4); consent/terms-version recording per user is not implemented. |

### Source: 2026-08-27 remediation rescan

Rows that restate a 2026-08-27 audit finding carry the original ID in Notes rather than
being re-adjudicated.

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| RESCAN-H1 | RESCAN | High | Security | Anonymous sign-in has no identity recovery and weakens abuse controls | Anonymous auth replaced by username+password (`cloud.js:3770` `usernameToEmail()`), gated on `profiles.recovery_verified_at` (`cloud.js:862,872,940-943`), with an admin-triggered reset Edge Function (`supabase/functions/admin_reset_password/`, `cloud.js:3063`); throttle is actor-keyed (`202608280013_invite_actor_throttle.sql:24-48,62-81`) | VERIFIED_FIXED | Both halves — recoverable identity and an actor-level throttle surviving session replacement — are real. |
| RESCAN-H2 | RESCAN | High | Accessibility | Dialog keyboard and focus management incomplete | See AUDIT0827-UX-1 | PARTIAL | Duplicate of AUDIT0827-UX-1. Only `inert` remains. |
| RESCAN-H3 | RESCAN | High | Accessibility | ARIA tabs lack keyboard behaviour | See AUDIT0827-UX-2 | PARTIAL | Duplicate of AUDIT0827-UX-2. |
| RESCAN-H4 | RESCAN | High | DevOps | No deployment workflow or release rollback gate | See AUDIT0827-OPS-H1 | STILL_OPEN | Duplicate of AUDIT0827-OPS-H1. |
| RESCAN-H5 | RESCAN | High | DevOps | Account purge depends on unversioned external scheduling | See AUDIT0827-OPS-H4 | STILL_OPEN | Duplicate of AUDIT0827-OPS-H4. The scheduler now exists but omits this job. |
| RESCAN-M1 | RESCAN | Medium | Security | Clickjacking protection depends on a different host | See AUDIT0827-SEC-M4 | STILL_OPEN | COMM-337 `todo`. |
| RESCAN-M2 | RESCAN | Medium | Accessibility | Explicit dark theme uses the old low-contrast `--steel` | `index.html:135` (auto dark) and `index.html:148` (explicit dark) both `#A8B3C9` | VERIFIED_FIXED | The "same token in both dark paths" half is done; the "test every theme token pair" half is not (see AUDIT0827-UX-5). |
| RESCAN-M3 | RESCAN | Medium | Accessibility | Text enlargement still relies on CSS zoom | See AUDIT0827-UX-3 | PARTIAL | |
| RESCAN-M4 | RESCAN | Medium | Accessibility | Landmarks and heading structure weak | See AUDIT0827-UX-6 / DSYNC-A11Y-2 | PARTIAL | |
| RESCAN-M5 | RESCAN | Medium | Accessibility | Calendar lacks grid semantics | See AUDIT0827-UX-8 | STILL_OPEN | |
| RESCAN-M6 | RESCAN | Medium | Accessibility | Unlabelled fields and weak error linkage | `cloud.js:4377-4385` `field()` helper covers community forms; challenge/invite/comment fields route through it | PARTIAL | Same as AUDIT0827-UX-9. DSYNC-A11Y-8 notes a few coach/admin inputs still placeholder-only. |
| RESCAN-M7 | RESCAN | Medium | Accessibility | Community photos have no text alternative | See AUDIT0827-UX-10 | PARTIAL | |
| RESCAN-M8 | RESCAN | Medium | Accessibility | Charts lack accessible descriptions and data equivalents | See AUDIT0827-UX-11 | PARTIAL | |
| RESCAN-M9 | RESCAN | Medium | Product | Moderation has server transitions but no admin review interface | `cloud.js:2253` reasons, `:2273-2279` `mod_queue()` read, `:5074` queue render, `:10925` reason radio group, `:11912` actions | VERIFIED_FIXED | |
| RESCAN-M10 | RESCAN | Medium | DevOps | Environment selection hard-coded | See AUDIT0827-OPS-M5 | STILL_OPEN | |
| RESCAN-M11 | RESCAN | Medium | DevOps | Service recovery not documented or tested | See AUDIT0827-OPS-M9 | STILL_OPEN | |
| RESCAN-M12 | RESCAN | Medium | DevOps | Supply-chain reporting partial | See AUDIT0827-OPS-M7 | PARTIAL | |
| RESCAN-L1 | RESCAN | Low | UX | Desktop content capped at 480 px | See AUDIT0827-ARCH-7 | PARTIAL | |
| RESCAN-L2 | RESCAN | Low | UX | Labels and secondary messages at 9–13 px | See AUDIT0827-UX-15 | STILL_OPEN | |
| RESCAN-L3 | RESCAN | Low | DevOps | `package.json` declares Node but not `packageManager` | `package.json` has `engines.node` only | STILL_OPEN | Trivial fix; grouped under AUDIT0827-OPS-L10. |
| RESCAN-L4 | RESCAN | Low | Security | Photo quota is object-count based, no aggregate byte budget | 20-object quota from `202608270006`; no byte budget added since | STILL_OPEN | Partly mitigated: `src/image.js` re-encodes and downsizes client-side before upload. |
| RESCAN-L5 | RESCAN | Low | QA | Browser suite targets Chromium only | See AUDIT0827-QA-7 | STILL_OPEN | |

### Source: 2026-09-02 design sync and cross-repo audit — Design tokens

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-DT-1 (P0 #1) | DSYNC | P0 | Design | `--shadow-sm` token deleted, flattening active-state affordances | `index.html:124,143,156` define it in all three theme paths; re-applied at `:244` `.tabbtn.active`, `:390` `.navrow.tabbtn.active`, `:464` `.subtabbtn.active`, `:469` `.rx-btn.active-type` | VERIFIED_FIXED | COMM-322. |
| DSYNC-DT-2 | DSYNC | P1 | Design | `--shadow-card` formula differs per app | Community's redesigned formula is intentional and shipped; `crossfit-pwa-Noam` never received the backport (`backlog.md:3382-3387`) | PARTIAL | COMM-351. Nothing to change in *this* repo — the residual work is in a repo outside this workspace. |
| DSYNC-DT-3 | DSYNC | P1 | Design | "Large text" scales 20% vs 12% | `index.html:130` `--text-scale: 1.2`; `:190` applies it | VERIFIED_FIXED | COMM-352. |
| DSYNC-DT-4 | DSYNC | P1 | Design | `.page-title` typography diverges | `index.html:402` Anton/400 + tracking, intentional here; Noam still Rubik/800 | PARTIAL | COMM-353, Noam-side only. |
| DSYNC-DT-5 | DSYNC | P1 | Design | `--steel` value differs between repos | `index.html:99,135,148` — Community's AA-clearing values; Noam still pre-fix | PARTIAL | COMM-354, Noam-side only. |
| DSYNC-DT-6 | DSYNC | P1 | Design | `.icon-btn` removed; two header icon buttons use different treatments | `index.html:771,775` — both header buttons now use `class="icon-chip icon-chip-steel"` | VERIFIED_FIXED | COMM-345. |
| DSYNC-DT-7 | DSYNC | P2 | Design | `.save-btn` gradient vs. flat | Community keeps the `color-mix()` gradient by choice | NO_LONGER_APPLICABLE | Cross-repo style reconciliation; Community's treatment is the intended one. |
| DSYNC-DT-8 | DSYNC | P2 | Design | `color-mix()` adopted only in Community | Still Community-only | NO_LONGER_APPLICABLE | Backport-to-Noam item, outside this repo. |
| DSYNC-DT-9 | DSYNC | P2 | Design | Border-radius drift across card components | Not reconciled | NO_LONGER_APPLICABLE | Cross-repo cosmetic; no in-repo defect. |
| DSYNC-DT-10 | DSYNC | P2 | Design | 44 px tap targets and broad `:focus-visible` are ahead in Community | `index.html:191,243` — confirmed present and correct here | VERIFIED_FIXED | Backport direction is Noam-ward; nothing owed here. |
| DSYNC-DT-11 | DSYNC | P2 | Design | Bottom tab-bar visual language diverges | Resolved downstream of the nav decision; `index.html:845` `#bottomTabBar` is the shipped pattern | VERIFIED_FIXED | COMM-350, plus the 2026-09-04 "Community promoted to the bottom tab bar" decision. |
| DSYNC-DT-12 | DSYNC | P2 | Design | `.plate::after` metallic sheen only in Community | Present here | NO_LONGER_APPLICABLE | Backport-to-Noam item. |
| DSYNC-DT-13 | DSYNC | P3 | Design | `--avatar-ink` is correctly Community-scoped | No action required | VERIFIED_FIXED | Informational. |

### Source: 2026-09-02 — Shared-screen parity

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-SS-1 (P0 #15) | DSYNC | P0 | UX/IA | Bottom tab bar replaced by hamburger nav — needs an explicit decision | `index.html:845` bottom tablist + `index.html:767` desktop sidebar; `backlog.md:3799-3850` records the reversal and its reasoning | VERIFIED_FIXED | Decided twice, explicitly, with test coverage (`test/nav-community-bottom-tab.test.mjs`) and a real browser-check regression caught and fixed. |
| DSYNC-SS-2 (P0 #2) | DSYNC | P0 | Design | Settings screen never received the card-based redesign | Settings now renders card-based panes with the cloud-aware staleness banner at `app.js:3046` and legal links at `:3093` | VERIFIED_FIXED | COMM-323 + COMM-355. |
| DSYNC-SS-3 (P0 #3) | DSYNC | P0 | UX | WOD Builder regressed the create-button placement fix | WOD builder is registered on `APP_DIALOGS` (`app.js:3854`) and the pinned bottom-bar action is covered by `test/wod-save-button-pinned.test.mjs` | VERIFIED_FIXED | COMM-324. |
| DSYNC-SS-4 | DSYNC | P1 | Design | Calendar missing `.cal-panel`, `.cal-legend`, `.cal-month-stats` | `app.js:2866` `.cal-panel`, `:2878-2881` `.cal-legend`, `:2882` `.cal-month-stats`, populated at `:2673-2680` | VERIFIED_FIXED | COMM-341. |
| DSYNC-SS-5 | DSYNC | P1 | UX | Calendar prev/next chevrons reversed | `app.js:2869` prev draws `M15 6l-6 6 6 6` (left), `:2873` next draws `M9 6l6 6-6 6` (right) | VERIFIED_FIXED | COMM-342 swapped them; convention now prev=left/next=right. |
| DSYNC-SS-6 | DSYNC | P1 | Design | Home/log lost the exercise-select empty state and `.stat-hero` | `index.html:254` `.exercise-select.log-empty-hint`, `:261` `.stat-hero` | VERIFIED_FIXED | COMM-343 + COMM-360. |
| DSYNC-SS-7 | DSYNC | P1 | Content | Onboarding subtitle says "four screens" but lists five | `index.html` onboarding modal now reads "חמישה מסכים" with 5 rows | VERIFIED_FIXED | COMM-344. |
| DSYNC-SS-8 | DSYNC | P1 | Design | Header icon buttons use two different styles | See DSYNC-DT-6 | VERIFIED_FIXED | |
| DSYNC-SS-9 | DSYNC | P2 | Design | Achievements panel missing progress chips / capstone styling / `.ach-invite` | Achievements overlay is registered (`app.js:3855`) and styled; the specific chrome parity items were folded into the design-sync batch | VERIFIED_FIXED | Marked `done` under COMM-350's batch; no residual defect found in-repo. |
| DSYNC-SS-10 | DSYNC | P2 | Design | Settings staleness logic kept but lost `.settings-warn` visual treatment | `app.js:3046` uses `class="settings-warn" role="status"` with the ⚠️ icon | VERIFIED_FIXED | COMM-355. |

### Source: 2026-09-02 — Community-only screens

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-COMM-1 (P0 #4) | DSYNC | P0 | Design | `.chip-btn.primary` used for "selected" state in ~13 places | `index.html:581` `.chip-btn.selected` defined; selected-state call sites use `" selected"` (`cloud.js:11141`, `:11154`, and peers) | VERIFIED_FIXED | COMM-325. 54 remaining `chip-btn primary` uses are genuine primary *actions* (retry, publish, confirm), not selection state. |
| DSYNC-COMM-2 (P0 #5) | DSYNC | P0 | Design | Post menu / mention picker hardcode `background:#1f2023` | `index.html:658` `.post-menu{background:var(--surface)}`; `cloud.js:5014` mention picker uses `var(--surface)`/`var(--border)`; zero `background:#RRGGBB` literals remain in `cloud.js` | VERIFIED_FIXED | COMM-326. |
| DSYNC-COMM-3 | DSYNC | P1 | Design | No `.chip-btn.danger`; destructive actions styled 3 ad-hoc ways | `index.html:587` `.chip-btn.danger`, `:588` `.chip-btn.primary.danger` | VERIFIED_FIXED | COMM-346. |
| DSYNC-COMM-4 | DSYNC | P1 | Architecture | ~19 community-only classes with zero CSS backing; 722 inline `style=` | `index.html:643-660` now backs `post-media-grid`, `post-menu`, `post-menu-item` etc.; but `cloud.js` inline `style="` count is now **780**, up from 722 | PARTIAL | COMM-347 promoted the high-traffic components; the overall inline-style trend reversed. See AUDIT-RECON-004. |
| DSYNC-COMM-5 | DSYNC | P1 | Design | `.post-media-grid` implies a grid but has no grid CSS | `index.html:643-644` — `display:grid; grid-template-columns:1fr 1fr; gap:6px` | VERIFIED_FIXED | COMM-348. |
| DSYNC-COMM-6 | DSYNC | P2 | Design | `.admin-tag` reused for a challenge "joined" badge | Given its own tag style | VERIFIED_FIXED | COMM-356. |
| DSYNC-COMM-7 | DSYNC | P2 | Design | Hardcoded `rgba()` tints break in dark mode | Replaced with `color-mix()` | VERIFIED_FIXED | COMM-357. |
| DSYNC-COMM-8 | DSYNC | P2 | Design | Avatar sizes are 7 arbitrary pixel literals | `avatarHtml(name, px, url)` still takes an arbitrary px argument (`cloud.js:758,764`) | STILL_OPEN | Low-severity; no shared avatar size scale. Folded under DSYNC-COMM-4 in the punch list. |
| DSYNC-COMM-9 | DSYNC | P2 | Design | Notification center re-implements feed typography inline | Not reconciled | STILL_OPEN | Folded under DSYNC-COMM-4. |
| DSYNC-COMM-10 | DSYNC | P2 | Docs | `.save-btn` vs `.chip-btn.primary` split is undocumented | `index.html:112` and `:337` now carry comments explaining the pairing and the danger/edit conventions | VERIFIED_FIXED | |

### Source: 2026-09-02 — Feature/fix diff (Noam → Community)

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-FEAT-1 | DSYNC | P1 | Correctness | `confirmClear` survives closing Settings without resetting | `closeSettings()` resets `confirmClear` and calls `render()`; pinned in `test/design-sync-audit-app-core.test.mjs` | VERIFIED_FIXED | COMM-339. |
| DSYNC-FEAT-2 | DSYNC | P1 | Accessibility | Modal focus trap wired for only 1 of 9 dialogs | See AUDIT0827-UX-1 | PARTIAL | Same gap as COMM-328/349; only `inert` remains. |
| DSYNC-FEAT-3 | DSYNC | P1 | UX | `interactive-widget=resizes-content` missing from viewport meta | `index.html:60` — present | VERIFIED_FIXED | COMM-340. |
| DSYNC-FEAT-4 | DSYNC | P2 | Performance | History search recomputes O(exercises × entries) per keystroke | Not ported | STILL_OPEN | Low impact at current data sizes; folded under AUDIT0827-PERF-1. |
| DSYNC-FEAT-5 | DSYNC | P2 | Correctness | App opens with Back Squat / Fran pre-selected | `movementExplicitlyChosen` flag added; `.log-empty-hint` empty state; 7 browser scenarios updated to pick explicitly | VERIFIED_FIXED | COMM-360. |
| DSYNC-FEAT-6 | DSYNC | P2 | Correctness | ~11 smaller Noam 2026-09-02 fixes never re-verified here | No record of a per-item re-check | PARTIAL | Explicitly deferred by the source audit as a dedicated follow-up pass; still not done. |

### Source: 2026-09-02 — Security

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-SEC-1 | DSYNC | P1 | Security | Clickjacking mitigation structurally absent | See AUDIT0827-SEC-M4 | STILL_OPEN | COMM-337 `todo` — the only `todo` in the design-sync ticket table. |
| DSYNC-SEC-2 | DSYNC | P1 | Security | Live/production RLS behaviour unverified | `scripts/smoke-test-multi-role.mjs` written for 5 roles, never executed; no staging project, no test accounts | STILL_OPEN | COMM-338 `partial`. Blocking for go-live. |
| DSYNC-SEC-3 | DSYNC | P2 | Product | Moderation has `review_report()` but no admin queue UI | See RESCAN-M9 | VERIFIED_FIXED | |
| DSYNC-SEC-4 | DSYNC | P2 | Supply chain | `vendor/supabase.js` version-checked but not checksum-checked | `scripts/check-vendored-supabase-version.mjs` matches a `t.version="X.Y.Z"` string only; `test/vendored-supabase-version.test.mjs` runs it under `npm test` | PARTIAL | The check runs in CI (via `npm test`), but a tampered bundle self-reporting the right version still passes. |
| DSYNC-SEC-5 | DSYNC | P2 | Security | Anon-key-plus-RLS assumption sampled, not exhaustively verified | Migration count grew 75 → 101 since; `202609060001`/`202609060009` closed a real anonymous-read hole the sampled pass missed | PARTIAL | The recommended full policy-by-policy pass has still not been done — and AUDIT-RECON-001 proves sampling was insufficient. |

### Source: 2026-09-02 — Accessibility

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-A11Y-1 (P0 #6) | DSYNC | P0 | Accessibility | Core training-log modals lost focus-trap/Escape | See AUDIT0827-UX-1; `app.js:3814-3859` registers all 10 | PARTIAL | Only `inert` remains. |
| DSYNC-A11Y-2 (P0 #7) | DSYNC | P0 | Accessibility | Zero heading elements and landmark regions anywhere | `index.html:767,769,791,817` landmarks; `app.js:205-209` `<h1>` per solo tab; `app.js`/`cloud.js` each contain 5 `<h1>`–`<h3>` occurrences; `test/heading-outline.test.mjs` covers 4 of ~9 top-level tabs | PARTIAL | COMM-329 `partial` by its own admission: no `<footer>`, tablist not inside `<nav>`, `#content` tabpanel has no `aria-labelledby`, community screens have almost no headings, no axe scan exists. |
| DSYNC-A11Y-3 | DSYNC | P1 | Accessibility | Tablist widgets lack Arrow-key/roving-tabindex | See AUDIT0827-UX-2 | PARTIAL | Desktop sidebar rows are the residue. |
| DSYNC-A11Y-4 | DSYNC | P1 | Accessibility | Trend chart has no accessible name or data alternative | See AUDIT0827-UX-11 | PARTIAL | Name done, data alternative not. |
| DSYNC-A11Y-5 | DSYNC | P1 | Accessibility | `--brass` fails AA at 4.22:1 | `index.html:100-105` — darkened to `#956529` (5.03:1 / 4.61:1), rationale in comment; `test/brass-contrast.test.mjs` computes it from the shipped tokens | VERIFIED_FIXED | COMM-361. |
| DSYNC-A11Y-6 | DSYNC | P2 | Accessibility | Calendar lacks grid semantics, `aria-current`, arrow keys | See AUDIT0827-UX-8 | STILL_OPEN | |
| DSYNC-A11Y-7 | DSYNC | P2 | Accessibility | Noam combines `zoom` scaling with `overflow-x:hidden` | Community documented its own removal at `index.html:166-177` | NO_LONGER_APPLICABLE | Noam-side item. Community's own residual `zoom` usage is tracked as AUDIT0827-UX-3. |
| DSYNC-A11Y-8 | DSYNC | P2 | Accessibility | A few coach/admin inputs are placeholder-only | `cloud.js:9241` composer textarea has `aria-describedby` but no label element; most inputs route through `field()` | PARTIAL | Folded into AUDIT0827-UX-9. |
| DSYNC-A11Y-9 | DSYNC | P2 | Accessibility | Report-reason radio group has no group label / `radiogroup` role | `cloud.js:10925` renders reasons as `<label class="log-row">` rows with no wrapping `role="radiogroup"` + label | STILL_OPEN | Small, contained fix. |
| DSYNC-A11Y-10 | DSYNC | P2 | Accessibility | Numeric-stepper clear-on-focus fixed in Community, not Noam | Fixed here | NO_LONGER_APPLICABLE | Noam-side item. |
| DSYNC-A11Y-11 | DSYNC | P2 | Accessibility | Noam's `:focus-visible` covers fewer elements | `index.html:191` — Community's broad rule is correct | NO_LONGER_APPLICABLE | Noam-side item. |

### Source: 2026-09-02 — Performance and PWA

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-PERF-1 (P0 #8) | DSYNC | P0 | Performance | `cloud.js` is a REQUIRED precache asset, blocking the offline shell | `sw.js:43-44` — `./cloud.js` is in `OPTIONAL_ASSETS`; `sw.js:91` requires only `REQUIRED_ASSETS`, `:93` tolerates optional failures | VERIFIED_FIXED | COMM-330. `test/sw-precache.test.mjs` asserts the split. |
| DSYNC-PERF-2 (P0 #9) | DSYNC | P0 | Performance | ~16 parallel Supabase requests on every page load | `cloud.js:55-60,827-860` — `ensureCommunityDataLoaded()` is gated and deferred; `cloud.js:11612` is the single deferred entry point, fired on first Community-tab open | VERIFIED_FIXED | COMM-331. |
| DSYNC-PERF-3 | DSYNC | P1 | Performance | No dynamic `import()` / code splitting | Zero `import(` occurrences in `cloud.js`/`app.js` | STILL_OPEN | 841 KB parsed synchronously on every load. |
| DSYNC-PERF-4 | DSYNC | P1 | Performance | `cloud.js` is unminified with no minify step | No `minify` script in `package.json` | STILL_OPEN | Build-free by design; would need a release-time step. |
| DSYNC-PERF-5 | DSYNC | P1 | UX | No unified offline/degraded-mode banner for the community layer | Failures still per-feature (`cloud.js` feed error text, per-widget error states) | STILL_OPEN | |
| DSYNC-PERF-6 | DSYNC | P2 | Docs | `REQUIRED_ASSETS` classification undocumented | `sw.js:24-44` now carries the rationale comment for both lists | VERIFIED_FIXED | |
| DSYNC-PERF-7 | DSYNC | P2 | Performance | 11 sequential `<script>` tags, no `async`/`defer`, fragile ordering | `index.html:1087-1102` — now 12 tags, still no `async`/`defer`; `cloud.js` still loads before `src/constants.js`/`format.js`/`sanitize.js`/`db.js` | STILL_OPEN | Count went up by one (`src/shared/safe-helpers.js`). |
| DSYNC-PERF-8 | DSYNC | P2 | Performance | `openDB()` memoised, DB namespaced | `src/db.js` | VERIFIED_FIXED | Informational/positive. |
| DSYNC-PERF-9 | DSYNC | P2 | PWA | No manifest shortcut into `?tab=community` | `manifest.json:20-38` — 2 shortcuts (`?tab=add`, `?tab=wod`), none for community | STILL_OPEN | More salient now that Community is a bottom-bar tab. |
| DSYNC-PERF-10 | DSYNC | P2 | Performance | No significant dead code in either `app.js` | Spot-confirmed | VERIFIED_FIXED | Informational. |

### Source: 2026-09-02 — Code architecture

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-ARCH-1 | DSYNC | P1 | Architecture | `cloud.js` flat `state` with ~89 keys, no namespacing | `cloud.js:135-237` — namespaced by feature domain (`admin`, `feed`, `posts`, `roster`, `ui`, …); `test/community-state-namespaces.test.mjs` pins it | VERIFIED_FIXED | COMM-365. |
| DSYNC-ARCH-2 | DSYNC | P1 | Architecture | Full-tree `innerHTML` rerender under strain (341 call sites) | `docs/community/2026-09-03-render-architecture-spike.md`; measured with `scripts/browser-check/community-render-cost.mjs` | PARTIAL | COMM-366: spiked, measured, and deliberately kept. Decision is documented and defensible; the underlying strain is unchanged. |
| DSYNC-ARCH-3 | DSYNC | P1 | Architecture | HTML escaping implemented twice (`esc()` vs `safeText()`) | Zero `safeText` occurrences in `cloud.js`; `src/shared/safe-helpers.js` is the single source, loaded first at `index.html:1087` | VERIFIED_FIXED | COMM-367. |
| DSYNC-ARCH-4 | DSYNC | P1 | Architecture | Core safety helpers are two independently-maintained copies across repos | `src/shared/safe-helpers.js` exists in this repo; no shared package/submodule reaching `crossfit-pwa-Noam` | PARTIAL | COMM-368 `partial` — the cross-repo half is structurally impossible from this workspace. |
| DSYNC-ARCH-5 | DSYNC | P2 | Architecture | Community modularised into `src/*.js`; Noam stayed monolithic | `src/` holds 8 modules + `src/shared/` | NO_LONGER_APPLICABLE | Cross-repo divergence; Community's direction is the intended one. |
| DSYNC-ARCH-6 | DSYNC | P2 | Architecture | `getFieldValue`/`setFieldState` dispatch style diverged | `FIELD_ACTIONS` table here | NO_LONGER_APPLICABLE | Cross-repo cosmetic. |
| DSYNC-ARCH-7 | DSYNC | P2 | Architecture | `isIOSDevice()` duplicated within Community | `app.js:4057` and `cloud.js:10113` — both still present | STILL_OPEN | Small, contained. |
| DSYNC-ARCH-8 | DSYNC | P2 | Architecture | 700+ inline `style=` in `cloud.js` | Now 780 (vs. 276 in `app.js`) | STILL_OPEN | Regressed. See DSYNC-COMM-4 and AUDIT-RECON-004. |
| DSYNC-ARCH-9 | DSYNC | P2 | Architecture | `render()`'s single try/catch has no error classification or reporting hook | No routing through `src/analytics.js` for render errors | STILL_OPEN | Ties to AUDIT0827-OPS-M8 (no error sink to route to). |
| DSYNC-ARCH-10 | DSYNC | P2 | Architecture | `sanitizeWodEntry`/`sanitizeCustomWod` field parity drifted | Community added `partnerTag`, typed EMOM slots | NO_LONGER_APPLICABLE | Cross-repo; a landmine only if a shared extraction is attempted (DSYNC-ARCH-4). |
| DSYNC-ARCH-11 | DSYNC | P2 | Architecture | `cloud.js` section comments are well organised | Confirmed | VERIFIED_FIXED | Informational/positive. |
| DSYNC-ARCH-12 | DSYNC | P2 | Architecture | No documented convention for silent-catch vs. user-visible-error | No such convention in `docs/` | STILL_OPEN | |

### Source: 2026-09-02 — Test coverage and QA

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-QA-1 (P0 #10) | DSYNC | P0 | QA | pgTAP suite failing 68/1995 assertions; backlog wrongly calls it non-blocking | `backlog.md:29-33` records a clean re-run (`Files=56, Tests=1995, PASS`) and attributes the 68 to a stale environment; suite is now 77 files; `test.yml` `migration-check` has no `continue-on-error` | VERIFIED_FIXED | COMM-332. Not re-run in this pass (needs Docker) — the correction and the hard-gate status are both verified in-file. |
| DSYNC-QA-2 (P0 #11) | DSYNC | P0 | QA | `run-all.mjs` aborts on first failure, hiding up to 6/24 scenarios | `scripts/browser-check/run-all.mjs:15` — "every script regardless of earlier failures and reports the full set"; single `process.exit(1)` at `:42` after the full report | VERIFIED_FIXED | COMM-333. 29 scenarios now on disk. |
| DSYNC-QA-3 (P0 #12) | DSYNC | P0 | Security | Production repo `haimunia-app` reportedly ships no CSP | `index.html:29-31` — comment corrected in place; `backlog.md:3109-3118` records direct verification against `origin/main` and a live `curl` | VERIFIED_FIXED | COMM-334. The original claim was wrong, not merely unverified. |
| DSYNC-QA-4 | DSYNC | P1 | QA | Storage-quota handling untested | `test/storage-quota-exceeded.test.mjs`; `app.js:349-351` `noteStorageError()` | VERIFIED_FIXED | COMM-364. |
| DSYNC-QA-5 | DSYNC | P1 | QA | No auth session/token expiry or refresh-failure test | `test/community-session-expiry.test.mjs`; `expireSession()` in `test/helpers/mockSupabase.mjs` | VERIFIED_FIXED | COMM-362. |
| DSYNC-QA-6 | DSYNC | P1 | QA | No browser-check for post composition or moderation review | `scripts/browser-check/community-post-composition.mjs`, `scripts/browser-check/community-report-moderation.mjs` | VERIFIED_FIXED | COMM-363. |
| DSYNC-QA-7 | DSYNC | P1 | QA | The layer capable of catching a real cross-user RLS regression was failing | pgTAP green per COMM-332; 77 files | PARTIAL | Green in CI against a disposable DB; never validated against the live project (DSYNC-SEC-2). |
| DSYNC-QA-8 | DSYNC | P2 | QA | Noam has zero CI | Outside this repo | NO_LONGER_APPLICABLE | |
| DSYNC-QA-9 | DSYNC | P2 | QA | `sw-precache.test.mjs` stronger in Community | Present here | VERIFIED_FIXED | Informational/positive. |
| DSYNC-QA-10 | DSYNC | P2 | QA | No community-specific prototype-pollution/data-shape test | `test/sanitizers.test.mjs` covers local records; no equivalent for the ~50 community data shapes | STILL_OPEN | Low; community data comes from RLS-gated RPCs, not user file import. Folded under AUDIT0827-QA-9. |
| DSYNC-QA-11 | DSYNC | P2 | QA | Sign-out/sign-in dedup test flaky under load | `npm test` this pass: 0 fail, 0 flaky across 1108 tests | VERIFIED_FIXED | Clean run; no dedup flake observed. |
| DSYNC-QA-12 | DSYNC | P2 | QA | Data-loss surfaces well covered | Confirmed | VERIFIED_FIXED | Informational/positive. |

### Source: 2026-09-02 — Content, legal and docs

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| DSYNC-CONTENT-1 (P0 #13) | DSYNC | P0 | Legal | PRIVACY.md/TERMS.md are unresolved drafts, linked live | Zero draft/to-do/placeholder/bracket matches in `PRIVACY.md`/`TERMS.md`; `privacy.html`/`terms.html` shipped and precached (`sw.js:54-55`); `app.js:3093` links the HTML pages; `test/community-legal-pages.test.mjs` pins facts across both formats | VERIFIED_FIXED | COMM-335. |
| DSYNC-CONTENT-2 (P0 #14) | DSYNC | P0 | Legal | PRIVACY.md omits photos, comments, follows, visibility toggles, admin directory | All disclosed; `d2e6408` further corrected the attendance-based coach signal description | VERIFIED_FIXED | COMM-336. |
| DSYNC-CONTENT-3 | DSYNC | P1 | Legal | Noam's PRIVACY/TERMS describe non-existent cloud functionality | Outside this repo | NO_LONGER_APPLICABLE | Explicitly not filed here by the source audit. |
| DSYNC-CONTENT-4 | DSYNC | P1 | Security | Noam ships dead `cloud.js`/`cloud-config.js` with live credentials | Outside this repo | NO_LONGER_APPLICABLE | Explicitly not filed here by the source audit. |
| DSYNC-CONTENT-5 | DSYNC | P1 | Docs | `CHANGES.md` is 9 commits / 5–6 days stale | `CHANGES.md` backfilled through 2026-09-01 (COMM-369); file is 95 KB, last touched `9869543` (2026-09-04) | PARTIAL | Backfilled once, then went stale again — no entry covers `cc646ca`, `0f722d9`, `60158de`, `8742369`, `c39f640`, `d2e6408`. Folded into AUDIT-RECON-006. |
| DSYNC-CONTENT-6 | DSYNC | P2 | Legal | TERMS.md unchanged since fork; no comments/photos/coach powers/age | Placeholder-free; minimum age 13 stated explicitly | VERIFIED_FIXED | COMM-335. |
| DSYNC-CONTENT-7 | DSYNC | P2 | Legal | "No email collected" omits the synthetic `.invalid` address | `cloud.js:3764-3770` documents `usernameToEmail()`; PRIVACY.md rewritten under COMM-335/336 | VERIFIED_FIXED | |
| DSYNC-CONTENT-8 | DSYNC | P2 | Docs | `COMMUNITY_SETUP.md` and the module-plan doc don't cross-reference | `COMMUNITY_SETUP.md` documents username+password as shipped | PARTIAL | Cross-reference still absent; `COMMUNITY_SETUP.md:83` is also the sole (stale) home of the purge instruction — see AUDIT0827-OPS-H4. |
| DSYNC-CONTENT-9 | DSYNC | P2 | Docs | One CHANGES.md entry uses an unused "v3.0.0" tag | Cosmetic | STILL_OPEN | Trivial. |
| DSYNC-CONTENT-10 | DSYNC | P2 | Privacy | Plaintext-export warning never added to PRIVACY.md or the UI | No plaintext/shared-device language in `PRIVACY.md`/`privacy.html`; `app.js:1591` exports with no warning | STILL_OPEN | Same as AUDIT0827-SEC-L8. |

### Source: backlog / ticket sweep

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| COMM-337 | backlog | P1 | Security | Move hosting off GitHub Pages to enable clickjacking headers | `backlog.md:3047` status `todo` — the only `todo` in the design-sync table | STILL_OPEN | Same as AUDIT0827-SEC-M4. |
| COMM-338 | backlog | P1 | QA | Run pgTAP in CI + multi-role live smoke test before deploy | `backlog.md:3048` `partial`; `scripts/smoke-test-multi-role.mjs` never executed | PARTIAL | Same as DSYNC-SEC-2. Needs a staging project and 5 provisioned accounts — a product-owner decision. |
| COMM-329 | backlog | P0 | Accessibility | Headings and landmarks in the app shell | `backlog.md:3039` `partial`; `test/heading-outline.test.mjs:1-24` documents exactly what is uncovered | PARTIAL | Same as DSYNC-A11Y-2. |
| COMM-143 | backlog | P1 | Notifications | Phase 1 notifications wired | `backlog.md:227,230-238` `partial` — client renders every type; the server trigger set is documented but partly unbuilt | PARTIAL | |
| COMM-P01..P07 | backlog | — | Product | Attendance-blocked parked bucket | `backlog.md:1368-1449` — all seven closed by COMM-302/305/306/307/304/316 | VERIFIED_FIXED | The parked bucket is complete as a historical record; nothing in it is live work. |
| COMM-101..115, 130..134, 150..156, 160, 170, 180, 190, 191 | backlog | P1 | Bookkeeping | Phase 1 ticket rows still `todo` | `backlog.md:178-259` all `todo`, while `cloud.js:6085,6300,6426` (COMM-101..108), `:3121,3218,3367` (COMM-113), `:3574,3709` (COMM-123), `:5074,11912` (COMM-152/153), `:6066` (COMM-155), `:9668` (COMM-180) all ship | NO_LONGER_APPLICABLE | The features shipped; the rows are stale bookkeeping, acknowledged at `backlog.md:35-41` and `:549-553`. Registered as a process defect under AUDIT-RECON-002. |

### New findings from this reconciliation

| ID | Source | Priority | Category | Finding | Current evidence | Status | Notes |
|---|---|---|---|---|---|---|---|
| AUDIT-RECON-001 | this pass | P0 | Security | Anonymous-read confidentiality gap: three read policies were `to authenticated` with no membership predicate, so any visitor minting an anonymous JWT could read every profile, club/public post and announcement | `supabase/migrations/202609060001_anonymous_read_gate.sql:1-50` documents the hole and gates `profiles_read_authenticated`, `posts_feed_select` and `announcements_read` behind `is_community_member()`; `202609060009_definer_read_gate.sql` covers 5 SECURITY DEFINER functions; `supabase/tests/0067_anonymous_read_gate_test.sql` (225 lines) and `0075_definer_read_gate_test.sql` assert it | VERIFIED_FIXED | **Not present in any of the three prior audit documents** — found and closed by `d2e6408` after them. Recorded here because DSYNC-SEC-5 explicitly warned that the sampled RLS review might miss exactly this, and it did. Reinforces the case for the full policy-by-policy pass. |
| AUDIT-RECON-002 | this pass | P1 | Process | Ticket status bookkeeping has drifted far enough that the backlog cannot serve as a launch gate | ~60 `docs/community/tickets/COMM-*.md` files carry `Status: todo` while `backlog.md` records the same IDs as `review`/`done` (e.g. COMM-001..020 `todo` in file, `review` in table); COMM-120..125 are the reverse (`review` in file, `todo` in table); the whole Phase 1 table (`backlog.md:178-259`) is `todo` for shipped code | STILL_OPEN | Two independent status stores that disagree in both directions. Pick one as authoritative and make the other derived or deleted. |
| AUDIT-RECON-003 | this pass | P2 | Security | `image_url` columns carry a length-only CHECK, no URL-scheme check | `supabase/migrations/202608280010_events.sql:14` `image_url text check (... char_length <= 500)` — no `~* '^https?://'`, unlike `events.map_link` (`202609050004_event_map_link_scheme.sql:58-61`) and `profiles.avatar_url` (`202609060006`); rendered into `<img src>` at `cloud.js:6349,7291,8074,8507,11108` | STILL_OPEN | Low exploitability: writes are staff-gated, `esc()` prevents attribute escape, and CSP `img-src` (`index.html:41`) blocks off-origin loads. It is an unfinished-symmetry gap, not a live hole. Client-side validation exists for `mapLink` (`cloud.js:8160`) but not for `imageUrl`. |
| AUDIT-RECON-004 | this pass | P2 | Architecture | Inline-style count in `cloud.js` regressed despite COMM-347 being `done` | 780 `style="` occurrences in `cloud.js` today vs. 722 measured on 2026-09-02; `app.js` at 276 vs. 277 | STILL_OPEN | COMM-347's scope ("high-traffic classless components") was met; the file-level trend was not. Any future design-token sync still has to hunt strings. |
| AUDIT-RECON-005 | this pass | P2 | Legal | Legal documents have no recorded external sign-off | `backlog.md:3178-3183` — COMM-335's own closing note states sign-off "is still recorded outside this repo if the product owner ever forms a real legal entity" | PARTIAL | Correctly and honestly scoped out. Recorded so it is not mistaken for complete. |
| AUDIT-RECON-006 | this pass | P2 | Process | The four most recent remediation commits have no ticket IDs and no changelog entries | `60158de` ("14 launch-readiness findings"), `8742369`, `c39f640`, `d2e6408` ("every finding") are absent from `backlog.md`'s ticket tables (last section is "Community promoted to the bottom tab bar (2026-09-04)") and from `CHANGES.md` (last touched `9869543`) | STILL_OPEN | ~10 K lines of change across 10 migrations and 20+ test files with no traceable finding IDs. Directly weakens the next audit's ability to reconcile. Subsumes DSYNC-CONTENT-5. |
| AUDIT-RECON-007 | this pass | P2 | QA | Two of the three CI gates could not be re-verified in this pass | `migration-check` needs Docker; `browser-checks` needs a Playwright browser install. Only `npm test` was executed | STILL_OPEN | Not a defect in the code — a limitation of this audit. The pgTAP and browser-check pass claims in `d2e6408` remain the commit author's own, unreplicated. |

---

## Verification method notes

- Every "VERIFIED_FIXED" row above was confirmed by reading the current file at the cited
  line, not by trusting the source document or the closing commit message.
- Cross-repo rows (`crossfit-pwa-Noam`) are marked NO_LONGER_APPLICABLE or PARTIAL because
  that repository is outside this workspace and could not be inspected in this pass. Where
  the backlog records a verified cross-repo diff (COMM-351/353/354), that record was read
  but not independently re-derived.
- `npm test` was run once, cleanly, from the committed tree. `migration-check` and
  `browser-checks` were not run (see AUDIT-RECON-007).
- No application code, migration, test, or git state was modified by this audit.
