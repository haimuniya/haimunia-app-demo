begin;

-- Supabase Security Advisor, "Security Definer View", public.community_streaks.
--
-- The advisor is right that a view without security_invoker runs with its
-- OWNER's privileges rather than the caller's - that is real, and worth
-- closing where it's just an oversight. It is not an oversight here:
-- 202609060002's own comment explains this view has to run as its owner
-- specifically to aggregate every member's activity_pings rows past that
-- table's owner-only RLS (`activity_pings_self_select`, 202608270001:69 -
-- `using (user_id = auth.uid())`, no broader policy exists anywhere), and
-- it hand-reimplements every equivalent access check as compensation:
-- deleted_at, both directions of blocks, is_community_member(), the
-- subject's visible_to_club/in_leaderboards (raw column AND
-- can_view_profile_field), and a show_attendance-gated last_activity_on.
-- Confirmed this session: flipping `security_invoker = true` on the view
-- as a one-line "fix" would NOT close the advisor finding safely - it
-- would silently zero out every member's streak but the caller's own,
-- because the underlying activity_pings rows a security-invoker view
-- would be allowed to read are exactly the caller's own and nobody else's.
-- That is a functional regression dressed as a security fix.
--
-- The actual fix, matching the pattern every other cross-RLS aggregate in
-- this schema already uses (feed_leaderboard, chal_progress,
-- coach_celebrate_feed, member_of_week_candidate_set: all functions, never
-- bare views) is to make the "runs with elevated privilege" fact an
-- explicit, audited SECURITY DEFINER FUNCTION rather than an implicit
-- property of an unmarked view. A function is also simply not something
-- the Security Advisor's security_definer_view rule inspects.
--
-- EXPAND, NOT CONTRACT. This migration adds the function and leaves the
-- view completely untouched - same definition, same grant, same name.
-- The reason: this repo has no build step and no deploy gate between
-- pushing to `main` and GitHub Pages serving it to real, already-installed
-- clients, some of whom are running out of a service worker cache that
-- will not see today's deploy for a while. cloud.js:1583 currently calls
-- `.from("community_streaks")`, the view's own PostgREST resource path.
-- Dropping the view in this same migration would 404 that call for every
-- client still running the old build the moment this migration reaches
-- production - there is no push ordering that avoids it, because the old
-- client is already in people's hands. The client switches to
-- `.rpc("community_streaks", ...)` in its own commit, and only once that
-- has had time to actually reach installed clients does a LATER migration
-- drop the view. A function and a view may share one name in Postgres
-- (confirmed on this project's own local Postgres 17.6 before writing this
-- migration) - PostgREST exposes them as two different resources
-- (`/rest/v1/community_streaks` for the view, `/rest/v1/rpc/community_streaks`
-- for the function), so there is no ambiguity for either engine during the
-- window both exist.
--
-- p_limit mirrors feed_leaderboard's own clamp (202609010012) rather than
-- relying on PostgREST's generic ?limit= on the RPC endpoint, for the same
-- reason that function does: an explicit, server-enforced ceiling that
-- cannot be raised by a client passing a larger query parameter.
create or replace function public.community_streaks(p_limit int default 50)
returns table (
  user_id uuid,
  handle text,
  display_name text,
  current_streak integer,
  last_activity_on date
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 100));
begin
  return query
  with islands as (
    select ap.user_id, ap.activity_date,
           (ap.activity_date - (row_number() over (partition by ap.user_id order by ap.activity_date))::integer * interval '1 day')::date as grp
    from public.activity_pings ap
  ),
  runs as (
    select i.user_id, i.grp, count(*)::integer as run_length, max(i.activity_date) as run_end
    from islands i
    group by i.user_id, i.grp
  ),
  latest_run as (
    select distinct on (r.user_id) r.user_id, r.run_length, r.run_end
    from runs r
    order by r.user_id, r.run_end desc
  )
  select pr.id as user_id, pr.handle, pr.display_name,
         case when lr.run_end >= current_date - 1 then coalesce(lr.run_length, 0) else 0 end as current_streak,
         case
           when pr.id = auth.uid() or public.can_view_profile_field(pr.id, 'show_attendance')
             then lr.run_end
           else null
         end as last_activity_on
  from public.profiles pr
  left join latest_run lr on lr.user_id = pr.id
  where pr.deleted_at is null
    and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = pr.id) or (b.blocker_id = pr.id and b.blocked_id = auth.uid()))
    and (
      pr.id = auth.uid()
      or (
        public.is_community_member()
        and pr.visible_to_club
        and pr.in_leaderboards
        and public.can_view_profile_field(pr.id, 'visible_to_club')
        and public.can_view_profile_field(pr.id, 'in_leaderboards')
      )
    )
  order by current_streak desc
  limit v_limit;
end $$;

revoke all on function public.community_streaks(int) from public, anon;
grant execute on function public.community_streaks(int) to authenticated;

comment on function public.community_streaks(int) is
  'Supabase Security Advisor remediation, security_definer_view finding on the view of the same name (202608270001/202609060002). Function form of the identical query: club activity streaks aggregated over activity_pings (days the member opened the app), one row per member, ordered by current_streak desc, capped at p_limit (clamped 1-100, default 50, matching feed_leaderboard''s own ceiling pattern). SECURITY DEFINER because activity_pings is owner-only RLS (activity_pings_self_select) and this has to aggregate across every member''s rows to compute a streak - every equivalent access check is re-applied by hand: deleted_at, both directions of blocks, is_community_member(), the subject''s visible_to_club/in_leaderboards (raw column AND can_view_profile_field so an admin''s own rank cannot decide what the club is told), and last_activity_on gated additionally on show_attendance (null unless the caller is the subject, an admin, or the subject opted in) - self always sees their own row and date regardless. EXPAND phase: the view public.community_streaks is deliberately left in place and unchanged so cloud.js''s existing .from("community_streaks") call keeps working for any client still running an older build; a later migration drops the view once the client has switched to calling this function and had time to actually reach installed clients through GitHub Pages and the service worker cache.';

commit;
