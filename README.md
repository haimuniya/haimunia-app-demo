# האימוניה — קהילה (demo)

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
  configured in `cloud-config.js` (see `COMMUNITY_SETUP.md`): magic-link
  sign-in, a profile, following/blocking, a workout feed with reactions
  and reporting, sharing a strength/WOD PR or an achievement unlock,
  activity streaks, coach-posted announcements, and a weekly box-wide
  challenge leaderboard. Row Level Security enforces every one of those
  boundaries at the database, not just in the UI.
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
- Not gated behind a box invite code or membership check yet — anyone who
  signs in with a valid email can create a profile and see the public
  feed. Scoping the community to one box's actual members is a real
  architecture change, tracked separately, not yet built.

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
