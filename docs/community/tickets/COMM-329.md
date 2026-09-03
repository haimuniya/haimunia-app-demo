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

## Not done — remaining scope

- Sub-section headings inside `cloud.js` that don't go through `sectionHead()`
  (e.g. modal/dialog titles, admin panel sub-headers) were not audited or
  converted — this pass covered the two highest-leverage shared functions,
  not every heading-shaped element in a 10,000+ line file.
- Not applied to `crossfit-pwa-Noam` — out of scope for this pass (Noam
  wasn't part of the "build tickets in Community's system" decision), but
  the accessibility audit finding was for both repos; Noam's `.page-title`/
  `.ach-section-title` still render as `<div>`/`<span>`.
- No automated axe/heading-outline scan was run to verify this ticket's own
  acceptance criteria #3 — verification here was source-level (grep +
  balanced-tag check) and the existing test suite, not a real accessibility
  scanner.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
