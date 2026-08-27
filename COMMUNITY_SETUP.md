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
   `202608270006_security_hardening.sql`), in each project.
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
   still a separate manual step, unrelated to invite codes:
   ```sql
   update public.profiles set is_admin = true where id = (select id from auth.users where email = 'their@email.com');
   ```
   (only works after they've signed in once and redeemed a code — the
   profile row has to exist first).

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
3. In Authentication, enable email magic links and add the deployed app URL to Redirect URLs.
4. Copy the project URL and **publishable** key into `cloud-config.js`.
5. Never place a secret or service-role key in browser code, Git, or a static-host environment variable.
6. Schedule `select public.purge_due_accounts();` once daily from a trusted service-role Edge Function or external scheduler.
7. Configure SMTP before public launch so authentication email delivery is dependable.

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
process:

```sql
select public.grant_coach_role('USER_UUID');
```

Run a daily service-role cleanup job which calls
`public.list_orphaned_post_photos(interval '1 day')`, then deletes the
returned objects through the Supabase Storage API. Do not delete Storage
objects through SQL because it only removes metadata.

## Required launch checks

- Run `npm test`.
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
