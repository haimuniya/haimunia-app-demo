begin;

-- COMM-313, schema half. Retention correlation views: a cohort retention
-- curve, plus two correlation cuts across it - the onboarding steps
-- (COMM-222 + COMM-316) and the early coach Welcome (COMM-224).
--
-- WHAT IS AND IS NOT HERE
--
-- No new table, no new policy, no policy edited, no grant changed on any
-- existing table. Nothing is materialised; all three answers are computed
-- live on every call from four sources that already exist:
--
--   invite_redemptions    the join month. This module's authoritative
--                         MEMBER_JOINED stamp (202608290011), the same
--                         column COMM-310's WCAM denominator, COMM-311's
--                         tenure test and the anniversary achievements all
--                         read.
--   analytics_events      WCAM-qualifying activity, ALWAYS through
--                         public.analytics_wcam_events() (202609010006).
--   onboarding_progress   the five step stamps (202608290011 wrote three,
--                         202609010003/COMM-316 added the two class ones).
--   member_contact_log    the coach Welcome (202608290013, COMM-224).
--
-- THE WCAM LIST IS NOT REPEATED HERE. 202609010006 wrote
-- analytics_wcam_events() precisely so that COMM-311, COMM-312 and COMM-313
-- could not each grow their own copy of the fifteen qualifying event names
-- and quietly disagree about who was active. One function in this file
-- (retention_member_weeks) calls it; the other four contain no event name at
-- all. 0052 asserts that structurally.
--
-- No client half is built here. The cohort chart, the two overlay toggles and
-- the Hebrew error copy are the client half and land separately, the same
-- two-phase split every cluster in Phase 2 and Phase 3 has used.
--
-- ---------------------------------------------------------------------------
-- ORDERING AGAINST COMM-312, WHICH THIS TICKET LISTS AS A DEPENDENCY
-- ---------------------------------------------------------------------------
-- COMM-313's "Dependencies" line names COMM-312, and this migration ships
-- BEFORE COMM-312 anyway. That is deliberate, and it is not a shortcut:
--
--   * COMM-313 reads nothing COMM-312 produces. Its acceptance criteria and
--     its client contracts never mention community_health_scores or any
--     COMM-312 function; the only thing it borrows from that ticket is the
--     WORDING OF THE PERMISSION GATE ("matching COMM-312's narrower bar").
--     A gate is copied by writing `is_admin()`, not by depending on code.
--   * COMM-312 genuinely reads COMM-313. Its health score names "a retention
--     signal (COMM-313, once it exists)" as one of its four weighted inputs.
--
-- So the dependency runs the other way round, and COMM-313 first is the only
-- order in which either ticket can be built. Recorded here, in
-- docs/community/contracts.md and on the ticket itself rather than left as a
-- silent reordering.
--
-- ---------------------------------------------------------------------------
-- THE GATE IS is_admin() ALONE - NARROWER THAN COMM-310 AND COMM-311
-- ---------------------------------------------------------------------------
-- Every other analytics surface in this cluster gates on
-- `has_perm('community.analytics.view') or is_admin()`. THIS FILE DOES NOT.
-- COMM-313 says it twice: "Gated by real `is_admin`, matching COMM-312's
-- narrower bar rather than the broader `community.analytics.view` bar
-- COMM-310 and COMM-311 use", and again in its client contracts, "`security
-- definer`, real `is_admin` required".
--
-- Today those two gates select almost the same people - 202608280001 seeds
-- community.analytics.view to admin and owner only, and both of those pass
-- is_admin() (rank 50 and 60, the bar is 50). The difference is real the
-- moment anybody grants that permission to a lower-ranked role: a
-- head_coach or staff role holding community.analytics.view can read the
-- dashboard and the segments and STILL cannot read a retention curve. That
-- is the intended asymmetry, not an oversight, and 0052 asserts exactly that
-- case - a real analytics-permission holder who is not an admin is refused
-- here while member_segments() lets them in.
--
-- The reason is COMM-313's own: a retention curve is close to COMM-312's
-- "easy to misread out of context" concern. "42% of the March cohort was
-- gone by week 6" is a sentence that travels badly, and unlike a segment
-- label it has no obvious owner to correct it.
--
-- ---------------------------------------------------------------------------
-- EVERY FIGURE IS A COHORT AGGREGATE. NO MEMBER IS NAMED, ANYWHERE.
-- ---------------------------------------------------------------------------
-- COMM-313's fourth acceptance criterion is the strictest privacy rule in
-- the Phase 3 cluster, and it is one step MORE aggregate than COMM-311:
-- member_segments() names individuals on purpose (acting on a segment means
-- knowing who is in it), and this file names nobody at all. Not a user_id,
-- not a handle, not a display_name, in any of the three public functions'
-- output. "Did this member churn" is a far more sensitive framing than
-- "which bucket are they in today", and it is not a question these functions
-- can be asked: the smallest thing they will answer is a group of
-- retention_min_cohort_size() people.
--
-- That is why the private helper below is granted to NOBODY. It is the only
-- function here that carries a user_id in its result, it exists so that the
-- three public functions share one definition of a membership week, and a
-- client-callable version of it would be a per-member churn label with a
-- thin wrapper - exactly the thing the criterion forbids. Same "the grant is
-- the gate" pattern analytics_breakdown() (202609010006) uses.
--
-- ---------------------------------------------------------------------------
-- CORRELATION, NOT CAUSATION - AND WHY THAT IS A SCHEMA CONCERN TOO
-- ---------------------------------------------------------------------------
-- COMM-313 asks that the two cuts be "explicitly not presented as causation
-- anywhere in the surface's own copy". The copy is the client half's job.
-- What this half can do, and does, is refuse to name a field in a way that
-- would make an honest label hard to write: there is no `effect`, `impact`,
-- `lift` or `uplift` key anywhere below. Each cut returns TWO INDEPENDENT
-- CURVES side by side and no difference between them; a reader who wants a
-- gap subtracts it themselves, which is the point at which they own the
-- claim.
--
-- The substantive caveat, worth stating once in full because it is the
-- reason the framing matters:
--
--   AN ONBOARDING STEP IS STAMPED ONLY WHEN THE CLIENT RENDERS IT
--   (202608290011: "shown, not merely scheduled"), which requires the member
--   to open the app. So "was welcomed_at ever stamped" is partly a
--   restatement of "did this member come back at all" - the exposure is
--   downstream of the very engagement the curve measures. A gap between the
--   two curves is therefore an upper bound on anything causal, and quite
--   possibly all selection. The same applies, more weakly, to the coach
--   Welcome: coaches notice and contact members who are around to be
--   noticed.
--
-- This is not a defect to be fixed in SQL - it is what the data is - but a
-- surface that shows these two curves without that sentence somewhere near
-- them is misleading, and this comment is the schema half's copy of it.

