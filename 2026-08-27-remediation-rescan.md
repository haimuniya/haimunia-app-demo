# Haimunia remediation rescan

Date: 2026-08-27  
Branch scanned: `main`  
Commit scanned: `e3a5a5f` plus uncommitted anonymous sign-in changes in
`cloud.js`, `README.md`, and `COMMUNITY_SETUP.md`

## Result

The security remediation is present on `main`. Unit, integration, version,
offline dependency, and browser checks pass. Several UI accessibility,
deployment, recovery, and operational gaps remain.

Public community launch status: conditional no-go.

The two original high-risk security findings are closed in the repository.
The remaining launch blockers are anonymous-account continuity, keyboard-safe
dialogs, tab behavior, deployment controls, and a versioned account-purge job.

## Scores

| Category | Earlier | Current | Status |
|---|---:|---:|---|
| Cybersecurity | 4/10 | 8/10 | Major repository findings fixed |
| QA | 7/10 | 9/10 | 181 tests and 11 browser scenarios pass |
| DevOps | 3/10 | 6/10 | CI hardened, deployment still absent |
| UI and UX | 6/10 | 7/10 | Several quick fixes landed |
| Accessibility | 4/10 | 5/10 | Focus visibility improved, structural gaps remain |
| Production readiness | 4/10 | 6/10 | Security improved, launch gates remain |

## Verification results

- Node tests: 181 passed, 0 failed.
- Browser scenarios: 11 passed, 0 failed.
- Browser console errors: 0.
- Version check: app and service worker both `3.0.8`.
- Offline dependency audit: 0 known advisories in the local database.
- Git whitespace validation: passed.
- Working tree: contains uncommitted anonymous sign-in changes which were
  present during the final validation pass. The rescan did not edit them.
- Restore branch: `codex/pre-remediation-2026-08-27` at `bfee095`.

## Closed findings

### Security

- Cross-user post-photo path reuse is blocked by a database trigger.
- Storage reads verify the photo path belongs to the post author.
- Uploads require an active profile and invite redemption.
- Post-photo uploads have a 20-object account quota.
- Legacy plaintext invite codes are revoked and removed.
- New member codes are high entropy, hashed, expiring, and usage-bounded.
- Invite guessing is limited to five attempts per 15-minute window for each
  Auth user ID. The anonymous-session limitation is listed below.
- Public invite redemption no longer grants coach access.
- Coach promotion uses a separate service-role function.
- Staff checks no longer accept an arbitrary user ID.
- Report review uses an admin-only function with reviewer and timestamp fields.
- CSP connections are restricted to the configured Supabase project.
- Signed Supabase post images are permitted by `img-src`.

Evidence:

- `supabase/migrations/202608270006_security_hardening.sql`
- `test/security-hardening.test.mjs`
- `cloud.js:44-58`
- `index.html:34-35`

### QA and delivery

- Browser checks run in CI.
- The browser runner discovers every check script automatically.
- GitHub Actions are pinned by commit SHA.
- Superseded CI runs are cancelled.
- Required service-worker assets fail installation as one atomic group.
- Optional images and fonts remain non-blocking.
- Node 22 or newer is declared.

Evidence:

- `.github/workflows/test.yml`
- `scripts/browser-check/run-all.mjs`
- `sw.js`
- `test/sw-precache.test.mjs`
- `package.json`

### UI quick fixes

- Focus indicators now include textareas, selects, links, and tabindex controls.
- Light and automatic-dark secondary colors were strengthened.
- Several calendar and icon targets were raised to 44 px.
- The photo picker has visible text.
- Numeric stepper focus selects the value instead of deleting it.

Evidence:

- `index.html:82-120`
- `index.html:179-208`
- `cloud.js:327`
- `app.js:4178-4183`
- `test/stepper-tap-type.test.mjs`

## Remaining launch blockers

### High: Anonymous sign-in has no identity recovery and weakens abuse controls

The current uncommitted client silently creates an anonymous Supabase Auth
user. Clearing site data, reinstalling, or changing devices creates a new user
with no route back to the prior profile, community history, private cloud sync,
or coach status.

The invite-attempt throttle is keyed by Auth user ID. A new anonymous session
receives a new ID, so the five-attempt limit is not an actor-level control.
High-entropy invite codes still make blind guessing impractical, but anonymous
account creation and repeated session replacement remain abuse and support
risks.

Evidence:

