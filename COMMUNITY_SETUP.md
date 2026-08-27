# Community backend setup

The app remains fully usable offline when the backend is not configured.

## Create the backend

1. Create separate Supabase projects for staging and production.
2. Run every file in `supabase/migrations/`, in filename order (currently
   `202608260001_community_foundation.sql`, then
   `202608270001_community_growth.sql`, then
   `202608270002_lock_anon_defaults.sql`, then
   `202608270003_invite_gate.sql`, then
   `202608270004_community_engagement.sql`, then
   `202608270005_coach_tier.sql`, then
   `202608270006_security_hardening.sql`, then
   `202608270007_grant_coach_by_handle.sql`, then
   `202608270008_hebrew_handles.sql`, then
   `202608270009_admin_moderation_visibility.sql`, then
   `202608270010_rate_limiting.sql`), in each project.
   `202608270001` adds the reactions RLS fix, achievement-unlock posts,
   coach announcements, activity streaks, and the weekly challenge — none
   of those features work until it's applied. `202608270002` is a
   required follow-up, not optional: this project auto-grants the `anon`
   role SELECT on any table created afterward unless a migration revokes
   it again, and `202608270001` didn't for its own new tables — without
   `202608270002`, `activity_pings`, `announcements`, `weekly_challenges`,
   and `community_streaks` are all readable with no login at all. Any
   *future* migration that adds a table should double check this the same
   way (query it as anon, no session, right after applying) rather than
   assuming the default-privilege revoke below still covers it forever —
   it only covers tables created after the point it runs. `202608270003`
   gates community sign-up behind an invite code — **after running it, no
   one can create a community profile until you insert at least one
   active code**:
   ```sql
   -- Historical example only. Do not run after 202608270006.
   ```
   Migration `202608270006` supersedes the original code-creation and
   coach-redemption instructions below. Follow "Hardened invite and photo
   operations" after applying the complete migration set.
   `role` is `'member'` or `'coach'` — as of `202608270005`, a `'coach'`
   code grants a fixed set of powers on its own (see "Access tiers"
   below), no separate step needed. To make someone a full admin, that's
   still a separate manual step, unrelated to invite codes. Sign-in has
   no email (see below), so look them up by handle, not email:
   ```sql
   update public.profiles set is_admin = true where handle = 'their-handle';
   ```
   (only works after they've signed in once, redeemed a code, and saved
   a profile — the profile row, and its handle, has to exist first).

   `202608270004` fixes a real bug in `202608270003`: the trigger meant to
   stop a client-side path from ever setting `is_admin` also blocked a
   *legitimate* manual grant run directly in the SQL editor — the exact
   `update ... set is_admin = true` command above would silently do
   nothing. If you ran that command before this migration and it didn't
   stick, re-run it after applying `202608270004`. This migration also
   adds: comments on posts, a `post-photos` Storage bucket (private,
   5MB/image limit) for optional photos on a shared result, a
   `coach_new_members()` RPC mirroring `coach_inactive_members()`, and a
   `pinned_date` column on `announcements` for a daily WOD note.

   `202608270005` builds the coach tier (see "Access tiers" below) — a
   coach-code redemption (`insert into public.invite_codes (code, role)
   values ('COACHCODE2026', 'coach');`) was the historical flow. Migration
   `202608270006` disables public coach-code promotion and replaces it with
   a trusted service-role promotion step. A coach then receives:
   posting/pinning announcements, setting the weekly challenge, and
   seeing the new/inactive member views, without needing the manual
   `is_admin` grant.
3. In Authentication → Sign In / Providers:
   - Enable **Anonymous Sign-ins** (off by default) — still required, as
     the one-time bootstrap step a brand-new signup uses before it has
     real credentials. See "Sign-in has no email" below.
   - Under the **Email** provider, turn **Confirm email** OFF. The app
     never configures SMTP and never will (see below) — every account's
     email field is a synthetic, never-delivered address, so a
     confirmation requirement would either silently fail to send or lock
     every new signup out of their own just-created account.
4. Copy the project URL and **publishable** key into `cloud-config.js`.
5. Never place a secret or service-role key in browser code, Git, or a static-host environment variable.
6. Schedule `select public.purge_due_accounts();` once daily from a trusted service-role Edge Function or external scheduler.

## Sign-in has no email, but does have a real username + password

Two-step signup, both in-app forms with no redirect anywhere: a
brand-new member first redeems a club invite code (needs some session to
attach the redemption to, so `ensureAnonymousSession()` silently creates
a throwaway anonymous one — a real `auth.users` row, `auth.uid()` works
normally, RLS applies exactly as for any other `authenticated` session).
Right after redeeming, they set a username + password, which
`client.auth.updateUser({ email, password })` links to that *same*
`auth.uid()` — the anonymous session becomes a permanent one in place,
no data migration, no new row. A returning member on any device just
calls `client.auth.signInWithPassword(...)` with those same credentials
and lands back in the exact same account.

The "email" `updateUser`/`signInWithPassword` sees is never real and
never collected from the person: `cloud.js`'s `usernameToEmail()` builds
it locally as `${username}@members.haimuniya.invalid` purely because
Supabase's password provider requires an email-shaped identifier.
`.invalid` is the RFC 2606-reserved TLD for exactly this — guaranteed to
never resolve or receive anything. This is also why **Confirm email**
must stay off (see setup step 3): there is no inbox behind that address,
so a confirmation requirement would only ever lock people out.

