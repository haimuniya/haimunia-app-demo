begin;

-- COMM-312, schema half. The community health score: ONE composite number,
-- 0-100, stored per ISO week, computed from four already-defined metrics.
--
-- ---------------------------------------------------------------------------
-- WHAT IS AND IS NOT HERE
-- ---------------------------------------------------------------------------
-- One new table (community_health_scores), one select policy on it, no client
-- write grant of any kind, and three functions:
--
--   community_health_component()  a private jsonb shape helper, no role
--   community_health_generate()   the scheduled job. service_role ONLY.
--   community_health_history()    the admin read. is_admin() ONLY.
--
-- No policy on any existing table is edited and no existing grant is changed.
--
-- ---------------------------------------------------------------------------
-- THIS IS THE ONE PHASE 3 ANALYTICS TICKET THAT STORES ITS ANSWER
-- ---------------------------------------------------------------------------
-- COMM-310 (analytics_dashboard), COMM-311 (member_segments) and COMM-313
-- (retention_cohorts) all compute live on every call and materialise nothing,
-- deliberately - a rollup would be a second place for WCAM to be defined.
-- COMM-312 is different because its third acceptance criterion asks for a
-- different thing: "the score and its component breakdown are STORED per
-- computed week, so a trend line is possible without recomputing history."
--
-- The trade that buys, stated plainly rather than left to be discovered:
--
--   * A stored score is a SNAPSHOT OF A JUDGEMENT, not of the data. The
--     weights below are expected to move (the ticket says so). When they do,
--     every row already in this table was computed under the old split and
--     the trend line silently mixes two scales. That is why `components`
--     carries the weights that produced each row - see "WHY THE WEIGHTS TRAVEL
--     IN THE ROW" - so a reader can at least SEE the discontinuity, and a
--     backfill can recompute the history under one split if that is wanted.
--   * A stored score can be recomputed and will not necessarily reproduce.
--     See "THE RETENTION COMPONENT IS AS-OF-NOW" below; this is the sharpest
--     limitation in the file.
--
-- WCAM is NOT redefined here. The event list comes from
-- analytics_wcam_events() (202609010006), which is exactly why that function
-- exists; there is no array of event names anywhere in this file and 0053
-- asserts that structurally.
--
-- ---------------------------------------------------------------------------
-- WHY EVERY COMPONENT IS RECOMPUTED HERE RATHER THAN READ OUT OF COMM-310
-- ---------------------------------------------------------------------------
-- Two of the four components - WCAM share and engagement per post - are
-- already computed, per ISO week, by analytics_dashboard() (202609010006).
-- Calling it for a one-week period and reading two keys out of the response
-- would be the obvious reuse. IT IS NOT POSSIBLE, and not merely expensive:
--
--   analytics_dashboard()'s first two statements are
--       v_uid := auth.uid();
--       if v_uid is null then raise exception 'not authorized'; end if;
--
--   community_health_generate() runs from a SCHEDULER as service_role. There
--   is no session and no JWT, so auth.uid() is null and the dashboard raises
--   before it reads a row. The same is true of retention_cohorts() and
--   member_segments(): every public function in this cluster is written for a
--   logged-in admin, and a cron job is not one.
--
-- So the two ratios are recomputed here, from the same sources, with the same
-- definitions:
--
--   WCAM SHARE. Numerator: count(distinct user_id) over
--   analytics_wcam_events() inside the week, user_id not null. Denominator:
--   club membership AS OF THE END OF THE WEEK - an invite_redemptions row
--   redeemed before the week ended (this module's authoritative MEMBER_JOINED
--   stamp, 202608290011) on a profile not soft-deleted before the week ended.
--   Both halves are COMM-310's `actives` and `members` CTEs for a single
--   bucket, term for term. That denominator is the one COMM-310, COMM-311 and
--   the recaps all use; COMM-313's cohort denominator deliberately differs
--   (it keeps soft-deleted members) and is NOT the one used here, because a
--   weekly share is a snapshot of who the club is.
--
--   ENGAGEMENT PER POST. (reaction_added + comment_created) / post_created
--   inside the week, from the event stream on both sides, exactly as
--   metrics.md defines it and exactly as COMM-310 computes it. COMM-310 also
--   ships a workout_posts/reactions/post_comments cross-check alongside;
--   that is a data-quality tool for a human reading a dashboard, not a second
--   definition, and it is deliberately NOT folded into the score.
--
-- The cost of recomputing rather than calling: these two definitions now exist
-- in two files, and a change to metrics.md's WCAM DENOMINATOR (not the event
-- list, which is shared) has to be made in both. That is a real duplication
-- and it is accepted knowingly, because the alternative is not "call the
-- dashboard", it is "make the dashboard callable without a session", which
-- would mean adding a service-role path through a function whose whole
-- purpose is an admin permission check. 0053 pins the numbers this file
-- produces against a hand-computed fixture so a drift shows up as a failure
-- rather than as a slowly diverging chart.
--
-- ---------------------------------------------------------------------------
-- THE RETENTION COMPONENT, AND EXACTLY WHICH COMM-313 OUTPUT IT USES
-- ---------------------------------------------------------------------------
-- COMM-312 names "a retention signal (COMM-313, once it exists)" and does not
-- say which number. COMM-313 shipped three public functions and one private
-- helper (202609010008). The choice made here, and why:
--
--   NOT retention_cohorts() / retention_onboarding_correlation() /
--   retention_welcome_correlation(). All three raise 'not authorized' on a
--   null auth.uid(), for the reason above. They are also curves, and a
--   composite score needs one scalar.
--
--   YES retention_member_weeks(p_months), the PRIVATE helper. It is
--   SECURITY DEFINER, granted to no role at all, and - uniquely in that file -
--   carries NO auth check of its own; its header says so and contracts.md
--   repeats it ("a definer function is the only thing that can call it, and
--   its own callers must gate first"). community_health_generate() is a
--   definer function whose gate is the service_role grant, which is the
--   documented exception a scheduled job carries in this module.
--
-- THE SCALAR: the POOLED week-4 retained share across every cohort in the last
-- 6 months whose week 4 has elapsed.
--
--     retained  = members with WCAM-qualifying activity in membership week 4
--     total     = members whose membership week 4 has fully elapsed
--     signal    = retained / total,  suppressed when total < 5
--
--   Why WEEK 4. Week 1 is close to a restatement of "did they open the app the
--   week they signed up", which is a signup artefact more than a retention
--   fact. Week 12 is the strongest signal but only exists for members who
--   joined 84+ days ago, so it would exclude the two most recent cohort months
--   entirely and lag the score by a quarter. Week 4 is the first point that
--   means "came back after the novelty" and is reached by everyone who joined
--   28+ days ago.
--
--   Why POOLED across cohort months rather than "the latest cohort". This
--   number lands in a WEEKLY time series. A single cohort month can be five
--   people, and a five-person denominator moves in 20-point steps, so a
--   single-cohort signal would make the health score jump for reasons that
--   have nothing to do with the week being scored. Pooling the whole 6-month
--   window gives the largest denominator COMM-313's own default window
--   supports.
--
--   THE FLOOR IS COMM-313's, reused rather than reinvented:
--   retention_min_cohort_size() = 5, applied to the POOLED denominator. Below
--   it the component is unavailable (see the null rule below), not zero.
--   Note the pooling includes cohort months COMM-313 would have folded into
--   its 'other' bucket - folding only matters when months are drawn as
--   separate lines, and here they are one number.
--
-- ---------------------------------------------------------------------------
-- THE RETENTION COMPONENT IS AS-OF-NOW, NOT AS-OF THE SCORED WEEK. READ THIS.
-- ---------------------------------------------------------------------------
-- retention_member_weeks(p_months) is anchored on now(): its cohort window is
-- the p_months calendar months ending with the month in progress, and its
-- `elapsed` flag is relative to the current instant. It takes no as-of
-- parameter and there is no way to ask it what the curve looked like on a past
-- date.
--
-- CONSEQUENCE. The retention component of a week's score reflects the club's
-- cohorts AT THE MOMENT THE ROW WAS COMPUTED, not at the end of that week. For
-- the intended use - the scheduler runs once, shortly after a week ends - the
-- two are within days of each other and the distinction is academic. FOR A
-- BACKFILL IT IS NOT: generating twelve weeks of history in one run gives all
-- twelve rows the SAME retention component, and that component is today's.
-- The trend line will then show three components moving and one flat, which is
-- an artefact of the backfill and not a fact about the club.
--
-- It also means A RECOMPUTE OF AN OLD WEEK DOES NOT REPRODUCE ITS ORIGINAL
-- SCORE, even with no new data for that week, because the retention input has
-- moved on. `computed_at` is refreshed on every write so a reader can always
-- tell how old the judgement is, and components.retention.detail.as_of records
-- the same instant inside the breakdown.
--
-- Not fixed here, and the fix is not small: an as-of-correct retention signal
-- means a second copy of COMM-313's membership-week arithmetic parameterised
-- on an as-of date, which is exactly the duplication 202609010008 was written
-- to prevent. The right fix is an as-of parameter on retention_member_weeks()
-- itself, in COMM-313's file, and it is out of scope for this ticket.
--
-- ---------------------------------------------------------------------------
-- INTERNAL ONLY, AND HOW THAT IS ENFORCED RATHER THAN PROMISED
-- ---------------------------------------------------------------------------
-- COMM-312's second and fourth acceptance criteria: "no member-facing surface
-- at all, and no general-staff surface either", and "no score is ever shown to
-- a member, a coach without admin rank, or surfaced in any notification, recap
-- or post". Four structural facts, not four rules a client is trusted to obey:
--
--   1. ONE select policy on the table, `public.is_admin()`. Not is_staff(),
--      not has_perm('community.analytics.view') - REAL admin rank, the same
--      narrower bar COMM-313 uses and narrower than COMM-310 and COMM-311.
--      A head_coach or staff role holding community.analytics.view reads the
--      dashboard, the segments, and NOT this. 0053 asserts exactly that
--      caller.
--   2. NO insert, update or delete grant to any client role, and no write
--      policy of any kind. Not for a coach, not for an admin, not for the
--      owner. The same shape pins, attendance_log, member_of_week and
--      monthly_club_recaps all use. There is no client write path to close
--      because none is opened.
--   3. NO trigger on this table and no notif_create() call anywhere in this
--      file, so a score cannot reach a notification. Nothing here writes
--      workout_posts, weekly_recaps or monthly_club_recaps, so it cannot reach
--      a feed card or a recap either.
--   4. NOT added to the supabase_realtime publication (202608290007), so
--      postgres_changes cannot stream a score to a subscriber.
--
-- And the score is INTERPRETIVE, which is the ticket's own reason for the
-- narrow gate: "48" is a number with no unit that mixes four incommensurable
-- things through weights somebody chose. It travels badly out of context in a
-- way a raw metric does not.
--
-- ---------------------------------------------------------------------------
-- EVERY FIGURE IN `components` IS AN AGGREGATE. NO MEMBER IS NAMED.
-- ---------------------------------------------------------------------------
-- components is a free-form jsonb column, so unlike monthly_club_recaps the
-- table shape cannot enforce aggregate-only. The rule is enforced by what
-- community_health_generate() PUTS there: every leaf is a count, a ratio or a
-- named constant, and there is no user_id, handle, display_name, post_id or
-- report_id anywhere in it. 0053 sweeps every leaf value of every stored row
-- against every profile in the database, the same sweep 0046, 0050 and 0052
-- make. Do not add a "worst offender", a "top poster" or a "members who
-- churned" key here.

-- ===========================================================================
-- 1. community_health_scores - one stored row per ISO week
-- ===========================================================================
-- Exactly the columns COMM-312's migration outline names, plus two CHECKs it
-- does not (both recorded below as additions).
create table if not exists public.community_health_scores (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),

  -- The Monday of the ISO week the score covers. `unique` is the ticket's own
  -- word and it is what makes generation once-per-week.
  --
  -- ADDITION TO THE OUTLINE: the isodow CHECK. It is the same load-bearing
  -- constraint weekly_recaps.week_start, member_of_week.week_start and
  -- monthly_club_recaps.month_start all carry, for the same reason - a unique
  -- key on a free-form date is unique per DATE, not per WEEK, so without it a
  -- run keying Monday and a run keying Wednesday would both insert and the
  -- club would get two scores for one week with no constraint violation.
  -- community_health_generate() normalises its input long before it reaches
  -- here, so this is a backstop against a future direct writer.
  week_start date not null unique check (extract(isodow from week_start) = 1),

  -- 0-100, per the first acceptance criterion. ADDITION TO THE OUTLINE: the
  -- range CHECK. The generator clamps every sub-score into 0..1 and divides by
  -- the applied weight total, so it cannot produce anything outside the range;
  -- the constraint only ever catches a writer that is not computing a score.
  score numeric not null check (score >= 0 and score <= 100),

  -- The component breakdown. Shape is documented on
  -- community_health_component() and pinned by 0053; the object CHECK stops a
  -- bare number or string being stored where a breakdown belongs.
  components jsonb not null default '{}' check (jsonb_typeof(components) = 'object'),

  computed_at timestamptz not null default now()
);

