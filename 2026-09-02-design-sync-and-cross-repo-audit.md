# Design sync & cross-repo improvement audit

Date: 2026-09-02
Repos: `crossfit-pwa-Noam` ("Noam," design reference / simpler base app) and
`haimunia-app-demo-publish` ("Community," the production module, branch
`community/phase-0`, going live soon)
Method: 10 read-only agents, each a distinct role, working in parallel against
the current working trees (including uncommitted WIP in both repos, left
untouched). No files were edited as part of this audit. No code changes are
included in this document — it is findings and proposed tickets only.

## Executive summary

99 findings across 10 domains. 15 are P0 (launch-blocking or high-risk), 34
are P1, 50 are P2 (including informational/positive findings called out for
awareness).

The headline narrative:

- **Community's core training-log screens are running an older visual
  language than Noam's on two high-traffic screens** — Settings and the WOD
  Builder never received redesigns Noam already shipped, including a
  documented UX fix (WOD Builder's create-button placement) that Community's
  version has literally regressed back into.
- **The design drift has a structural cause, not just missed syncs**:
  `cloud.js` carries 722 inline `style="..."` attributes (vs. 277 in the
  larger `app.js`) and ~19 community-only class names with zero CSS backing.
  Every visual property for those elements is retyped at each call site, so a
  future token change has to be hunted down string-by-string. This will
  resist the design-token sync unless addressed first or alongside it.
- **Security is in good shape.** Both P0 findings from the 2026-08-27 audit
  are verified fixed at the code level (not just claimed). No new P0 security
  issues were found in this pass. The one item worth checking outside this
  workspace: a code comment in this repo's own `index.html` states the real
  production repo (`haimunia-app`, not present here) currently **ships no CSP
  at all** — flagged as P0 since it's your actual go-live target.
- **Almost all of Noam's security/hardening work already made it into
  Community pre-fork.** The real gaps are fixes Noam shipped *after* the
  fork (mostly a 2026-09-02 redesign session) — modal accessibility chief
  among them.
- **The two CI gates protecting release may not be reliably green.** A local
  pgTAP run failed 68/1995 assertions across 17 files, contradicting the
  backlog's note that this step is non-blocking (it currently has no
  `continue-on-error`). The Playwright suite is flaky and aborts on first
  failure, meaning up to 6 of 24 scenarios may never run on a bad CI pass.
- **Legal docs are not launch-ready and are linked live in the app.**
  PRIVACY.md/TERMS.md still open with "this is a draft" language and a
  literal to-do list, unchanged except one paragraph since the prior audit's
  2/10 score — and PRIVACY.md omits real shipped data categories (photos,
  comments, follows, admin user directory).
- **Accessibility remains 4/10-equivalent.** Two structural gaps span both
  apps: zero heading/landmark elements anywhere, and inconsistent modal
  keyboard support — Community's core dialogs (picker, WOD builder,
  achievements, etc.) lost the focus-trap/Escape handling Noam's base
  already has for all of them.

## P0 — launch blockers / highest risk