-- ===========================================================================
-- 1. retention_min_cohort_size() - the floor, as a named constant
-- ===========================================================================
-- COMM-313: "a cohort with fewer than a minimum member count (for example 5,
-- to avoid a curve built from 1-2 people) is grouped into 'other' rather than
-- shown as its own unstable line", and under validation rules, the floor is
-- not a client input.
--
-- FIVE. The ticket offers 5 as an example and nothing in the repo grounds a
-- different number, so the example is taken. What five buys, concretely: no
-- figure this file will emit can move by more than 20 percentage points when
-- one person changes their mind, and no share can be 0% or 100% off fewer
-- than five people. Four would allow quarter-steps, three would let a single
-- member swing a line by a third. It is also small enough to keep a real
-- club's monthly cohorts visible - a gym that signs up four people in a month
-- has a signup problem the retention chart is not the place to read.
--
-- It is a FUNCTION rather than a constant inside each body for two reasons:
-- all three public functions apply the same floor and must not drift apart,
-- and the client half needs the number to write its "cohorts under N members
-- are grouped together" caption without hardcoding a second copy of it. It is
-- granted to authenticated for that second reason - it is one integer, and
-- one that ships in the UI copy anyway.
--
-- IMMUTABLE, so it folds into a constant wherever it is compared.
create or replace function public.retention_min_cohort_size()
returns integer
language sql immutable set search_path = '' as $$
  select 5;
$$;

revoke all on function public.retention_min_cohort_size() from public, anon;
grant execute on function public.retention_min_cohort_size() to authenticated;

comment on function public.retention_min_cohort_size() is
  'COMM-313. The minimum number of members behind any figure retention_cohorts(), retention_onboarding_correlation() or retention_welcome_correlation() will emit: 5, the value COMM-313 offers as its example. A cohort month with fewer than this many members is folded into the "other" bucket rather than drawn as its own unstable line, and any (group, week) cell whose denominator falls below it is not emitted at all. A named constant in one place, not a client parameter, so the three surfaces cannot drift apart; granted to authenticated so the client can write its "cohorts under N members are grouped" caption without a second copy of the number. IMMUTABLE.';

