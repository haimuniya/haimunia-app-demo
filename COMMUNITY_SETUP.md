# Community backend setup

The app remains fully usable offline when the backend is not configured.

## Create the backend

1. Create separate Supabase projects for staging and production.
2. Run every file in `supabase/migrations/`, in filename order (currently
   `202608260001_community_foundation.sql` then
   `202608270001_community_growth.sql`), in each project. The second file
   adds the reactions RLS fix, achievement-unlock posts, coach
   announcements, activity streaks, and the weekly challenge — none of
   those features work until it's applied.
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

## Offline synchronization

Local writes are authoritative while offline and enter IndexedDB's `syncOutbox`. Once authenticated and online, the outbox upserts them into owner-only `private_records`. Existing history is queued only after the user explicitly approves the migration in the Community tab.

The first release uses last-write-wins timestamps. A future multi-device conflict screen should be added before supporting collaborative editing of the same workout record.
