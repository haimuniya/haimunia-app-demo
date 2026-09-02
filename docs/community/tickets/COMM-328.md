# COMM-328 Port overlay focus-trap/Escape contract to Community's core training-log dialogs

Phase: Design sync & audit remediation (2026-09-02)
Agent: unassigned (app.js core, outside the 15-agent community roster)
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Noam's base app wires every modal overlay (picker, WOD picker, WOD builder,
achievements, celebration, notifications, settings, onboarding, welcome)
through a shared `OVERLAY_A11Y`/`trapFocusOnOpen`/`restoreFocusOnClose`
mechanism giving Tab-trap, Escape-to-close, and focus restoration. Community's
own dialog registry (`APP_DIALOGS`) exists and is well-designed, but its own
code comment states it is wired only into the new nav menu and settings — the
picker, WOD picker/builder, achievements, celebration, notifications, and
onboarding overlays never got migrated onto it. Community's own community-
specific dialog registry (`CLOUD_DIALOGS`) does not have this gap.

## Acceptance criteria

- [x] `registerAppDialog()` (or equivalent) called for the picker, WOD picker, WOD
  builder, achievements, celebration, notifications, and onboarding overlays.
  (Welcome was found during implementation as a missed 8th dialog with the
  identical gap — Noam's own reference list names it too — so it's
  included as well.)
- [x] Tab cycles only within the topmost open dialog; Escape closes it (except
  onboarding/welcome, which stay click-backdrop-only by design); focus returns
  to the triggering control on close.
- [x] `appDialogFocusables()`'s selector narrows its bare `[href]` clause to
  `a[href]`, so non-interactive `<use href="#glyphN">` medal SVG elements are
  never included in the trap.
- [ ] Verified with a keyboard-only manual pass across all migrated dialogs.
  **Not done** — no browser/manual-testing access from this environment.
  Verified instead by: (a) full `node --test` suite green (941 tests) with
  no test asserting behavior these changes touch broke, (b) code review of
  each registration against the existing `navMenu`/`settings` pattern this
  mirrors, (c) a full `scripts/browser-check` Chromium pass (24/24, ×5) —
  real-browser coverage, though none of those scenarios specifically drive
  Tab/Escape on these dialogs. A real keyboard pass is still worth doing
  before shipping.

## Location / evidence

- Community: `app.js:3423-3502` (`APP_DIALOGS`/`registerAppDialog`, only
  `navMenu` and `settings` registered)
- Overlay open/close pairs not yet migrated: `openPicker`/`closePicker`
  (`app.js:3388-3422`), `openAchievements`/`closeAchievements` (`:581-588`),
  `openNotifications`/`closeNotifications` (`:796-807`),
  `openOnboarding`/`closeOnboarding` (`:816-825`), celebration (`~:700-712`),
  WOD builder/picker (`:1739-1770, :3552-3565`)
- Noam reference: `app.js:5304-5349` (`OVERLAY_A11Y`)
- Community's own gap acknowledgment: `app.js:3423-3431`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
