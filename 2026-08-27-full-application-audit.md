# Haimunia Community Demo

## Full application audit

Date: 2026-08-27  
Scope: Web architecture, cybersecurity, UI and UX, DevOps, QA, accessibility, product research

## Executive assessment

Haimunia is an offline-first Hebrew training log packaged as a static progressive web app. Athletes record strength sets, WOD results, body weight, measurements, calendar notes, achievements, and local backups. An optional Supabase layer adds profiles, following, posts, reactions, comments, photos, announcements, challenges, and coach views.

The local training log is mature for a demo. Its automated coverage is broad. All 164 Node tests passed. All eight browser scenarios in the included aggregate runner passed with no console errors.

The community layer is not ready for public production use. Two high-risk security findings require fixes before launch. Release automation, database delivery, deletion scheduling, legal documents, monitoring, disaster recovery, keyboard accessibility, and responsive text behavior also block production readiness.

## Overall scorecard

| Category | Score | Status |
|---|---:|---|
| Product concept | 7/10 | Clear value, incomplete audience and success definition |
| Local training features | 8/10 | Strong demo behavior and test coverage |
| Web architecture | 5/10 | Simple deployment, high client-code concentration |
| Cybersecurity | 4/10 | Good RLS baseline, two high-risk access flaws |
| UI and UX | 6/10 | Mobile-focused and consistent, weak desktop and complex-flow support |
| Accessibility | 4/10 | RTL and motion support exist, major keyboard and contrast gaps remain |
| QA | 7/10 | 164 tests and browser checks pass, critical production paths remain untested |
| DevOps | 3/10 | CI exists, release and operations controls are missing |
| Privacy and legal | 2/10 | Draft documents are incomplete |
| Production readiness | 4/10 | Do not launch the community layer yet |

## Release decision

Decision: No-go for public community launch.

The offline local log is suitable for controlled demo use. The community feature should remain limited to test accounts until all launch blockers in this report are closed.

## Application purpose and users

### Primary purpose

- Give Hebrew-speaking functional-fitness athletes a fast mobile training log.
- Keep private workout data usable without an account or network.
- Add an optional gym community without making cloud access mandatory.
- Separate this demo from the production app at the browser-storage level.

### Intended users found in the product

- Member: records workouts and joins community activity.
- Coach: publishes announcements, manages the weekly challenge, and views new or inactive members.
- Admin: receives manual elevated access outside the normal app flow.

### Product strengths

- Offline use remains the default path.
- Private training data is not published by default.
- Community sharing requires an explicit user action.
- Strength, duration, ladder, superset, WOD, EMOM, body, calendar, and achievement flows cover real gym workflows.
- Hebrew RTL presentation matches the target audience.
- The demo uses separate IndexedDB, browser keys, and service-worker caches from the production app.

### Product gaps

1. High: The product lacks measurable success criteria.
   - No activation, retention, backup, sync, community engagement, or coach-value targets are documented.
   - Define a product scorecard before adding more features.

2. High: The coach model is global, not roster-scoped.
   - Every coach receives the same staff powers.
   - There is no coach-to-class or coach-to-member boundary.
   - Treat this as a demo limitation. Do not market it as full gym management.

3. Medium: Onboarding does not fully explain local versus cloud data.
   - Users need a clear explanation of which records stay on the device, which records sync, and which records become public.
   - Add a short privacy choice screen before community sign-in.

4. Medium: Recovery depends on user-managed JSON exports.
   - Users need visible backup status, restore guidance, and shared-device warnings.
   - Define whether private cloud sync is a recovery feature or only a synchronization feature.

5. Medium: Moderation is incomplete.
   - Users submit a generic report, but the app lacks a complete review and resolution workflow.
   - Define moderation ownership, categories, evidence, response targets, appeals, and account sanctions.

6. Medium: No formal feedback channel is present.
   - Add an in-app support or feedback route with release version and non-sensitive diagnostic context.

## Architecture assessment

### Current architecture

