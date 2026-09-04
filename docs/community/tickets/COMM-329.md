# COMM-329 Add heading elements and landmark regions to the app shell

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: partial
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Neither app has a single `<h1>`-`<h3>`, `<header>`, `<nav>`, `<main>`,
`<footer>`, or `role="main"|"navigation"|"banner"` anywhere — confirmed by
exhaustive grep across `index.html`, `app.js`, and `cloud.js` in both repos.
Screen-reader heading/landmark navigation returns nothing on every screen of
both apps, including all of Community's community layer.

## Acceptance criteria

- [ ] Real `<h1>`/`<h2>` elements introduced for page and section titles (replacing
  plain `<div class="page-title">` / section-title divs) with no visual change
  for sighted users.
- [ ] `<header>`/`<nav>`/`<main>` landmarks added to the app shell; exactly one
  `<main>` landmark per screen.
- [ ] An axe or heading-outline scan of every top-level tab and every community
  screen (feed, profile, challenges, admin) shows a non-empty, logically nested
  heading list.

## Location / evidence

- Confirmed absent via grep across `index.html`, `app.js` (both repos) and
  `cloud.js`
- `app.js:149` (`.page-title` div), `app.js:536-561` / `cloud.js:3355` (section
  titles as plain divs/spans)

## Shipped 2026-09-02 (Community repo only — partial)

- Heading reset added (`h1, h2, h3 { margin: 0; font: inherit; }`,
  `index.html`) so semantic elements inherit their existing class's
  size/weight/margin instead of picking up the UA default heading margin on
  top of it.
- `renderTabHeader()` (`app.js`) now emits `<h1 class="page-title">` — covers
  all 4 core tabs (add/history/calendar/wod), one shared function.
- `sectionHead()` (`cloud.js`, 30 call sites across feed/challenges/events/
  moderation/admin/etc.) and the 4 inline achievements-panel section headers
  (`app.js`) now emit `<h2 class="ach-section-title">` instead of `<span>`.
- App shell landmarks: `.header` div → `<header>`; `#content` wrapped in
  `<main>` (kept `role="tabpanel"` on the inner div rather than on `<main>`
  itself — an explicit `role` on the landmark element would override its
  implicit main-landmark semantics for assistive tech); `#desktopSidebar`
  and `#navMenuList` → `<nav aria-label="ניווט ראשי">`.
- Verified: `node --test` full suite green (941 tests, 940 pass / 1 skip / 0
  fail) after these changes: no test asserted a tag name or `span`/`div`
  selector for any element touched here.

## Shipped 2026-09-03 (closes the h1 gap below)

- `renderCommunityApp()`'s main tabbed shell (feed/boards/directory/account/
  coach) now opens with `renderTabHeader("community")`, the same shared
  function the other 4 solo tabs already use — reads "קהילה" from the one
  `getNavItems()` registry entry rather than inventing a second name (the
  per-club name stays the club-strip card's own identity, not this screen's).
  The pre-membership gate screens above it in the same function (login,
  invite code, profile completion, recovery) are unchanged — they're
  one-off setup cards, not "the Community tab" this gap was about.
- Verified via the existing community test suite (feed-client, nav-exports)
  booting `renderCommunityApp()` for real; no ReferenceError from calling an
  app.js-defined function from cloud.js (cloud.js loads first in
  `index.html`, but this call only executes on an actual render, well after
  both scripts have run).

## Shipped 2026-09-04 (further remaining-scope closure, this repo only)

- `adminAnalyticsCard(title, bodyHtml)` (`cloud.js`) — the one shared
  function behind all 27 metric cards inside the admin analytics dashboard
  (`renderAdminAnalyticsDashboard()` and its own nested groups) — now emits
  `<h3 class="field-label">` instead of `<div class="field-label">`. This is
  a real "admin panel sub-header not going through `sectionHead()`" gap, the
  exact category the "Not done" note below named; converting the one shared
  function fixes all 27 call sites at once, the same leverage the original
  pass used for `sectionHead()`/`ach-section-title`. Nests correctly: every
  caller of `adminAnalyticsCard()` already renders inside a `sectionHead()`
  h2 (verified: `renderAdminAnalyticsDashboard`, `renderRegistrationFunnel`,
  `renderMemberSegments` — all reached from the h2 "לוח בקרה: אנליטיקת
  קהילה" section), so h3 is the correct next level, not a skip.
  `test/community-retention-correlation-views.test.mjs:176` already
  selects `.chart-card .field-label` by class, not tag, so it needed no
  change.
- New `test/heading-outline.test.mjs`: a real automated heading-outline
  scan (not a scanner dependency, but a genuine DOM heading-list check) for
  the 4 solo top-level tabs (add/history/calendar/wod), using the existing
  `bootApp()` jsdom harness. Asserts, per tab, exactly one `<h1>` inside
  `<main>` and that the heading list never skips a level going deeper (no
  h3 with no ancestor h2, etc.) — the real substance of acceptance
  criterion #3. This is real, if partial, closure of the "no automated
  scan was run" gap below: it covers the 4 solo tabs for real, but not the
  four community screens the criterion also names (see below).

## Not done — remaining scope

- The admin-analytics sub-headers are fixed, but `cloud.js` still has
  roughly 40 other one-off `<div class="field-label">` sub-headers acting
  as section/panel titles outside any shared function (invite management's
  two panels, challenge/event "ended" list headers, team management,
  monthly-recap card labels, profile-completion sub-labels, etc. — see
  `grep -n 'class="field-label"' cloud.js`). Converting those is a
  file-wide audit, one heading-shaped element at a time, in a 10,000+ line
  file — explicitly out of scope for this pass too, same reasoning as the
  original 2026-09-02 pass's own scope boundary. This is what a real
  heading-outline/axe scan across every screen (next bullet) would surface
  systematically instead of by manual grep.
- Not applied to `crossfit-pwa-Noam` — confirmed by actually reading
  `crossfit-pwa-Noam/index.html:155` (`.page-title`, still a plain
  `<div id="pageTitle">`) and `crossfit-pwa-Noam/app.js:1287`
  (`.ach-section-title`, still a plain `<span>`) — not out-of-date
  guesswork, read directly from that checkout. Cannot be changed from here
  (see repo-access constraints); whoever owns that repo needs to apply the
  same `<h1>`/`<h2>` conversion this repo already shipped 2026-09-02.
- No automated scan covers the four **community** screens (feed, profile,
  challenges, admin) acceptance criterion #3 also names. Reaching them in
  a test needs `bootCommunity()` with a mock Supabase project and, for the
  admin screen specifically, an admin/coach fixture plus in-app navigation
  to each community sub-view — real, separate harness work, not a small
  addition to `test/heading-outline.test.mjs`.
- No axe-core (or any other accessibility-scanner) dependency exists
  anywhere in this repo — checked `package.json`, `node_modules`, and
  `scripts/browser-check/package.json` (only `playwright`, no
  axe/a11y-named script in that directory). Adding real axe-core coverage
  is new tooling (a new devDependency plus a Playwright-driven scan
  script), not a fix-in-place; `test/heading-outline.test.mjs` above covers
  the "logically nested, non-empty heading list" half of criterion #3
  without that dependency, but does not replace a full WCAG-rule scan.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