| # | Domain | Finding | Primary location |
|---|---|---|---|
| 1 | Design tokens | `--shadow-sm` token deleted in Community, silently flattening active-state affordances | `index.html` `:root` |
| 2 | Shared screens | Settings screen never received Noam's card-based redesign | `app.js:2797` (`renderSettingsBody`) |
| 3 | Shared screens | WOD Builder regressed a documented Noam fix (create-button placement) | `index.html:701-729` |
| 4 | Community screens | `.chip-btn.primary` still used for "selected" state in ~13 places, contradicting the app's own documented fix | `cloud.js` (13 call sites) |
| 5 | Community screens | Post menu / mention picker hardcode a dark popover background, ignoring the theme system | `cloud.js:3964, :4958` |
| 6 | Accessibility | Core training-log modals lost the focus-trap/Escape handling Noam's base already has | `app.js:3423-3502` |
| 7 | Accessibility | Zero heading elements and landmark regions anywhere in either app | both repos, all files |
| 8 | Performance/PWA | `cloud.js` (700KB) is a *required* precache asset — its failure blocks the entire offline app shell | `sw.js:19-33` |
| 9 | Performance/PWA | ~16 parallel Supabase requests fire unconditionally on every page load | `cloud.js:10252` |
| 10 | Test coverage | pgTAP suite fails ~3.4% of assertions on a from-scratch run; not actually non-blocking as backlog.md claims | `.github/workflows/test.yml`, `supabase/tests/` |
| 11 | Test coverage | Playwright `browser-check` suite is flaky and aborts on first failure, hiding up to 6/24 scenarios | `scripts/browser-check/run-all.mjs` |
| 12 | Test coverage / Security | Real production repo `haimunia-app` (outside this workspace) reportedly ships **no CSP at all**, per this repo's own code comment | `index.html:20-25` (comment) |
| 13 | Content/legal | PRIVACY.md/TERMS.md are still unresolved drafts and are linked live in the app | `PRIVACY.md`, `TERMS.md`, linked from `app.js:2844` |
| 14 | Content/legal | PRIVACY.md omits real shipped data categories: photos, comments, follows, profile-visibility toggles, admin user directory | `PRIVACY.md:5-20` |
| 15 | Navigation (design decision, not a bug) | Bottom tab bar replaced by hamburger nav menu in Community — changes the interaction model for every shared screen; needs an explicit decision, not a silent divergence | `index.html:595-644` |

Security's two original P0s (photo disclosure, reusable invite codes) are
**confirmed fixed** — not re-listed here as open items.

## Detailed findings by domain

### 1. Design Tokens & Visual System (13 findings — 1 P0, 5 P1, 7 P2)

Both apps share the same font stack, manifest, and several base component
rules verbatim. Community independently re-tuned several shared tokens
without a matching Noam change, and dropped one token entirely.

- **P0** `--shadow-sm` deleted in Community; `.subtabbtn.active` and
  `.rx-btn.active-type` lost their `box-shadow` with no comment/changelog
  explaining the removal. → *Restore `--shadow-sm` and re-apply it to both
  selectors.*
- **P1** `--shadow-card` uses a different formula per app (Community's is a
  deliberate, better redesign per its own comment) — every `.card` in both
  apps now renders subtly differently. → *Reconcile canonically, port winner
  to the other repo.*
- **P1** "Large text" accessibility toggle scales 20% in Noam (`--text-scale:
  1.2`) vs only 12% in Community (hardcoded `zoom:1.12`, variable removed
  entirely). → *Restore `--text-scale` and unify the magnitude.*
- **P1** `.page-title` typography diverges: Noam is Rubik/800, Community
  switched to Anton/400+letter-spacing with no corresponding Noam change. →
  *Pick one treatment for both.*
- **P1** `--steel` (secondary text) color value differs in both themes — the
  one outlier among an otherwise byte-identical palette. → *Reconcile the
  value.*
- **P1** `.icon-btn` component removed from Community; the two header icon
  buttons (nav-menu, notification bell) now use two different treatments
  that don't even match each other. → *Restore a consistent icon-button
  treatment.*
- **P2** `.save-btn` gradient (Community, via `color-mix()`) vs. flat (Noam)
  — same button renders differently.
- **P2** `color-mix()` adopted only in Community (11 uses); Noam still
  hand-writes `rgba()` tints for the same pattern — one-directional technique
  adoption worth standardizing.
- **P2** Card/chart-card/log-row border-radius drifted inconsistently (not a
  uniform scale shift — some grew, some shrank).
- **P2** Tap-target sizing (44px) and broadened `:focus-visible` scope are
  *ahead* in Community — worth backporting to Noam, the design reference.