```text
Browser PWA
  index.html
  app.js
  cloud.js
  service worker
  IndexedDB and namespaced browser settings
        |
        | optional
        v
Supabase
  Auth magic links
  Postgres and RLS
  Storage photos
  SQL functions and views
```

### Strengths

- Static hosting keeps the delivery model simple.
- IndexedDB gives the private log offline durability.
- Cloud features are optional.
- RLS places access decisions in the database.
- Sanitizers constrain imported and user-entered records.
- The service worker isolates the demo cache namespace.
- The vendored Supabase client supports build-free deployment.

### Findings

1. High: `app.js` is a 228 KB monolith with more than 4,000 lines.
   - UI rendering, persistence, validation, domain rules, import and export, charts, navigation, PWA lifecycle, and event handling share one global module.
   - A change in one feature has a large regression surface.
   - Split by domain: storage, validation, strength log, WODs, calendar, body tracking, achievements, settings, navigation, and PWA lifecycle.

2. High: `cloud.js` combines network access, session state, authorization gates, uploads, synchronization, and HTML rendering.
   - Separate API access, state, sync queue, authorization helpers, and presentation.
   - Keep server authorization in RLS and trusted functions. Treat UI gates as display rules only.

3. Medium: The application replaces large DOM regions with `innerHTML`.
   - The current escaping work reduces XSS exposure.
   - Full-region replacement harms focus stability, accessibility announcements, and incremental rendering.
   - Move toward small view modules and DOM updates scoped to the changed component.

4. Medium: Global mutable state drives most screens.
   - Formalize state ownership and transitions.
   - Add a small event-driven store or domain controllers. Avoid adding a large framework unless measured needs support it.

5. Medium: There is no schema version strategy for local records beyond sanitization.
   - Add an explicit backup schema version and IndexedDB migration policy.
   - Test upgrades across the last supported app versions.

6. Medium: Frontend and database releases are not coupled.
   - Add compatibility rules so a new frontend works with both the current and next database schema during rollout.

7. Low: Desktop screens remain capped at 480 px.
   - Keep the phone layout for logging.
   - Add tablet and desktop layouts for history, charts, community, and coach tools.

## Cybersecurity findings

### High severity

1. Cross-user photo disclosure through `photo_path`.
   - A post owner controls the referenced storage path.
   - Storage read access trusts a visible post referencing the object.
   - No database control ties the path owner to the post author.
   - Evidence: `supabase/migrations/202608270004_community_engagement.sql:28`, `:34`, `:41`, `supabase/migrations/202608260001_community_foundation.sql:132`, `cloud.js:254`.
   - Fix: enforce the first path segment equals `author_id`, validate ownership through a trigger or trusted function, block direct path updates, and add two-user disclosure tests.

2. Coach invite codes provide a privilege escalation route.
   - Codes accept four-character values.
   - Codes lack expiration, usage bounds, per-user attempt limits, and safe role-upgrade rules.
   - Evidence: `supabase/migrations/202608270003_invite_gate.sql:8`, `:32`, `:40`, `supabase/migrations/202608270005_coach_tier.sql:13`.
   - Fix: use high-entropy hashed codes, expiration, maximum uses, revocation, atomic redemption, server throttling, audit records, and a separate controlled coach-promotion flow.

### Medium severity

3. Authenticated users have an unbounded upload path.
   - A valid Auth account does not need a profile or redeemed invite to upload.
   - No per-user quota or orphan cleanup is defined.
   - Evidence: `supabase/migrations/202608270004_community_engagement.sql:30-37`.
   - Fix: require an active profile and redemption, set quotas, throttle uploads, and clean abandoned files.

