begin;

-- COMM-311, schema half. Member engagement segmentation: one definer
-- function that puts every club member into exactly one named bucket, so
-- staff can act on a segment instead of scrolling one undifferentiated
-- member list.
--
-- WHAT IS AND IS NOT HERE
--
-- No new table, no new policy, no policy edited, no grant changed on any
-- existing table. Nothing is materialised - the segmentation is computed
-- live on every call from three sources that already exist:
--
--   analytics_events      WCAM-qualifying activity, ALWAYS through
--                         public.analytics_wcam_events() (202609010006).
--   invite_redemptions    tenure, this module's authoritative MEMBER_JOINED
--                         stamp (202608290011), the same source COMM-309's
--                         recap_monthly_generate() and COMM-310's WCAM-share
--                         denominator both use.
--   coach_engagement_flags  the `declining` signal (COMM-304, 202608310008).
--
-- THE WCAM LIST IS NOT REPEATED HERE, and that is the single most important
-- line in this file. 202609010006 wrote analytics_wcam_events() precisely so
-- that COMM-311, COMM-312 and COMM-313 could not each grow their own copy of
-- the 15 qualifying event names and quietly disagree about who was active.
-- This function calls it. There is no array literal of event names below.
--
-- No client half is built here. The dashboard shell, the segment cards and
-- the drill-down are the client half of this ticket and land separately, the
-- same two-phase split every cluster in Phase 2 and Phase 3 has used.