- **P2** Bottom tab-bar visual language (pill+cap vs. inset-shadow+border)
  diverges, downstream of the navigation-IA change (see P0 #15 above).
- **P2** `.plate::after` metallic sheen (barbell visualization) exists only
  in Community — low-risk, worth backporting to Noam.
- **P3/informational** `--avatar-ink` is a correctly-scoped Community-only
  token; no action needed.

### 2. Shared-Screen Visual & UX Parity (10 findings — 3 P0, 5 P1, 2 P2)

Screens/components that exist in both apps: nav, home/log, WOD builder,
calendar, achievements, settings, onboarding.

- **P0** Bottom tab bar replaced by a hamburger nav-menu overlay in
  Community — a deliberate, documented IA change (5th "Community" tab +
  desktop sidebar) but it changes the interaction model for every shared
  screen and every other finding below is downstream of it. → *Explicit
  decision needed: bring a tab-bar-equivalent affordance back, or backport
  the hamburger pattern to Noam so both apps share one pattern
  intentionally.*
- **P0** Settings screen (`app.js:2797`, `renderSettingsBody`) still uses
  legacy `.divider-label`/`.card`/`.footer-note` classes; Noam's card-based
  `.settings-pane`/`.settings-block`/profile-avatar redesign
  (`app.js:4022`) never made it into Community. → *Port the redesign,
  keeping Community-only rows (cloud/backup panel, legal links) as
  additional sections.*
- **P0** WOD Builder (`index.html:701-729`) is the pre-redesign flat layout;
  the "צור אימון" create button sits mid-form — exactly the placement Noam's
  own code comment explains it fixed by pinning the button to a footer.
  Format chips also lost their descriptive subtitles. → *Port Noam's
  two-card layout with pinned footer and format-chip subtitles.*
- **P1** Calendar missing `.cal-panel` card chrome, `.cal-legend`, and
  `.cal-month-stats` monthly summary — real feature loss, not just styling.
- **P1** Calendar prev/next month chevrons are **reversed** relative to Noam
  — a concrete, verifiable bug. → *Swap the two `path` values.*
- **P1** Home/log screen lost the chosen/unchosen exercise-select empty
  state and `.stat-hero` styling that Noam added in a later UX pass.
- **P1** Onboarding modal subtitle still says "four screens" ("ארבעה
  מסכים") but Community's list now has five rows (Community was appended).
  → *Genuine copy bug, not a style question.*
- **P1** Header icon buttons use two different styles from each other
  (`.icon-chip.icon-chip-steel` vs. bare inline style) — neither matches
  Noam.
- **P2** Achievements panel missing progress chips, capstone
  eyebrow/earned-locked styling, and the dashed-border `.ach-invite`
  component.
- **P2** Settings staleness-banner threshold logic (5/30-day cloud-aware
  split) is a legitimate improvement, but lost Noam's icon+box `.settings-warn`
  visual treatment — carry the logic forward when porting the Settings
  redesign (P0 above).

### 3. Community-Only Screens Design Consistency (10 findings — 2 P0, 3 P1, 5 P2)

Community's own screens mostly reuse the shared component vocabulary rather
than inventing a parallel system — several classes (`.post-card`,
`.avatar-badge`, `.comment-row`) were even promoted into the shared
stylesheet. The problem is depth: `cloud.js` carries 722 inline `style=`
attributes across ~10,400 lines, and ~19 community-only classes have zero CSS
backing, so styling is retyped at each call site instead of defined once.

- **P0** `.chip-btn.primary` still used for "selected" state in ~13 places
  (audit filters, admin analytics, visibility/type pickers, RSVP, notif
  prefs, mod duration picker) even though `index.html:449-455` documents
  this exact confusion was already fixed for feed scope/leaderboard
  scope/mod-queue status. → *Finish the `.primary`/`.selected` migration
  everywhere.*
- **P0** Post menu and @mention picker hardcode `background:#1f2023` — a
  literal dark hex ignoring the theme system every other overlay in the app
  respects via `var(--surface)`. → *Replace with theme tokens.*
- **P1** No `.chip-btn.danger` class exists — destructive actions are styled
  3 different ad hoc ways, including an identical inline red-fill style
  string duplicated verbatim at two call sites.
- **P1** ~19 community-only classes (`coach-badge`, `pr-badge`,
  `notif-group`, `post-menu`, `progress-track`, etc.) have zero CSS backing
  — every instance re-declares its look inline, sometimes duplicating
  identical strings (e.g. `coach-badge`/`pr-badge` render pixel-identical
  output from three independently-maintained inline strings).
- **P1** `.post-media-grid` implies a grid layout but has no grid CSS —
  multi-photo posts just stack vertically.
- **P2** `.admin-tag` reused for a challenge "joined" badge with only its
  background overridden, leaving mismatched energy-orange text/border.
- **P2** Hardcoded `rgba()` tints (announcement badges, coach comment
  highlight) duplicate token colors at light-theme values only, breaking in
  dark mode, instead of the `color-mix()` pattern already established
  elsewhere.
- **P2** Avatar sizes are 7 arbitrary pixel literals with no shared scale.
- **P2** Notification center re-implements the feed's `.post-author`/
  `.post-time` typography from scratch via inline styles.
- **P2** `.save-btn` (full-page forms) vs. `.chip-btn.primary` (in-context
  actions) split is sensible but undocumented — worth writing down before
  the token sync touches either.

### 4. Core Feature & Fix Diff, Noam → Community (6 findings — 0 P0, 3 P1, 3 P2)

**The good news first:** nearly all of Noam's headline security/hardening
work (XSS-safe escaping, all 5 record sanitizers, prototype-pollution
guards, 25MB/20K-record import caps with confirm+auto-backup, the rewritten
origin-gated service worker, `crypto.randomUUID()` IDs, IndexedDB-backed
`userName`, `CSS.escape`, `openDB()` memoization, deferred
`revokeObjectURL`, CSP/font hardening) is **already present** in Community's
`src/sanitize.js`, `src/db.js`, `src/constants.js`, `sw.js`, and `app.js` —
Community's fork point sits right after that work landed upstream. Full list
of confirmed-present items is in the scratchpad report
(`04-feature-fix-diff.md`) if a re-check is ever needed.

The confirmed gaps are all fixes Noam shipped **after** the fork, mostly a
single 2026-09-02 redesign/bug-fix session:

- **P1** Stray "delete everything" confirmation (`confirmClear`, `app.js:253`)
  survives closing the Settings sheet without resetting — a user who backs
  out is one accidental tap from wiping data with no fresh warning. →
  *Reset `confirmClear` in `closeSettings()`.*
- **P1** Modal-overlay accessibility (focus trap + Escape) is wired for only
  1 of 9 dialogs (see Accessibility F1 above — same underlying gap, flagged
  independently by two agents).
- **P1** `interactive-widget=resizes-content` missing from the viewport
  meta — on Android Chrome, focusing an input leaves fixed UI (save bar,
  modals) floating over the keyboard instead of resizing around it. Noam
  fixed this and verified it on a real device. → *One-line fix.*
- **P2** History-tab search recomputes O(exercises × entries) on every
  keystroke; Noam replaced this with a single-pass lookup map
  (`bestEst1RMByExercise()`).
- **P2** App still opens with Back Squat / Fran pre-selected instead of an
  explicit empty state — Noam fixed this because it risked a user saving a
  set/WOD under the wrong exercise without realizing they never chose one.
- **P2** A batch of ~11 smaller correctness bugs fixed in Noam's
  2026-09-02 redesign session (null-kg display, stale search after wipe,
  bodyweight-0kg-with-no-delete, PR-replay-after-restore, month-nav wiping
  an unsaved note, etc.) were not individually re-verified against
  Community's now-diverged UI — flagged as a dedicated follow-up pass, not
  confirmed present or absent here.

### 5. Security & Data Access (5 findings — 0 new P0, 2 P1, 3 P2)

Both original 2026-08-27 P0 findings verified fixed **in the code**, not
just claimed:

1. Cross-user photo disclosure — closed by an ownership trigger plus a
   matching private-bucket storage policy.
2. Reusable/low-entropy coach invite codes — closed; codes are now hashed,
   expiring, rate-limited, and coach promotion is split into a
   service-role-only function unreachable from the browser. The anonymous-
   auth-weakens-throttle gap flagged in the 2026-08-27 remediation rescan as
   a remaining High also appears addressed (actor-key-based throttle that
   survives an anonymous-session reset).

The repo has grown substantially since (7→75 migrations, `cloud.js` now
10,405 lines). Spot-checking that growth: all 52 tables have RLS enabled, no
`to anon` grants, no `security definer` function missing `set search_path`,
sensitive tables consistently gated by `is_admin()`/`has_perm()`.

- **P1** Clickjacking mitigation is still structurally absent — GitHub
  Pages can't send `frame-ancestors`/`X-Frame-Options` as real response
  headers (the code honestly documents this rather than shipping an inert
  meta tag). → *Needs a hosting change (Cloudflare/Netlify/Vercel or an edge
  layer) if this needs closing before launch.*
- **P1** Live/production RLS behavior remains unverified — this audit was
  static-only; a real pgTAP run (see Test Coverage F1) and a multi-role
  staging smoke test (anon/member/coach/admin) are recommended before
  go-live.
- **P2** Moderation has a sound server-side `review_report()` function but
  no admin queue UI was found — safe but not operable pre-launch.
- **P2** Vendored `vendor/supabase.js` is version-checked but not
  checksum/integrity-checked — a compromised local copy that self-reports
  the right version would pass.
- **P2 (informational)** The "anon key is public because RLS covers
  everything" assumption is well-supported by this sampled review (~15
  sensitive tables checked) but not exhaustively verified against all 75
  migrations — recommend one full policy-by-policy pass against a
  role/action matrix before public launch.

### 6. Accessibility (11 findings — 2 P0, 3 P1, 6 P2)

Both apps remain far from WCAG 2.2 AA. Some prior-audit findings are
genuinely fixed (`--steel` contrast, photo alt-text, `field()` helper's
`aria-invalid`/`aria-describedby`, stepper clear-on-focus — though that last
fix landed only in Community). The two structurally biggest gaps are
unresolved, and one is a regression:

- **P0** Community's core training-log modals (picker, WOD picker/builder,
  achievements, celebration, notifications, onboarding) lost the generic
  focus-trap/Escape behavior Noam's base has for all of them — Community's
  own code comment admits this explicitly. Community's own community-dialog
  registry (`CLOUD_DIALOGS`) is well-designed by contrast; the gap is
  specifically in the inherited core screens.
