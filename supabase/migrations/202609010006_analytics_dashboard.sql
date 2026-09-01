begin;

-- COMM-310, schema half. The admin community analytics dashboard: one
-- definer function that answers every "Core metric" and every "Additional
-- metric" docs/community/metrics.md already defines, in one call.
--
-- WHAT IS AND IS NOT HERE
--
-- No new table. Nothing is materialised: every figure is computed live from
-- analytics_events plus the community tables metrics.md already names as the
-- cross-check side. That is deliberate - a rollup table would be a second
-- place for WCAM to be defined, and the whole point of the WCAM section in
-- metrics.md is that there is exactly one definition.
--
-- No metric is invented. The metric set is exactly metrics.md's two lists,
-- 5 + 13 = 18 keys, and that file's own closing note says its list was
-- reconciled against the shipped event schema rather than the other way
-- round. If a figure is not in one of those two lists it is not in this
-- function's output, and if it is in one of them it is.
--
-- HOW THE FUNCTION IS STRUCTURED, and why it is not one 300-line query.
-- Five small helpers carry the parts that repeat, and the dashboard body is
-- then one `select ... into` block per metric, each with the metrics.md line
-- it implements quoted above it. The helpers are:
--
--   analytics_wcam_events()    the 15 qualifying event names, as data
--   analytics_week_buckets()   the ISO-week grid for a period
--   analytics_ratio()          a division that is null, not an error or a
--                              lie, when the denominator is zero
--   analytics_event_uuid()     a null-on-anything-bad uuid read out of props
--   analytics_breakdown()      "one event, grouped by one prop", the shape
--                              ten of the eighteen metrics are made of
--
-- Four of the five read no data at all; only analytics_breakdown() touches
-- analytics_events. They exist so a reviewer reads the metric definitions
-- rather than reading the same GROUP BY ten times.
--
-- WHY THE HELPERS ARE GRANTED TO NOBODY. analytics_breakdown() reads
-- analytics_events past its RLS policy and takes an event name as a
-- parameter, so a client-callable version would be a general-purpose reader
-- of the analytics stream with no permission check of its own. It is revoked
-- from public, anon and authenticated and granted to no role: the grant is
-- the gate, exactly as it is for recap_monthly_generate() (202609010002),
-- and the standing "check auth.uid() first" rule is satisfied one level up -
-- analytics_dashboard() has already checked both auth.uid() and the
-- permission before it calls any of them. The same revoke is applied to the
-- four pure helpers for uniformity, except analytics_wcam_events(), which is
-- granted to authenticated because it is a list of event names that already
-- ships to every browser inside src/analytics.js.

-- ===========================================================================
-- 1. analytics_wcam_events() - the ONE server-side WCAM definition
-- ===========================================================================
-- Weekly Community Active Members is defined in docs/community/metrics.md
-- (spec section 78) and kept as data in two places so a rollup and the client
-- cannot drift apart: ACTIVE_MEMBER_EVENTS in src/analytics.js, and the
-- worked SQL in metrics.md's own "Computed from the stored events" block.
-- Until this migration there was no THIRD place - no function in this schema
-- computed WCAM at all, which is why this list is being written server-side
-- for the first time here rather than reused from an existing function.
--
-- It is a function and not a literal inside analytics_dashboard() precisely
-- so that it stays the only server-side copy: COMM-311 (member segments),
-- COMM-312 (health scores) and COMM-313 (retention cohorts) are all already
-- specified in terms of "WCAM-qualifying activity", and each of them must
-- call this rather than paste the array again.
--
-- The 15 names below are, in order, byte-for-byte the metrics.md query's IN
-- list and byte-for-byte ACTIVE_MEMBER_EVENTS. Do not add a name here
-- without adding it there; 0050 asserts the two agree by comparing this
-- function's own result against the literal list metrics.md publishes.
--
-- IMMUTABLE, so the planner folds it into a constant and `event_name =
-- any(public.analytics_wcam_events())` still uses analytics_events_name_idx.
create or replace function public.analytics_wcam_events()
returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'post_created',
    'workout_shared',
    'achievement_shared',
    'comment_created',
    'reaction_added',
    'challenge_joined',
    'challenge_completed',
    'event_rsvp',
    'post_opened',
    'profile_opened',
    'member_followed',
    'notification_opened',
    'weekly_recap_shared',
    'coach_congratulate_sent',
    'attendance_recorded'
  ]::text[];
$$;

revoke all on function public.analytics_wcam_events() from public, anon;
grant execute on function public.analytics_wcam_events() to authenticated;

comment on function public.analytics_wcam_events() is
  'COMM-310. The 15 analytics_events.event_name values that make a member ACTIVE for a week under the WCAM definition in docs/community/metrics.md (spec section 78). The single server-side copy of that list, mirroring ACTIVE_MEMBER_EVENTS in src/analytics.js and the worked query in metrics.md. IMMUTABLE, so `event_name = any(analytics_wcam_events())` still uses analytics_events_name_idx. Any later WCAM consumer (COMM-311 segments, COMM-312 health scores, COMM-313 cohorts) MUST call this rather than repeat the array, so no two surfaces can disagree about who was active. Passive views (club_tab_viewed, feed_viewed, post_impression, leaderboard_viewed, challenge_viewed, event_viewed, weekly_recap_opened, search_performed, directory_opened, classmates_card_viewed) and account configuration (push_opt_in) are deliberately absent; report_submitted is absent too.';

-- ===========================================================================
-- 2. analytics_week_buckets(p_start, p_end) - the ISO-week grid
-- ===========================================================================
-- WCAM, WCAM share, posting members and engagement per post are all defined
-- BY THE WEEK, so a dashboard period that is not exactly one week still has
-- to answer them at weekly grain. This returns every ISO week (Monday-based)
-- touched by the inclusive date range, with week_end EXCLUSIVE.
--
-- is_partial flags a week the period only covers part of - the two edge weeks
-- of a calendar month, typically. Those weeks are RETURNED, not dropped, and
-- flagged, because silently omitting them would make a month's WCAM series
-- shorter than the month and silently including them unflagged would show a
-- three-day week next to a seven-day one as if they were comparable. The
-- caller renders a partial week differently; the number itself is computed
-- over the part of the week that is inside the period, never outside it.
--
-- TIMEZONE. date_trunc('week', ...) is Monday-based and, on the event side,
-- resolves at the CALLING SESSION's TimeZone - UTC for PostgREST, which is
-- the only caller. That is the same choice recap_monthly_generate()
-- (202609010002) recorded and the same UTC ISO week recap_weekly computes in.
-- metrics.md's WCAM section says "week boundaries follow the club's local
-- week, not UTC", which this does not implement and which no other function
-- in this module implements either. Pinning a zone here would make this the
-- one function in the module with an opinion about the club's local time;
-- that belongs in one module-wide decision. Flagged, not hidden.
create or replace function public.analytics_week_buckets(p_start date, p_end date)
returns table (week_start date, week_end date, is_partial boolean)
language sql immutable set search_path = '' as $$
  select w::date,
         (w + interval '7 days')::date,
         (w::date < p_start or (w + interval '7 days')::date > (p_end + 1))
  from pg_catalog.generate_series(
         pg_catalog.date_trunc('week', p_start::timestamp),
         pg_catalog.date_trunc('week', p_end::timestamp),
         interval '7 days') w;