-- ===========================================================================
-- member_segments(p_as_of date default current_date) returns setof jsonb
-- ===========================================================================
-- One row per member, `{user_id, display_name, handle, segment}`, exactly the
-- shape COMM-311's "Client calls and contracts" names.
--
-- ---------------------------------------------------------------------------
-- AUTH
-- ---------------------------------------------------------------------------
-- security definer; auth.uid() first, then `has_perm('community.analytics
-- .view') or is_admin()`. Same pair, in the same order, as
-- analytics_dashboard() (202609010006) and recap_monthly_publish()
-- (202609010002).
--
-- Note what this is NOT: it is not is_staff(). A coach holds is_staff() and
-- does not hold community.analytics.view (202608280001 seeds it to admin and
-- owner only), so A COACH IS REFUSED, exactly as they are refused
-- analytics_dashboard(). That is narrower than coach_celebrate_feed() on
-- purpose and it is what makes COMM-311's fourth acceptance criterion -
-- "segmentation never exposes a `declining` label to the member it
-- describes" - true END TO END rather than only in the UI: there is no
-- member-facing version of this function at all, and a plain member holds
-- neither the permission nor is_admin(), so a member cannot learn their own
-- segment by calling it. 0051 asserts that on a member who really does carry
-- an open flag.
--
-- WHY DEFINER. Three boundaries, each of which would otherwise silently
-- return the caller's own slice and label it the club's:
--
--   * invite_redemptions is SELF-SELECT ONLY (202608270003:
--     invite_redemptions_self_select is `user_id = auth.uid()`). Without
--     definer rights the member universe would be one row - the caller.
--   * analytics_events' select policy is a community.analytics.view holder
--     (202608280012). Every legitimate caller of this function already
--     satisfies that, so this crosses nothing an admin could not read; it is
--     definer for the OTHER two.
--   * coach_engagement_flags carries `user_id <> auth.uid()` on all four of
--     its policies (202608280011). Definer rights step past that - which is
--     why the self-exclusion is re-applied by hand below rather than relied
--     on from the policy. See "THE SELF-FLAG RULE".
--
-- ---------------------------------------------------------------------------
-- THE MEMBER UNIVERSE, and what "as of" means
-- ---------------------------------------------------------------------------
-- A member is a profile with an invite_redemptions row, redeemed before the
-- end of p_as_of, on a profile not soft-deleted before the end of p_as_of.
-- That is COMM-310's WCAM-share denominator, term for term, and it is reused
-- rather than restated so the segment counts and the dashboard's club_members
-- figure can never disagree about who the club is.
--
-- invite_redemptions.user_id is the PRIMARY KEY of that table, so the join
-- cannot duplicate a member. That is what makes "exactly one segment per
-- member" a structural property here and not something the query has to be
-- careful about.
--
-- Staff are members too. A coach, an admin and the owner all hold an
-- invite_redemptions row and all appear in the output with a segment, the
-- same way they are all inside COMM-310's club_members denominator.
--
-- Known limitation, the same one recap_monthly_generate() and
-- analytics_dashboard() both record: grant_coach_role() UPDATEs
-- invite_redemptions.redeemed_at, so promoting an existing member to coach
-- re-dates their join and can put a long-standing member back into `new` for
-- 30 days. There is no immutable joined_at in this schema to fall back on.
--
-- ---------------------------------------------------------------------------
-- THE WEEK GRID: the last 8 COMPLETE ISO weeks, never the one in progress
-- ---------------------------------------------------------------------------
-- "WCAM-qualifying in each of the last 4 weeks" and "in at least half of the
-- last 8 weeks" are both statements about WEEKS, and WCAM is defined by the
-- ISO week (metrics.md, spec section 78). So the window is an ISO-week grid
-- and not a rolling count of days.
--
-- The grid ENDS at the Monday of p_as_of's own ISO week, exclusive. The week
-- p_as_of falls in is IN PROGRESS and is deliberately excluded from both
-- windows. Including it would mean a member is judged on a week that has not
-- happened yet: run on a Monday morning, every member in the club would have
-- failed to be active "this week" and `highly_active` would be unreachable
-- for six days out of seven. Every week this function counts is a whole one.
--
-- This is the same choice analytics_week_buckets() makes visible with its
-- is_partial flag, resolved here in the only direction a THRESHOLD can be
-- resolved: a partial week cannot be compared against a whole-week bar, so it
-- is not compared at all.
--
-- TIMEZONE. date_trunc('week', ...) is Monday-based and resolves at the
-- calling session's TimeZone - UTC for PostgREST, the only caller. Same UTC
-- ISO week analytics_dashboard(), recap_weekly and recap_monthly_generate()
-- all compute in, and the same gap against metrics.md's "week boundaries
-- follow the club's local week, not UTC" that 202609010006 flagged. Pinning a
-- zone here would make this the second function in the module with a private
-- opinion about the club's local time. Flagged, not hidden, not fixed here.
--
-- ---------------------------------------------------------------------------
-- THE SEGMENTS, AND THE PRECEDENCE BETWEEN THEM
-- ---------------------------------------------------------------------------
-- COMM-311 names five buckets and lists them in the order new,
-- highly_active, steady, declining, dormant. It does NOT state what happens
-- to a member who matches more than one, and the buckets as written overlap
-- in at least three ways. It also does not cover every member. Both gaps are
-- closed here, explicitly, and both decisions are reversible in the single
-- CASE expression at the bottom of this function.
--
-- THE ORDER APPLIED IS:  new > declining > highly_active > steady >
--                        occasional > dormant
--
-- 1. `new` FIRST, ABOVE EVERYTHING.
--    A member inside their first 30 days has at most four complete weeks of
--    history, and usually fewer. Every other bucket is a judgement about a
--    pattern; a member who joined nine days ago has no pattern yet, only a
--    short record. Two overlaps this settles:
--
--      * new vs dormant. A member who joined yesterday and has done nothing
--        has zero WCAM weeks in the last 8 and is literally `dormant` by the
--        letter of the definition. Calling them dormant is the single worst
--        false positive this function could produce - it is the same error
--        coach_detect_engagement_decline() refuses to make with its
--        no-baseline-no-flag rule, and for the same reason.
--      * new vs highly_active/steady. A member who joined 29 days ago CAN
--        have been active in each of the last 4 complete weeks, so this is a
--        real overlap and not a theoretical one. `new` still wins, because
--        the action a club takes on a member in their first month is
--        onboarding either way, and "highly active" would route them away
--        from it.
--
-- 2. `declining` ABOVE `highly_active` AND `steady`.
--    THIS IS THE DECISION THAT DEPARTS FROM THE ORDER THE ACCEPTANCE
--    CRITERIA LIST THE BUCKETS IN, so it gets the most words. That list is an
--    enumeration of definitions, not a stated precedence - the ticket says
--    nothing about precedence at all - and read as a precedence it produces a
--    result the feature cannot want. Three reasons:
--
--      a. THE TWO SIGNALS MEASURE DIFFERENT THINGS. An open
--         coach_engagement_flags row is derived from attendance_log - a
--         member's verified, physical training rate against their own
--         8-week baseline (202608310008). WCAM is app engagement, and the
--         qualifying list includes post_opened, profile_opened and
--         notification_opened. So a member who has stopped coming to the gym
--         but still opens a notification once a week is `highly_active` by
--         the WCAM test and is, in the only sense a club cares about, the
--         most urgent outreach target in the building. Letting `highly_
--         active` outrank `declining` would hide exactly that member, and
--         they are the reason this segmentation exists.
--      b. A WEAK SIGNAL MUST NOT OVERRIDE A STRONG ONE. `highly_active` can
--         be earned by opening four notifications in four different weeks.
--         `declining` is a ratio computed against a member's own baseline,
--         with a floor under it, and it survived every one of COMM-304's
--         suppression rules. It is a much more specific claim about a person.
--      c. `declining` IS A STAFF-OWNED, STAFF-RESOLVABLE STATE, so this
--         precedence traps nobody. The flag leaves `open` the moment a coach
--         reviews or dismisses it, and the member moves to whatever bucket
--         their activity says. If the reverse order were used, the
--         `declining` segment would be a strict subset of the open flags with
--         no visible explanation of the gap, and a coach comparing the
--         Engage section's count against the segment card would find two
--         different numbers for the same thing.
--
--    THE COST, STATED HONESTLY: a flag that no coach ever triages keeps a
--    member in `declining` indefinitely, even if their attendance recovered
--    weeks ago. coach_detect_engagement_decline() does not auto-close a flag
--    on recovery - it only updates one that still qualifies - so the flag can
--    be stale in exactly that way. That is a real downside and it is accepted
--    on the grounds of (c): the cure is the dismiss button COMM-304 already
--    shipped the write path for, and an untriaged flag is itself something
--    staff should be seeing.
--
-- 3. `declining` ABOVE `dormant` too, which is the easy half of the same
--    decision. Both describe a member who is drifting; `declining` carries a
--    level, two rates and a flagged_at, and `dormant` is the bucket for a
--    member about whom nothing else is known. More information wins.
--
-- 4. `highly_active` ABOVE `steady`, which is not a judgement call: every
--    member active in each of the last 4 weeks is by construction active in
--    at least 4 of the last 8, so `steady` is a superset and the stricter
--    test has to be asked first or `highly_active` would be unreachable.
--
-- 5. `occasional` - A SIXTH BUCKET, ADDED HERE, NOT IN THE TICKET.
--    The five buckets COMM-311 names ARE NOT EXHAUSTIVE, and the first
--    acceptance criterion requires that they be: a member with WCAM activity
--    in 1, 2 or 3 of the last 8 weeks, no open flag and more than 30 days of
--    tenure is not `new`, not `highly_active` (needs 4 of the last 4), not
--    `steady` (needs 4 of 8), not `declining` and NOT `dormant` either -
--    dormant is defined as NO qualifying activity in the last 8 weeks, and
--    this member has some. On a real club roster that hole is not an edge
--    case; it is one of the larger groups.
--
--    Two ways to close it, and this file takes the second:
--
--      * Widen `dormant` to "everything left over". Keeps the bucket set at
--        five and makes the word `dormant` false for a member who trained
--        three weeks out of the last eight. A staff member acting on a
--        segment named "dormant" would be writing win-back messages to
--        people who were in the gym last Tuesday.
--      * Name the residual. `occasional` is true about the member, keeps
--        every other label true, and satisfies "exactly one segment" without
--        stretching any existing definition.
--
--    This does NOT reshape the output - COMM-311 explicitly allows the bucket
--    set and its thresholds to be tuned later "without a reshaped output",
--    and `segment` is a text value in a jsonb object either way. It IS a
--    product decision made by this implementation rather than by the ticket,
--    and it is the one thing in this file most worth a second opinion. To
--    reverse it, delete one line of the CASE below; `occasional` members then
--    fall through to `dormant`.
--
-- 6. `dormant` LAST, as the true residual: no qualifying activity at all in
--    the last 8 complete weeks, and not new, and not flagged.
--
-- ---------------------------------------------------------------------------
-- THE SELF-FLAG RULE: nobody learns their own `declining` label, ever
-- ---------------------------------------------------------------------------
-- coach_engagement_flags carries `user_id <> auth.uid()` on all four of its
-- policies, and 202608280011 is explicit that this covers "a member who is
-- themselves a coach, an admin or the owner". This function is SECURITY
-- DEFINER and therefore reads that table past its policies, so the rule is
-- re-applied by hand in the `flagged` CTE below.
--
-- The consequence, stated because it is the one viewer-relative thing in an
-- otherwise viewer-independent answer: THE CALLER'S OWN ROW MAY READ
-- DIFFERENTLY FROM THE SAME ROW SEEN BY ANOTHER ADMIN. An admin with an open
-- flag sees themselves as whatever their activity says - `dormant`,
-- `steady`, whatever - and a second admin looking at the same club sees them
-- as `declining`. That is not a bug and it is not an inconsistency to be
-- ironed out later; it is the table's own guarantee, held one level up. Note
-- the row is NOT dropped: the caller still appears exactly once, so the
-- segment counts still add up to the club.
--
-- The flag is also required to have been raised on or before p_as_of, so a
-- flag created after the as-of date does not appear in a historical run. Its
-- OPEN-NESS, though, is a fact about NOW and not about p_as_of - there is no
-- status history on that table to reconstruct - which is the same asymmetry
-- analytics_dashboard() records for moderation_load.queue.open_now.
--
-- ---------------------------------------------------------------------------
-- visible_to_club ON THE DRILL-DOWN
-- ---------------------------------------------------------------------------
-- COMM-311 is the one place in this cluster where individual attribution is
-- intentional: acting on a segment means knowing who is in it. It must still
-- respect visible_to_club "the same way any other staff-facing member list
-- already does". The existing precedents were read rather than assumed, and
-- they do not all agree:
--
--   coach_inactive_members() / coach_new_members() (202608270005) - is_staff()
--     and NO visible_to_club filter at all. Phase 0, predates the toggle
--     (202608280003 added the column). Not a precedent, just older.
--   admin_search_members() (202608270011) - admin-only, no filter. Same.
--   coach_celebrate_feed() (202608290013) - is_staff(), and
--     can_view_profile_field(subject, 'visible_to_club') per branch.
--   member_of_week_candidate_set() (202609010001) - can_view_profile_field AND
--     the RAW profiles.visible_to_club column, with a comment saying exactly
--     why both: "can_view_profile_field short-circuits to true for an admin,
--     and an admin's rank governs what they may see, never what the club may
--     be told."
--
-- THIS FUNCTION USES THE RAW COLUMN, matching member_of_week_candidate_set()'s
-- half of that pattern and NOT can_view_profile_field(). Deliberately, for
-- two reasons that are specific to this function's permission gate:
--
--   1. can_view_profile_field() WOULD BE A NO-OP HERE. It returns true for
--      any caller that passes is_admin() before it ever reads the target's
--      toggle. This function's gate is `community.analytics.view or
--      is_admin()`, and 202608280001 seeds that permission to admin and owner
--      only - so essentially every legitimate caller short-circuits it and
--      the acceptance criterion would be satisfied on paper and by nothing at
--      runtime.
--   2. IT WOULD MAKE THE ROSTER VIEWER-DEPENDENT in a way that breaks the
--      first acceptance criterion. can_view_profile_field() returns false
--      across a block edge in either direction, so an admin who has blocked
--      one member would get a segmentation of the club with that member
--      missing and every segment count one short - a club-wide statistic
--      silently altered by a personal block.
--
-- WHAT IT DOES INSTEAD: a member with visible_to_club = false is RETURNED,
-- with their segment, and with user_id, display_name AND handle all null.
-- That is the only reading that satisfies both criteria at once:
--
--   * "every member is assigned to exactly one segment" - the row is there,
--     so the segment COUNTS on the dashboard cards are the whole club and a
--     hidden member is not quietly deducted from the denominator;
--   * "the drill-down lists members by name, respecting visible_to_club" -
--     the row carries no name, no handle and no id, so the drill-down list
--     cannot attribute it to anybody. Dropping the id as well as the name
--     matters: a bare uuid is still an identifier a staff screen could join
--     against.
--
-- The rule is applied UNIFORMLY and viewer-independently - it is a fact about
-- the member, not about who is asking - which means the caller's own row is
-- redacted too if the caller has hidden themselves. Harmless (they know who
-- they are) and worth the consistency: two admins running this on the same
-- day get byte-identical output except for their own `declining` label.
--
-- ---------------------------------------------------------------------------
-- THRESHOLDS ARE NAMED CONSTANTS, NOT CLIENT PARAMETERS
-- ---------------------------------------------------------------------------
-- COMM-311: "Segment thresholds are named constants in the function, not
-- client parameters." Same style, and the same reasoning, as COMM-304's
-- tuning-constants block: every number this function makes a decision with is
-- declared in one place at the top, none of them is reachable from a client,
-- and a tuning pass is a migration. p_as_of is the only input, and it moves
-- the window rather than changing any bar.
create or replace function public.member_segments(p_as_of date default current_date)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  -- =====================================================================
  -- TUNING CONSTANTS. Every threshold, in one place. See the header.
  -- =====================================================================

  -- `new` - how long a member is still new. 30 days, from COMM-311. Read as
  -- "inside their first 30 days": the join day is day 1 and day 30 is the
  -- last day a member is new, so a member who joined exactly 30 days ago is
  -- not.
  c_new_member_days constant integer := 30;

  -- `highly_active` - qualifying in EACH of the last N complete weeks. All
  -- four, not three of four: the bucket's whole meaning is "without a gap".
  c_highly_active_weeks constant integer := 4;

  -- `steady` / `dormant` - the long window both are measured over.
  c_activity_window_weeks constant integer := 8;

  -- `steady` - "at least half of the last 8 weeks". Written as its own
  -- constant rather than as c_activity_window_weeks / 2 so that a later
  -- tuning pass can move the bar without also moving the window, which are
  -- two different product questions.
  c_steady_min_weeks constant integer := 4;

  -- =====================================================================

  v_uid uuid;
  v_as_of date;

  -- Exclusive end of the as-of DAY. p_as_of is inclusive of itself, the same
  -- convention analytics_dashboard()'s p_period_end carries.
  v_to timestamptz;

  -- A member redeemed at or after this instant is still `new`.
  v_new_cutoff timestamptz;

  -- The ISO-week grid. v_grid_end is the Monday of p_as_of's own week and is
  -- the EXCLUSIVE upper bound of both windows - the week in progress is never
  -- counted. See "THE WEEK GRID" in the header.
  v_grid_end date;
  v_window_start date;
  v_recent_start date;
begin
  -- ---------------------------------------------------------------------
  -- AUTH, before anything is read.
  -- ---------------------------------------------------------------------
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.analytics.view') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  -- A null p_as_of means the same thing as omitting it. Unlike
  -- analytics_dashboard()'s two bounds, which are both required and raise,
  -- this parameter HAS a sensible default in its own signature, so treating
  -- an explicit null as that default is the same reading member_of_week_
  -- suggest() and recap_weekly_classmates() already give a null week.
  v_as_of := coalesce(p_as_of, current_date);

  -- A FUTURE as-of date is refused rather than clamped, for the reason
  -- analytics_dashboard() refuses a bad period rather than shortening it: a
  -- clamped date would put a segmentation on screen labelled with a date it
  -- was not computed for, and nobody could tell from the output. There is no
  -- lookback cap to go with it - the window is a fixed 8 weeks whatever
  -- p_as_of is, so an old date costs the same as today's.
  if v_as_of > current_date then
    raise exception 'as-of date is in the future';
  end if;

  v_to           := (v_as_of + 1)::timestamptz;
  v_new_cutoff   := v_to - make_interval(days => c_new_member_days);
  v_grid_end     := date_trunc('week', v_as_of::timestamp)::date;
  v_window_start := v_grid_end - (c_activity_window_weeks * 7);
  v_recent_start := v_grid_end - (c_highly_active_weeks * 7);

  return query
  -- The club, as of p_as_of. COMM-310's WCAM-share denominator, term for
  -- term. invite_redemptions.user_id is that table's primary key, so this
  -- join cannot produce a second row for anybody.
  with members as (
    select p.id, p.handle, p.display_name, p.visible_to_club, ir.redeemed_at
    from public.profiles p
    join public.invite_redemptions ir on ir.user_id = p.id
    where ir.redeemed_at < v_to
      and (p.deleted_at is null or p.deleted_at >= v_to)
  ),
  -- One row per (member, ISO week) in which that member did at least one
  -- WCAM-qualifying thing. The event list is analytics_wcam_events() and
  -- nothing else; see the header. `user_id is not null` because
  -- analytics_events legitimately carries pre-profile rows (202608280012),
  -- and the bounds are the whole-week grid.
  active_weeks as (
    select e.user_id, date_trunc('week', e.created_at)::date as wk
    from public.analytics_events e
    where e.event_name = any(public.analytics_wcam_events())
      and e.created_at >= v_window_start::timestamptz
      and e.created_at <  v_grid_end::timestamptz
      and e.user_id is not null
    group by 1, 2
  ),
  -- Both counts come out of ONE pass over the same week rows, so the 4-week
  -- test and the 8-week test can never be computed off different sets.
  week_counts as (
    select aw.user_id,
           count(*)::integer as weeks_active,
           count(*) filter (where aw.wk >= v_recent_start)::integer as recent_weeks_active
    from active_weeks aw
    group by 1
  ),
  -- The `declining` signal. Open flags only - a reviewed or dismissed flag is
  -- a conversation that already happened. Raised on or before p_as_of.
  -- `user_id <> v_uid` is coach_engagement_flags' own rule, re-applied by
  -- hand because definer rights have already stepped past the policy that
  -- carries it. See "THE SELF-FLAG RULE".
  flagged as (
    select distinct f.user_id
    from public.coach_engagement_flags f
    where f.status = 'open'
      and f.flagged_at < v_to
      and f.user_id <> v_uid
  ),
  -- ONE CASE, TOP TO BOTTOM, and the order of its branches IS the precedence
  -- decision documented in the header. Every member falls into exactly one
  -- branch and the final `else` guarantees there is no sixth outcome.
  segmented as (
    select
      m.id,
      m.handle,
      m.display_name,
      m.visible_to_club,
      case
        when m.redeemed_at >= v_new_cutoff                                then 'new'
        when fl.user_id is not null                                       then 'declining'
        when coalesce(wc.recent_weeks_active, 0) >= c_highly_active_weeks then 'highly_active'
        when coalesce(wc.weeks_active, 0) >= c_steady_min_weeks           then 'steady'
        when coalesce(wc.weeks_active, 0) > 0                             then 'occasional'
        else                                                                   'dormant'
      end as segment
    from members m
    left join week_counts wc on wc.user_id = m.id
    left join flagged fl on fl.user_id = m.id
  )
  select jsonb_build_object(
    -- The three identifying fields are nulled together, never separately: a
    -- row that carried a uuid but no name would still be attributable.
    'user_id',      case when s.visible_to_club then s.id end,
    'display_name', case when s.visible_to_club
                         then coalesce(nullif(s.display_name, ''), s.handle) end,
    'handle',       case when s.visible_to_club then s.handle end,
    'segment',      s.segment)
  from segmented s
  -- Grouped by segment so a client can render cards without re-sorting, then
  -- by name inside each. Redacted rows sort last within their segment on
  -- their id rather than on the display name they are not allowed to expose -
  -- otherwise a hidden member's position in an alphabetical list would leak
  -- the first letter of the name that was just withheld.
  order by
    s.segment,
    case when s.visible_to_club
         then coalesce(nullif(s.display_name, ''), s.handle) end nulls last,
    s.id;
end $$;

revoke all on function public.member_segments(date) from public, anon;
grant execute on function public.member_segments(date) to authenticated;

comment on function public.member_segments(date) is
  'COMM-311 member engagement segmentation. Returns setof jsonb, ONE ROW PER CLUB MEMBER, {user_id, display_name, handle, segment}. AUTH: security definer; auth.uid() checked first, then `has_perm(''community.analytics.view'') or is_admin()` - NOT is_staff(), so a coach is refused, exactly as analytics_dashboard() refuses one. There is no member-facing version, which is how COMM-311''s "never expose a declining label to the member it describes" is enforced end to end: a plain member holds neither the permission nor is_admin() and cannot call this at all. Raises ''not authorized'' and ''as-of date is in the future'' (both P0001); a null p_as_of means current_date. SEGMENTS, in strict precedence order: new (redeemed within 30 days of p_as_of) > declining (an open coach_engagement_flags row raised on or before p_as_of) > highly_active (WCAM-qualifying in EACH of the last 4 complete ISO weeks) > steady (in at least 4 of the last 8) > occasional (in 1 to 3 of the last 8) > dormant (in none). `occasional` is a SIXTH bucket this implementation added because COMM-311''s five are not exhaustive and its first criterion requires that they be; delete one CASE line to fold it back into dormant. `declining` deliberately outranks highly_active and steady: the flag is verified attendance decline and WCAM is app engagement, so a member who stopped training but still opens notifications must not be hidden behind highly_active. WINDOW: the last 8 COMPLETE Monday-based ISO weeks before p_as_of''s own week - the week in progress is never counted, so a member is never judged on a week that has not happened. WCAM comes from analytics_wcam_events() (202609010006), the single server-side copy of the qualifying list; this function contains no second copy. Membership is COMM-310''s denominator: an invite_redemptions row redeemed before the end of p_as_of on a profile not soft-deleted before it. PRIVACY: a member with visible_to_club = false is still returned with their segment, so the counts are the whole club, but user_id, display_name and handle are ALL null so the drill-down cannot name them. The raw column is read, not can_view_profile_field(), which would short-circuit true for this function''s admin callers and would additionally drop blocked members and silently shrink a club-wide count. coach_engagement_flags'' `user_id <> auth.uid()` rule is re-applied by hand, so the caller never reads their own declining label; their row is still present, under whatever their activity says. Thresholds (30 days, 4 weeks, 8 weeks, 4-of-8) are named constants, not client parameters. Read-only, no side effects.';

commit;