- **P0** Zero heading elements (`h1`–`h3`) and zero landmark regions
  (`header`/`nav`/`main`) anywhere in either app, confirmed by exhaustive
  grep — total, not partial, and equally present across Community's 10K+
  line community layer.
- **P1** Tab/tablist widgets (main nav, WOD sub-tabs, and — new in Community
  — the feed scope filter) are marked up with `role="tab"` but implement no
  Arrow-key/roving-tabindex behavior.
- **P1** The est-1RM trend chart (shared logic, both apps) has no accessible
  name or data alternative for screen readers.
- **P1** `--brass` text color fails WCAG AA contrast (4.22:1, below 4.5:1)
  where used for small bold body text — PR values, leaderboard/badge text —
  meaningful data, not decoration.
- **P2** Calendar day grid lacks grid semantics, `aria-current`, and
  arrow-key day navigation (both apps).
- **P2** Noam still combines `zoom`-based text scaling with
  `overflow-x:hidden`, clipping content at enlarged text sizes — Community
  already fixed this and documented why; port the fix back to Noam.
- **P2** A few coach/admin inputs in Community are placeholder-only with no
  accessible name, unlike the rest of the app which routes through a
  `field()` helper.
- **P2** Report-reason radio group has no group-level label/`radiogroup`
  role.
