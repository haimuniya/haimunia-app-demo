# Community backend setup

The app remains fully usable offline when the backend is not configured.

## Create the backend

1. Create separate Supabase projects for staging and production.
2. Run every file in `supabase/migrations/`, in filename order (currently
   `202608260001_community_foundation.sql`, then
   `202608270001_community_growth.sql`, then
   `202608270002_lock_anon_defaults.sql`, then
   `202608270003_invite_gate.sql`, then
   `202608270004_community_engagement.sql`), in each project.
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
   insert into public.invite_codes (code, role) values ('YOURCODE2026', 'member');
   ```
   `role` is `'member'` or `'coach'` — right now this is a label only
   (shown nowhere yet, grants nothing extra); it's there for when real
   coach-scoped permissions get built (see below). To make someone a full
   admin, that's still a separate manual step, unrelated to invite codes:
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
3. In Authentication, enable email magic links and add the deployed app URL to Redirect URLs.
4. Copy the project URL and **publishable** key into `cloud-config.js`.
5. Never place a secret or service-role key in browser code, Git, or a static-host environment variable.
6. Schedule `select public.purge_due_accounts();` once daily from a trusted service-role Edge Function or external scheduler.
7. Configure SMTP before public launch so authentication email delivery is dependable.

## Required launch checks

- Run `npm test`.
- Run the migration against an empty staging database.
- Test every RLS policy as two different users, especially private records, blocks, follower-only posts, and reports.
- Confirm bodyweight, measurements, session notes, WOD notes, and partner tags never appear in `workout_posts` or `community_feed`.
- Confirm a reported post disappears for its reporter.
- Confirm blocking works in both directions.
- Confirm account deletion immediately unpublishes posts and the scheduled purge removes the Auth user after 30 days.
- Install Playwright Chromium and run the browser checks before deployment.

## Access tiers (roadmap)

The end state is three real tiers: **admin** (full access, today's
`profiles.is_admin`), **coach** (scoped to their own relevant
classes/members — not built yet), and **member**. `invite_codes.role`
already distinguishes `'member'`/`'coach'` at sign-up time so that piece
doesn't need revisiting, but a coach-code redemption currently grants
*nothing* beyond the label — it is deliberately not wired to `is_admin`.
Building real coach-scoped access needs a data model for what "their
relevant" means (which classes or members a coach is attached to) before
any RLS policy can scope by it; that's a separate task, not started.

## Offline synchronization

Local writes are authoritative while offline and enter IndexedDB's `syncOutbox`. Once authenticated and online, the outbox upserts them into owner-only `private_records`. Existing history is queued only after the user explicitly approves the migration in the Community tab.

The first release uses last-write-wins timestamps. A future multi-device conflict screen should be added before supporting collaborative editing of the same workout record.
