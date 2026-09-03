# COMM-324 Port Noam's two-card WOD Builder layout with pinned footer

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Community's WOD Builder modal is the pre-redesign flat layout with the create
button placed mid-form — exactly the placement problem Noam's own code comment
says it fixed by pinning the create button to a footer. Format chips also lost
their descriptive subtitles.

## Acceptance criteria

- [x] WOD Builder markup restructured into Noam's two-card layout (`.wodbuild-card-
  details` + `.wodbuild-card-moves`).
- [x] "צור אימון" create button becomes a pinned footer (`.wodbuild-foot`),
  reachable regardless of scroll position.
- [x] Format chips regain descriptive subtitles (e.g. "זמן" / "כמה מהר סיימתם").
- [x] Existing WOD-builder tests pass; no regression to `renderWodBuilderFormats()`
  behavior.

## Shipped 2026-09-03

`crossfit-pwa-Noam` is not checked out in this workspace, so Noam's exact
`.wodbuild-*` CSS at `index.html:1347-1394` couldn't be read - the ticket's
own evidence names the two card classes and the footer class, which was
enough to build the shape without the other repo:

- `#wodBuilderName`/format picker/EMOM & time-cap options now live inside
  `.wodbuild-card-details`; the movement search + list live inside
  `.wodbuild-card-moves` - both a `.card`-style section (surface, border,
  `--shadow-card`).
- The "צור אימון" button moved out of `.modal-list` (the scrollable middle
  section) into a new `.wodbuild-foot`, a sibling of `.modal-list` inside
  `.modal-sheet`'s flex column - the same structural trick `#bottomNavWrap`
  already uses to stay pinned regardless of scroll position.
- Each `.format-chip` gained a `.format-chip-sub` line (זמן→"כמה מהר
  סיימתם", AMRAP→"כמה סיבובים הספקתם", משקל מקסימלי→"המשקל הכי כבד
  שהרמתם", EMOM→"תרגיל חדש כל דקה").
- `renderWodBuilderFormats()` only toggles `.active`/`aria-checked` on the
  existing `.format-chip` buttons via `querySelectorAll` - it never
  regenerates their markup, so adding the subtitle `<span>` statically in
  `index.html` carried zero regression risk to that function.
- Verified via `test/wod-extras.test.mjs`, `test/emom.test.mjs`,
  `test/audit-ux-fixes.test.mjs` (all still pass) plus a direct render
  check confirming the footer button, both cards, and a chip subtitle all
  exist in the real DOM.

## Location / evidence

- Community: `index.html:701-729` (flat `.modal-list` layout)
- Noam reference: `index.html:1347-1394`, `.wodbuild-*` CSS rules

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