- `cloud.js:168-184`
- `cloud.js:306-312`
- `COMMUNITY_SETUP.md:74-100`
- `supabase/migrations/202608270006_security_hardening.sql:36-72`

Fix:

- Decide whether community identity is disposable or recoverable.
- For recoverable identity, add account linking through a verified method.
- For disposable identity, state the loss behavior before invite redemption.
- Add an actor-level invite throttle outside the replaceable anonymous user ID.
- Add controls for anonymous Auth-user creation volume.
- Test site-data deletion, reinstall, device change, and abandoned-profile cleanup.

### High: Dialog keyboard and focus management is incomplete

Dialogs still toggle visibility and page overflow independently. There is no
shared focus trap, background `inert` state, Escape policy, or reliable focus
return to the opening control.

Impact:

- Keyboard focus moves behind an open dialog.
- Users lose their prior location after closing.
- Dialog behavior differs across achievements, notifications, onboarding,
  welcome, WOD builder, movement picker, WOD picker, and celebrations.

Evidence:

- `app.js:1212-1220`
- `app.js:1363-1392`
- `app.js:1776-1807`
- `app.js:2260-2282`
- `app.js:3750-3785`
- `app.js:3835-3848`

Fix:

- Add one dialog controller.
- Store the opener.
- Focus the first meaningful control.
- Trap Tab and Shift+Tab.
- Mark background regions inert.
- Apply an Escape policy.
- Restore focus on close.
- Add automated keyboard tests for every dialog.

### High: ARIA tabs lack keyboard behavior

The main tabs and WOD tabs expose `role="tab"`, but every tab stays in the
normal tab sequence. Arrow, Home, and End handling is absent. The shared panel
does not identify its active tab.

Community subtabs remain plain buttons with a visual active state only.

Evidence:

- `index.html:389-399`
- `app.js:3414-3447`
- `app.js:3703-3710`
- `cloud.js:350-355`

Fix:

- Keep only the active tab at `tabindex="0"`.
- Set inactive tabs to `tabindex="-1"`.
- Add Arrow, Home, and End handling.
- Give each tab and panel a stable ID relationship.
- Apply the same pattern to community tabs.

### High: No deployment workflow or release rollback gate

CI tests changes but does not package or deploy the tested revision. The
repository contains one test workflow and no staging, production, smoke-test,
approval, or rollback job.

Evidence:

- `.github/workflows/test.yml`
- `.github/workflows/` contains no deployment workflow.

Fix:

- Package an immutable release artifact.
- Deploy the tested commit to staging.
- Run smoke checks against staging.
- Require production approval.
- Deploy the same artifact to production.
- Retain the prior artifact and document one-step rollback.

### High: Account purge remains dependent on unversioned external scheduling

The database function exists, but the repository only instructs an operator to
schedule it. There is no job definition, execution record, failure handling, or
ownership record.

Evidence:

- `COMMUNITY_SETUP.md:65-70`
- `supabase/migrations/202608260001_community_foundation.sql`

Fix:

- Add a versioned scheduled Edge Function or equivalent job.
- Make the call idempotent.
- Record success and failure counts without personal content.
- Add a runbook and named owner.

## Remaining medium findings

### Clickjacking protection still depends on a different host

The meta CSP does not enforce `frame-ancestors`. GitHub Pages does not send the
required response headers.

Evidence:

- `index.html:19-27`

Fix:

- Deploy behind a host or edge layer which sends:
  - `Content-Security-Policy: frame-ancestors 'none'`
  - `X-Frame-Options: DENY`

### Explicit dark theme still uses the old low-contrast secondary color

Automatic dark mode uses `#A8B3C9`, but explicit dark mode still assigns
`--steel:#8891A6`. The app defaults to an explicit dark stamp, so much of the
small secondary text still uses the weaker color.

Evidence:

- `index.html:94-111`

Fix:

- Use the same AA-tested secondary token in both dark-mode paths.
- Add a test which checks every theme token pair.

### Text enlargement still relies on CSS zoom

The included 800 px browser scenario passes without horizontal overflow. CSS
zoom still scales layout and fixed overlays as one surface. Narrow-width and
200 percent reflow behavior remain fragile.

Evidence:

- `index.html:119`
- `scripts/browser-check/text-scale.mjs`

Fix:

- Replace CSS zoom with rem-based type tokens.
- Allow the main navigation to wrap or scroll.
- Add 320 CSS px and 200 percent reflow browser checks.

