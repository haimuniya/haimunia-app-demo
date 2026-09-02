# COMM-337 Move hosting off GitHub Pages (or add an edge layer) to enable clickjacking headers

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`frame-ancestors`/`X-Frame-Options` cannot be delivered via `<meta>` — only as
real HTTP response headers — and GitHub Pages cannot send custom response
headers. The app can still be iframed by a third party and used for
clickjacking against any authenticated action (invite redemption, coach-
promotion trigger, report submission). The code already documents this
honestly rather than shipping an inert meta tag.

## Acceptance criteria

- [ ] A hosting option that can send custom response headers is chosen (Cloudflare
  Pages, Netlify, Vercel, or a CDN edge in front of GitHub Pages).
- [ ] `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
  are served as real response headers in production.
- [ ] Verified via a live response-header check that a page load inside a foreign-
  origin `<iframe>` is blocked by the browser.

## Location / evidence

- `index.html:19-27` (comment), `:29-40` (CSP meta tag)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
