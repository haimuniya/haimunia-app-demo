# האימוניה — קהילה (demo)

Standalone preview of the community feature described in the build-phases
plan — leaderboard, community wall, coach dashboard, plus box invite-code
sign-up. Runs entirely on mock data today; no real Supabase project, no
real member data, no connection to the live app or its database.

## What this is

- Phases 00–03 of the plan, scaffolded against a fake in-memory backend
  (`mockBackend` in `app.js`) shaped exactly like the real Supabase calls
  will be — every "backend" function (`dbSignIn`, `dbJoinBox`,
  `dbGetLeaderboard`, `dbGetFeed`, `dbGetCoachActivity`, ...) is called the
  same way a real Supabase-backed version would call it. Swapping the mock
  for real Supabase queries later is a matter of rewriting the bodies of
  those functions, not the screens that call them.
- No IndexedDB, no service worker, not an installable PWA — this is a
  reviewable preview, not a shipped product.

## What this is not

- Not connected to `haimunia-app`'s real database or member data.
- Not linked from the live app anywhere.
- Not live for real members — this repo/deploy is for review only, per
  the build-phases plan's rollout gate.

## Running it locally

Any static file server works, e.g.:

```
npx serve .
```

Open the printed URL. Try signing up with invite code `DEMO2026` (seeded
in the mock data) to see the member view, or `COACH2026` to land as a
coach and see the coach dashboard too.

## Next step

Create a free Supabase project, hand its URL + anon key to whoever is
wiring this up, and the mock backend functions in `app.js` get replaced
with real `@supabase/supabase-js` calls — the schema they should
implement is in `schema.sql`.
