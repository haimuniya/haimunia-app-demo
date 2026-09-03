# COMM-334 Confirm CSP status of the real production repo (haimunia-app) and port CSP headers to it

Phase: Design sync & audit remediation (2026-09-02)
Agent: unassigned (separate repo, outside this workspace)
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

This repo's own `index.html` carried a code comment stating verbatim that "the
production app (haimunia-app) ships no CSP at all, so this demo is still
strictly ahead on every directive that does work via <meta>." This audit only
had access to `haimunia-app-demo-publish`, not `haimunia-app` — but if the
comment were accurate, the actual going-live codebase would have zero
XSS/exfiltration defense-in-depth from CSP, which would be materially higher
severity than anything found inside this repo given Community's user-generated
content surfaces (posts, comments, photos).

**Resolved 2026-09-03: the comment's claim was wrong, and the finding does not
hold.** Verified directly, not inferred:
- A live checkout of `haimunia-app`'s `origin/main` was available locally at
  `crossfit-pwa-Noam` (its `origin` remote is `github.com/haimuniya/haimunia-app`).
  `git show origin/main:index.html` shows the same kind of meta-tag CSP as
  this demo repo.
- Directly confirmed against the live production URL,
  `https://haimuniya.github.io/haimunia-app/`: `curl -sD -` shows no
  `content-security-policy` or `x-frame-options` HTTP response header (same
  GitHub Pages limitation this repo already documents), and the served HTML
  carries the same `<meta http-equiv="Content-Security-Policy">` tag,
  including a `frame-ancestors 'none'` directive this demo's own meta tag
  did not even list (inert either way, but present in production).
- So production is not "strictly behind" this demo on CSP — both ship an
  equivalent meta-tag CSP, and both share the exact same real, unclosed gap:
  no real HTTP response headers on GitHub Pages, tracked separately as
  COMM-337.

The stale comment in this repo's `index.html` has been corrected to state the
verified reality instead of the unverified assumption, and this demo's own
meta tag now also lists `frame-ancestors 'none'` for parity with production
(inert in meta form either way, until COMM-337 lands).

## Acceptance criteria

- [x] The real `haimunia-app` production repo's current CSP status is directly
  verified (not inferred from a comment in a different repo).
- [x] If confirmed absent, an equivalent Content-Security-Policy is added — ideally
  as a real response header via the production host, not a `<meta>` tag, so
  `frame-ancestors`/`X-Frame-Options` can also be enforced (see COMM-337).
  Not applicable: confirmed present, not absent.

## Location / evidence

- `index.html:19-27` (comment referencing the production repo's CSP status,
  now corrected)
- Verified via a local checkout of `haimunia-app`'s `origin/main` (present at
  `crossfit-pwa-Noam` in this workspace) and a direct `curl` against
  `https://haimuniya.github.io/haimunia-app/`, 2026-09-03.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
