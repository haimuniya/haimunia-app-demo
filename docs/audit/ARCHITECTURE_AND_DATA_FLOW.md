# Architecture and data flow

## Technology stack

- **Frontend:** static, build-free HTML/CSS/JS. `index.html` + `app.js`
  (~244 KB, the offline training-log app) + `cloud.js` (~841 KB, the
  Supabase-backed Community module) + `sw.js` (service worker) +
  `theme-init.js`. No bundler, no transpiler, no framework — plain DOM APIs
  and template-string HTML. `src/` holds five small shared helper modules
  (`analytics.js`, `constants.js`, `db.js`, `eventbus.js`, `format.js`,
  `image.js`, `realtime.js`, `sanitize.js`, `shared/safe-helpers.js`) loaded
  as classic `<script>` tags before `cloud.js`/`app.js`.
- **Local storage:** IndexedDB (via `src/db.js`) for the offline training
  log — strength sets, WODs, bodyweight, measurements, calendar, custom
  movements, achievements. Its own DB name/localStorage-key-prefix/Cache
  Storage cache name are namespaced separately from the production
  `haimunia-app`, per `README.md`.
- **Backend:** a single Supabase project — Postgres (with `pgcrypto`,
  `pg_net`, `pg_cron`, `pgtap` extensions), Supabase Auth (anonymous +
  username/password via a synthetic email), Supabase Storage (two buckets:
  `post-photos` private/signed-URL, `avatar-photos` public then made
  private-by-signed-URL per `202609060003`), and 3 Deno Edge Functions
  (`recap_weekly`, `purge_abandoned_profiles`, `admin_reset_password`).
- **Vendoring:** `@supabase/supabase-js` is vendored into `vendor/supabase.js`
  for static hosting with no build step; `scripts/check-vendored-supabase-version.mjs`
  keeps it in lockstep with `package.json`'s declared version (verified
  matching, `DEPENDENCY_AUDIT.md`).
- **Hosting:** GitHub Pages (`haimuniya.github.io`), deployed by merging to
  the Pages-tracked branch — there is no separate build/deploy workflow file;
  the merge *is* the deploy (`INFRASTRUCTURE_AUDIT.md`).
- **CI:** GitHub Actions, 3 jobs — `node-tests` (jsdom unit/integration,
  1108 tests), `browser-checks` (real Chromium via Playwright, 29 scenarios),
  `migration-check` (`supabase start` + `supabase test db`, ~2686 pgTAP
  assertions across ~77 files as of the last verified clean run pre-dating
  this pass).

## Application architecture

Two largely independent halves sharing one HTML shell and one bottom tab bar:

1. **Offline training log** (`app.js`) — fully local, IndexedDB-backed,
   works with zero network and zero backend configuration. Five tabs: Add,
   History, Calendar, WOD, and (new) Community.
2. **Community module** (`cloud.js`) — opt-in, requires `cloud-config.js` to
   name a real Supabase project. Gated behind an invite code (member/coach
   role) and, since this pass, a properly-scoped read boundary
   (`is_community_member()`) for every relation that carries a member
   identifier. Renders as sub-tabs (Feed, Boards, Account) once joined.

Both halves render into the same `#content` element via full-string
`innerHTML` replacement on every state change (no virtual DOM, no component
tree) — a deliberate architectural decision analyzed at length in
`docs/community/2026-09-03-render-architecture-spike.md`, which the backlog
records as *kept* (rewriting 342 call sites in a 10,700-line file was judged
negative-expected-value against the alternative of continuing the existing
`renderXContent()` pattern the other four tabs already use).

## Trust boundaries

```
                          ┌─────────────────────────────┐
                          │      Public internet         │
                          │  (unauthenticated browser)   │
                          └──────────────┬───────────────┘
                                         │ GitHub Pages (static files, no
                                         │ server-side auth check possible)
                          ┌──────────────▼───────────────┐
                          │   Browser: app.js + cloud.js  │
                          │   (all client-side logic;     │
                          │    trust boundary #1 — the    │
                          │    server must re-check       │
                          │    everything this enforces)  │
                          └──────────────┬───────────────┘
                                         │ HTTPS, publishable (anon) key
                                         │ shipped in cloud-config.js
                          ┌──────────────▼───────────────┐
                          │        Supabase Auth          │
                          │  anonymous sign-in ENABLED —  │
                          │  anyone can mint a real        │
                          │  `authenticated` JWT for free  │
                          │  (trust boundary #2 — RLS is   │
                          │   the ONLY thing standing      │
                          │   between "authenticated" and  │
                          │   "actual club member")        │
                          └──────────────┬───────────────┘
                                         │ PostgREST, RLS-enforced
                          ┌──────────────▼───────────────┐
                          │   Postgres (RLS + SECURITY     │
                          │   DEFINER functions)           │
                          │   is_community_member() is the │
                          │   real trust boundary — a      │
                          │   redeemed invite + verified   │
                          │   recovery method (trust        │
                          │   boundary #3)                 │
                          └──────────────┬───────────────┘
                                         │ service_role only
                          ┌──────────────▼───────────────┐
                          │  pg_cron → Edge Functions       │
                          │  (recap_weekly, purge_*,         │
                          │   admin_reset_password)          │
                          │  service-role key never leaves   │
                          │  this layer                      │
                          └───────────────────────────────┘
```

