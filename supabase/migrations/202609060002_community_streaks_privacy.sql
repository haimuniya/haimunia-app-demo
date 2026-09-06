begin;

-- Launch-readiness audit, finding 2: community_streaks bypasses the privacy
-- toggles every sibling leaderboard surface honours.
--
-- THE HOLE. public.community_streaks (202608270001) is deliberately NOT
-- security_invoker - it has to be, so it can aggregate every member's
-- activity_pings rows past that table's own owner-only RLS - and its own
-- comment says definer mode "bypasses the RLS that would otherwise apply
-- them", which is why it re-checks deleted_at and blocks by hand. It stops
-- there. It never checked a single one of the three privacy toggles, so a
-- member who switched visible_to_club, in_leaderboards AND show_attendance
-- all off was still fully readable through it - handle, display name,
-- streak length and a raw last_activity_on date - by any authenticated
-- caller. Verified live on a fresh stack.
--
-- That is a real bypass, not a theoretical one, because every OTHER surface
-- that publishes the same figure already gets it right:
--   feed_leaderboard              202608310004 / 202609010012
--   chal_progress                 202608290003
--   coach_celebrate_feed          202608290013
--   member_of_week_candidate_set  202609010001
-- All four apply can_view_profile_field() for in_leaderboards (and, in
-- consistency mode, show_attendance) and the raw visible_to_club column.
-- One surface out of five disagreeing with the other four is precisely the
-- drift the "one resolution point" rule in can_view_profile_field()'s own
-- comment exists to prevent.
--
-- HOW THE THREE TOGGLES MAP HERE, and the one place this deviates from a
-- literal copy of the sibling pattern. This view's subject is
-- activity_pings - one row per day the member OPENED THE APP - not
-- attendance_log, which is verified class attendance. So:
--
--   visible_to_club   gates the ROW. Same meaning everywhere: a member who
--                     hides from the club is not published to the club.
--   in_leaderboards   gates the ROW. This view IS a board; that is what the
--                     column is for, and it is the toggle contracts.md
--                     already names as "the real, server-enforced opt-out"
--                     for exactly this figure.
--   show_attendance   gates last_activity_on, NOT the row.
--
-- show_attendance is applied to the COLUMN rather than the row on purpose,
-- and this is a considered choice rather than a shortcut:
--
--   * last_activity_on is the only field here that is a raw per-day date
--     rather than an aggregate. It is exactly the kind of value
--     202608270001 kept out of activity_pings' own RLS and routed through
--     the admin-gated coach_inactive_members() instead ("raw dates are a bit
--     more personal than a headline number"), and the audit called it out by
--     name. show_attendance is the toggle that governs "may others see when
--     I train", so it is the right gate for it.
--   * Applying show_attendance to the row instead would empty this view for
--     essentially the whole club and silently break a shipped surface, for a
--     toggle this view's data source does not actually expose.
--     show_attendance defaults to FALSE (202608280003), unlike
--     visible_to_club and in_leaderboards which default to true. The coach
--     Welcome surface reads state.club.streaks per member (cloud.js ~7056),
--     and 0064 already asserts that one member sees another's streak length
--     through this view. Both would go dark for every member who never
--     opened a settings screen - a functional regression, not a privacy fix,
--     because a "days you opened the app" streak is not a claim about class
--     attendance in the first place.
--
-- Belt and braces, the same doubled form member_of_week_candidate_set uses
-- and for the reason its own comment gives: the RAW column AND
-- can_view_profile_field(). can_view_profile_field short-circuits to true
-- for an admin, and an admin's rank governs what THEY may see, never what
-- the club may be told - so the raw column has to be tested too. The
-- explicit blocks check from 202608270001 is kept even though
-- can_view_profile_field settles block edges as well, because the self
-- branch below skips that function entirely.
--
-- The self branch: a member always sees their own row and their own date,
-- through every toggle. Identical to feed_leaderboard's "it never hides the
-- caller from themselves" rule.
--
-- AND the anonymous read gate (202609060001, the same audit's finding 1)
-- applies here too and is added in the same pass. This view publishes a
-- handle and a display name for every member in the club, so it is the same
-- confidentiality surface profiles_read_authenticated was: `to authenticated`
-- has never meant "redeemed" since anonymous sign-in was enabled.
-- 202608270002 revoked it from the anon ROLE, which an anonymous SESSION is
-- not - that session is `authenticated`.
--
-- create or replace, not drop and recreate: same column names, same types,
-- same order, so the grant on the view and any dependent object survive.

create or replace view public.community_streaks as
with islands as (
  select user_id, activity_date,
         (activity_date - (row_number() over (partition by user_id order by activity_date))::integer * interval '1 day')::date as grp
  from public.activity_pings
),
runs as (
  select user_id, grp, count(*)::integer as run_length, max(activity_date) as run_end
  from islands
  group by user_id, grp
),
latest_run as (
  select distinct on (user_id) user_id, run_length, run_end
  from runs
  order by user_id, run_end desc
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
  );

grant select on public.community_streaks to authenticated;

comment on view public.community_streaks is
  'COMM-020 club activity streaks, aggregated over activity_pings (days the member opened the app), one row per member. Deliberately NOT security_invoker: it runs with the owner''s rights so it can aggregate past activity_pings'' owner-only RLS, and therefore re-applies every access rule by hand. Those rules, since the launch-readiness audit: deleted_at, block edges in both directions, is_community_member() (an anonymous sign-in session holds a real authenticated JWT and must not read the club), and - for anyone but the caller themselves - the subject''s own visible_to_club AND in_leaderboards, tested both as raw columns and through can_view_profile_field so an admin''s own rank cannot decide what the club is told. last_activity_on is a raw per-day date and carries the extra show_attendance gate: null for a member who has not opted in, which is the default, with self and (through can_view_profile_field) an admin exempt. current_streak is 0, not null, for a member whose run ended more than a day ago.';

commit;