-- ===========================================================================
-- 2. retention_member_weeks(p_months) - the one definition of a member week
-- ===========================================================================
-- PRIVATE. Granted to no role at all; the grant is the gate, exactly as it is
-- for analytics_breakdown() (202609010006) and recap_monthly_generate()
-- (202609010002). It is SECURITY DEFINER and returns a user_id, so a
-- client-callable version would be a per-member retained/churned feed - the
-- one output COMM-313's fourth acceptance criterion forbids. The three public
-- functions below have already checked auth.uid() and is_admin() before they
-- call it, which is where this schema's "check auth.uid() first" rule is
-- satisfied for it.
--
-- WHY DEFINER. Two boundaries, each of which would otherwise silently return
-- the caller's own slice and label it the club's:
--
--   * invite_redemptions is SELF-SELECT ONLY (202608270003:
--     invite_redemptions_self_select is `user_id = auth.uid()`). Without
--     definer rights every cohort would be one member - the caller.
--   * analytics_events' select policy is a community.analytics.view holder
--     (202608280012). This function's callers gate on is_admin(), which is
--     NOT that permission - so unlike member_segments(), where the definer
--     bit crossed nothing for analytics_events, here it genuinely does. An
--     admin holds community.analytics.view by seed today, but the gate does
--     not require it, so the crossing is real and is named rather than
--     assumed away.
--
-- profiles is read too, but only for existence; nothing about its RLS is
-- crossed that matters, and no profile column is returned.
--
-- ---------------------------------------------------------------------------
-- ONE ROW PER (MEMBER, WEEK 1..12), INCLUDING WEEKS THAT HAVE NOT HAPPENED
-- ---------------------------------------------------------------------------
-- Every cohort member gets exactly twelve rows, whatever their tenure, and
-- `elapsed` says whether that week has finished. That shape is what lets a
-- caller count the COHORT (twelve rows per member, so count(distinct
-- user_id) is the true number who joined that month) and the WEEK DENOMINATOR
-- (only the elapsed rows) from the same result set, without the two
-- disagreeing. A helper that had pre-filtered to elapsed weeks would make a
-- cohort of six in which only two members have finished week 1 look like a
-- cohort of two, and it would be folded into "other" for a reason that has
-- nothing to do with how many people joined.
--
-- ---------------------------------------------------------------------------
-- A MEMBERSHIP WEEK IS 7x24h FROM THE JOIN INSTANT, NOT AN ISO WEEK
-- ---------------------------------------------------------------------------
-- This is the one place COMM-313 departs from the ISO-week grid every other
-- WCAM consumer uses (analytics_dashboard, member_segments, the recaps), and
-- it is forced by the ticket's own wording: "the share still WCAM-qualifying
-- in each of THEIR FIRST 12 WEEKS OF MEMBERSHIP". A cohort is a calendar
-- month, so its members join on different days; week 1 has to mean each
-- member's own first week or the curve is not a retention curve at all.
--
-- On an ISO grid a member who joined on a Sunday would get a one-day "week
-- 1" and look like a week-1 dropout for a reason that is purely an artefact
-- of the day they signed up. Every member here gets twelve equal windows:
-- week k is [joined_at + (k-1)*7 days, joined_at + k*7 days).
--
-- THE WCAM DEFINITION IS UNCHANGED BY THIS. Which events count is
-- analytics_wcam_events() and nothing else; only the window boundary moves.
-- Worth stating plainly because metrics.md defines WCAM as a weekly measure
-- on the ISO week: a member counted active in "membership week 3" here might
-- straddle two ISO weeks in the dashboard's own WCAM figure. The two numbers
-- answer different questions and are not expected to reconcile row for row.
--
-- The arithmetic is in SECONDS (604800 per week) rather than in `interval '7
-- days'`, so a DST change cannot make one member's week 23 or 25 hours long
-- and shift an event across a boundary. PostgREST runs in UTC and would never
-- have hit that, but a pgTAP run or a psql session in a civil timezone would.
--
-- ---------------------------------------------------------------------------
-- WHO IS IN A COHORT: JOIN TIME, NOT AS-OF NOW. SOFT-DELETED MEMBERS STAY.
-- ---------------------------------------------------------------------------
-- COMM-310's denominator and COMM-311's member universe both exclude a
-- profile soft-deleted before the as-of date; both are snapshots of who the
-- club IS. A cohort is not a snapshot - it is a fixed group of people fixed
-- at the moment they joined - and THE MOST CHURNED MEMBER OF ALL IS THE ONE
-- WHO DELETED THEIR ACCOUNT. Dropping them would compute every curve over
-- survivors only and bias every line upward, worst exactly where staff would
-- most want the truth. So `deleted_at` is not consulted: a member who joined
-- in March and deleted in May is in the March cohort for all twelve weeks and
-- simply stops being WCAM-qualifying. Stated as a deliberate departure from
-- COMM-310's denominator, because everything else in this cluster reuses it
-- term for term.
--
-- A REDEMPTION WITH NO PROFILE IS NOT COUNTED (the join to profiles is
-- inner). That is somebody who redeemed an invite and abandoned the flow
-- before creating a profile; counting them would make retention look worse
-- for a reason no other member count in this module recognises - every
-- member figure in the schema is profile + redemption. purge_abandoned_
-- profiles() (202609010004) cannot remove a cohort member either way: it only
-- deletes accounts with NO invite_redemptions row.
--
-- Known limitation, the same one recap_monthly_generate(), analytics_
-- dashboard() and member_segments() all record: grant_coach_role() UPDATEs
-- invite_redemptions.redeemed_at, so promoting an existing member to coach
-- re-dates their join and moves them into a later cohort. There is no
-- immutable joined_at in this schema to fall back on.
--
-- ---------------------------------------------------------------------------
-- THE WINDOW, AND WHY THE MONTH IN PROGRESS IS INCLUDED
-- ---------------------------------------------------------------------------
-- p_months cohort months ending with the current one, from the first instant
-- of that month. Clamped to 1..24 here as well as at the public boundary -
-- clamping twice is idempotent and this function is reachable from the two
-- correlations with a hardcoded value.
--
-- member_segments() deliberately excludes the ISO week in progress; this
-- function deliberately includes the calendar month in progress, and the
-- difference is not an inconsistency. There, a partial week was being
-- compared against a whole-week THRESHOLD, which cannot be done honestly.
-- Here there is no threshold: a member of this month's cohort contributes to
-- week k only once week k has actually finished, so a young cohort produces a
-- short line rather than a wrong one, and staff see week 1 for this month's
-- intake as soon as it means anything.
--
-- TIMEZONE. date_trunc('month', ...) and to_char() both resolve at the
-- calling session's TimeZone - UTC for PostgREST, the only caller - so a
-- member who joined within a few hours of a month boundary could fall in a
-- different cohort than the club's local calendar would say. The same
-- unresolved "week boundaries follow the club's local week, not UTC" gap
-- 202609010006 and 202609010007 both flagged, in its monthly form. Flagged,
-- not hidden, not fixed here: pinning a zone in this one file would make it
-- the third function in the module with a private opinion about local time.
create or replace function public.retention_member_weeks(p_months integer)
returns table (
  user_id uuid,
  redeemed_at timestamptz,
  cohort_month text,
  week_number integer,
  elapsed boolean,
  retained boolean)
