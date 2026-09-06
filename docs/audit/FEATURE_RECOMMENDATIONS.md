# Feature recommendations

Every item here is grounded in a specific finding from `FEATURE_INVENTORY.md`,
`SECURITY_AUDIT.md`, or `DATABASE_AUDIT.md` — nothing is proposed here on
the basis of "competing products have this."

## Complete: three genuine incomplete-production-feature candidates

These are the backlog's own `todo`/`partial` rows independently confirmed by
this audit as real gaps, not stale status:

### COMM-337 — Move hosting off GitHub Pages, or add an edge layer, for clickjacking headers

- **Problem:** `frame-ancestors` only works as a real HTTP response header;
  GitHub Pages serves static files with no header configuration, so the
  directive in `index.html`'s `<meta>` CSP is inert (SEC-014). There is no
  clickjacking defense in production today.
- **Required work:** infra only — front the site with Cloudflare, Netlify, or
  an nginx proxy capable of setting response headers; add
  `X-Frame-Options: DENY` and a header-based CSP there. Also gets
  `Strict-Transport-Security` for free.
- **Security/privacy risk of NOT doing it:** low-probability but real —
  clickjacking against destructive actions (the ~19 `askConfirm()` gated
  actions, now keyboard-reachable per this pass's A3 fix, are exactly the
  kind of action clickjacking targets).
- **Effort:** small if a hosting change is acceptable; a real decision, not a
  code change.

### COMM-329 — Heading elements and landmark regions in the app shell

- **Problem:** `ACCESSIBILITY_AUDIT.md` A2 — the entire Community module
  ships 5 heading elements total; `heading-outline.test.mjs` documents this
  scope as "not done" in its own file. Screen-reader heading navigation is
  effectively dead across feed/profile/challenges/admin.
- **Required work:** front-end only — add a real heading hierarchy to each
  Community screen and to every dialog title (currently `<div>`s); add
  `role="tabpanel"` with `aria-labelledby` to close A1 in the same pass
  (10 tablists, 1 shared unlabelled panel, `aria-controls` count is 0).
- **Estimated effort:** medium — touches every screen render function in
  `cloud.js`, but is additive markup, not a logic change; test coverage
  (`heading-outline.test.mjs`) already has the pattern for the 4 screens it
  covers today.

### COMM-338 — Live multi-role smoke test before deploy

- **Problem:** the CI half is done and verified (`supabase test db` runs in
  `.github/workflows/test.yml`) — the *live*, multi-role (member/coach/admin)
  smoke test against a real deployed environment before it goes live is not
  built. `scripts/smoke-test-multi-role.mjs` exists in the repo but is not
  wired into any deploy gate (there is no deploy workflow to wire it into —
  see `INFRASTRUCTURE_AUDIT.md`: merging *is* the deploy).
- **Required work:** either a manual runbook step (run
  `smoke-test-multi-role.mjs` against the real project immediately after
  merge) or a real deploy workflow that runs it automatically. Given
  COMM-337 above, this is a good moment to design both together.

## Improve: two dormant features that silently do nothing

Both were found by the feature-inventory stream, not fixed by the
implementation pass (in-scope for a feature call, not a security/correctness
fix, and each needs a product decision on cadence/params):

- **FEAT-004 — `community_health_generate()` has no producer.** Defined,
  correct, and never called by anything — not the client, not an Edge
  Function, not any of the eight scheduled cron jobs. `community_health_scores`
  is therefore permanently empty. **Recommendation:** add a `cron.schedule`
  entry (weekly, matching the module's established Monday rhythm) — this is
  a one-line migration once a cadence is picked.
- **FEAT-010 — Personalized feed ranking runs a scheduled no-op.**
  `recompute_feed_weights()` is a deliberate, documented empty stub; the
  cron job that calls it weekly does real work computing nothing.
  **Recommendation:** either build the derivation the function's own TODO
  describes (COMM-303's real scope) or unschedule the job and correct its
  now-stale "nothing schedules it" comment so a future reader isn't misled
  into thinking the feature works because the job "runs fine."

## Simplify / harden: multi-tenancy is schema-ready but unenforced

`SECURITY_AUDIT.md` SEC-008 — `club_id` exists on every relevant table but is
filtered nowhere. This pass added the cheap invariant (refuse a second
`clubs` row) for launch. **If a second club becomes a real near-term product
need**, the real fix is `club_id` filtering added to every read policy now
listed in `AUTHORIZATION_MATRIX.md` §1, while there is exactly one tenant and
the change is a no-op in practice — cheaper to do now than after a second
club exists and every query needs auditing under time pressure.

## Add: CAPTCHA on account creation

`SECURITY_AUDIT.md` SEC-004 — free, unlimited anonymous account creation is
now materially riskier given SEC-001's scope (every ghost-readable relation
was reachable by unlimited free identities). **Recommendation:** enable
Cloudflare Turnstile or hCaptcha in the Supabase dashboard (Authentication →
Bot and Abuse Protection) and thread the token through
`signInAnonymously()`/`updateUser()` — see `IMPLEMENTED_FEATURES.md` for why
this pass could not complete it (requires a live dashboard site key this
sandbox cannot create).

## Do not add: anything not named above

No other feature gap surfaced during this pass that rises to a
production-blocking or clearly-valuable-enough-to-recommend level. In
particular, this audit found the *existing* feature set (feed, posts,
achievements, challenges, events, notifications, moderation, admin tools,
recaps, onboarding) structurally complete and, once the P0 security gap and
the accompanying corrections in this pass are applied, fit for the scope
`README.md`/`COMMUNITY_SETUP.md` describe. Expanding scope before those
fixes are verified in a real environment would be premature.
