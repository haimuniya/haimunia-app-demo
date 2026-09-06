# Response headers — the clickjacking gap and how to close it

Launch-readiness audit, SEC-014 (and the header half of SEC-015's
mitigation).

## The problem, stated precisely

`index.html` ships a strict Content-Security-Policy in a `<meta>` tag. That
covers most directives — but **`frame-ancestors` is ignored in a meta CSP by
specification**. It is honoured only as a real HTTP response header. The
same is true of `X-Frame-Options` and `Strict-Transport-Security`, neither of
which can be expressed in markup at all.

GitHub Pages serves static files with no way to configure response headers.
So today, in production:

- **There is no clickjacking protection.** The `frame-ancestors 'none'` in
  `index.html` is inert. Any site can iframe the app.
- **There is no HSTS**, so a first visit over `http://` is downgradeable.
- There is no `X-Content-Type-Options`, `Referrer-Policy` (the meta
  `referrer` tag does cover this one), or `Permissions-Policy`.

This matters more than it might sound: roughly nineteen destructive actions
(delete account, admin remove-member, block, delete post/comment, cancel
event, leave challenge) sit behind a confirm sheet. Clickjacking is exactly
the attack that baits a click onto a control the victim cannot see.

## What is already in the repo

`_headers` at the repository root, in the Netlify / Cloudflare Pages format.
It is **inert on GitHub Pages** — an unused file, harmless — and becomes the
fix as soon as the site is served by a host that reads it. Nothing else in
the app needs to change.

## Option A — Cloudflare in front of GitHub Pages (smallest change)

Keeps GitHub Pages as the origin and puts Cloudflare in front of it, which
is the least disruptive path since the deploy flow (merge to the Pages
branch) is unchanged.

1. Add the domain to Cloudflare and point DNS at the Pages site.
2. Rules → Transform Rules → **Modify Response Header** → add each header
   from `_headers`.
3. SSL/TLS → Edge Certificates → enable **Always Use HTTPS** and **HSTS**
   (this is what actually issues `Strict-Transport-Security`; do not enable
   `preload` until the max-age has been live and correct for a while, since
   preload is hard to undo).

## Option B — Netlify or Cloudflare Pages (zero config)

Both read `_headers` from the published directory automatically. Point the
host at this repository and the file already in it takes effect on the next
deploy. No further configuration.

## Option C — self-hosted nginx

```nginx
server {
    # ... tls config ...
    add_header X-Frame-Options "DENY" always;
    add_header Content-Security-Policy "frame-ancestors 'none'" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), usb=(), payment=()" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
}
```

`always` is load-bearing — without it nginx omits these on error responses,
which are exactly the responses an attacker would rather have unprotected.

## Do NOT move the meta CSP into the header and delete it

Keep both. The meta CSP is what protects the app while it is still on
GitHub Pages, and it is what protects it if a future host misconfigures its
header rules. A header-based CSP is strictly stronger, so when one exists it
should carry **at least** everything the meta tag carries — including the
two CAPTCHA provider hosts in `script-src`/`frame-src`/`connect-src` that
SEC-004 added, or sign-in will break.

## Verifying it worked

```bash
curl -sI https://<your-domain>/ | grep -iE 'x-frame-options|content-security-policy|strict-transport'
```

All three must appear. Then confirm the app still loads and a member can
still sign in — a CSP typo surfaces as a blank page or a failed sign-in, not
as an error anyone gets told about.

## Status

This item stays **open in the production checklist** until someone runs that
`curl` against the real deployment and sees the headers. The repository side
is done; the hosting change is an external action that cannot be completed
from here.
