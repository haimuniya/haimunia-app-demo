# COMM-368 Extract shared low-level safety helpers into a package or submodule used by both repos

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: partial
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`esc`/`cssSel`/`bag`/`clean*`/`uid` are currently byte-identical between Noam
and Community but exist as two independently-maintained copy-pasted forks with
no shared package. A future security-relevant fix to `cleanId()` or `cssSel()`
in one repo has no mechanism to propagate to the other except a human
remembering to port it by hand.

## Acceptance criteria

- [x] (this repo) Extracted into `src/shared/safe-helpers.js` +
  `src/shared/package.json` (`@boxlog/safe-helpers` v1.0.0) +
  `src/shared/README.md`. This repo now consumes it and no longer defines any
  of the nine helpers anywhere else.
- [ ] (other repo) `crossfit-pwa-Noam` consuming it. NOT DONE and not doable
  from the workspace this ticket was implemented in - that repo was not
  checked out. See the backlog note.
- [x] No behavior change (verified helper-by-helper against the originals over a
  shared input corpus before the originals were deleted).
- [ ] Propagation via version bump is only half-wired: the versioned artifact
  and the protocol exist (`src/shared/README.md`), but until the other repo
  actually consumes it a fix here still has to be hand-carried there.

## Location / evidence

- Noam: `app.js:320-402`
- Community: `src/format.js`, `src/constants.js:288-303`, `src/sanitize.js:1-37`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