-- No second index. community_health_history() reads `order by week_start desc
-- limit n`, which the unique constraint's own btree serves by scanning
-- backwards, and this table gains 52 rows a year.

alter table public.community_health_scores enable row level security;

-- SELECT only, for authenticated. NO insert, update or delete grant for any
-- client role and no write policy for any of the three - see "INTERNAL ONLY"
-- in the header. community_health_generate() (service_role, and SECURITY
-- DEFINER, so it bypasses both) is the only writer that exists.
revoke all on public.community_health_scores from public, anon;
grant select on public.community_health_scores to authenticated;

-- ONE policy, and the predicate is is_admin() ALONE.
--
-- Every other table in the analytics cluster that is readable at all is
-- readable by `has_perm('community.analytics.view') or is_staff()` or some
-- similar pair. THIS ONE IS NOT, and it is not an oversight: COMM-312's second
-- acceptance criterion says "real is_admin (not merely any
-- community.analytics.view holder) is the read gate, narrower than every other
-- admin dashboard ticket in this phase, since this figure is interpretive and
-- easy to misread out of context".
--
-- Today the two bars select nearly the same people - 202608280001 seeds that
-- permission to admin and owner only, both of which clear is_admin()'s rank
-- bar of 50. The difference bites the moment anybody grants it one rank lower,
-- and that is the intended asymmetry, the same one 202609010008 built for
-- COMM-313. GATE THE NAV ITEM ON is_admin(), not on the analytics permission,
-- or a head_coach is shown a screen the database refuses.
--
-- The read gate is duplicated in community_health_history()'s body on purpose.
-- That function is SECURITY DEFINER and so would bypass this policy; the two
-- must agree, and 0053 asserts both independently.
create policy community_health_scores_admin_select on public.community_health_scores
  for select to authenticated
  using (public.is_admin());

