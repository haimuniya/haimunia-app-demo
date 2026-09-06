# האימוניה — קהילה

> **This repository ships a LIVE app to real members.** Despite the `-demo`
> in the repository name, `cloud-config.js` points at a **production**
> Supabase project holding real profiles, posts and training logs, and the
> GitHub Pages site is what members actually install.
>
> **Never test against it.** Bring up a local stack instead —
> `supabase start && supabase db reset` builds the identical schema from the
> same migrations, and you can grant yourself any role there.
> `scripts/seed-local-personas.sql` fills it with members, roles and feed
> volume in one shot. See
> `docs/audit/REMEDIATION_STATUS.md` for what "production" means here.

Live community layer for האימוניה: an installable, offline-first PWA with
its own IndexedDB store, plus an optional Supabase-backed social layer
(profiles, follows, a workout feed, reactions, streaks, coach
announcements, a weekly challenge). This is a real, working app, not a
mock-data preview — see [What this is not](#what-this-is-not) for the one
thing it still isn't.

## What this is

- The full offline-first app (log lifts, WODs, bodyweight, measurements,
  calendar, achievements) — everything `haimunia-app` has, plus a
  Community tab.
- The Community tab talks to a real Supabase project once one is
  configured in `cloud-config.js` (see `COMMUNITY_SETUP.md`): sign-in is
  invisible and instant (no email, no magic link — see "Sign-in has no
  email" in `COMMUNITY_SETUP.md` for the tradeoff), gated by a box invite
  code; a profile, following/blocking, a workout feed with reactions
  and comments, an optional photo on a shared result, sharing a strength/
  WOD PR or an achievement unlock, activity streaks, coach-posted
  announcements (with an optional "today's workout" pin), and a weekly
  box-wide challenge leaderboard. Row Level Security enforces every one
  of those boundaries at the database, not just in the UI. Organized into
  three sub-tabs — Feed, Boards, Account — instead of one long scroll.
- Fully usable offline with no backend configured at all — training data
  stays local in IndexedDB and nothing in the Community tab is required
  to log a workout.
- Deployed on GitHub Pages at the same origin as the production app
  (`haimuniya.github.io`), on its own path — its IndexedDB name, its
  localStorage key prefix, and its Cache Storage cache name are all
  distinct from `haimunia-app`'s own, so the two apps never see or
  overwrite each other's data despite sharing an origin.

## What this is not

- Not connected to `haimunia-app`'s real database or member data — it's a
  separate Supabase project and a separate browser storage namespace.
- Not scoped to a coach's specific classes or members — sign-up is gated
  behind a single shared invite code per role (member/coach), and a
  coach gets a fixed set of powers (announcements, the weekly challenge,
  the new/inactive member views), the same for every coach, not a
  per-coach roster. Class scheduling and "who's coming to class" are
  intentionally out of scope here — that's already handled by Arbox.
  Full admin stays a separate, manual, dashboard-only grant. See
  "Access tiers" in `COMMUNITY_SETUP.md`.

## Running it locally

Any static file server works, e.g.:

```
npx serve .
```

Open the printed URL. Without a configured `cloud-config.js` the app runs
fully offline; the Community tab shows a "connect Supabase" notice instead
of the feed.

## Setting up the backend

See `COMMUNITY_SETUP.md` for creating the Supabase project, running the
migrations in `supabase/migrations/`, and the required pre-launch checks.

## Development

Requires Node 22+ and npm (no other runtime dependency — the app itself
ships with zero build step; Node is only for the test suite and the
browser-check scripts).

```
npm ci                              # install test dependencies
npm test                            # 177+ unit/integration tests (jsdom)
npm run sync-version                # keep APP_VERSION (app.js) and SW_VERSION (sw.js) in sync after a version bump
cd scripts/browser-check && npm ci && npx playwright install chromium
node run-all.mjs                    # full real-Chromium suite; same jobs CI runs
```

`npm test` and the browser-check suite both run in CI on every push and
pull request (see `.github/workflows/test.yml`).
