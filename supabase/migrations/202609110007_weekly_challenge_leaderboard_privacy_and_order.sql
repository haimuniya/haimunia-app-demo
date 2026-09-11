begin;

-- Live bug hunt, round 8 (2026-09-11), leaderboard/ranking-accuracy agent.
--
-- THE FINDING, TWO BUGS ON ONE LEGACY VIEW. weekly_challenge_leaderboard
-- (202608270001) predates the in_leaderboards privacy toggle and the
-- deterministic-tie-break convention every LATER ranked view
-- (feed_leaderboard 202608290015, challenge_progress_view 202608290003)
-- was built with, and was never retrofitted when those landed.
--
-- 1. in_leaderboards = false was silently ignored. Confirmed live: a member
--    with in_leaderboards=false and the week's highest score still rendered
--    at rank #1 with the trophy - the same "hide my result" toggle
--    (cloud.js) gives a false sense of being hidden here. Every other
--    ranked view already gates on can_view_profile_field(uid,
--    'in_leaderboards'); this one never did.
--
-- 2. No deterministic order at all. The view carried no ORDER BY and the
--    client (loadWeeklyChallenge(), cloud.js) sorts only by score_value/
--    score_direction with no tie-break clause - confirmed live, two
--    members tied on score rendered in whichever order Postgres happened
--    to return rows in, which flipped between two page loads of the
--    IDENTICAL data. The same missing order also made `.limit(50)` on the
--    client's query arbitrary rather than "top 50 by score" once a
--    challenge draws more than 50 entrants.
--
-- THE FIX. Add the in_leaderboards gate (same call, same place every other
-- ranked view already puts it) and a deterministic ORDER BY replicating the
-- client's own score_direction-aware comparator plus a stable tie-break
-- (occurred_on, then display_name, then post id - same shape
-- feed_leaderboard's rank window uses: tenure/recency first, then name,
-- then id as the final, always-distinct tiebreaker). Ordering server-side
-- is sufficient to fix BOTH bugs without touching the client at all:
-- JS's Array.prototype.sort is stable (ES2019+), so once the DB returns
-- rows in a deterministic order, the client's existing direction-only sort
-- preserves that order for any ties it doesn't itself break.
drop view if exists public.weekly_challenge_leaderboard;
create or replace view public.weekly_challenge_leaderboard with (security_invoker = true) as
select wc.id as challenge_id, wc.title, wc.comparison_key, wc.starts_on, wc.ends_on,
       p.id as post_id, p.author_id, pr.handle, pr.display_name, p.score_value, p.score_direction, p.result_text, p.occurred_on
from public.weekly_challenges wc
join public.workout_posts p on p.comparison_key = wc.comparison_key and p.occurred_on between wc.starts_on and wc.ends_on
join public.profiles pr on pr.id = p.author_id
where p.deleted_at is null
  and current_date between wc.starts_on and wc.ends_on
  and public.can_view_profile_field(p.author_id, 'in_leaderboards')
order by (case when p.score_direction = 'lower' then -p.score_value else p.score_value end) desc,
         p.occurred_on asc,
         pr.display_name asc,
         p.id asc;
grant select on public.weekly_challenge_leaderboard to authenticated;

comment on view public.weekly_challenge_leaderboard is
  'Live bug hunt round 8 (202609110007). "אתגר השבוע" leaderboard: one row per matching, non-deleted post inside the active weekly challenge''s window, gated on can_view_profile_field(author, in_leaderboards) same as every later ranked view (feed_leaderboard, challenge_progress_view). Deterministically ordered (score by direction desc, then occurred_on/display_name/post id as a stable tie-break) so a client LIMIT truncates to a real top-N and identical scores render in a fixed order across reloads, not whatever order Postgres happened to return. security_invoker reuses posts_feed_select/profiles_read_authenticated as-is.';

commit;