This whole design exists to route around a real problem the previous
plain-anonymous-only version had: with no way to reauthenticate, a
cleared browser, a new device, or a reinstall left someone locked out of
their own profile/history/streak with no path back, and a casual-looking
"sign out" button would have been actively misleading, so there wasn't
one. Real credentials fix that directly — the Account tab can now offer
an honest sign-out, and logging in from a different device reaches the
same account. "Request account deletion" still exists for someone who
deliberately wants to walk away for good.

Because no real email is ever collected or sent, keep SMTP/email
delivery configuration entirely out of scope for this project going
forward — there is nothing in the app that would ever send a member an
email.

## Hardened invite and photo operations

Migration `202608270006_security_hardening.sql` revokes every legacy
plaintext invite. Create a replacement member code through the service role:

```sql
select public.create_member_invite(now() + interval '14 days', 1);
```

The returned high-entropy code is shown once and stored only as a hash. The
first argument is the expiry. The second is the maximum redemption count.
Normal redemption only grants member access.

Promote an existing redeemed member to coach through a trusted service-role
process — by handle (what you'd actually have on hand day to day):

```sql
select public.grant_coach_role_by_handle('their-handle');
```

Or by UUID directly, if you already have it:

```sql
select public.grant_coach_role('USER_UUID');
```

There is deliberately no code-based or client-reachable path to either
coach or admin — both are always a manual step run here, by an operator
with dashboard access. To make someone a full admin, still the same
handle-based `update` as before (not a function — deliberately not one,
to keep this the single rarest, most manual operation in the system):

```sql
update public.profiles set is_admin = true where handle = 'their-handle';
```

Run a daily service-role cleanup job which calls
`public.list_orphaned_post_photos(interval '1 day')`, then deletes the
returned objects through the Supabase Storage API. Do not delete Storage
objects through SQL because it only removes metadata.

## Required launch checks

- Run `npm test`.
- Confirm Anonymous Sign-ins is enabled in the project (Authentication →
  Sign In / Providers) — without it, opening the Community tab fails
  silently at `signInAnonymously()` and nobody can ever get past
  "מתחברים לקהילה…".
- Run the migration against an empty staging database.
- Test every RLS policy as two different users, especially private records, blocks, follower-only posts, and reports.
- Confirm bodyweight, measurements, session notes, WOD notes, and partner tags never appear in `workout_posts` or `community_feed`.
- Confirm a reported post disappears for its reporter.
- Confirm one user cannot attach or read another user's photo path.
- Confirm an unredeemed Auth user cannot upload a post photo.
- Confirm invite redemption stops after five failed attempts in 15 minutes.
- Confirm normal invite redemption never grants coach access.
- Confirm only an admin can run `review_report()`.
- Confirm blocking works in both directions.
- Confirm account deletion immediately unpublishes posts and the scheduled purge removes the Auth user after 30 days.
- Install Playwright Chromium and run the browser checks before deployment.
- Confirm posting a comment/reaction/report more than the configured
  rate limit returns `rate_limited` instead of silently queuing forever.

## Recommended, not yet done: CAPTCHA on sign-up

Flagged by an independent security review: `signInAnonymously()` and
`client.auth.updateUser()` (the anonymous-to-permanent upgrade a new
signup goes through) have no bot/abuse protection — creating an account
costs an attacker nothing beyond having one leaked invite code, and rate
limiting (this migration) only slows down what a scripted attacker can
do with an account, not how many accounts they can make in the first
place. Supabase supports requiring a CAPTCHA (Cloudflare Turnstile or
hCaptcha) on `signInAnonymously()`/sign-up via Authentication → Sign In /
Providers → Bot and Abuse Protection. This needs a Turnstile/hCaptcha
site key from an account only the project owner can create, so it's
listed here rather than done — the app-side call would need to pass a
`captchaToken` through, once the site key exists.

## Access tiers

Three real tiers, as of `202608270005`:

- **Admin** (`profiles.is_admin = true`, manual dashboard-only grant) —
  everything, including who else is admin. Still the only tier that can
  ever be granted this way; there is no client-side path to it, coach
  code or otherwise.
- **Coach** (`invite_redemptions.role = 'coach'`, set at sign-up by which
  invite code they used) — a fixed set of powers, the same for every
  coach: post/pin announcements, set the weekly challenge, see the
  new/inactive member views. Deliberately *not* scoped to "their own"
  classes or members — Arbox already owns class scheduling and rosters,
  so this app's coach tier only needs to cover the community-layer
  actions above, not a parallel membership model.
- **Member** — the default: feed, sharing, comments, streaks.

Both admin and coach are checked server-side through a single
`public.is_staff()` function (true if either applies) — RLS policies and
the `coach_inactive_members()`/`coach_new_members()` functions all use
it, so there's one place that defines "staff," not two policies that can
drift apart.

## Offline synchronization

Local writes are authoritative while offline and enter IndexedDB's `syncOutbox`. Once authenticated and online, the outbox upserts them into owner-only `private_records`. Existing history is queued only after the user explicitly approves the migration in the Community tab.

The first release uses last-write-wins timestamps. A future multi-device conflict screen should be added before supporting collaborative editing of the same workout record.