$$;

revoke all on function public.analytics_week_buckets(date, date) from public, anon, authenticated;

comment on function public.analytics_week_buckets(date, date) is
  'COMM-310 internal. Every Monday-based ISO week touched by the inclusive date range [p_start, p_end], as (week_start, week_end EXCLUSIVE, is_partial). is_partial is true when the period does not cover the whole week - returned and flagged rather than dropped, so a month series is as long as the month. Granted to no role; called only from analytics_dashboard().';

-- ===========================================================================
-- 3. analytics_ratio(p_num, p_den) - division that refuses to lie
-- ===========================================================================
-- COMM-310's empty state is "a genuinely quiet week renders honest zeros,
-- not an error". A COUNT of zero is an honest zero. A RATE over a zero
-- denominator is not: "0% open rate" for a week in which nothing was
-- delivered is a false statement about the surface, not a measurement of it.
-- This returns NULL there, and the client renders an em dash. Every ratio in
-- the dashboard goes through this one function so no metric gets to make a
-- different choice.
--
-- Four decimal places: enough for a per-mille open rate, and it keeps the
-- jsonb from carrying twenty digits of float noise.
create or replace function public.analytics_ratio(p_num numeric, p_den numeric)
returns numeric
language sql immutable set search_path = '' as $$
  select case
    when p_den is null or p_den = 0 then null
    else round(coalesce(p_num, 0) / p_den, 4)
  end;
$$;

revoke all on function public.analytics_ratio(numeric, numeric) from public, anon, authenticated;

comment on function public.analytics_ratio(numeric, numeric) is
  'COMM-310 internal. p_num / p_den rounded to 4 places, or NULL when the denominator is zero or null. Every rate in analytics_dashboard() goes through this: a count of zero is an honest zero, a RATE over a zero denominator is not, so the dashboard returns null and the client renders a dash. Granted to no role.';

-- ===========================================================================
-- 4. analytics_event_uuid(p_props, p_key) - a uuid out of client-written jsonb
-- ===========================================================================
-- analytics_events takes a DIRECT client insert (analytics_events_insert_self,
-- 202608280012) and its props are only size-checked, never shape-checked. So
-- `(props ->> 'post_id')::uuid` inside a dashboard query is one malformed row
-- away from failing the whole call for every admin. This returns null for
-- anything that is not a uuid, which drops that row from the join instead.
create or replace function public.analytics_event_uuid(p_props jsonb, p_key text)
returns uuid
language sql immutable set search_path = '' as $$
  select case
    when p_props ->> p_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then (p_props ->> p_key)::uuid
  end;
$$;

revoke all on function public.analytics_event_uuid(jsonb, text) from public, anon, authenticated;

comment on function public.analytics_event_uuid(jsonb, text) is
  'COMM-310 internal. Reads p_key out of an analytics_events props blob as a uuid, or null if it is missing, not a string, or not uuid-shaped. analytics_events props are client-written and only size-checked, so a bare ::uuid cast in a dashboard query would let one malformed row fail the whole call. Granted to no role.';