**The critical trust boundary this audit's P0 finding (SEC-001) sat on:**
boundary #2 above is *free to cross* — anonymous sign-in has no cost, no
CAPTCHA (SEC-004, still open), and no invite code required. Boundary #3
(`is_community_member()`) is therefore the *only* real gate protecting member
data, and until this pass it was applied to only 4 of ~18 relations that
needed it. See `THREAT_MODEL.md` and `SECURITY_AUDIT.md` SEC-001.

## User roles and the permission model

Five roles, ranked (`public.roles.rank`): **member** (10) < **coach**/`is_staff()`
threshold (20) < **head_coach** < **admin**/`is_admin()` < **owner** (highest,
`my_role_code() = 'owner'` gates schema-level RBAC writes). A sixth,
**service_role**, exists only at the database/Edge Function layer and is
never reachable from a browser session. Permissions are a
`role_permissions` join table (`community.*` permission strings) rather than
hardcoded role checks in most places — `has_perm('community.xxx')` is the
idiom; `is_staff()`/`is_admin()` are used where the audit confirmed the
distinction is deliberate (e.g. `attendance_log_staff_select`, see
`PRIVACY_AUDIT.md` PRIV-001). Full per-table, per-role matrix:
`AUTHORIZATION_MATRIX.md`.

## Sensitive-data locations

- `profiles` — display name, handle, bio, avatar; privacy toggles
  (`show_*`, `visible_to_club`, `allow_follows/mentions/messages`).
- `attendance_log` — raw per-day attendance; see PRIV-001 above.
- `private_records` — the full offline training log once cloud-synced (an
  opt-in mirror of IndexedDB), no membership gate by design.
- `invite_redemptions` / `invites` — invite codes are stored only as sha256
  hashes; plaintext is retrievable exactly once, at creation.
- `push_subscriptions` — Web Push endpoints, now capped at 10 active per
  member (SEC-007, this pass).
- `analytics_events` — behavioral telemetry, 90-day retention, no read
  access below `community.analytics.view`.
- Storage: `post-photos` (private, signed URL, EXIF/GPS stripped per the
  2026-09-05 audit's fix), `avatar-photos` (now object-capped, this pass).

## Single points of failure

1. **`cloud-config.js`** — if the anon key/URL is ever swapped for a
   service-role key by mistake, every RLS boundary above is bypassed
   instantly. Verified this pass: it is not (`SECURITY_AUDIT.md` evidence).
2. **`is_community_member()`** — every read gate in the schema now depends
   on this one function's correctness (by design, deliberately centralized
   per `202609060001`'s own reasoning — one predicate, not two that could
   drift). A regression here reopens SEC-001-class holes schema-wide.
3. **The single `clubs` row** — no multi-tenant filtering exists anywhere
   (SEC-008); a second row would silently turn every unfiltered read policy
   cross-tenant. This pass added a hard trigger-level invariant refusing a
   second row, converting a silent failure mode into a loud one.
4. **GitHub Pages hosting** — no server-settable response headers means the
   CSP is `<meta>`-only (`frame-ancestors` is inert, SEC-014) and there is no
   HSTS/`X-Content-Type-Options` at the transport layer; documented,
   accepted, requires a hosting change to close.
5. **The vendored Supabase client** — a single file (`vendor/supabase.js`)
   is the only path to the backend for every user; its version is checked
   against `package.json` in CI (this pass wired that check into the actual
   CI run, `INFRASTRUCTURE_AUDIT.md`) but a manual re-vendor step is still
   required to pick up upstream security fixes.

## External integrations

- Supabase (Auth, Postgres, Storage, Realtime, Edge Functions) — the only
  external service. No third-party analytics, ad, or tracking SDK anywhere
  in the bundle (grepped, zero hits).
- Google Fonts is NOT used — fonts are self-hosted `.woff2` files under
  `assets/fonts/`.