language sql stable security definer set search_path = '' as $$
  -- Every number this function makes a decision with, in one place. See the
  -- header; the cohort-size floor is not among them because it is
  -- retention_min_cohort_size() and belongs to the callers.
  with tuning as (
    select 12     as curve_weeks,   -- COMM-313: "their first 12 weeks"
           604800 as week_secs,     -- 7 x 24 x 3600, a membership week
           least(greatest(coalesce(p_months, 6), 1), 24) as months
  ),
  bounds as (
    select t.curve_weeks,
           t.week_secs,
           now() as now_ts,
           date_trunc('month', now()) - make_interval(months => t.months - 1)
             as window_start
    from tuning t
  ),
  -- The cohort universe. No deleted_at filter, inner join to profiles; see
  -- "WHO IS IN A COHORT" in the header. invite_redemptions.user_id is that
  -- table's PRIMARY KEY, so this join cannot duplicate a member and "twelve
  -- rows per member" is structural rather than something to be careful about.
  cohort as (
    select ir.user_id as uid,
           ir.redeemed_at as joined_at,
           to_char(date_trunc('month', ir.redeemed_at), 'YYYY-MM') as month_key
    from public.invite_redemptions ir
    join public.profiles p on p.id = ir.user_id
    cross join bounds b
    where ir.redeemed_at >= b.window_start
      and ir.redeemed_at <  b.now_ts
  ),
  -- Twelve rows per member, whatever their tenure. `elapsed` is the honest
  -- half of the denominator: a member is counted in week k only once the
  -- whole of week k has passed, so "joined three weeks ago" never reads as
  -- "churned by week 4".
  member_weeks as (
    select c.uid,
           c.joined_at,
           c.month_key,
           w.n as wk,
           (c.joined_at + make_interval(secs => w.n * b.week_secs) <= b.now_ts)
             as is_elapsed
    from cohort c
    cross join bounds b
    cross join lateral generate_series(1, b.curve_weeks) w(n)
  ),
  -- One row per (member, membership week) in which that member did at least
  -- one WCAM-qualifying thing. The event list is analytics_wcam_events() and
  -- nothing else - there is no array of event names in this file. The week
  -- index is integer division of the elapsed seconds, which is exactly the
  -- same boundary the `is_elapsed` arithmetic above uses.
  active as (
    select distinct
           c.uid,
           (floor(extract(epoch from (e.created_at - c.joined_at)) / b.week_secs)::integer + 1) as wk
    from cohort c
    cross join bounds b
    join public.analytics_events e on e.user_id = c.uid
    where e.event_name = any(public.analytics_wcam_events())
      and e.created_at >= c.joined_at
      and e.created_at <  c.joined_at + make_interval(secs => b.curve_weeks * b.week_secs)
  )
  select mw.uid,
         mw.joined_at,
         mw.month_key,
         mw.wk,
         mw.is_elapsed,
         -- `retained` is only ever true on an elapsed week: the `active` CTE
         -- is bounded by the same twelve windows, and an event cannot land in
         -- a window that has not started.
         (a.uid is not null)
  from member_weeks mw
  left join active a on a.uid = mw.uid and a.wk = mw.wk;
$$;

-- Granted to NOBODY. Not authenticated, not anon, not public. See the header:
-- this is the only function in the file that carries a user_id, and the
-- three public wrappers are the only callers.
revoke all on function public.retention_member_weeks(integer) from public, anon, authenticated;