-- ===========================================================================
-- 5. analytics_breakdown(p_event, p_prop, p_from, p_to) - "count by one prop"
-- ===========================================================================
-- Ten of the eighteen metrics are literally "this event name, grouped by that
-- prop": feed_viewed by scope, club_tab_viewed by tab, report_submitted by
-- reason, workout_shared by visibility, weekly_recap_shared by figure, and so
-- on. This is that query, once.
--
-- TWO BOUNDS ON THE OUTPUT, and both matter because the group KEY comes from
-- a value the member's own browser wrote. analytics_events_insert_self lets
-- any member insert any props as long as user_id is their own, so nothing
-- stops a client from sending `{"scope": "<640 characters>"}` or ten thousand
-- distinct scope values:
--
--   * every key is truncated to 64 characters, the same ceiling the
--     notifications.type CHECK already uses for a server-side type name;
--   * at most 25 distinct keys are returned, the largest 25 by count, with
--     everything else summed into '(other)'.
--
-- Without those two, one member could make a staff dashboard response
-- arbitrarily large. A missing or empty prop groups under '(none)' rather
-- than being dropped, so "how many of these events carried no scope at all"
-- stays visible instead of quietly shrinking the total.
--
-- Returns '{}' for a period with no matching events, never null.
create or replace function public.analytics_breakdown(
  p_event text, p_prop text, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with grouped as (
    select left(coalesce(nullif(e.props ->> p_prop, ''), '(none)'), 64) as k,
           count(*)::bigint as n
    from public.analytics_events e
    where e.event_name = p_event
      and e.created_at >= p_from
      and e.created_at < p_to
    group by 1
  ),
  ranked as (
    select k, n, row_number() over (order by n desc, k) as rn from grouped
  ),
  capped as (
    select case when rn <= 25 then k else '(other)' end as k, sum(n) as n
    from ranked group by 1
  )
  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from capped;
$$;

revoke all on function public.analytics_breakdown(text, text, timestamptz, timestamptz)
  from public, anon, authenticated;

comment on function public.analytics_breakdown(text, text, timestamptz, timestamptz) is
  'COMM-310 internal. {prop value: count} for one analytics_events event_name over [p_from, p_to). Keys truncated to 64 chars, at most 25 of them (largest by count) with the rest folded into ''(other)'', because the group key is client-written and unbounded otherwise. A missing or empty prop groups under ''(none)'' rather than vanishing. Returns ''{}'' for no rows, never null. SECURITY DEFINER because it reads analytics_events past its own RLS policy, and granted to NO role at all - it takes the event name as a parameter, so a client-callable version would be an unpermissioned reader of the whole analytics stream. The grant is the gate; auth.uid() and the permission are checked one level up in analytics_dashboard().';

-- ===========================================================================
-- 6. analytics_dashboard(p_period_start, p_period_end) returns jsonb
-- ===========================================================================
-- The whole dashboard in one call, as COMM-310 specifies, matching
-- coach_celebrate_feed()'s "one call for the whole list" shape (202608290013)
-- rather than one RPC per metric card.
--
-- AUTH. security definer; auth.uid() first, then `has_perm(
-- 'community.analytics.view') or is_admin()`. Same pair, in the same order,
-- as recap_monthly_publish() (202609010002). Note what this is NOT: it is not
-- is_staff(). A coach holds is_staff() and does not hold
-- community.analytics.view (202608280001 seeds it to admin and owner only),
-- and this function refuses a coach. That is narrower than
-- coach_celebrate_feed() on purpose - a coach's own dashboard is about the
-- members they coach, and club-wide behavioural analytics is not that.
--
-- WHY DEFINER. analytics_events' select policy already restricts reads to a
-- community.analytics.view holder (202608280012), and this ticket does not
-- widen that grant by one row. The boundary this function actually crosses is
-- the OTHER six tables it cross-checks against: notifications is own-row only,
-- push_subscriptions is own-row only, reports is reporter-or-moderator,
-- attendance_log is own-row plus staff, and workout_posts / post_comments /
-- reactions / follows are all viewer-relative. Counting any of them club-wide
-- from an admin's own session would return that admin's slice and call it the
-- club's number. It crosses those boundaries once, on purpose, and returns
-- integers rather than rows.
--
-- AGGREGATE ONLY, EVERYWHERE, WITHOUT EXCEPTION. Not one figure in the
-- returned object is broken out to a member, and no member id, handle,
-- display name or post id appears anywhere in it. That is the same posture
-- monthly_club_recaps (COMM-309) enforces through its column list; this
-- function has no column list to enforce it with, so the rule is enforced by
-- what the queries SELECT - every one of them ends in a count, a sum or a
-- ratio, and the only grouping keys are surface names, enum-shaped props and
-- ISO week starts. The one place a member id could sneak in is
-- analytics_breakdown()'s group key, so it is never called with a prop that
-- holds an id: not 'post_id', not 'user_id', not 'notification_id', not
-- 'challenge_id', not 'event_id', not 'member_achievement_id'. 0050 asserts
-- the whole response text mentions no fixture member's id, handle or display
-- name, the same assertion 0046 makes about a monthly recap.
--
-- PERIOD SEMANTICS. p_period_end is INCLUSIVE of its day: (Mon, Sun) is that
-- week and (Sep 1, Sep 30) is September. The resolved half-open window is
-- returned in the response as period.end_exclusive so a caller never has to
-- guess which convention it got.
--
-- MAX LOOKBACK. The span is capped at 366 days. analytics_events is the
-- highest-volume table in the module and its only time index is
-- (event_name, created_at desc), so an unbounded range from a dashboard would
-- be a full scan per metric. 366 rather than 365 so a leap year and a
-- "this day last year to today" inclusive range both fit.
--
-- CLUB SCOPE. No club_id filter, consistently with every other reader in this
-- module (202608280001: club_id exists so a second club is a data migration
-- rather than a schema rewrite, and nothing reads it as a filter today).
create or replace function public.analytics_dashboard(
  p_period_start date, p_period_end date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_from  timestamptz;
  v_to    timestamptz;
  v_days  integer;
  v_weeks numeric;

  v_wcam            jsonb;
  v_wcam_share      jsonb;
  v_posting         jsonb;
  v_engagement      jsonb;
  v_feed_reach      jsonb;

  v_open_rate       jsonb;
  v_filter_use      jsonb;
  v_sub_tab         jsonb;
  v_notif           jsonb;
  v_social          jsonb;
  v_challenge       jsonb;
  v_moderation      jsonb;
  v_share_intent    jsonb;
  v_recap           jsonb;
  v_discovery       jsonb;
  v_coach           jsonb;
  v_push            jsonb;
  v_classmates      jsonb;

  v_a bigint; v_b bigint; v_c bigint; v_d bigint; v_e bigint;
begin
  -- -----------------------------------------------------------------------
  -- AUTH, before anything is read.
  -- -----------------------------------------------------------------------
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.analytics.view') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  -- -----------------------------------------------------------------------
  -- PERIOD VALIDATION. Raises rather than clamping, which is the opposite of
  -- coach_celebrate_feed()'s p_days. The reasoning differs because the input
  -- differs: p_days is one number with an obvious sane neighbour, whereas a
  -- silently shortened date range would put a number on screen labelled with
  -- a period it was not computed over, and an admin would have no way to tell.
  -- -----------------------------------------------------------------------
  if p_period_start is null or p_period_end is null then
    raise exception 'period required';
  end if;
  if p_period_end < p_period_start then
    raise exception 'period end before start';
  end if;
  if (p_period_end - p_period_start) > 365 then
    raise exception 'period exceeds 366 days';
  end if;

  v_from  := p_period_start::timestamptz;
  v_to    := (p_period_end + 1)::timestamptz;
  v_days  := (p_period_end - p_period_start) + 1;
  v_weeks := v_days::numeric / 7;

  -- =======================================================================
  -- CORE METRICS - metrics.md "## Core metrics", spec section 78.
  -- =======================================================================

  -- -----------------------------------------------------------------------
  -- 1 + 2. WCAM, and WCAM as a share of club members.
  --
  -- metrics.md: "WCAM for a calendar week is the count of unique members who,
  -- inside that week, did at least one of [the 15 qualifying events]" and
  -- "WCAM as a share of club members, from WCAM / count(profiles) for the
  -- club in the same week."
  --
  -- The event predicate is analytics_wcam_events() plus `user_id is not null`
  -- and the week bounds, which is exactly the query metrics.md publishes. The
  -- two metrics are computed in ONE pass and then split into two keys, so the
  -- headline number and its share can never be computed off different rows.
  --
  -- THE DENOMINATOR is club membership AS OF THE END OF THAT WEEK, not as of
  -- today: an invite_redemptions row (this module's authoritative
  -- MEMBER_JOINED stamp, 202608290011) redeemed before the week ended, on a
  -- profile that was not soft-deleted before the week ended. A member who
  -- joins in March is not in January's denominator, which a bare
  -- count(profiles) today would have made them.
  --
  -- Known limitation, the same one recap_monthly_generate() records:
  -- grant_coach_role() UPDATEs invite_redemptions.redeemed_at, so promoting
  -- an existing member to coach re-dates their join. There is no immutable
  -- joined_at in this schema to fall back on.
  --
  -- period_active_members is NOT WCAM and is labelled so it cannot be read as
  -- WCAM: it is the distinct active members across the WHOLE period, which
  -- for a month is a bigger number than any of its weeks and is not
  -- comparable to one. It is here because a month selector needs an answer to
  -- "how many distinct members were active at all", and computing it on the
  -- client by summing weeks would double-count.
  -- -----------------------------------------------------------------------
  with buckets as (
    select * from public.analytics_week_buckets(p_period_start, p_period_end)
  ),
  actives as (
    select date_trunc('week', e.created_at)::date as wk,
           count(distinct e.user_id)::bigint as n
    from public.analytics_events e
    where e.event_name = any(public.analytics_wcam_events())
      and e.created_at >= v_from
      and e.created_at < v_to
      and e.user_id is not null
    group by 1
  ),
  members as (
    select b.week_start,
           (select count(*)::bigint
            from public.profiles p
            join public.invite_redemptions ir on ir.user_id = p.id
            where ir.redeemed_at < least(b.week_end, p_period_end + 1)::timestamptz
              and (p.deleted_at is null
                   or p.deleted_at >= least(b.week_end, p_period_end + 1)::timestamptz)
           ) as club_members
    from buckets b
  ),
  rows_out as (
    select b.week_start, b.is_partial,
           coalesce(a.n, 0) as active,
           m.club_members
    from buckets b
    left join actives a on a.wk = b.week_start
    join members m on m.week_start = b.week_start
  )
  select
    jsonb_build_object(
      'weeks', coalesce(jsonb_agg(jsonb_build_object(
                 'week_start',     r.week_start,
                 'partial',        r.is_partial,
                 'active_members', r.active) order by r.week_start), '[]'::jsonb),
      'average_weekly', public.analytics_ratio(sum(r.active), count(*)),
      'peak_weekly',    coalesce(max(r.active), 0)),
    jsonb_build_object(
      'weeks', coalesce(jsonb_agg(jsonb_build_object(
                 'week_start',    r.week_start,
                 'partial',       r.is_partial,
                 'club_members',  r.club_members,
                 'share',         public.analytics_ratio(r.active, r.club_members))
                 order by r.week_start), '[]'::jsonb),
      'average_share', public.analytics_ratio(sum(r.active), nullif(sum(r.club_members), 0)))
  into v_wcam, v_wcam_share
  from rows_out r;

  select count(distinct e.user_id)::bigint into v_a
  from public.analytics_events e
  where e.event_name = any(public.analytics_wcam_events())
    and e.created_at >= v_from and e.created_at < v_to
    and e.user_id is not null;
  v_wcam := v_wcam || jsonb_build_object('period_active_members', v_a);

  -- -----------------------------------------------------------------------
  -- 3. Posting members per week.
  -- metrics.md: "count(distinct user_id) over post_created, workout_shared
  -- and achievement_shared."
  -- Weekly, because the metric is named "per week"; the period total is the
  -- distinct posters across the whole period and is not a sum of the weeks.
  -- -----------------------------------------------------------------------
  with buckets as (
    select * from public.analytics_week_buckets(p_period_start, p_period_end)
  ),
  posters as (
    select date_trunc('week', e.created_at)::date as wk,
           count(distinct e.user_id)::bigint as n
    from public.analytics_events e
    where e.event_name in ('post_created', 'workout_shared', 'achievement_shared')
      and e.created_at >= v_from and e.created_at < v_to
      and e.user_id is not null
    group by 1
  )
  select jsonb_build_object(
    'weeks', coalesce(jsonb_agg(jsonb_build_object(
               'week_start',      b.week_start,
               'partial',         b.is_partial,
               'posting_members', coalesce(p.n, 0)) order by b.week_start), '[]'::jsonb),
    'average_weekly', public.analytics_ratio(sum(coalesce(p.n, 0)), count(*)))
  into v_posting
  from buckets b left join posters p on p.wk = b.week_start;

  select count(distinct e.user_id)::bigint into v_a
  from public.analytics_events e
  where e.event_name in ('post_created', 'workout_shared', 'achievement_shared')
    and e.created_at >= v_from and e.created_at < v_to
    and e.user_id is not null;
  v_posting := v_posting || jsonb_build_object('period_posting_members', v_a);

  -- -----------------------------------------------------------------------
  -- 4. Engagement per post.
  -- metrics.md: "reaction_added plus comment_created over post_created, in a
  -- week." Events on both sides of the division, as written - the community
  -- tables below are the CROSS-CHECK, not the source, which is metrics.md's
  -- own standing rule for this module ("a week whose event count and table
  -- count disagree by a wide margin means events were dropped, not that
  -- members were inactive").
  --
  -- The cross-check counts are filtered the way COMM-309's posts_created is:
  -- not deleted, active, not only_me, author_id not null (so the club's own
  -- authorless announcements do not inflate a member-engagement figure).
  -- reactions and post_comments carry no soft-delete of their own, so they are
  -- counted through their post.
  -- -----------------------------------------------------------------------
  with buckets as (
    select * from public.analytics_week_buckets(p_period_start, p_period_end)
  ),
  ev as (
    select date_trunc('week', e.created_at)::date as wk,
           count(*) filter (where e.event_name = 'post_created')::bigint as posts,
           count(*) filter (where e.event_name = 'reaction_added')::bigint as reactions,
           count(*) filter (where e.event_name = 'comment_created')::bigint as comments
    from public.analytics_events e
    where e.event_name in ('post_created', 'reaction_added', 'comment_created')
      and e.created_at >= v_from and e.created_at < v_to
    group by 1
  )
  select jsonb_build_object(
    'weeks', coalesce(jsonb_agg(jsonb_build_object(
               'week_start', b.week_start,
               'partial',    b.is_partial,
               'posts',      coalesce(ev.posts, 0),
               'reactions',  coalesce(ev.reactions, 0),
               'comments',   coalesce(ev.comments, 0),
               'engagement_per_post',
                 public.analytics_ratio(coalesce(ev.reactions, 0) + coalesce(ev.comments, 0),
                                        ev.posts)) order by b.week_start), '[]'::jsonb),
    'period', jsonb_build_object(
      'posts',     sum(coalesce(ev.posts, 0)),
      'reactions', sum(coalesce(ev.reactions, 0)),
      'comments',  sum(coalesce(ev.comments, 0)),
      'engagement_per_post',
        public.analytics_ratio(sum(coalesce(ev.reactions, 0)) + sum(coalesce(ev.comments, 0)),
                               nullif(sum(coalesce(ev.posts, 0)), 0))))
  into v_engagement
  from buckets b left join ev on ev.wk = b.week_start;

  select count(*)::bigint into v_a
  from public.workout_posts w
  where w.created_at >= v_from and w.created_at < v_to
    and w.deleted_at is null and w.status = 'active'
    and w.visibility <> 'only_me' and w.author_id is not null;

  select count(*)::bigint into v_b
  from public.reactions r
  join public.workout_posts w on w.id = r.post_id
  where r.created_at >= v_from and r.created_at < v_to
    and w.deleted_at is null and w.status = 'active' and w.visibility <> 'only_me';

  select count(*)::bigint into v_c
  from public.post_comments pc
  join public.workout_posts w on w.id = pc.post_id
  where pc.created_at >= v_from and pc.created_at < v_to
    and w.deleted_at is null and w.status = 'active' and w.visibility <> 'only_me';

  v_engagement := v_engagement || jsonb_build_object(
    'table_cross_check', jsonb_build_object(
      'posts',     v_a,
      'reactions', v_b,
      'comments',  v_c,
      'engagement_per_post', public.analytics_ratio(v_b + v_c, v_a)));

  -- -----------------------------------------------------------------------
  -- 5. Feed reach.
  -- metrics.md: "count(distinct post_id) over post_impression against the
  -- posts published in the window."
  --
  -- The denominator deliberately does NOT carry `author_id is not null`,
  -- unlike the engagement cross-check above. Feed reach is about the feed: a
  -- club announcement or a POST_NEW_MEMBER row is a card members scroll past
  -- and is part of what the feed had to show. Excluding it would make reach
  -- look higher than it was.
  --
  -- post_id is read through analytics_event_uuid() and joined to
  -- workout_posts, so an impression on a post that no longer exists, or on a
  -- malformed props blob, drops out of the numerator rather than being
  -- counted as reach.
  -- -----------------------------------------------------------------------
  select count(*)::bigint into v_a
  from public.workout_posts w
  where w.created_at >= v_from and w.created_at < v_to
    and w.deleted_at is null and w.status = 'active'
    and w.visibility <> 'only_me';

  select count(*)::bigint into v_b
  from public.analytics_events e
  where e.event_name = 'post_impression'
    and e.created_at >= v_from and e.created_at < v_to;

  select count(distinct w.id)::bigint, count(*)::bigint
  into v_c, v_d
  from public.analytics_events e
  join public.workout_posts w
    on w.id = public.analytics_event_uuid(e.props, 'post_id')
  where e.event_name = 'post_impression'
    and e.created_at >= v_from and e.created_at < v_to
    and w.created_at >= v_from and w.created_at < v_to
    and w.deleted_at is null and w.status = 'active'
    and w.visibility <> 'only_me';

  v_feed_reach := jsonb_build_object(
    'posts_published',          v_a,
    'posts_with_impressions',   v_c,
    'reach_share',              public.analytics_ratio(v_c, v_a),
    'impressions_total',        v_b,
    'impressions_on_period_posts', v_d,
    'impressions_per_reached_post', public.analytics_ratio(v_d, v_c));

  -- =======================================================================
  -- ADDITIONAL METRICS - metrics.md "## Additional metrics", spec section 79.
  --
  -- Several of these are defined "per week" in metrics.md while the dashboard
  -- period is arbitrary. Rather than repeat the four-week series shape for
  -- all thirteen (which would make the response mostly scaffolding), each of
  -- them returns the period TOTAL plus a per_week average over the period's
  -- length in weeks. Selecting one week in the UI - which is the primary way
  -- COMM-310 says this screen is driven - makes total and per_week the same
  -- number, which is the "per week" metrics.md asks for.
  -- =======================================================================

  -- -----------------------------------------------------------------------
  -- 6. Open rate per surface.
  -- metrics.md: "post_opened over post_impression, by post_type."
  --
  -- post_impression carries no post_type prop (its props are post_id,
  -- position, feed_session_id), so the type has to come from the post. Both
  -- SIDES are therefore typed from workout_posts.post_type through the shared
  -- post_id rather than the numerator using post_opened's own post_type prop:
  -- one source for the grouping key means the numerator and the denominator
  -- cannot be typed differently for the same post.
  --
  -- No window filter on the post itself - opening a two-week-old post is
  -- still an open of it, and its impression is in the denominator too.
  -- -----------------------------------------------------------------------
  select coalesce(jsonb_object_agg(t.pt, jsonb_build_object(
           'impressions', t.imps,
           'opens',       t.opens,
           'open_rate',   public.analytics_ratio(t.opens, t.imps))), '{}'::jsonb)
  into v_open_rate
  from (
    select w.post_type::text as pt,
           count(*) filter (where e.event_name = 'post_impression')::bigint as imps,
           count(*) filter (where e.event_name = 'post_opened')::bigint as opens
    from public.analytics_events e
    join public.workout_posts w
      on w.id = public.analytics_event_uuid(e.props, 'post_id')
    where e.event_name in ('post_impression', 'post_opened')
      and e.created_at >= v_from and e.created_at < v_to
    group by 1
  ) t;

  -- -----------------------------------------------------------------------
  -- 7. Filter use.
  -- metrics.md: "feed_viewed grouped by scope, and the share of sessions that
  -- ever change scope."
  --
  -- JUDGMENT CALL, stated: feed_viewed carries no session id. post_impression
  -- has feed_session_id; feed_viewed's props are scope and source only, so
  -- "share of sessions" is not directly answerable. A SESSION IS APPROXIMATED
  -- BY A MEMBER-DAY here - the share of (member, calendar day) pairs that saw
  -- the feed at all and also changed scope at least once that day. A member
  -- who opens the app three times in one day is one denominator unit, not
  -- three, so this number is a floor on the true per-session rate rather than
  -- an estimate of it. The raw source split is returned alongside it so a
  -- reader can see the same thing counted per feed ENTRY as well.
  -- Adding feed_session_id to feed_viewed would answer it exactly and is a
  -- client change (an additive prop, no SCHEMA_VERSION bump), not a schema one.
  -- -----------------------------------------------------------------------
  select count(*)::bigint, count(*) filter (where s.changed)::bigint
  into v_a, v_b
  from (
    select e.user_id, e.created_at::date as d,
           bool_or(coalesce(e.props ->> 'source', '') = 'scope_change') as changed
    from public.analytics_events e
    where e.event_name = 'feed_viewed'
      and e.created_at >= v_from and e.created_at < v_to
      and e.user_id is not null
    group by 1, 2
  ) s;

  v_filter_use := jsonb_build_object(
    'by_scope',  public.analytics_breakdown('feed_viewed', 'scope',  v_from, v_to),
    'by_source', public.analytics_breakdown('feed_viewed', 'source', v_from, v_to),
    'sessions', jsonb_build_object(
      'basis',                    'member_day',
      'feed_sessions',            v_a,
      'sessions_changing_scope',  v_b,
      'scope_change_share',       public.analytics_ratio(v_b, v_a)));

  -- -----------------------------------------------------------------------
  -- 8. Sub-tab split.
  -- metrics.md: "club_tab_viewed grouped by tab."
  -- -----------------------------------------------------------------------
  select count(*)::bigint into v_a
  from public.analytics_events e
  where e.event_name = 'club_tab_viewed'
    and e.created_at >= v_from and e.created_at < v_to;

  v_sub_tab := jsonb_build_object(
    'total',  v_a,
    'by_tab', public.analytics_breakdown('club_tab_viewed', 'tab', v_from, v_to));

  -- -----------------------------------------------------------------------
  -- 9. Notification effectiveness.
  -- metrics.md: "notification_opened over notifications delivered, by type,
  -- with was_unread separating a real open from a revisit."
  --
  -- Delivered is the notifications TABLE (a row per delivery, created in the
  -- window), because there is no delivery event; opened is the event stream.
  -- open_rate uses the UNREAD opens only, which is what "a real open" means
  -- here - counting revisits would let one member re-reading an old
  -- notification push a type over 100%.
  --
  -- A FULL JOIN, not a left join from either side: a type with deliveries and
  -- no opens is the interesting case, and so is a type with opens and no
  -- deliveries in the window (an old notification opened late), and a left
  -- join in either direction hides one of them.
  -- -----------------------------------------------------------------------
  with delivered as (
    select left(n.type, 64) as k, count(*)::bigint as dl
    from public.notifications n
    where n.created_at >= v_from and n.created_at < v_to
    group by 1
  ),
  opened as (
    select left(coalesce(nullif(e.props ->> 'type', ''), '(none)'), 64) as k,
           count(*)::bigint as ot,
           count(*) filter (where e.props ->> 'was_unread' = 'true')::bigint as ou
    from public.analytics_events e
    where e.event_name = 'notification_opened'
      and e.created_at >= v_from and e.created_at < v_to
    group by 1
  ),
  merged as (
    select coalesce(d.k, o.k) as k,
           coalesce(d.dl, 0) as dl,
           coalesce(o.ot, 0) as ot,
           coalesce(o.ou, 0) as ou
    from delivered d
    full join opened o on o.k = d.k
    order by coalesce(d.dl, 0) desc, coalesce(o.ot, 0) desc, coalesce(d.k, o.k)
    limit 25
  )
  select coalesce(jsonb_object_agg(m.k, jsonb_build_object(
           'delivered',      m.dl,
           'opened',         m.ot,
           'opened_unread',  m.ou,
           'opened_revisit', m.ot - m.ou,
           'open_rate',      public.analytics_ratio(m.ou, m.dl))), '{}'::jsonb)
  into v_notif
  from merged m;

  -- -----------------------------------------------------------------------
  -- 10. Social graph growth.
  -- metrics.md: "member_followed per week, and profile_opened with self =
  -- false as the discovery signal ahead of it."
  --
  -- self is a jsonb boolean from the client, so it is compared as text and
  -- ANYTHING THAT IS NOT EXACTLY 'true' counts as another member's profile.
  -- That is the safe direction: a malformed or missing self prop is counted
  -- as discovery of somebody else, which slightly deflates the follow
  -- conversion rate rather than inflating it.
  --
  -- follows is the cross-check side. Its row count in the window can exceed
  -- member_followed legitimately (an older cached client, or a follow made
  -- before the event existed) and can also fall below it, because a follow
  -- that was later undone leaves no row - metrics.md's counting-once note
  -- says member_followed fires on the successful INSERT only and the toggle's
  -- duplicate-key branch is an unfollow.
  -- -----------------------------------------------------------------------
  select
    count(*) filter (where e.event_name = 'member_followed')::bigint,
    count(*) filter (where e.event_name = 'profile_opened'
                       and coalesce(e.props ->> 'self', '') <> 'true')::bigint,
    count(*) filter (where e.event_name = 'profile_opened'
                       and e.props ->> 'self' = 'true')::bigint
  into v_a, v_b, v_c
  from public.analytics_events e
  where e.event_name in ('member_followed', 'profile_opened')
    and e.created_at >= v_from and e.created_at < v_to;

  select count(*)::bigint into v_d
  from public.follows f
  where f.created_at >= v_from and f.created_at < v_to;

  v_social := jsonb_build_object(
    'member_followed', jsonb_build_object(
      'total',    v_a,
      'per_week', public.analytics_ratio(v_a, v_weeks)),
    'profile_opened', jsonb_build_object(
      'other', v_b,
      'self',  v_c),
    'follow_conversion', public.analytics_ratio(v_a, v_b),
    'table_cross_check', jsonb_build_object('follow_edges_created', v_d));

  -- -----------------------------------------------------------------------
  -- 11. Challenge and leaderboard pull.
  -- metrics.md: "challenge_viewed and leaderboard_viewed per week, against
  -- challenge_joined for the conversion."
  --
  -- join_rate is joins over challenge_viewed only. leaderboard_viewed is NOT
  -- in that denominator: the consistency board and a challenge progress board
  -- are not things a member can join, so folding them in would make the
  -- conversion rate a function of how many boards the Boards tab happens to
  -- render.
  --
  -- Comparability caveat metrics.md records and this cannot fix: any
  -- challenge_viewed with source = 'post_card' dated before COMM-233 may
  -- actually be a Boards open, so a by_source split across that boundary is
  -- not comparable.
  -- -----------------------------------------------------------------------
  select
    count(*) filter (where e.event_name = 'challenge_viewed')::bigint,
    count(*) filter (where e.event_name = 'leaderboard_viewed')::bigint,
    count(*) filter (where e.event_name = 'challenge_joined')::bigint
  into v_a, v_b, v_c
  from public.analytics_events e
  where e.event_name in ('challenge_viewed', 'leaderboard_viewed', 'challenge_joined')
    and e.created_at >= v_from and e.created_at < v_to;

  v_challenge := jsonb_build_object(
    'challenge_viewed', jsonb_build_object(
      'total',     v_a,
      'per_week',  public.analytics_ratio(v_a, v_weeks),
      'by_source', public.analytics_breakdown('challenge_viewed', 'source', v_from, v_to)),
    'leaderboard_viewed', jsonb_build_object(
      'total',    v_b,
      'per_week', public.analytics_ratio(v_b, v_weeks),
      'by_board', public.analytics_breakdown('leaderboard_viewed', 'board', v_from, v_to)),
    'challenge_joined', jsonb_build_object(
      'total',    v_c,
      'per_week', public.analytics_ratio(v_c, v_weeks)),
    'join_rate', public.analytics_ratio(v_c, v_a));

  -- -----------------------------------------------------------------------
  -- 12. Moderation load.
  -- metrics.md: "report_submitted grouped by reason and target_type, against
  -- the queue in reports."
  --
  -- The event side is what members DID; the reports side is what the club has
  -- to act on. queue_open_now is deliberately not period-bounded - a backlog
  -- is a fact about right now, and an admin looking at last March needs to
  -- know the queue is 40 deep today, not that it was empty then.
  -- -----------------------------------------------------------------------
  select count(*)::bigint into v_a
  from public.analytics_events e
  where e.event_name = 'report_submitted'
    and e.created_at >= v_from and e.created_at < v_to;

  select count(*)::bigint into v_b
  from public.reports r
  where r.created_at >= v_from and r.created_at < v_to;

  select count(*)::bigint into v_c
  from public.reports r
  where r.status = 'open';

  v_moderation := jsonb_build_object(
    'reports_submitted', jsonb_build_object(
      'total',          v_a,
      'per_week',       public.analytics_ratio(v_a, v_weeks),
      'by_reason',      public.analytics_breakdown('report_submitted', 'reason', v_from, v_to),
      'by_target_type', public.analytics_breakdown('report_submitted', 'target_type', v_from, v_to)),
    'queue', jsonb_build_object(
      'rows_created_in_period', v_b,
      'open_now',               v_c,
      'by_reason', coalesce((
        select jsonb_object_agg(t.reason, t.n) from (
          select r.reason, count(*)::bigint as n from public.reports r
          where r.created_at >= v_from and r.created_at < v_to group by 1) t), '{}'::jsonb),
      'by_target_type', coalesce((
        select jsonb_object_agg(t.target_type, t.n) from (
          select r.target_type, count(*)::bigint as n from public.reports r
          where r.created_at >= v_from and r.created_at < v_to group by 1) t), '{}'::jsonb),
      'by_status', coalesce((
        select jsonb_object_agg(t.status, t.n) from (
          select r.status::text as status, count(*)::bigint as n from public.reports r
          where r.created_at >= v_from and r.created_at < v_to group by 1) t), '{}'::jsonb)));

  -- -----------------------------------------------------------------------
  -- 13. Share intent split.
  -- metrics.md: "workout_shared by visibility, and achievement_shared by
  -- source."
  -- -----------------------------------------------------------------------
  select
    count(*) filter (where e.event_name = 'workout_shared')::bigint,
    count(*) filter (where e.event_name = 'achievement_shared')::bigint
  into v_a, v_b
  from public.analytics_events e
  where e.event_name in ('workout_shared', 'achievement_shared')
    and e.created_at >= v_from and e.created_at < v_to;

  v_share_intent := jsonb_build_object(
    'workout_shared', jsonb_build_object(
      'total',         v_a,
      'by_visibility', public.analytics_breakdown('workout_shared', 'visibility', v_from, v_to)),
    'achievement_shared', jsonb_build_object(
      'total',     v_b,
      'by_source', public.analytics_breakdown('achievement_shared', 'source', v_from, v_to)));

  -- -----------------------------------------------------------------------
  -- 14. Recap pull-through.
  -- metrics.md: "weekly_recap_opened by source against the recap
  -- notifications sent, and weekly_recap_shared over it by figure."
  --
  -- "Recap notifications sent" is notifications.type = 'weekly_recap', the
  -- type the recap_weekly Edge Function passes to notif_create(). open_rate
  -- can legitimately exceed 1: metrics.md records that weekly_recap_opened
  -- also fires for source = 'account', which is a member opening the recap
  -- from their account screen with no notification behind it at all.
  -- -----------------------------------------------------------------------
  select
    count(*) filter (where e.event_name = 'weekly_recap_opened')::bigint,
    count(*) filter (where e.event_name = 'weekly_recap_shared')::bigint
  into v_a, v_b
  from public.analytics_events e
  where e.event_name in ('weekly_recap_opened', 'weekly_recap_shared')
    and e.created_at >= v_from and e.created_at < v_to;

  select count(*)::bigint into v_c
  from public.notifications n
  where n.type = 'weekly_recap'
    and n.created_at >= v_from and n.created_at < v_to;

  v_recap := jsonb_build_object(
    'opened', jsonb_build_object(
      'total',     v_a,
      'by_source', public.analytics_breakdown('weekly_recap_opened', 'source', v_from, v_to)),
    'notifications_sent', v_c,
    'open_rate',          public.analytics_ratio(v_a, v_c),
    'shared', jsonb_build_object(
      'total',     v_b,
      'by_figure', public.analytics_breakdown('weekly_recap_shared', 'figure', v_from, v_to)),
    'share_rate', public.analytics_ratio(v_b, v_a));

  -- -----------------------------------------------------------------------
  -- 15. Discovery split.
  -- metrics.md: "search_performed by source with member_count at zero as the
  -- 'found nothing' rate, against directory_opened for how many members
  -- browse the roster instead of searching it."
  --
  -- member_count is compared as text against '0' rather than cast: the prop
  -- is client-written, and a cast would raise on a malformed value. Anything
  -- that is not literally '0' is not a proven zero-result search.
  -- -----------------------------------------------------------------------
  select
    count(*) filter (where e.event_name = 'search_performed')::bigint,
    count(*) filter (where e.event_name = 'search_performed'
                       and e.props ->> 'member_count' = '0')::bigint,
    count(*) filter (where e.event_name = 'directory_opened')::bigint
  into v_a, v_b, v_c
  from public.analytics_events e
  where e.event_name in ('search_performed', 'directory_opened')
    and e.created_at >= v_from and e.created_at < v_to;

  v_discovery := jsonb_build_object(
    'search_performed', jsonb_build_object(
      'total',              v_a,
      'by_source',          public.analytics_breakdown('search_performed', 'source', v_from, v_to),
      'zero_member_result', v_b,
      'zero_member_rate',   public.analytics_ratio(v_b, v_a)),
    'directory_opened', jsonb_build_object(
      'total',     v_c,
      'by_source', public.analytics_breakdown('directory_opened', 'source', v_from, v_to)),
    'search_vs_directory', public.analytics_ratio(v_a, v_c));

  -- -----------------------------------------------------------------------
  -- 16. Coach reach.
  -- metrics.md: "coach_congratulate_sent per week by kind, against the
  -- celebrate items the dashboard offered."
  --
  -- JUDGMENT CALL, stated: "the celebrate items the dashboard offered" cannot
  -- be replayed exactly. coach_celebrate_feed() (202608290013) is
  -- VIEWER-RELATIVE - each of its three branches is gated by
  -- can_view_profile_field() against the calling coach - and a member who has
  -- since flipped show_prs would change what a historical replay returned.
  -- It also clamps its window to 30 days and caps at 100 rows.
  --
  -- So items_eligible below is the count of items the feed's three SOURCES
  -- produced in the period - PR posts, tenure anniversaries, challenge
  -- completions - with the same non-privacy filters coach_celebrate_feed()
  -- applies to each branch and WITHOUT the per-viewer toggle gates. It is
  -- therefore an upper bound on what any one coach was actually shown, and
  -- coverage is a lower bound on the share of celebrations that were acted
  -- on. Deriving it from the same three sources, with the same filters, is
  -- what stops it becoming a second definition of "a celebrate item".
  -- -----------------------------------------------------------------------
  select count(*)::bigint into v_a
  from public.analytics_events e
  where e.event_name = 'coach_congratulate_sent'
    and e.created_at >= v_from and e.created_at < v_to;

  select
    (select count(*) from public.workout_posts p
      where p.post_type = 'POST_PR'
        and p.created_at >= v_from and p.created_at < v_to
        and p.deleted_at is null and p.status = 'active'
        and p.author_id is not null)
  + (select count(*) from public.invite_redemptions ir
      join public.achievement_definitions d
        on coalesce(d.config ->> 'metric', '') = 'tenure_days'
       and d.enabled and d.threshold >= 365
      where ir.redeemed_at + (d.threshold || ' days')::interval >= v_from
        and ir.redeemed_at + (d.threshold || ' days')::interval <  v_to)
  + (select count(*) from public.challenge_participants cp
      join public.challenges c on c.id = cp.challenge_id
      where cp.completed_at >= v_from and cp.completed_at < v_to
        and cp.status <> 'withdrawn' and c.status <> 'draft')
  into v_b;

  v_coach := jsonb_build_object(
    'congratulations', jsonb_build_object(
      'total',    v_a,
      'per_week', public.analytics_ratio(v_a, v_weeks),
      'by_kind',  public.analytics_breakdown('coach_congratulate_sent', 'kind', v_from, v_to),
      'by_via',   public.analytics_breakdown('coach_congratulate_sent', 'via', v_from, v_to)),
    'celebrate_items_eligible', v_b,
    'coverage',                 public.analytics_ratio(v_a, v_b));

  -- -----------------------------------------------------------------------
  -- 17. Push adoption.
  -- metrics.md: "push_opt_in per week against the unrevoked rows in
  -- push_subscriptions."
  --
  -- subscriptions_active_now is a snapshot of today, not of the period, for
  -- the same reason the moderation queue depth is: "how many members can we
  -- reach" is a fact about now. subscriptions_created_in_period is the
  -- period-bounded half, and it is the one comparable to the opt-in events.
  -- The two can legitimately disagree - push_opt_in fires AFTER the upsert
  -- succeeds, so a re-enable on an endpoint that already existed is an event
  -- with no new row.
  -- -----------------------------------------------------------------------
  select count(*)::bigint into v_a
  from public.analytics_events e
  where e.event_name = 'push_opt_in'
    and e.created_at >= v_from and e.created_at < v_to;

  select
    count(*) filter (where s.created_at >= v_from and s.created_at < v_to)::bigint,
    count(*) filter (where s.revoked_at is null)::bigint,
    count(*) filter (where s.revoked_at is not null)::bigint,
    count(distinct s.user_id) filter (where s.revoked_at is null)::bigint
  into v_b, v_c, v_d, v_e
  from public.push_subscriptions s;

  v_push := jsonb_build_object(
    'opt_in_events', jsonb_build_object(
      'total',       v_a,
      'per_week',    public.analytics_ratio(v_a, v_weeks),
      'by_pref_type', public.analytics_breakdown('push_opt_in', 'pref_type', v_from, v_to)),
    'subscriptions', jsonb_build_object(
      'created_in_period',   v_b,
      'active_now',          v_c,
      'revoked_now',         v_d,
      'members_reachable_now', v_e));

  -- -----------------------------------------------------------------------
  -- 18. Trained-with-you reach.
  -- metrics.md: "classmates_card_viewed per week with rows as the size of the
  -- overlap it found, against attendance_recorded for the share of training
  -- days that produced a card at all. A LOW RATIO IS show_attendance
  -- ADOPTION, NOT A BROKEN CARD: the toggle defaults to false and both sides
  -- of every pair have to have flipped it."
  --
  -- That caveat is carried into the response as a key rather than left in a
  -- doc, because the number is otherwise easy to read as a defect. The card's
  -- event fires only when the card renders with at least one classmate on it,
  -- so card views and "how often the card had anything to show" are the same
  -- number by construction and card_rate is genuinely a coverage figure.
  --
  -- rows is a client-written prop, so it is summed only when it is a plain
  -- small integer; anything else contributes 0 rather than raising.
  -- -----------------------------------------------------------------------
  select
    count(*) filter (where e.event_name = 'classmates_card_viewed')::bigint,
    coalesce(sum(case when e.event_name = 'classmates_card_viewed'
                       and e.props ->> 'rows' ~ '^[0-9]{1,6}$'
                      then (e.props ->> 'rows')::bigint else 0 end), 0),
    count(*) filter (where e.event_name = 'attendance_recorded')::bigint
  into v_a, v_b, v_c
  from public.analytics_events e
  where e.event_name in ('classmates_card_viewed', 'attendance_recorded')
    and e.created_at >= v_from and e.created_at < v_to;

  select count(*)::bigint into v_d
  from public.attendance_log a
  where a.occurred_on >= p_period_start and a.occurred_on <= p_period_end;

  v_classmates := jsonb_build_object(
    'card_views', jsonb_build_object(
      'total',    v_a,
      'per_week', public.analytics_ratio(v_a, v_weeks)),
    'classmates_shown_total',  v_b,
    'classmates_per_card',     public.analytics_ratio(v_b, v_a),
    'attendance_events',       v_c,
    'card_rate',               public.analytics_ratio(v_a, v_c),
    'table_cross_check', jsonb_build_object('attendance_days_logged', v_d),
    'note', 'card_rate is bounded by show_attendance adoption: both sides of every pair must have opted in, and the toggle defaults to false. A low value is adoption, not a broken card.');

  -- =======================================================================
  -- ONE OBJECT. Grouped core / additional to match metrics.md's own split,
  -- which is also the section split COMM-310 asks the screen to render.
  -- =======================================================================
  return jsonb_build_object(
    'period', jsonb_build_object(
      'start',         p_period_start,
      'end',           p_period_end,
      'end_exclusive', (p_period_end + 1),
      'days',          v_days,
      'weeks',         round(v_weeks, 4)),
    'generated_at', now(),
    'core', jsonb_build_object(
      'wcam',                v_wcam,
      'wcam_share',          v_wcam_share,
      'posting_members',     v_posting,
      'engagement_per_post', v_engagement,
      'feed_reach',          v_feed_reach),
    'additional', jsonb_build_object(
      'open_rate',                 v_open_rate,
      'filter_use',                v_filter_use,
      'sub_tab_split',             v_sub_tab,
      'notification_effectiveness', v_notif,
      'social_graph_growth',       v_social,
      'challenge_leaderboard_pull', v_challenge,
      'moderation_load',           v_moderation,
      'share_intent_split',        v_share_intent,
      'recap_pull_through',        v_recap,
      'discovery_split',           v_discovery,
      'coach_reach',               v_coach,
      'push_adoption',             v_push,
      'trained_with_you_reach',    v_classmates));
end $$;

revoke all on function public.analytics_dashboard(date, date) from public, anon;
grant execute on function public.analytics_dashboard(date, date) to authenticated;

comment on function public.analytics_dashboard(date, date) is
  'COMM-310 admin community analytics dashboard. ONE call returning every metric in docs/community/metrics.md''s "Core metrics" (5) and "Additional metrics" (13) sections, keyed by name under core/additional, matching coach_celebrate_feed()''s one-call-for-the-whole-list shape. No metric outside those two lists is computed. AUTH: security definer; auth.uid() checked first, then `has_perm(''community.analytics.view'') or is_admin()` - NOT is_staff(), so a coach is refused. Refuses ''not authorized'', ''period required'', ''period end before start'', ''period exceeds 366 days'' (all P0001); the period is validated, never clamped, so a number can never be labelled with a range it was not computed over. p_period_end is INCLUSIVE of its day; the resolved half-open bound is returned as period.end_exclusive. Max span 366 days, because analytics_events'' only time index is (event_name, created_at desc). DEFINER for the cross-check tables, not for analytics_events: that table''s own RLS already restricts read to a community.analytics.view holder and this function does not widen it by one row, but notifications, push_subscriptions, reports, attendance_log, follows, post_comments, reactions and workout_posts are all own-row or viewer-relative and would each return the calling admin''s own slice. AGGREGATE ONLY: every value is a count, a sum or a ratio; the only grouping keys are ISO week starts, surface names and enum-shaped props; no member id, handle, display name or post id appears anywhere in the output, and analytics_breakdown() is never called with an id-bearing prop. Read-only, no side effects. WCAM comes from analytics_wcam_events(), the single server-side copy of the spec-78 list.';

commit;