4. Clickjacking defense is ineffective on the current static host.
   - Evidence: `index.html:19-27`.
   - Fix: deploy on a host with response headers. Send `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.

5. Reporting lacks trusted moderator status transitions.
   - Evidence: `supabase/migrations/202608260001_community_foundation.sql:76-86`, `:106`, `:140-141`, `cloud.js:221`.
   - Fix: add a moderator-only function with reviewer, timestamp, reason, notes, and an audit trail.

6. Privacy and terms remain launch drafts.
   - Evidence: `PRIVACY.md:1`, `PRIVACY.md:13`, `TERMS.md:1`.
   - Fix: add operator identity, contact, region, retention, subprocessors, legal basis, age limits, user rights, and jurisdiction review.

### Low severity

7. CSP permits network connections to every Supabase project.
   - Evidence: `index.html:35`.
   - Fix: allow only the exact production and staging origins. Add CSP reporting. Add the selected Supabase image host to `img-src`.

8. Sensitive device data and JSON backups remain plaintext.
   - Evidence: `app.js:535-552`, `app.js:1925-1957`.
   - Fix: warn before export, document shared-device risk, and offer password-protected encrypted backups if the threat model requires them.

9. Staff status is enumerable for arbitrary user IDs.
   - Evidence: `supabase/migrations/202608270005_coach_tier.sql:13-20`.
   - Fix: remove the user parameter and evaluate `auth.uid()`.

### Security strengths

- No service-role secret was found.
- RLS is enabled across exposed application tables.
- Private records use owner-scoped policies.
- Imported backups pass through size and content sanitizers.
- User-generated community text is escaped before HTML rendering.
- Inline scripts are blocked by CSP.
- Image uploads restrict MIME type and file size.
- Account deletion hides profiles and posts immediately.

## UI and UX findings

1. High: Modal behavior is inconsistent for keyboard users.
   - Add one shared dialog controller with opener storage, initial focus, focus trap, Escape handling, inert background, and focus restoration.
   - Evidence: `app.js:1212-1220`, `:1363-1372`, `:1383-1392`, `:1776-1807`, `:2260-2282`, `:3750-3785`, `:3835-3848`.

2. High: Tab controls do not implement expected keyboard behavior.
   - Add roving `tabindex`, Arrow keys, Home, End, unique panels, and `aria-labelledby`.
   - Apply the same model to WOD and community subtabs.
   - Evidence: `index.html:389-397`, `app.js:3440-3447`, `app.js:3705-3708`, `cloud.js:349-354`.

3. High: Text enlargement uses CSS `zoom` with hidden horizontal overflow.
   - This risks clipped content on small screens and at 200 percent zoom.
   - Replace it with rem-based type tokens. Allow navigation to wrap or scroll with a visible cue.
   - Evidence: `index.html:114`, `:119`, `:130`, `:134-136`.

4. Medium: Focus styles do not cover all interactive elements.
   - Add a global `:focus-visible` rule for links, buttons, inputs, textareas, selects, and custom focusable controls.
   - Evidence: `index.html:116-120`, `:186-187`.

5. Medium: Secondary text contrast fails WCAG AA in several themes.
   - Footer light ratio: about 1.34:1.
   - Footer dark ratio: about 2.09:1.
   - Dark steel text on surface: about 4.11:1.
   - Use text tokens tested at 4.5:1 or higher for normal text.

6. Medium: Core page landmarks and headings are missing.
   - Replace structural divs with `header`, `nav`, `main`, and `footer`.
   - Add one `h1` and ordered section headings.
   - Evidence: `index.html:369-405`.

7. Medium: Dynamic screen changes lack focus movement or announcements.
   - Evidence: `app.js:3414-3447`.
   - Add panel labels and a clear focus or live-region policy.

8. Medium: The calendar lacks grid semantics and full accessible dates.
   - Add a semantic grid or table, full localized labels, Arrow-key movement, `aria-current`, and selection state.
   - Evidence: `app.js:2911-2936`.

9. Medium: Form errors lack persistent field-level descriptions.
   - Add visible labels, `aria-invalid`, `aria-describedby`, persistent messages, and first-error focus.

10. Medium: Shared photos always use empty alternative text.
    - Evidence: `cloud.js:316`.
    - Ask for short alternative text or mark the photo as decorative by explicit choice.

11. Medium: SVG charts lack an accessible name and data alternative.
    - Evidence: `app.js:2588-2610`.
    - Add a trend summary and an accessible table or list.

12. Medium: Numeric inputs are visually cleared on focus.
    - Evidence: `app.js:4178-4179`.
    - Select the existing value or preserve normal editing behavior.

13. Low: Icon targets are too small for frequent mobile use.
    - Set a 44 by 44 px target for main actions and clear spacing around destructive actions.

14. Low: The community photo picker uses an emoji with title text.
    - Add visible text, an accessible name, focus styling, and selected-file status.

15. Low: Essential secondary text often uses 9 to 13 px sizes.
    - Raise essential copy to 14 to 16 px with rem tokens.

## Accessibility status

Target: WCAG 2.2 AA.

### Present controls

- `lang="he"` and `dir="rtl"` exist.
- Browser zoom is not disabled.
- Reduced-motion handling exists.
- Many icon buttons have Hebrew accessible names.
- Inputs commonly use a mobile-safe 16 px size.
- Loading and status regions exist in several flows.
- Dark, light, and automatic themes exist.

### Required verification

- Keyboard-only journey through every screen.
- Screen-reader review in NVDA with Chrome or Firefox.
- VoiceOver review on iOS Safari.
- 320 CSS px width and 200 percent zoom.
- Portrait and landscape layouts.
- Automated axe scans on every main state.
- Contrast testing for both themes.
- Reduced-motion behavior during celebrations and updates.

## QA assessment

### Verified results

- Node tests: 164 passed, 0 failed.
- Aggregate browser checks: 8 scripts passed.
- Browser boot: all five main tabs opened with content.
- Runtime console: no errors in the included browser scenarios.
- Ladder, update, duration, WOD builder, superset, EMOM, and WOD extra scenarios passed.
- Version check passed at `3.0.8`.
- Installed dependency tree resolved.
- Offline dependency audit reported no known advisory in the local database.

### QA findings

1. High: Browser checks do not run in CI.
   - CI only runs `npm test`.
   - Add the browser suite as a required pull-request and release job.

2. High: The aggregate browser runner omits existing scripts.
   - `roadmap.mjs`, `text-scale.mjs`, and `benchmarks.mjs` are outside `run-all.mjs`.
   - Use a manifest or file convention so new browser checks cannot be skipped silently.

3. High: No automated two-user RLS test suite exists.
   - Test anonymous, unredeemed Auth, member, follower, blocked user, coach, and admin identities against every table, view, function, and storage policy.

4. High: No end-to-end community test runs against staging.
   - Cover magic link, invite redemption, profile, follow, block, post visibility, reaction, comment, photo, report, challenge, announcements, sync, and deletion.

5. Medium: Accessibility automation is absent.
   - Add axe checks, tab-order tests, modal focus tests, and contrast tests.

6. Medium: Offline recovery needs more fault injection.
   - Test partial cache, IndexedDB denial, quota exhaustion, corrupt records, outbox retry, conflicting remote updates, expired sessions, clock skew, and interrupted upgrades.

7. Medium: Cross-browser coverage is undefined.
   - Set a support matrix for Android Chrome, iOS Safari, desktop Chrome, Firefox, and installed PWA mode.

8. Medium: Performance budgets are absent.
   - Track app-shell bytes, startup time, interaction latency, memory, IndexedDB scale, feed pagination, image size, and low-end mobile results.

9. Medium: Backup compatibility testing needs version fixtures.
   - Keep sanitized backup fixtures from each supported schema version.

10. Low: The offline advisory scan is not current threat intelligence.
    - Add an online scheduled dependency scan and pull-request checks.

## DevOps and operations findings

### High severity

1. No deployment pipeline or release gate.
   - Evidence: `.github/workflows/test.yml:1-16`, `README.md:27`.
   - Add immutable artifact packaging, protected production environment, deployment concurrency, post-deploy smoke tests, and rollback.

2. Real-browser checks are excluded from CI.
   - Evidence: `.github/workflows/test.yml:16`, `scripts/browser-check/run-all.mjs:9`.

3. Database migrations depend on manual SQL execution.
   - Evidence: `COMMUNITY_SETUP.md:7`, `:18`, `:68`.
   - Use a Supabase CLI pipeline, drift checks, disposable database validation, and role-based RLS tests.

4. The required account purge is not implemented as versioned infrastructure.
   - Evidence: `COMMUNITY_SETUP.md:63`.
   - Add an idempotent scheduled job, run history, alerts, and a synthetic check.

### Medium severity

5. Environment configuration is hard-coded in a tracked file.
   - Evidence: `cloud-config.js:4`, `COMMUNITY_SETUP.md:7`, `:61`.
   - Generate it during deployment from validated non-secret environment values.

6. Service-worker installation accepts an incomplete app shell.
   - Evidence: `sw.js:51-54`.
   - Fail installation when a required boot asset is missing. Keep optional visual assets separate.

7. Supply-chain controls are incomplete.
   - Pin GitHub Actions by commit SHA.
   - Add online advisory scans, license review, an SBOM, dependency updates, and vendored-client integrity checks.

8. Operational monitoring and health checks are missing.
   - Add privacy-safe client errors, release IDs, uptime checks, sync failure metrics, outbox age, purge status, authentication email status, and incident ownership.

9. Service backup and recovery are not defined.
   - User JSON exports do not cover Supabase Auth, database, or Storage.
   - Define recovery point and recovery time goals. Run isolated restore drills.

### Low severity

10. Runtime and contributor setup are under-specified.
    - Add Node and package-manager versions and one full verification command.

11. CI lacks cancellation for superseded changes.
    - Add a concurrency group and cancel older pull-request runs.

## Performance assessment

No production measurements were available. The following risks need measurement:

- Large `app.js` parsing and execution on low-end phones.
- Full-region DOM replacement during navigation and updates.
- Feed growth without clear pagination and image budget evidence.
- SVG chart rendering with large local histories.
- IndexedDB startup time after years of records.
- Service-worker cache size and update cost.
- Rubik font weights and image payload on first visit.

Set budgets before launch:

- App shell transfer size.
- Largest Contentful Paint on a mid-range Android device.
- Interaction to Next Paint for steppers, navigation, save, and search.
- Maximum photo dimensions and compressed byte size.
- Feed page size and query duration.
- IndexedDB startup with 10,000 records.

## Data and privacy assessment

- Build a data inventory for local storage, Auth, database, Storage, telemetry, email, reports, and backups.
- Define purpose, lawful basis, retention, deletion, access, export, and incident rules for each data class.
- Keep body weight, measurements, notes, partner tags, and email out of community shares.
- Verify permanent deletion across Auth, database, Storage, backups, logs, and processors.
- Define child and teen access rules.
- Add processor agreements and hosting-region disclosure.
- Avoid workout content in logs and monitoring.
- Record consent and terms versions accepted by each cloud user.

## Required target architecture

### Near-term structure

```text
PWA shell
  domain modules
    strength
    WOD
    body
    calendar
    achievements
  platform modules
    IndexedDB
    backup migration
    service worker
    settings
  community modules
    API client
    session and profile
    sync outbox
    feed
    coach tools