comment on function public.retention_member_weeks(integer) is
  'COMM-313 PRIVATE helper, granted to NO ROLE - the grant is the gate, as it is for analytics_breakdown(). The single definition of a "membership week" shared by retention_cohorts(), retention_onboarding_correlation() and retention_welcome_correlation(). Returns one row per (cohort member, week 1..12): {user_id, redeemed_at, cohort_month, week_number, elapsed, retained}. Twelve rows per member ALWAYS, so a caller can count the cohort (distinct user_id) and the week denominator (elapsed only) from one result set. A membership week is 7x24h from the join instant - NOT an ISO week - because COMM-313 asks for "their first 12 weeks of membership" and a cohort''s members join on different days; arithmetic is in seconds so DST cannot resize a week. WCAM comes from analytics_wcam_events() (202609010006); this file contains no second copy of the event list. COHORT = an invite_redemptions row in the window with a profile row; deleted_at is deliberately NOT consulted, because a member who deleted their account is the clearest churn there is and excluding them would bias every curve upward (a deliberate departure from COMM-310''s denominator, which every other function in this cluster reuses). A redemption with no profile is excluded. Window: p_months calendar months ending with the month in progress, clamped 1..24. SECURITY DEFINER for invite_redemptions (self-select only) and analytics_events (community.analytics.view only, which this cluster''s is_admin() gate does not imply). Carries no auth check of its own; its callers check auth.uid() and is_admin() before calling it. Read-only.';

-- ===========================================================================
-- 3. retention_cohorts(p_cohort_months) - the curve itself
-- ===========================================================================
-- One row per (cohort_month, week_number), exactly the four keys COMM-313's
-- "Client calls and contracts" names: {cohort_month, week_number,
-- retained_share, member_count}. A standard retention curve, not a single
-- number.
--
-- cohort_month is TEXT, either 'YYYY-MM' or the literal 'other'. A real month
-- key can never be the string 'other', so the two cannot be confused, and the
-- client renders one line per distinct value with 'other' sorted last.
--
-- ---------------------------------------------------------------------------
-- THE FLOOR IS APPLIED TWICE, AND THE SECOND ONE IS AN IMPLEMENTATION
-- DECISION THIS TICKET DOES NOT MAKE. READ THIS BEFORE BUILDING A CHART.
-- ---------------------------------------------------------------------------
-- 1. A COHORT MONTH with fewer than retention_min_cohort_size() members is
--    relabelled 'other' and pooled with every other small month. That is
--    COMM-313's rule, word for word, and the count it is tested against is
--    how many people JOINED that month - not how many have lived through
--    week 1 yet, which is why the helper returns non-elapsed weeks too.
--
-- 2. A (cohort, week) CELL whose denominator is below the same floor IS NOT
--    EMITTED AT ALL. The ticket only writes the first rule. This one follows
--    from its stated reason - "to avoid a curve built from 1-2 people" is
--    just as true of the twelfth point on a line as it is of the whole line -
--    and without it the rule would be trivially escapable: an eight-member
--    cohort in which only two members have reached week 9 would draw a
--    week-9 point off those two people, which is precisely the unstable
--    figure rule 1 exists to prevent.
--
--    IT TRUNCATES A LINE, IT NEVER PUNCHES A HOLE IN ONE. The week
--    denominator is monotonically non-increasing in week_number - a member
--    who has completed week k has completed every earlier week - so the
--    suppressed cells are always a suffix. A client can draw the rows it gets
--    in week order and will never need to bridge a gap. That is what makes
--    this safe to do server-side instead of shipping the raw cells and
--    trusting the chart to hide them.
--
--    THE COST, STATED: a cohort can return NO rows (nobody has finished week
--    1 yet, or it is a small month whose members are spread thin), and a
--    client that renders "no data" per cohort must handle that. To reverse,
--    delete the one `where r.member_count >= v_min` line; every cell then
--    ships with its own member_count and the decision moves to the client.
--
-- ---------------------------------------------------------------------------
-- p_cohort_months IS CLAMPED, NOT REFUSED
-- ---------------------------------------------------------------------------
-- COMM-313: "p_cohort_months clamps to 1..24." That is the opposite of
-- analytics_dashboard() and member_segments(), which both REFUSE an
-- out-of-range period rather than quietly adjusting it, and the ticket is
-- explicit, so it is followed. It is also safe here in a way it is not
-- there: every row carries its own cohort_month, so a caller who asked for 99
-- months can see exactly which months came back and cannot mistake a clamped
-- answer for the one they asked for. A null is treated as the default 6, the
-- same reading member_segments() gives a null p_as_of.
create or replace function public.retention_cohorts(p_cohort_months integer default 6)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_months integer;
  v_min integer := public.retention_min_cohort_size();