- **P2** Numeric-stepper clear-on-focus bug is fixed in Community
  (`select()` instead of clearing) but not yet in Noam.
- **P2** Noam's `:focus-visible` rule covers fewer element types than
  Community's broader, already-correct version.

### 7. Performance & PWA/Offline (10 findings — 2 P0, 3 P1, 5 P2)

Both apps share a well-engineered service-worker foundation; Community's is
actually *more* advanced than Noam's (required/optional split, push
notifications, cache-prefix isolation), not behind. The real risk is
architectural, in how the community layer is loaded and gated:

- **P0** `cloud.js` (700KB) is classified `REQUIRED` in `sw.js`'s precache
  list, so a failed install-time fetch of it blocks the **entire offline app
  shell** — even though `app.js` already guards every cloud.js integration
  point defensively, proving the core doesn't need it to be required. →
  *Reclassify as `OPTIONAL`.*
- **P0** The community layer fires ~16 parallel Supabase requests
  unconditionally on every page load (`refreshSession()` cascade,
  `cloud.js:10252`), regardless of whether the user ever opens the
  Community tab — costs battery/data and contends with the offline-first
  core's own IndexedDB reads on every cold start. → *Gate behind first
  navigation to the Community tab.*
- **P1** No dynamic `import()`/code-splitting despite CSP already permitting
  it — 700KB parsed/compiled synchronously on every load, including for
  users who haven't joined a community.