### Page landmarks and heading structure remain weak

The header, navigation, main panel, and dynamic footer are generic divs. Most
screen titles are styled text rather than headings.

Evidence:

- `index.html:369-405`
- `app.js:3240-3285`

Fix:

- Use `header`, `nav`, `main`, and `footer`.
- Add one page heading and ordered section headings.

### Calendar interaction lacks grid semantics

Calendar days are unrelated buttons. They lack full localized date labels,
weekday association, roving focus, Arrow-key movement, `aria-current`, and
selection state.

Evidence:

- `app.js:2911-2936`
- `app.js:3117-3134`

Fix:

- Implement a grid or table pattern.
- Add full localized date names.
- Add Arrow-key movement and roving focus.
- Expose today and selected states.

### Forms still have unlabeled fields and weak error linkage

The weekly challenge dates lack labels. Comment and invite fields depend on
placeholders. WOD builder errors are visual and are not linked with
`aria-invalid` or `aria-describedby`.

Evidence:

- `cloud.js:300`
- `cloud.js:303-304`
- `cloud.js:337`
- `app.js:2283-2315`

Fix:

- Add visible labels.
- Add persistent field-level messages.
- Set `aria-invalid` and `aria-describedby`.
- Focus the first invalid field after submission.

### Community photos have no text alternative

Feed images use `alt=""` for every shared photo.

Evidence:

- `cloud.js:329`

Fix:

- Add a short optional description during upload.
- Store it with the post.
- Require an explicit decorative choice when no description is provided.

### Charts lack accessible descriptions and data equivalents

Charts are SVG-only. They lack an accessible name, trend summary, and adjacent
data list.

Evidence:

- `app.js:2583-2610`

Fix:

- Add `role="img"` with a concise trend label.
- Add an accessible list or table containing the plotted dates and values.

### Moderation has server transitions but no admin review interface

`review_report()` records trusted status transitions. The client still only
submits a generic report and exposes no queue for review, reason selection,
notes, or decisions.

Evidence:

- `cloud.js:221-225`
- `supabase/migrations/202608270006_security_hardening.sql:226-244`

Fix:

- Add report reasons and optional details.
- Add an admin-only queue.
- Add review, resolve, and dismiss actions through the trusted function.

### Environment selection remains hard-coded

The Supabase URL and publishable key are stored directly in
`cloud-config.js`. The publishable key is not a secret. The issue is staging
and production target confusion.

Evidence:

- `cloud-config.js:4-5`

Fix:

- Keep a checked-in empty template.
- Generate the real file during deployment.
- Validate the project hostname against the deployment environment.
- Show a visible staging marker.

### Service recovery is not documented or tested

Local JSON export does not cover Supabase Auth, Postgres, or Storage. No restore
procedure or restore drill evidence exists in the repository.

Fix:

- Define database, Auth, and Storage backup coverage.
- Set recovery time and recovery point targets.
- Restore into an isolated project on a schedule.
- Record the drill result.

### Supply-chain reporting remains partial

Action pinning and offline audit checks improved the baseline. Release SBOM,
license review, scheduled online advisory scanning, and vendored-client checksum
validation are absent.

Fix:

- Generate an SBOM for each release.
- Add scheduled online dependency scanning.
- Validate the vendored Supabase bundle checksum and version.

## Remaining low findings

- Desktop content remains capped at 480 px. History, charts, community, and
  coach tools underuse larger screens.
- Many labels and secondary messages remain 9 to 13 px.
- `package.json` declares Node but not `packageManager`.
- Photo quota is object-count based. It lacks a lower aggregate byte budget.
- The browser suite targets Chromium only.

## Current release priority

1. Add shared dialog focus management.
2. Fix main, WOD, and community tab keyboard behavior.
3. Add a deployment workflow with staging, smoke tests, approval, and rollback.
4. Version the account-purge job.
5. Move to a host with clickjacking response headers.
6. Fix explicit-dark contrast and replace CSS zoom.
7. Add landmarks, calendar semantics, field errors, photo descriptions, and
   chart data alternatives.
8. Add the moderation review interface.
9. Generate environment configuration during deployment.
10. Add service restore drills and supply-chain release evidence.

## Release recommendation

Keep the community layer in controlled testing. The repository security fixes
are strong enough for staging. Close the five high findings before public
production use.