begin
  -- AUTH, before anything is read. auth.uid() first, then the permission -
  -- the same order every definer function in this schema uses. The permission
  -- is is_admin() ALONE, with no community.analytics.view alternative; see
  -- "THE GATE IS is_admin() ALONE" at the top of this file.
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_admin() then raise exception 'not authorized'; end if;

  v_months := least(greatest(coalesce(p_cohort_months, 6), 1), 24);

  return query
  with grid as (
    select mw.user_id, mw.cohort_month, mw.week_number, mw.elapsed, mw.retained
    from public.retention_member_weeks(v_months) mw
  ),
  -- How many people JOINED each month. Every member has exactly twelve rows,
  -- so the distinct count is the cohort, not the subset that has lived
  -- through a week.
  sizes as (
    select g.cohort_month as month_key, count(distinct g.user_id) as n
    from grid g
    group by g.cohort_month
  ),
  -- Rule 1: a month under the floor becomes 'other'.
  labelled as (
    select g.user_id,
           case when s.n >= v_min then g.cohort_month else 'other' end as bucket,
           g.week_number,
           g.elapsed,
           g.retained
    from grid g
    join sizes s on s.month_key = g.cohort_month
  ),
  -- One row per (bucket, week). `where l.elapsed` is the denominator rule: a
  -- week that has not finished for a member is not a week that member failed.
  rolled as (
    select l.bucket,
           l.week_number,
           count(*)::integer as member_count,
           count(*) filter (where l.retained)::integer as retained_count
    from labelled l
    where l.elapsed
    group by l.bucket, l.week_number
  )
  select jsonb_build_object(
    'cohort_month',   r.bucket,
    'week_number',    r.week_number,
    -- Four decimal places: enough that retained_count is recoverable as
    -- round(share * member_count) for any club this schema will ever hold,
    -- and not so many that a share reads as spurious precision.
    'retained_share', round(r.retained_count::numeric / r.member_count, 4),
    'member_count',   r.member_count)
  from rolled r
  -- Rule 2. Delete this line to ship every cell and move the decision to the
  -- client; see the header before doing so.
  where r.member_count >= v_min
  -- 'other' last, then chronological, then along each line. A boolean sorts
  -- false before true, so the named months come first.
  order by (r.bucket = 'other'), r.bucket, r.week_number;
end $$;

revoke all on function public.retention_cohorts(integer) from public, anon;
grant execute on function public.retention_cohorts(integer) to authenticated;

comment on function public.retention_cohorts(integer) is
  'COMM-313 cohort retention curve. Returns setof jsonb, one row per (cohort_month, week_number): {cohort_month, week_number, retained_share, member_count} - exactly the four keys the ticket''s contract names. Members are grouped by the month of invite_redemptions.redeemed_at and the row reports the share still WCAM-qualifying in each of their first 12 MEMBERSHIP weeks (7x24h from the join instant, not ISO weeks - a cohort''s members join on different days). AUTH: security definer; auth.uid() checked first, then is_admin() ALONE - deliberately NARROWER than analytics_dashboard() and member_segments(), which both also accept has_perm(''community.analytics.view''). A holder of that permission who is not an admin is refused here, per COMM-313''s "gated by real is_admin, matching COMM-312''s narrower bar". Raises ''not authorized'' (P0001). p_cohort_months is CLAMPED to 1..24 (null means 6), not refused - the ticket says clamp, and every row names its own cohort_month so a clamped answer cannot be mistaken for the one asked for. cohort_month is ''YYYY-MM'' or the literal ''other''. THE FLOOR, retention_min_cohort_size() = 5, is applied twice: a cohort month with fewer than 5 members is folded into ''other'' (COMM-313''s rule), and a (cohort, week) cell whose denominator is below 5 is not emitted at all (this implementation''s extension of the same reason; it always truncates the tail of a line, never gaps it, because the denominator is monotonic in week_number). A week counts for a member only once it has fully elapsed, so a young cohort gives a short line rather than a false one. Soft-deleted members REMAIN in their cohort - excluding them would compute retention over survivors only. NO MEMBER IS NAMED: no user_id, handle or display_name appears in the output, one step more aggregate than member_segments() on purpose. WCAM comes from analytics_wcam_events(). Read-only, no side effects.';

