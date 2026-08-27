begin;

-- Found by live-testing the previous migration right after applying it:
-- activity_pings, announcements, weekly_challenges, and the
-- community_streaks view were all readable with NO login at all (the
-- publishable/anon key alone, no session). RLS still correctly blocked
-- writes — an anon insert into announcements/weekly_challenges failed on
-- the RLS policy as expected — this was a read-only hole.
--
-- Cause: this project has a default privilege that auto-grants SELECT
-- (and on tables, INSERT/UPDATE/DELETE) to anon on every newly created
-- table. 202608260001's "revoke all on all tables in schema public from
-- anon, authenticated" only covered tables that existed at that moment —
-- every table created afterward, in that same migration's own view
-- (community_feed, which is security_invoker and so was unaffected) or
-- in 202608270001, re-triggers the default grant unless it's revoked
-- again for that specific new object.

-- Close what already leaked.
revoke all on public.activity_pings, public.announcements, public.weekly_challenges, public.community_streaks from anon;

-- Close it for good: stop the default from applying to anything created
-- after this point, in this migration or any future one. Every table
-- this app needs already gets an explicit "grant ... to authenticated"
-- alongside its own RLS policies — anon should never have standing
-- access to anything in this schema, and a future migration that adds a
-- table shouldn't have to remember this revoke to avoid repeating today's
-- mistake.
alter default privileges in schema public revoke select, insert, update, delete on tables from anon, authenticated;

commit;
