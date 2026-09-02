# COMM-334 Confirm CSP status of the real production repo (haimunia-app) and port CSP headers to it

Phase: Design sync & audit remediation (2026-09-02)
Agent: unassigned (separate repo, outside this workspace)
Status: todo
Priority: P0
Attendance-blocked: no

## Problem / user outcome

This repo's own `index.html` carries a code comment stating verbatim that "the
production app (haimunia-app) ships no CSP at all, so this demo is still
strictly ahead on every directive that does work via <meta>." This audit only
had access to `haimunia-app-demo-publish`, not `haimunia-app` — but if the
comment is accurate, the actual going-live codebase currently has zero
XSS/exfiltration defense-in-depth from CSP, which is materially higher
severity than anything found inside this repo given Community's user-generated
content surfaces (posts, comments, photos).

## Acceptance criteria

- [ ] The real `haimunia-app` production repo's current CSP status is directly
  verified (not inferred from a comment in a different repo).
- [ ] If confirmed absent, an equivalent Content-Security-Policy is added — ideally
  as a real response header via the production host, not a `<meta>` tag, so
  `frame-ancestors`/`X-Frame-Options` can also be enforced (see COMM-337).

## Location / evidence

- `index.html:20-25` (comment referencing the production repo's CSP status)
- Note: this ticket cannot be fully verified or closed from within this repo —
  requires direct access to `haimunia-app`.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