-- ===========================================================================
-- 4. retention_onboarding_correlation()
-- ===========================================================================
-- Cuts the same cohorts by whether each of the five onboarding_progress
-- stamps was EVER set, and reports the retention curve for each side of that
-- cut. One row per (step, stamped, week_number).
--
-- All five steps, named by their column: welcomed_at, first_week_shown_at,
-- first_month_shown_at (COMM-222, 202608290011) and first_class_shown_at,
-- third_class_shown_at (COMM-316, 202609010003). The step key IS the column
-- name, so a reader can go straight to the column comment that defines when
-- it is stamped, and a sixth step added later needs one line here.
--
-- NO PARAMETER, so the window is the same default 6 months
-- retention_cohorts() uses. That is the signature COMM-313 asks for.
--
-- POOLED ACROSS COHORT MONTHS, deliberately. Splitting by month as well would
-- give 5 steps x 2 groups x 12 weeks x 6 months = 720 cells over the same
-- members, nearly all of them under the floor and therefore suppressed,
-- which would turn a real signal into an empty grid. The cut this ticket asks
-- for is "did members who saw the step retain differently", and that is a
-- question about the whole window.
--
-- A STEP NOBODY HAS EVER BEEN STAMPED WITH RETURNS ONLY ITS `false` GROUP
-- rather than an empty pair or a zero row. That is the expected state of both
-- COMM-316 columns immediately after deploy - 202609010003 does not backfill
-- them - and a client must not read a missing `stamped: true` group as "the
-- step is bad for retention".
--
-- ON NAMING: the boolean is `stamped`, which is a fact about the row in
-- onboarding_progress, not `saw`, `completed` or `onboarded`, which are
-- claims about the member. Two curves are returned and no difference between
-- them is computed here; see "CORRELATION, NOT CAUSATION" at the top of this
-- file for why that is a schema-half concern and not only a copy one.
create or replace function public.retention_onboarding_correlation()
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  -- The same window retention_cohorts() defaults to. Written here as a named
  -- constant because this function takes no parameter - COMM-313's contract
  -- gives it none - and a client therefore cannot move it.
  c_cohort_months constant integer := 6;
  v_uid uuid;
  v_min integer := public.retention_min_cohort_size();
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_admin() then raise exception 'not authorized'; end if;

  return query
  with grid as (
    select mw.user_id, mw.week_number, mw.elapsed, mw.retained
    from public.retention_member_weeks(c_cohort_months) mw
  ),
  -- Five (step, stamped) pairs per member-week. A LEFT JOIN because a member
  -- with no onboarding_progress row at all reads as not-stamped on every
  -- step, which is the correct answer: `x is not null` on a null row is
  -- false. (The seeding trigger on invite_redemptions gives every member a
  -- row from 202608290011 onward, so this is defensive rather than common.)
  cut as (
    select g.user_id, g.week_number, g.elapsed, g.retained, s.step, s.stamped
    from grid g
    left join public.onboarding_progress op on op.user_id = g.user_id
    cross join lateral (values
      ('welcomed_at',          (op.welcomed_at is not null)),
      ('first_week_shown_at',  (op.first_week_shown_at is not null)),
      ('first_month_shown_at', (op.first_month_shown_at is not null)),
      ('first_class_shown_at', (op.first_class_shown_at is not null)),
      ('third_class_shown_at', (op.third_class_shown_at is not null))
    ) s(step, stamped)
  ),
  rolled as (
    select c.step,
           c.stamped,
           c.week_number,
           count(*)::integer as member_count,
           count(*) filter (where c.retained)::integer as retained_count
    from cut c
    where c.elapsed
    group by c.step, c.stamped, c.week_number
  )
  select jsonb_build_object(
    'step',           r.step,
    'stamped',        r.stamped,
    'week_number',    r.week_number,
    'retained_share', round(r.retained_count::numeric / r.member_count, 4),
    'member_count',   r.member_count)
  from rolled r
  -- The same floor, for the same reason: a two-curve comparison in which one
  -- curve is three people is not a comparison.
  where r.member_count >= v_min
  order by r.step, r.stamped desc, r.week_number;
end $$;

revoke all on function public.retention_onboarding_correlation() from public, anon;
grant execute on function public.retention_onboarding_correlation() to authenticated;

comment on function public.retention_onboarding_correlation() is
  'COMM-313 onboarding correlation. Returns setof jsonb, one row per (step, stamped, week_number): {step, stamped, week_number, retained_share, member_count}. Cuts the same cohorts retention_cohorts() draws - the last 6 months, POOLED across cohort months - by whether each of the five onboarding_progress stamps was EVER set, and reports the 12-week membership retention curve for each side. `step` is the literal column name: welcomed_at, first_week_shown_at, first_month_shown_at (COMM-222), first_class_shown_at, third_class_shown_at (COMM-316). `stamped` is a fact about the row, not a claim about the member. AUTH: security definer; auth.uid() first, then is_admin() ALONE, the same narrower gate as retention_cohorts(); raises ''not authorized'' (P0001). No parameter, so the 6-month window is a named constant a client cannot move. Any (step, group, week) cell under retention_min_cohort_size() = 5 members is not emitted, so a step nobody has been stamped with returns ONLY its `stamped: false` group - the expected state of both COMM-316 columns right after deploy, since 202609010003 does not backfill them, and NOT evidence that the step hurts retention. THIS IS A CORRELATION. Two independent curves are returned and no difference between them is computed; there is no effect/impact/lift key anywhere. A step is stamped only when the client RENDERS it, which requires the member to open the app, so exposure is downstream of the very engagement the curve measures and any gap is an upper bound on anything causal. NO MEMBER IS NAMED anywhere in the output. Read-only, no side effects.';