comment on table public.community_health_scores is
  'COMM-312. One row per ISO week of the composite community health score, 0-100, with its component breakdown. INTERNAL ONLY: exactly one policy, a SELECT for real public.is_admin() - deliberately narrower than the has_perm(''community.analytics.view'') or is_admin() pair COMM-310 and COMM-311 use, matching COMM-313, because the figure is interpretive and travels badly out of context. NO insert, update or delete grant for any client role and no write policy of any kind; public.community_health_generate() (service_role only) is the only writer. Not in the supabase_realtime publication and carrying no trigger, so a score cannot reach a notification, a recap or a feed card. week_start is the ISO Monday and is unique, which is the once-per-week rule; the isodow CHECK is what makes that uniqueness mean "per week" rather than "per date". components is aggregate-only by construction - every leaf is a count, a ratio or a named constant, and no member id, handle or display name is ever written into it.';

comment on column public.community_health_scores.score is
  '0-100. The weighted mean of the available component sub-scores, times 100, rounded to 2 places. An INTERPRETIVE composite of four incommensurable metrics under weights that COMM-312 itself calls a starting split "expected to move": not comparable across a weight change, and not meaningful without components.';

comment on column public.community_health_scores.components is
  'The full breakdown that produced `score`, including the weights in force when the row was written - so a trend line spanning a weight change can be seen for what it is rather than read as a change in the club. Four keys (wcam_share, engagement_per_post, moderation_load, retention), each {value, sub_score, weight, weight_applied, detail}. `value` is the metric in its own units; `sub_score` is that metric mapped into 0..1; for moderation_load the two move in OPPOSITE directions, because more reports lowers the score. A component with no data has sub_score null and weight_applied 0 and the remaining weights are renormalised. AGGREGATE ONLY: counts, ratios and constants, never a member.';