- **P1** `cloud.js` is unminified (~30% comments/whitespace by volume) with
  no minify step, unlike the already-bundled `vendor/supabase.js`.
- **P1** No unified offline/degraded-mode banner for the community layer —
  failures are scattered per-feature (feed error text here, blank streaks
  widget there) instead of one clear "community needs a connection" signal.
- **P2** `REQUIRED_ASSETS` classification is undocumented and contradicts
  the rationale `sw.js`'s own comments give for avoiding all-or-nothing
  install failure.
- **P2** 11 sequential `<script>` tags with no `async`/`defer`; `src/*`
  module ordering is fragile (some load before `cloud.js`, some after).
- **P2 (positive)** `openDB()` is correctly memoized in both repos, with
  Community additionally namespacing its DB to avoid collisions with the
  real production app — no action needed.
- **P2** No manifest shortcut into `?tab=community`, despite two shortcuts
  existing for the training-log tabs.
- **P2 (informational)** No significant dead code or unexplained bloat found
  in either `app.js` on a quick pass — the size story is entirely `cloud.js`.

### 8. Code Architecture & Quality (12 findings — 0 P0, 4 P1, 8 P2)

Both repos are clean of the usual dead-code smells (no stray `console.log`,
`TODO`/`FIXME`, commented-out blocks, `alert()`). The real risk is
structural strain in `cloud.js` and duplicated safety-critical logic between
the two repos:

- **P1** `cloud.js`'s flat `state` object has ~89 keys spanning 11+
  unrelated feature domains with no namespacing — increasing collision risk
  as Phase 2/3 features land on top.
- **P1** The full-tree `innerHTML` rerender pattern (341 `rerender()` call
  sites) is under strain — it's the reason a ~60-line manual
  DOM-focus-restoration subsystem (`syncCloudDialogFocus`) has to exist at
  all. Worth a feasibility spike on scoped/keyed rendering before Phase 2.
- **P1** HTML-escaping is implemented twice under different names (`esc()`
  in `src/format.js` vs. locally reimplemented `safeText()` in `cloud.js`,
  used 372 times) — a hardening fix to one has no mechanism to reach the
  other.
- **P1** Core safety helpers (`cssSel`, `bag`, `esc`, `clean*`, `uid`) are
  currently byte-identical between the two repos but exist as two
  independently-maintained copies with no shared package — a future
  security-relevant fix to one has no path to the other except manual
  porting.
- **P2** Community modularized shared helpers into `src/*.js`; Noam stayed
  monolithic — a real improvement, but the two "same fork" repos now differ
  in basic file layout too, making backporting harder.
- **P2** `getFieldValue`/`setFieldState` dispatch style diverged (if/else
  chain in Noam vs. a data-driven `FIELD_ACTIONS` table in Community) despite
  identical behavior — evidence that even core (non-community) logic drifts
  stylistically once forked.
- **P2** `isIOSDevice()` duplicated verbatim between `app.js` and `cloud.js`
  within Community itself.