Supabase
  RLS with automated role tests
  trusted functions for privileged transitions
  bounded Storage ownership and quotas
  scheduled deletion and cleanup jobs

Delivery
  unit and DOM tests
  browser and accessibility tests
  disposable database migration tests
  staging deployment
  production approval
  smoke tests and rollback
```

## Prioritized remediation roadmap

### Phase 0: Stop public launch

Owner: Security, backend, product

- Fix cross-user photo ownership.
- Replace reusable coach invite codes.
- Restrict uploads and add quotas.
- Complete legal and privacy documents.
- Build and test moderation status transitions.
- Verify all live RLS policies with separate accounts.

Exit criteria: no open critical or high security finding, legal approval recorded, and multi-role staging tests pass.

### Phase 1: Establish safe delivery

Owner: DevOps, backend, QA

- Add automated migrations and drift detection.
- Add all browser checks to CI.
- Add staging end-to-end community tests.
- Add a deployment workflow and rollback.
- Version the deletion purge and storage cleanup schedules.
- Generate environment configuration during deployment.

Exit criteria: one tested commit moves through staging to production with recorded checks and rollback evidence.

### Phase 2: Accessibility and core UX

Owner: UI, accessibility, QA

- Fix dialogs, tabs, focus indicators, landmarks, calendar semantics, form errors, charts, and alt text.
- Replace CSS zoom.
- Resolve contrast failures.
- Standardize touch targets and text sizes.
- Add keyboard, axe, contrast, and 320 px reflow tests.

Exit criteria: WCAG 2.2 AA audit passes for all local and community flows.

### Phase 3: Reliability and recovery

Owner: DevOps, security, backend

- Add monitoring, synthetic checks, alerts, and an incident runbook.
- Define and test database, Auth, and Storage recovery.
- Make required service-worker precache atomic.
- Add dependency scanning, action pinning, SBOM, and vendored-client integrity.

Exit criteria: restore drill succeeds, alert paths are tested, and offline boot failure modes are covered.

### Phase 4: Maintainability and growth

Owner: Web architecture, product, performance

- Split `app.js` and `cloud.js` into domain modules.
- Add local schema migrations and backup-version fixtures.
- Add desktop history and coach layouts.
- Set product and performance scorecards.
- Run research with members and coaches before expanding scope.

Exit criteria: module boundaries are enforced, budgets pass, and roadmap work maps to measured user outcomes.

## Quick wins

- Add missing browser scripts to `run-all.mjs`.
- Add Node and package-manager versions.
- Add CI concurrency cancellation.
- Restrict CSP to exact Supabase origins.
- Replace footer text colors with AA-compliant tokens.
- Add global focus-visible styling.
- Raise frequent icon controls to 44 by 44 px.
- Add a visible label to the photo picker.
- Remove the arbitrary UUID argument from `is_staff`.
- Separate required and optional service-worker assets.

## Production launch checklist

- [ ] Photo ownership is enforced by the database.
- [ ] Invite codes are high entropy, bounded, expiring, revocable, and throttled.
- [ ] Coach promotion is separate from normal member redemption.
- [ ] Storage upload quotas and cleanup exist.
- [ ] Multi-account RLS and Storage tests pass.
- [ ] Privacy policy and terms have legal approval.
- [ ] Moderation workflow is operational.
- [ ] Migration pipeline and drift checks pass.
- [ ] Browser and accessibility checks are required in CI.
- [ ] Staging community end-to-end tests pass.
- [ ] Deployment, smoke test, and rollback are automated.
- [ ] Account purge and orphan cleanup jobs are monitored.
- [ ] Clickjacking headers are active.
- [ ] CSP uses exact production origins.
- [ ] Backup and restore drill passes.
- [ ] Monitoring and incident ownership are active.
- [ ] WCAG 2.2 AA review passes.
- [ ] Performance budgets pass on a mid-range mobile device.

## Test limitations

The local source, Node suite, and included Playwright scenarios were reviewed. The audit did not connect to the live Supabase project. It did not send magic links, create real accounts, change cloud records, or inspect production hosting settings.

The following remain unverified:

- Applied production migrations.
- Live RLS and Storage behavior across separate users.
- Auth and OTP rate limits.
- Redirect allowlist and SMTP delivery.
- Production HTTP response headers.
- External purge or cleanup schedules.
- Supabase backup settings and restore history.
- Production monitoring and incident procedures.
- Real screen-reader output.
- iOS and Android installed-PWA behavior.
- Production load and capacity.

## Final priority order

1. Fix photo ownership and invite-code privilege escalation.
2. Complete legal, moderation, deletion, and storage controls.
3. Automate database, browser, staging, deployment, and rollback checks.
4. Fix keyboard, contrast, reflow, form, and semantic accessibility.
5. Add monitoring, disaster recovery, supply-chain, and service-worker reliability controls.
6. Split the client monolith and set product and performance measures.
