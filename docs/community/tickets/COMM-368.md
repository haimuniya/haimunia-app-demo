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

## Investigated 2026-09-04 (real read of `crossfit-pwa-Noam`, not assumed)

The ticket's premise — "byte-identical between Noam and Community" — was
asserted from the original audit, before either extraction. This session
actually read `crossfit-pwa-Noam/app.js:319-409` (the same
`esc`/`cssSel`/`bag`/`cleanStr`/`cleanNum`/`cleanId`/`cleanISODate`/
`cleanTs`/`uid` block the ticket cites, at the same line numbers) and
compared each function body, character by character, against
`src/shared/safe-helpers.js`'s versions.

**Confirmed, not assumed: still byte-identical, zero drift.** Every one of
the nine helpers — including `LIMITS.idLen` (128 in both), the exact
regexes (`cleanStr`'s control-char strip, `cleanId`'s charset,
`cleanISODate`'s date-shape check), and `uid`'s two-level
`randomUUID`/`getRandomValues`/`Date.now()+Math.random()` fallback chain —
matches. So the extraction's core premise (there is one true, safe
implementation to standardize on) still holds; this is not a case where
"reconciling" would mean picking a winner, only a case of Noam adopting
what Community already extracted.

### What `crossfit-pwa-Noam` needs to do to actually consume the package

Noam is a classic-script app with no bundler (`index.html` loads only
`./theme-init.js` then `./app.js` — confirmed, no `<script type="module">`
anywhere), the same architecture Community had before COMM-368, so the
same vendor-a-file approach Community's own README already describes
applies directly:

1. Copy `src/shared/safe-helpers.js` from this repo into
   `crossfit-pwa-Noam/src/shared/safe-helpers.js` verbatim (it has zero
   dependencies and touches neither DOM, storage nor network — the whole
   point of the module boundary). Record `VERSION` "1.0.0" as the vendored
   version, the same way Community's own README asks any vendored consumer
   to.
2. In `crossfit-pwa-Noam/index.html`, add
   `<script src="./src/shared/safe-helpers.js"></script>` **before**
   `<script src="./app.js"></script>` (currently the sole script tag at
   line 1602) — the module has to run first, exactly as it does in this
   repo's `index.html`.
3. In `crossfit-pwa-Noam/app.js`, delete the local definitions of the nine
   helpers (`esc` at line 320, `cssSel` at 324-327, `bag` at 348, `cleanStr`
   at 374-378, `cleanNum` at 379-383, `cleanId` at 384-389, `cleanISODate`
   at 390-394, `cleanTs` at 395-399, `uid` at 400-409) and replace them with
   bindings off the shared module, matching this repo's own
   `src/constants.js` pattern:
   `var esc = window.BoxLogSafe.esc, cssSel = window.BoxLogSafe.cssSel, bag = window.BoxLogSafe.bag, cleanStr = window.BoxLogSafe.cleanStr, cleanNum = window.BoxLogSafe.cleanNum, cleanId = window.BoxLogSafe.cleanId, cleanISODate = window.BoxLogSafe.cleanISODate, cleanTs = window.BoxLogSafe.cleanTs, uid = window.BoxLogSafe.uid;`
   (`var`, not `const` — a top-level `var` in a classic script also
   publishes onto `window`, matching what the deleted `function` statements
   did implicitly). Noam's own `LIMITS.idLen` (`app.js:352`, currently a
   literal `128`) should read `window.BoxLogSafe.LIMITS.idLen` instead, the
   same way this repo's `src/constants.js` does, so the cap cannot drift a
   second time.
4. Add `"./src/shared/safe-helpers.js"` to `crossfit-pwa-Noam/sw.js`'s
   `ASSETS` precache array (currently starts at line 9, with `"./app.js"`
   at line 12) — `app.js` calls `esc()`/`uid()` unconditionally, so, exactly
   as in this repo, the offline shell cannot boot without it.
5. Run Noam's own test suite after — several of its test files stub or
   import `esc`/`uid`/etc. directly (this repo's own equivalent,
   `test/sanitizers.test.mjs`, reaches them via `window.esc` etc.; Noam's
   suite will need the same load-order fix in whatever boot helper it uses,
   analogous to this repo's `test/helpers/boot.mjs` loading
   `src/shared/safe-helpers.js` before `app.js`).

None of the above was done or attempted in `crossfit-pwa-Noam` — per this
task's constraints, that repo's files were only read, never modified.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