- **P2** 700+ inline `style=` attributes in `cloud.js` (same pattern noted
  independently by the community-screens audit) with no CSS-class
  extraction — top values repeat 20-33× each.
- **P2** `render()`'s single try/catch treats a `renderCalendarTab()` bug and
  a `renderCommunityApp()` bug identically — no error classification/
  reporting hook beyond `console.error`, worth routing through the existing
  `src/analytics.js` module.
- **P2** `sanitizeWodEntry`/`sanitizeCustomWod` field parity has drifted
  (Community added `partnerTag`, typed EMOM slots that Noam's copy lacks) —
  a landmine for any future shared-sanitizer extraction.
- **P2 (positive)** `cloud.js`'s ticket-scoped section comments are
  genuinely well-organized internally — the strain is file-level, not
  organizational.
- **P2** No documented convention for silent-catch vs. user-visible-error
  handling in `cloud.js` (31 silent catches, 10 user-visible, spot-checked as
  individually reasonable but with no written rule for future contributors).

### 9. Test Coverage & QA (12 findings — 3 P0, 5 P1, 4 P2)

Noam: 33 test files, 195/195 passing, no CI. Community: 103 test files, 939
tests (937 pass / 1 flaky / 1 skip) — up sharply from 164 at the last audit,
alongside 24 Playwright scenarios (up from 8).

- **P0** The pgTAP suite backing `migration-check` — which
  `docs/community/backlog.md` describes as non-blocking (COMM-020) — has no
  `continue-on-error` in the current workflow file, meaning it's a hard gate
  today. A from-scratch local run failed 68/1995 assertions across 17/56
  files. → *Verify actual current CI status and fix before V1; correct the
  stale backlog note either way.*
- **P0** The Playwright `browser-check` suite is flaky (a nondeterministic
  409 console error recurs across `duration.mjs`/`ladder.mjs`) and
  `run-all.mjs` aborts on first failure — across 3 local runs, 6 of 24
  scenarios never executed in any attempt.
- **P0** This repo's own code comment states the real production repo
  (`haimunia-app`) ships no CSP at all (see executive summary — needs direct
  verification against that repo, which isn't in this workspace).
- **P1** Storage-quota handling (`noteStorageError`) is implemented in both
  apps but tested in neither — higher risk for Community given its heavier
  storage footprint (photos, feed/analytics caching).
- **P1** No test for auth session/token expiry or refresh failure mid-session
  — a plausible scenario for a gym-use PWA that's often backgrounded.
- **P1** No `browser-check` (real-browser) coverage for post composition or
  moderation/report-review — Community's most-used action and its safety
  valve are unit-tested only, against a mocked client.
- **P1** RLS is tested at two layers by design (JS-mock + pgTAP), but the
  layer actually capable of catching a real cross-user RLS regression
  (pgTAP) is the one currently failing (ties to P0 #1 above) — re-verify the
  RLS-tagged files specifically once the suite is green.
- **P2** Noam has zero CI — its hardening work is protected only by manual
  `npm test` runs.
- **P2 (positive)** `test/sw-precache.test.mjs` evolved stronger in
  Community (required/optional split assertions) — worth backporting to
  Noam.
- **P2 (positive)** `sanitizers.test.mjs`/`import.test.mjs` are
  byte-identical and passing in both repos — the prototype-pollution
  regression test carries over cleanly. Community has grown a lot of new
  data shapes with no community-specific version of that same test, though.
- **P2** A sign-out/sign-in dedup test is flaky under full-suite load
  (passed twice in isolation) — worth distinguishing harness timing from a
  real intermittent double-subscription bug before shipping.
- **P2 (positive)** Data-loss surfaces (import/export, sync ordering,
  backup, storage isolation) are well covered — no material gap beyond what
  P1 items above already flag.

### 10. Content, Legal & Docs (10 findings — 2 P0, 3 P1, 5 P2)

- **P0** PRIVACY.md/TERMS.md still open with "this is a draft" language and
  close with a literal unfinished checklist (operator identity, contact,
  region, retention, subprocessors, lawful basis, age, data-subject rights)
  — unchanged except one paragraph since the prior audit's 2/10 score, and
  linked live in-app (`app.js:2844`).
- **P0** PRIVACY.md omits real shipped data categories: post photos,
  comments, the follow graph, the full profile-visibility toggle set, and
  the admin-visible user directory.
- **P1** Noam's PRIVACY.md/TERMS.md describe cloud/community functionality
  that doesn't exist in the shipped Noam app at all (confirmed: no
  `cloud.js` script tag, zero "community" references in `app.js`) — stale
  copy-paste from the shared fork point.
- **P1** Noam still ships dead `cloud.js`/`cloud-config.js`/
  `COMMUNITY_SETUP.md` containing a stale magic-link email auth flow that
  directly contradicts Noam's own privacy claim ("never collects an email"),
  plus live production Supabase credentials in unused code.
- **P1** Community's CHANGES.md is ~9 commits / 5-6 days stale (last entry
  2026-08-27 vs. commits through 2026-09-01, including user-facing a11y/RTL
  fixes) — Noam's changelog discipline is current by contrast.
- **P2** TERMS.md is byte-identical between both repos and unchanged since
  the fork — doesn't mention comments/photos/coach powers/moderation, and
  has no concrete minimum age.
- **P2** PRIVACY.md's "no email collected" claim is technically true but
  omits that a synthetic `.invalid` email exists server-side and is
  admin-visible — worth one clarifying sentence.
- **P2** `COMMUNITY_SETUP.md` (documents username+password as shipped) and
  the community-module-plan doc (describes a not-yet-deployed
  "recovery-verified" gate) don't cross-reference each other, so a reader of
  either alone could reach the wrong conclusion about what's currently live.
- **P2** One CHANGES.md entry uses a "v3.0.0" version tag not used anywhere
  else — minor format inconsistency.
- **P2** The plaintext-export privacy warning both repos' own CHANGES.md
  flagged as a backlog item ("Left for you") was never added to PRIVACY.md
  or the UI.

## Not covered in this pass — recommended follow-ups

- **The actual `haimunia-app` production repo** is outside this workspace
  and was never directly inspected — only referenced by a code comment in
  this repo. Its CSP status (P0 #12) needs direct verification.
- **A dedicated re-check of the ~11 smaller Noam bug fixes** bundled in the
  2026-09-02 redesign session (Feature/Fix Diff, item F6) against
  Community's now-diverged screens.
- **A full, non-sampled RLS policy review** against a role/action matrix
  (anon, unredeemed auth, member, coach, admin), codified as pgTAP tests
  (Security F2/F5).
- **A live/production smoke test** (multi-account: anonymous, member, coach,
  admin, blocked user) once the pgTAP gate is actually green.

## Suggested sequencing

1. **Trust the gates first.** Fix or correctly label the pgTAP/browser-check
   CI status (Test Coverage P0s #1-#2) before relying on green CI for
   everything else in this list — otherwise later fixes can't be verified.
2. **Verify the production CSP gap** (P0 #12) directly against `haimunia-app`
   — outside this workspace, but the highest-severity item if the comment is
   accurate.
3. **Close the legal-doc gap** (P0 #13-#14) — it's user-visible today and
   the lowest-effort-to-risk-ratio item on this list.
4. **Decide the navigation question** (P0 #15) — it gates a large share of
   the design-parity work, since Settings/WOD-Builder/calendar findings all
   assume a target IA.
5. **Design sync**: Settings redesign port, WOD Builder fix, the token
   findings (`--shadow-sm`, `--steel`, `.page-title`), and the two
   community-screen P0s (chip selection state, popover theming).
6. **Accessibility P0s** (modal focus-trap, headings/landmarks) — largest
   remaining launch-readiness risk after the above.
7. **Performance P0s** (`cloud.js` required-asset reclassification, deferred
   session cascade) — both are small, contained changes with outsized
   offline-reliability impact.
8. Everything else (P1/P2) by domain, at your discretion.