comment on column public.community_health_scores.computed_at is
  'When this row was last written. Refreshed on every recompute, because a recompute of an old week does NOT reproduce its original score - the retention component is measured as of the run, not as of the scored week. See the migration header.';

-- ===========================================================================
-- 2. community_health_component() - the shape of one component, once
-- ===========================================================================
-- Four components with an identical key set, built in one place so they cannot
-- drift apart and so 0053 can assert the key set once. Pure, reads nothing.
--
-- p_value        the metric in its own units (a share, a ratio, a rate)
-- p_sub_score    that metric mapped into 0..1, or null if unavailable
-- p_weight       the named constant weight from the generator
-- p_weight_total the sum of the weights of the AVAILABLE components, used to
--                renormalise. Passing it in rather than the finished
--                weight_applied keeps the renormalisation rule in one place.
-- p_detail       the raw counts the value was computed from, so a reader can
--                check the arithmetic without re-querying
--
-- Granted to no role. It is trivially safe, but it is an implementation detail
-- of the generator and a client-callable version would be a second way to mint
-- something that looks like a stored component.
create or replace function public.community_health_component(
  p_value numeric,
  p_sub_score numeric,
  p_weight numeric,
  p_weight_total numeric,
  p_detail jsonb)
returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'value',     p_value,
    'sub_score', p_sub_score,
    'weight',    p_weight,
    -- 0 when the component had no data, so "this week's score ignored
    -- engagement entirely" is visible in the row rather than inferable.
    'weight_applied',
      case when p_sub_score is null or coalesce(p_weight_total, 0) = 0 then 0
           else round(p_weight / p_weight_total, 4) end,
    'detail',    coalesce(p_detail, '{}'::jsonb));
$$;

revoke all on function public.community_health_component(numeric, numeric, numeric, numeric, jsonb)
  from public, anon, authenticated;

comment on function public.community_health_component(numeric, numeric, numeric, numeric, jsonb) is
  'COMM-312 internal. One component of a community health score as {value, sub_score, weight, weight_applied, detail}. `value` is the metric in its own units, `sub_score` is it mapped into 0..1 (null when the component had no data), `weight_applied` is the weight renormalised over the available components (0 when unavailable). Written once so all four components carry an identical key set. Pure; granted to no role.';

