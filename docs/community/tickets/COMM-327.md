# COMM-327 Decide and align on one navigation pattern across both apps

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Noam uses a persistent bottom tab bar; Community replaced it with a hamburger-
triggered full-page nav menu (to fit a 5th Community tab plus a desktop
sidebar breakpoint). This is a deliberate, documented change, but it's the
single largest interaction-model divergence between the two apps and every
shared-screen finding in this audit is downstream of it. It needs an explicit
decision, not a silent divergence.

## Acceptance criteria

- [x] A decision is recorded (in this ticket or a design note) on whether Community
  keeps the hamburger nav-menu pattern (and Noam adopts it too, if Noam
  continues receiving syncs) or a bottom-tab-bar-equivalent affordance is
  restored in Community (e.g. 4 fixed tabs + "More"). **Decision (from the
  product owner, not invented by this ticket): a hybrid.** A fixed bottom
  tab bar for the 4 main (offline training-log) tabs, matching Noam's
  pattern, plus a small hamburger that opens the remaining destination
  (Community) — not a full port of either app's existing pattern alone.
- [x] Once decided, the three coexisting active-tab visual treatments are
  addressed for the two that this decision actually puts in tension
  (`.tabbtn.active` in the new bottom bar vs. `.navrow.tabbtn.active` in
  the now-single-item nav menu) — see Implementation below.
  `.subtabbtn.active` (Community's own internal sub-tab navigation:
  feed/boards/directory/account, and the WOD sub-tabs) is a different
  navigation level entirely and was left alone; COMM-350 is still open for
  anyone who wants to revisit that as a separate, narrower question.

## Location / evidence

- Community: `index.html:595` (`#navMenuBtn`), `:633-644` (`#navMenuOverlay`),
  `app.js:160` (`renderNavMenuList`), rationale comment `index.html:614-632`
- Noam reference: `index.html:1288-1312` (`#bottomNavWrap`/`.tabbar`)

## Dependencies

- COMM-350

## Implementation, 2026-09-02

- `index.html`: new `#bottomNavWrap` (fixed, `bottom:0`) wraps the existing
  `#bottomBar` (save button) and a new `.tabbar#bottomTabBar` (4 buttons,
  populated by `app.js`). `.bottom-bar` lost its own `position:fixed` — one
  fixed wrapper computing the safe-area inset once, not two independently
  (Noam's `CHANGES.md` documents the exact gap-below-the-bar bug this
  avoids). `.tabbar`/`.tabbtn`/`.tabbtn.active` CSS rules (previously dead —
  an unused inline-segmented-control leftover, confirmed via grep) redefined
  to match Noam's fixed-dock treatment, keeping Community's own 44px tap
  targets and `--shadow-sm`/`color-mix()` tokens rather than a byte-for-byte
  port. `#app`'s bottom padding raised from 100px to 200px (matching Noam)
  now that the wrap is persistent and the save bar can be visible above it
  at the same time. `interactive-widget=resizes-content` added to the
  viewport meta (this is COMM-340 — folded in here since it's specifically
  about this same fixed-position element).
- `app.js`: `getNavItems()` items gained a `main: true/false` flag.
  New `renderBottomTabBar()` renders the 4 main items with bare icon+label
  (Noam's compact style, not the chip-wrapped list-row style the nav menu
  uses). `renderNavRows()` gained an `onlyOther` parameter; the mobile nav
  menu (`renderNavMenuList`) now passes `true` (Community only); the
  desktop sidebar (`renderDesktopSidebar`) still passes `false` (shows
  everything — no bottom bar to split against at that width). `render()`
  populates `#bottomTabBar` every render, same pattern as the nav menu list.
- `#bottomNavWrap .tabbar` hidden at the existing ≥900px desktop breakpoint,
  alongside `#navMenuBtn` — the sidebar already covers every destination
  there.
- `scripts/browser-check/lib/actions.mjs`'s `switchTab()` helper needed a
  matching fix — see COMM-333's writeup for why and what broke without it.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
