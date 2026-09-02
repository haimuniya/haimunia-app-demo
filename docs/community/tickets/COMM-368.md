# COMM-368 Extract shared low-level safety helpers into a package or submodule used by both repos

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`esc`/`cssSel`/`bag`/`clean*`/`uid` are currently byte-identical between Noam
and Community but exist as two independently-maintained copy-pasted forks with
no shared package. A future security-relevant fix to `cleanId()` or `cssSel()`
in one repo has no mechanism to propagate to the other except a human
remembering to port it by hand.

## Acceptance criteria

- [ ] Shared low-level helpers (`src/format.js` + `src/sanitize.js` + the relevant
  slice of `src/constants.js`) extracted into a small versioned package or git
  submodule consumed by both repos.
- [ ] No behavior change; a follow-up fix to one repo propagates to the other via a
  version bump instead of manual copy-paste.

## Location / evidence

- Noam: `app.js:320-402`
- Community: `src/format.js`, `src/constants.js:288-303`, `src/sanitize.js:1-37`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