-- ===========================================================================
-- 3. community_health_generate(p_week_start) - the scheduled job
-- ===========================================================================
-- The "scheduled service-role job" the table's RLS comment refers to. Same
-- shape as recap_monthly_generate() (202609010002), purge_abandoned_profiles()
-- (202609010004), coach_detect_engagement_decline() (202608310008) and
-- chal_notify_ending_soon(): a Postgres function granted to service_role and
-- revoked from public, anon and authenticated, with NO auth.uid() check -
-- the documented exception a scheduled job carries in this schema, because
-- there is no session to check. The grant IS the gate, and PostgREST will not
-- call what the caller's role cannot execute.
--
-- NO SCHEDULER IS BUILT HERE. That is the same open infrastructure item every
-- one of the functions above already carries, listed once in contracts.md
-- rather than re-argued per ticket.
--
-- ---------------------------------------------------------------------------
-- ONE WEEK PER CALL, AND THE WEEK MUST HAVE FINISHED
-- ---------------------------------------------------------------------------
-- p_week_start null means the most recently COMPLETED ISO week. Any other date
-- is normalised to the Monday of its own ISO week, so a scheduler that passes
-- "today" and a scheduler that passes "the Monday" agree.
--
-- A week that has not fully elapsed is REFUSED, not scored. Every component is
-- a whole-week figure - a Wednesday run would divide three days of activity by
-- a full week's membership and store the result as that week's health, and
-- because the row is permanent nobody downstream would ever see that it was
-- partial. This is analytics_dashboard()'s posture (validate and raise) rather
-- than retention_cohorts()' (clamp): a clamped week would be a number labelled
-- with a period it was not computed over.
--
-- Backfilling is a loop over this function in the caller, one call per week,
-- not a range parameter - but read "THE RETENTION COMPONENT IS AS-OF-NOW" in
-- the header before backfilling anything.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENT PER WEEK: `on conflict (week_start) do update`
-- ---------------------------------------------------------------------------
-- COMM-312 does not ask for idempotency in the words COMM-309 and COMM-314 use
-- for their own scheduled jobs, but `week_start ... unique` in its own
-- migration outline makes the decision unavoidable: a plain insert would raise
-- 23505 on the second run for a week, and a scheduled job that throws on a
-- retry is a job that pages somebody every time a run is retried.
--
-- So: upsert, matching recap_monthly_generate()'s `on conflict do update`.
-- A rerun over unchanged data produces the same score and touches one row.
-- What it does NOT do is freeze the row the way monthly_club_recaps does after
-- publication - there is no publish step here, no member ever sees this
-- number, and a recompute is a legitimate act rather than a rewrite of
-- history. computed_at is refreshed so the row says when its answer was made.
--
-- ---------------------------------------------------------------------------
-- WHY DEFINER
-- ---------------------------------------------------------------------------
-- Three real crossings, each of which would otherwise return a slice:
--   * analytics_events - select is restricted to a community.analytics.view
--     holder (202608280012), which a service role JWT does not satisfy.
--   * invite_redemptions - self-select only (202608270003).
--   * retention_member_weeks() - granted to NO role, so only a definer
--     function owned by a role that can execute it can call it at all.
-- reports and profiles are read club-wide too and are both narrower than that
-- from any session's point of view.
create or replace function public.community_health_generate(p_week_start date default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  -- =====================================================================
  -- THE WEIGHTS. Named constants, in the computing function, exactly as
  -- COMM-312's validation rules require. A STARTING SPLIT, expected to move -
  -- the ticket says so twice - and nothing in this repo grounds a different
  -- set, so these are a judgement recorded rather than a measurement.
  --
  --   WCAM SHARE 0.40, the largest single weight. It is metrics.md's first
  --   core metric and the one figure that most directly answers "is the
  --   community layer being used at all". Everything else in this score is a
  --   quality or a safety signal on top of it.
  --
  --   ENGAGEMENT PER POST 0.25 and RETENTION 0.25, equal, and together 0.50 -
  --   deliberately MORE than WCAM share on its own. A week where lots of
  --   members opened a feed and nothing they posted got a response, or where
  --   activity is high because new members keep arriving and leaving, is not
  --   a healthy week, and a split that let raw reach carry the score would
  --   call it one.
  --
  --   MODERATION LOAD 0.10, the smallest, and deliberately not zero. It is a
  --   penalty signal with a naturally tiny dynamic range: a healthy club sits
  --   at the top of it permanently, so a larger weight would be ten free
  --   points most weeks. At 0.10 a genuine moderation crisis can still take a
  --   visible ten points off the number, which is what the "inverse" in
  --   COMM-312's first acceptance criterion is for.
  --
  -- They sum to 1.00. 0053 asserts that from the stored row rather than from
  -- the source, so a future edit that forgets one cannot pass quietly.
  -- =====================================================================
  c_w_wcam       constant numeric := 0.40;
  c_w_engagement constant numeric := 0.25;
  c_w_retention  constant numeric := 0.25;
  c_w_moderation constant numeric := 0.10;

  -- =====================================================================
  -- THE THREE NORMALISATION CONSTANTS. Two of the four metrics are not
  -- naturally 0..1 and have to be mapped onto it; that mapping is as much a
  -- judgement as the weights and is named in the same place.
  --
  --   ENGAGEMENT TARGET 3.0 interactions per post for full marks. metrics.md
  --   defines engagement per post and sets no target. Three reactions-plus-
  --   comments on a typical post is the difference between a feed where
  --   posting gets you a response and one where it does not; one is a
  --   courtesy, ten is a different kind of club. Linear below it, clamped
  --   above.
  --
  --   MODERATION CEILING 10.0 reports per 100 members per week scores zero.
  --   A RATE, not a raw count, so a club that doubles in size is not penalised
  --   for the reports that come with it. Ten per hundred is one report per ten
  --   members in a single week, which is a week the club would already know
  --   about. Linear below it, clamped at zero above.
  --
  --   RETENTION WEEK 4, over a 6-MONTH cohort window - COMM-313's own default.
  --   Reasoning in the migration header.
  -- =====================================================================
  c_engagement_target   constant numeric := 3.0;
  c_moderation_ceiling  constant numeric := 10.0;
  c_retention_week      constant integer := 4;
  c_retention_months    constant integer := 6;

  v_week date;
  v_from timestamptz;
  v_to   timestamptz;
  v_now  timestamptz := now();

  v_club_members integer;

  v_active integer;
  v_wcam_value numeric;
  v_wcam_sub   numeric;

  v_posts integer;
  v_reactions integer;
  v_comments integer;
  v_epp_value numeric;
  v_epp_sub   numeric;

  v_reports integer;
  v_mod_value numeric;
  v_mod_sub   numeric;

  v_ret_total integer;
  v_ret_kept  integer;
  v_ret_floor integer := public.retention_min_cohort_size();
  v_ret_value numeric;
  v_ret_sub   numeric;

  v_weight_total numeric := 0;
  v_weighted     numeric := 0;
  v_score        numeric;
  v_components   jsonb;
  v_id           uuid;
begin
  -- -----------------------------------------------------------------------
  -- THE WEEK. No auth.uid() check: see the header. This function is reachable
  -- only through the service_role grant.
  -- -----------------------------------------------------------------------
  -- coalesce first, then truncate, so a null and an explicit date take the
  -- same normalisation path. current_date - 7 lands inside the previous ISO
  -- week on every day of the week, including Monday.
  v_week := date_trunc('week', coalesce(p_week_start, current_date - 7)::timestamp)::date;
  v_from := v_week::timestamptz;
  v_to   := (v_week + 7)::timestamptz;

  if v_to > v_now then
    raise exception 'week has not finished';
  end if;

  -- -----------------------------------------------------------------------
  -- THE DENOMINATOR TWO COMPONENTS SHARE: club membership at the END of the
  -- week. COMM-310's `members` CTE for a single bucket - a redemption before
  -- the week ended on a profile not soft-deleted before the week ended.
  --
  -- Known limitation, the same one recap_monthly_generate(),
  -- analytics_dashboard(), member_segments() and retention_member_weeks() all
  -- record: grant_coach_role() UPDATEs invite_redemptions.redeemed_at, so
  -- promoting an existing member to coach re-dates their join. There is no
  -- immutable joined_at in this schema to fall back on.
  --
  -- ZERO MEMBERS MEANS NO ROW AT ALL. A week before the club had a single
  -- member has no community health to measure: WCAM share and moderation rate
  -- are both divisions by zero, and storing a zero would put a real-looking
  -- low point at the left end of every trend line. The function returns null
  -- and writes nothing, which is also what makes it safe for a backfill loop
  -- to run further back than the club has existed.
  -- -----------------------------------------------------------------------
  select count(*)::integer into v_club_members
  from public.profiles p
  join public.invite_redemptions ir on ir.user_id = p.id
  where ir.redeemed_at < v_to
    and (p.deleted_at is null or p.deleted_at >= v_to);

  if v_club_members = 0 then
    return null;
  end if;

  -- -----------------------------------------------------------------------
  -- COMPONENT 1: WCAM SHARE. metrics.md core metric 2, "WCAM / count(profiles)
  -- for the club in the same week". The event list is analytics_wcam_events()
  -- and nothing else - there is no array of event names in this file.
  --
  -- CLAMPED AT 1. The numerator counts anybody with a qualifying event and a
  -- non-null user_id; the denominator counts members as of the week's end. A
  -- member who was active on Tuesday and deleted their account on Thursday is
  -- in the first and not the second, so the raw share can exceed 1 by a hair.
  -- least(..., 1) keeps the sub-score a proportion; `value` is left unclamped
  -- so the raw figure stays visible in the breakdown.
  -- -----------------------------------------------------------------------
  select count(distinct e.user_id)::integer into v_active
  from public.analytics_events e
  where e.event_name = any(public.analytics_wcam_events())
    and e.created_at >= v_from
    and e.created_at <  v_to
    and e.user_id is not null;

  v_wcam_value := round(v_active::numeric / v_club_members, 4);
  v_wcam_sub   := round(least(greatest(v_wcam_value, 0), 1), 4);

  -- -----------------------------------------------------------------------
  -- COMPONENT 2: ENGAGEMENT PER POST. metrics.md core metric 4,
  -- "reaction_added plus comment_created over post_created, in a week".
  -- Events on both sides, as written and as COMM-310 computes it.
  --
  -- NO POSTS MEANS UNAVAILABLE, NOT ZERO. This is COMM-310's analytics_ratio()
  -- rule ("a count of zero is an honest zero, a RATE over a zero denominator
  -- is not") applied to a component: with nothing posted there is no
  -- engagement-per-post to measure, and scoring it 0 would double-penalise a
  -- quiet week that the WCAM component has already scored as quiet. The
  -- component drops out and its weight is redistributed - see the
  -- renormalisation block below.
  -- -----------------------------------------------------------------------
  select
    count(*) filter (where e.event_name = 'post_created')::integer,
    count(*) filter (where e.event_name = 'reaction_added')::integer,
    count(*) filter (where e.event_name = 'comment_created')::integer
  into v_posts, v_reactions, v_comments
  from public.analytics_events e
  where e.event_name in ('post_created', 'reaction_added', 'comment_created')
    and e.created_at >= v_from
    and e.created_at <  v_to;

  if v_posts > 0 then
    v_epp_value := round((v_reactions + v_comments)::numeric / v_posts, 4);
    v_epp_sub   := round(least(v_epp_value / c_engagement_target, 1), 4);
  end if;

  -- -----------------------------------------------------------------------
  -- COMPONENT 3: MODERATION LOAD, INVERTED. More reports lowers the score,
  -- which is COMM-312's first acceptance criterion in its own words.
  --
  -- THE REPORTS TABLE, NOT THE report_submitted EVENT. COMM-310 draws the
  -- distinction and this component takes the other side of it deliberately:
  -- "the event side is what members DID; the reports side is what the club has
  -- to act on". LOAD is what the club has to act on. The table is also the
  -- authoritative record - an analytics event can be dropped by an ad blocker
  -- or a failed request, and a moderation figure that quietly improves when
  -- telemetry breaks is the worst possible failure mode for a safety signal.
  --
  -- NOT period-bounded to open reports only. `reports` has no status history,
  -- so "how many were open during that week" is not reconstructable - the same
  -- asymmetry analytics_dashboard()'s queue.open_now records. Rows CREATED in
  -- the week is a fact about the week and is what this uses.
  --
  -- The rate is per 100 members so a growing club is not penalised for growth.
  -- v_club_members is > 0 here, guaranteed by the early return above.
  -- -----------------------------------------------------------------------
  select count(*)::integer into v_reports
  from public.reports r
  where r.created_at >= v_from
    and r.created_at <  v_to;

  v_mod_value := round(v_reports * 100.0 / v_club_members, 4);
  v_mod_sub   := round(greatest(1 - v_mod_value / c_moderation_ceiling, 0), 4);

  -- -----------------------------------------------------------------------
  -- COMPONENT 4: RETENTION, from COMM-313. The pooled week-4 retained share
  -- across the last 6 months of cohorts. See the header for why this figure,
  -- why pooled, and - importantly - why it is as-of-now rather than as-of the
  -- scored week.
  --
  -- `elapsed` is COMM-313's honest-denominator rule: a member counts toward
  -- week 4 only once their week 4 has fully passed, so a young cohort makes
  -- the denominator smaller rather than the share worse.
  --
  -- Below retention_min_cohort_size() the component is UNAVAILABLE rather than
  -- zero, for the same reason COMM-313 suppresses a cell: a share off four
  -- people moves 25 points when one of them changes their mind, and feeding
  -- that into a composite would make the whole score jitter for a reason no
  -- reader could see.
  -- -----------------------------------------------------------------------
  select count(*)::integer, count(*) filter (where mw.retained)::integer
  into v_ret_total, v_ret_kept
  from public.retention_member_weeks(c_retention_months) mw
  where mw.week_number = c_retention_week
    and mw.elapsed;

  if v_ret_total >= v_ret_floor then
    v_ret_value := round(v_ret_kept::numeric / v_ret_total, 4);
    v_ret_sub   := v_ret_value;
  end if;

  -- -----------------------------------------------------------------------
  -- THE COMPOSITE.
  --
  -- A weighted mean over the AVAILABLE components, not a weighted sum over all
  -- four. An unavailable component contributes neither numerator nor
  -- denominator, so its weight is redistributed proportionally across the rest
  -- and the score stays on the same 0..100 scale instead of being dragged
  -- toward zero by a metric that had nothing to say.
  --
  -- THE COST, STATED: a week with two components available is scored on those
  -- two and the number does not announce that on its face. It announces it in
  -- the row - every component carries weight_applied, which is 0 for the ones
  -- that dropped out, and a client showing a score whose weight_applied values
  -- do not include all four should say so.
  --
  -- moderation_load is available whenever v_club_members > 0, which the early
  -- return guarantees, so v_weight_total is never 0 in practice. The guard
  -- below is a backstop, not a live path.
  -- -----------------------------------------------------------------------
  if v_wcam_sub is not null then
    v_weight_total := v_weight_total + c_w_wcam;
    v_weighted     := v_weighted + c_w_wcam * v_wcam_sub;
  end if;
  if v_epp_sub is not null then
    v_weight_total := v_weight_total + c_w_engagement;
    v_weighted     := v_weighted + c_w_engagement * v_epp_sub;
  end if;
  if v_ret_sub is not null then
    v_weight_total := v_weight_total + c_w_retention;
    v_weighted     := v_weighted + c_w_retention * v_ret_sub;
  end if;
  if v_mod_sub is not null then
    v_weight_total := v_weight_total + c_w_moderation;
    v_weighted     := v_weighted + c_w_moderation * v_mod_sub;
  end if;

  if v_weight_total = 0 then
    return null;
  end if;

  v_score := round(100 * v_weighted / v_weight_total, 2);

  -- -----------------------------------------------------------------------
  -- THE BREAKDOWN.
  --
  -- WHY THE WEIGHTS TRAVEL IN THE ROW. COMM-312 says the split is expected to
  -- move. When it does, every row already stored was computed under the old
  -- one, and a trend line drawn across the change would show a step that looks
  -- like the club changing. Storing the weights alongside the components makes
  -- that step readable - and means the client needs no second copy of the
  -- numbers to render "WCAM share, weight 40%" under the bar.
  --
  -- EVERY LEAF IS A COUNT, A RATIO OR A CONSTANT. No user_id, no handle, no
  -- display_name, no post_id, no report_id. 0053 sweeps every leaf of every
  -- stored row against every profile in the database.
  -- -----------------------------------------------------------------------
  v_components := jsonb_build_object(
    'version', 1,
    'week_start', v_week,
    'week_end_exclusive', (v_week + 7),
    'club_members', v_club_members,
    'weight_total_applied', v_weight_total,

    'wcam_share', public.community_health_component(
      v_wcam_value, v_wcam_sub, c_w_wcam, v_weight_total,
      jsonb_build_object(
        'active_members', v_active,
        'club_members',   v_club_members)),

    'engagement_per_post', public.community_health_component(
      v_epp_value, v_epp_sub, c_w_engagement, v_weight_total,
      jsonb_build_object(
        'posts',     v_posts,
        'reactions', v_reactions,
        'comments',  v_comments,
        'target',    c_engagement_target)),

    'moderation_load', public.community_health_component(
      v_mod_value, v_mod_sub, c_w_moderation, v_weight_total,
      jsonb_build_object(
        'reports',         v_reports,
        'per_100_members', v_mod_value,
        'ceiling',         c_moderation_ceiling,
        -- Carried in the row because the sign is the one thing about this
        -- component a reader can get backwards.
        'inverted',        true)),

    'retention', public.community_health_component(
      v_ret_value, v_ret_sub, c_w_retention, v_weight_total,
      jsonb_build_object(
        'week_number',   c_retention_week,
        'cohort_months', c_retention_months,
        -- Named `cohort_size`, not `member_count`. Not a style choice: 0053
        -- sweeps this blob for every profile handle, and rls_helpers ships a
        -- member whose handle is a substring of the string "member_count".
        'cohort_size',   v_ret_total,
        'retained',      v_ret_kept,
        'floor',         v_ret_floor,
        -- The instant the retention curve was read, which is NOT the end of
        -- the scored week. See "THE RETENTION COMPONENT IS AS-OF-NOW".
        'as_of',         v_now,
        'as_of_basis',   'run_time_not_week_end')));

  -- -----------------------------------------------------------------------
  -- THE UPSERT. One statement, idempotent per ISO week.
  -- -----------------------------------------------------------------------
  insert into public.community_health_scores (week_start, score, components, computed_at)
  values (v_week, v_score, v_components, v_now)
  on conflict (week_start) do update
    set score       = excluded.score,
        components  = excluded.components,
        computed_at = excluded.computed_at
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.community_health_generate(date) from public, anon, authenticated;
grant execute on function public.community_health_generate(date) to service_role;

comment on function public.community_health_generate(date) is
  'COMM-312. Computes and stores ONE ISO week of the community health score. service_role only: revoked from public, anon and authenticated, and - the documented exception a scheduled job carries in this schema - no auth.uid() check, because there is no session to check. The grant IS the gate. SECURITY DEFINER for analytics_events (community.analytics.view only), invite_redemptions (self-select only) and retention_member_weeks() (granted to no role). p_week_start null means the most recently COMPLETED ISO week; any other date is normalised to the Monday of its own week; a week that has not fully elapsed RAISES ''week has not finished'' (P0001) rather than being scored partially. Returns the row id, or NULL when the club had zero members at the end of that week (no row is written - a week before the club existed has no health to measure). IDEMPOTENT per week via `on conflict (week_start) do update`: a rerun recomputes in place and can never duplicate. FOUR COMPONENTS, weights as named constants in the body and copied into the stored row: wcam_share 0.40, engagement_per_post 0.25, retention 0.25, moderation_load 0.10 (inverse - more reports lowers the score). A component with no data drops out and the remaining weights are RENORMALISED, so the score stays on 0..100. WCAM comes from analytics_wcam_events(); there is no second copy of the event list here. THE RETENTION COMPONENT IS MEASURED AS OF THE RUN, NOT AS OF THE SCORED WEEK - retention_member_weeks() is anchored on now() and takes no as-of parameter - so a backfill gives every week the same retention input and a recompute of an old week does not reproduce its original score. No scheduler is built here, the same open item recap_monthly_generate(), purge_abandoned_profiles(), coach_detect_engagement_decline(), chal_notify_ending_soon() and recap_weekly all carry. Writes nothing but community_health_scores: no notification, no post, no recap.';

-- ===========================================================================
-- 4. community_health_history(p_weeks) - the only read path
-- ===========================================================================
-- COMM-312's client contract, signature for signature: `community_health_
-- history(p_weeks int default 12) returns setof jsonb`, {week_start, score,
-- components}. Three keys, nothing else - the row's id, club_id and
-- computed_at are not in the contract and are not returned.
--
-- p_weeks CLAMPS to 1..52, which the ticket's validation rules state
-- explicitly. Clamping is safe here for the same reason it is safe in
-- retention_cohorts(): every row names its own week_start, so a caller who
-- asked for 999 weeks can see exactly which weeks answered.
--
-- ORDER: the newest p_weeks rows, returned OLDEST FIRST, so a client draws the
-- trend line left to right without re-sorting. The limit is applied before the
-- sort, in the subquery - `order by week_start limit 12` would return the
-- twelve OLDEST weeks, which is the opposite of a current trend line.
--
-- EMPTY AND ONE-ROW STATES ARE THE CALLER'S. COMM-312's frontend states ask
-- for "fewer than 2 computed weeks shows the latest score with no trend line
-- rather than a broken chart"; this returns 0 or 1 rows and the client decides
-- what to draw. Nothing is fabricated to fill a chart.
--
-- WHY DEFINER, HONESTLY. It crosses nothing today. The table's only policy is
-- already `is_admin()` and this function checks the same thing, so an admin
-- caller would read exactly these rows through the policy and a non-admin is
-- refused by both. It is definer because COMM-312's client contract says
-- `security definer` and because it makes the function's gate independent of
-- the table's policy rather than derived from it - belt and braces on the one
-- surface in this cluster whose whole point is that almost nobody may read it.
-- Both halves are asserted separately in 0053 so they cannot drift apart.
create or replace function public.community_health_history(p_weeks integer default 12)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_weeks integer;
begin
  -- AUTH, before anything is read. auth.uid() first, then the permission - the
  -- same order every definer function in this schema uses. is_admin() ALONE,
  -- with no has_perm('community.analytics.view') alternative; see the policy
  -- comment on community_health_scores.
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_admin() then raise exception 'not authorized'; end if;

  v_weeks := least(greatest(coalesce(p_weeks, 12), 1), 52);

  return query
  select jsonb_build_object(
    'week_start', h.week_start,
    'score',      h.score,
    'components', h.components)
  from (
    select s.week_start, s.score, s.components
    from public.community_health_scores s
    order by s.week_start desc
    limit v_weeks
  ) h
  order by h.week_start;
end $$;

revoke all on function public.community_health_history(integer) from public, anon;
grant execute on function public.community_health_history(integer) to authenticated;

comment on function public.community_health_history(integer) is
  'COMM-312 community health score history. Returns setof jsonb, one row per stored week: {week_start, score, components} - exactly the three keys the ticket''s contract names; id, club_id and computed_at are not returned. AUTH: security definer; auth.uid() checked first, then public.is_admin() ALONE - deliberately NARROWER than analytics_dashboard() and member_segments(), which both also accept has_perm(''community.analytics.view''). A holder of that permission who is not an admin is refused here, matching COMM-313 and per COMM-312''s "real is_admin, not merely any community.analytics.view holder". Raises ''not authorized'' (P0001). p_weeks is CLAMPED to 1..52 (null means 12), not refused, per the ticket''s validation rules; every row names its own week_start so a clamped answer cannot be mistaken for the one asked for. Returns the NEWEST p_weeks weeks, ordered OLDEST FIRST so a trend line draws left to right. Returns 0 or 1 rows happily - COMM-312''s empty state is "fewer than 2 computed weeks shows the latest score with no trend line", and nothing is fabricated to fill a chart. The definer bit crosses no boundary today (the table''s only policy is the same is_admin() test); it is there because the ticket specifies it and because it makes this gate independent of the table''s. Read-only, no side effects. This is the ONLY read path: there is no member-facing or general-staff surface for this figure anywhere.';

commit;