-- ===========================================================================
-- 5. retention_welcome_correlation()
-- ===========================================================================
-- The third cut COMM-313 asks for: did a member receive a coach Welcome in
-- their first two weeks, and how do the two curves compare. One row per
-- (contacted, week_number).
--
-- WHAT "A COACH WELCOME" IS, AND THE GAP THIS HAS TO ADMIT.
-- member_contact_log (202608290013, COMM-224) has no kind, type or template
-- column - it is `{user_id, contacted_by, contacted_at, note}`, one row per
-- coach outreach of any sort. There is therefore NO WAY IN THIS SCHEMA TO
-- TELL A WELCOME FROM ANY OTHER CONTACT, and the fourteen-day window is
-- doing all the work: "contacted at all within two weeks of joining" is the
-- available proxy for "welcomed". It is a good proxy - COMM-224's own framing
-- of the log is coaches coordinating so that "nobody welcomes the same new
-- member twice and nobody is missed" - but it is a proxy, and a coach who
-- logs a scheduling note on day three is counted as a Welcome. Recorded in
-- contracts.md as well; if this ever needs to be exact, the fix is a `kind`
-- column on member_contact_log, not a heuristic on the note text.
--
-- THE WINDOW IS [joined_at, joined_at + 14 days), half-open, in the same
-- seconds arithmetic the membership weeks use. A contact at the join instant
-- counts; one at exactly fourteen days does not. Contacts before the join
-- instant are excluded by construction and by the bound - member_contact_log
-- keys to profiles, which cannot exist before the redemption.
--
-- THE OVERLAP IS DELIBERATE AND MUST BE READ. The exposure window covers
-- membership weeks 1 and 2, so the first two points of the two curves are
-- partly contemporaneous with the thing being correlated, not downstream of
-- it. The curve is left whole rather than starting at week 3 so that both
-- cuts and the main chart share one x-axis; the caveat belongs in the copy.
-- And the selection problem is the same one the onboarding cut has, in a
-- weaker form: coaches notice and contact the members who are around to be
-- noticed.
create or replace function public.retention_welcome_correlation()
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c_cohort_months constant integer := 6;
  -- COMM-313: "in their first two weeks".
  c_welcome_window_secs constant integer := 14 * 86400;
  v_uid uuid;
  v_min integer := public.retention_min_cohort_size();
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_admin() then raise exception 'not authorized'; end if;

  return query
  with grid as (
    select mw.user_id, mw.redeemed_at, mw.week_number, mw.elapsed, mw.retained
    from public.retention_member_weeks(c_cohort_months) mw
  ),
  -- One row per member, not per member-week, so the contact log is scanned
  -- once per member rather than twelve times.
  members as (
    select distinct g.user_id as uid, g.redeemed_at as joined_at
    from grid g
  ),
  welcomed as (
    select distinct m.uid
    from members m
    join public.member_contact_log l on l.user_id = m.uid
    where l.contacted_at >= m.joined_at
      and l.contacted_at <  m.joined_at + make_interval(secs => c_welcome_window_secs)
  ),
  cut as (
    select g.week_number, g.elapsed, g.retained, (w.uid is not null) as contacted
    from grid g
    left join welcomed w on w.uid = g.user_id
  ),
  rolled as (
    select c.contacted,
           c.week_number,
           count(*)::integer as member_count,
           count(*) filter (where c.retained)::integer as retained_count
    from cut c
    where c.elapsed
    group by c.contacted, c.week_number
  )
  select jsonb_build_object(
    'contacted',      r.contacted,
    'week_number',    r.week_number,
    'retained_share', round(r.retained_count::numeric / r.member_count, 4),
    'member_count',   r.member_count)
  from rolled r
  where r.member_count >= v_min
  order by r.contacted desc, r.week_number;
end $$;

revoke all on function public.retention_welcome_correlation() from public, anon;
grant execute on function public.retention_welcome_correlation() to authenticated;

comment on function public.retention_welcome_correlation() is
  'COMM-313 coach-Welcome correlation. Returns setof jsonb, one row per (contacted, week_number): {contacted, week_number, retained_share, member_count}. Cuts the same 6-month cohort window, pooled across months, by whether the member has a member_contact_log row (COMM-224, 202608290013) in the half-open window [redeemed_at, redeemed_at + 14 days), and reports the 12-week membership retention curve for each side. AUTH: security definer; auth.uid() first, then is_admin() ALONE, the same narrower gate as retention_cohorts(); raises ''not authorized'' (P0001). No parameter: both the 6-month window and the 14-day Welcome window are named constants a client cannot move. Cells under retention_min_cohort_size() = 5 members are not emitted. KNOWN PROXY: member_contact_log has no kind/type column, so a Welcome cannot be distinguished from any other coach outreach - "contacted at all within two weeks of joining" is what `contacted` actually means, and a scheduling note on day three counts. The fix, if it ever needs to be exact, is a kind column on that table, not a heuristic here. THE EXPOSURE WINDOW OVERLAPS MEMBERSHIP WEEKS 1 AND 2 of the curve it is cut against, deliberately, so both cuts and the main chart share one x-axis; that caveat belongs in the surface''s copy. THIS IS A CORRELATION: two independent curves, no difference computed, no effect/impact/lift key - and coaches contact the members who are around to be noticed. NO MEMBER IS NAMED anywhere in the output. Read-only, no side effects.';

commit;
