begin;

-- COMM-304, schema half. The first producer for `coach_engagement_flags`,
-- which has shipped empty since Phase 0 (202608280011) behind a comment
-- naming this exact ticket: "no producer writes to it until an attendance
-- source exists". COMM-300 (202608310001) is that source, so this file is
-- the one that fills the table. It closes the parked COMM-P04.
--
-- WHAT THIS FILE IS NOT
-- No new table, no new policy, no policy edited, no grant changed on
-- `coach_engagement_flags`. Its four Phase 0 policies each carry
-- `user_id <> auth.uid()`, and that clause is the single most important
-- guarantee in this corner of the schema: this table says "this member
-- looks like they are drifting away", and a member reading that about
-- themselves - including a member who is themselves a coach, an admin or
-- the owner - is the exact outcome the feature must never produce. Nothing
-- below works around it, and nothing below runs with a session that could.
-- 0044 re-asserts it against rows this function actually wrote, rather than
-- against the planted rows 0011 has been using since Phase 0.
--
-- It also does not flip COMM-226's `state.featureFlags.coachEngage`. That,
-- the review/dismiss controls and the "reach out" action are the client
-- half of this ticket and land separately, the same two-phase split the
-- coach-tools cluster (COMM-223 to COMM-226) already used.
--
-- THE REVIEW/DISMISS WRITE PATH NEEDS NO MIGRATION - VERIFIED, NOT ASSUMED
-- COMM-304's "Client calls and contracts" claims the existing staff update
-- policy already covers the client half's `status` / `reviewed_by` /
-- `reviewed_at` writes. Read against 202608280011 that is true, for two
-- separate reasons that both have to hold: `grant select, insert, update,
-- delete on public.coach_engagement_flags to authenticated` is a
-- table-level update grant with no column list, so all three columns are
-- inside it; and `coach_engagement_flags_staff_update` has no column
-- predicate either, only the staff test and the self-exclusion, in both
-- USING and WITH CHECK. So a coach marking another member's flag reviewed
-- is already legal and a coach marking their own is already impossible.
-- 0044 exercises the real three-column update rather than restating this.
--
-- One thing that is worth a reviewer's attention rather than a skim:
-- nothing pins `reviewed_by` to `auth.uid()`. A staff member can set it to
-- any profile id. That is the shape the table shipped with in Phase 0 and
-- this ticket does not change it - it is a provenance field on a
-- staff-only table, not an authorisation input, and no rule below or in
-- the client half reads it.

-- =====================================================================
-- coach_detect_engagement_decline()
-- =====================================================================
-- Same auth shape as `chal_notify_ending_soon()` (202608290006) and
-- `notif_batch_flush_due()` (202608280028): `security definer`, granted to
-- `service_role` and to nobody else, selects what is due, does the work,
-- and leaves state behind that stops it doing the same work twice.
--
-- Like both of those, and unlike every client-facing definer function in
-- this schema, it does NOT check `auth.uid()` first. That is the documented
-- exception rather than an oversight: this is a scheduled job with no
-- session at all, so an `auth.uid()` gate would reject every legitimate
-- call and pass none. The gate is the grant. There is no caller identity to
-- check, and the function takes no parameters, so there is no input from a
-- client to validate either.
--
-- It is definer for exactly one boundary: `attendance_log` is own-row plus
-- staff (202608310001) and `coach_engagement_flags` excludes the flagged
-- member from every policy, so it reads and writes across both on purpose.
--
-- SCHEDULER IS NOT BUILT HERE. Same open item already logged against
-- `notif_batch_flush_due()`, `chal_notify_ending_soon()` and `recap_weekly`:
-- this needs a pg_cron entry or a scheduled Edge Function once one exists
-- for any of them. Running it by hand as the service role is safe and
-- repeatable, which is the property the "already open" rule below buys.
create or replace function public.coach_detect_engagement_decline() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  -- ===================================================================
  -- TUNING CONSTANTS. COMM-304: "The exact drop thresholds per bucket are
  -- a product-tuning decision this ticket states as a named constant, not
  -- a magic number buried in a query, so a later tuning pass is a one-line
  -- change." Every number this function makes a decision with is here and
  -- nowhere else. None of them is a client parameter and none is read from
  -- a table - a coach tuning this is a migration, deliberately, because
  -- the numbers decide who gets a conversation about drifting away.
  -- ===================================================================

  -- The two windows. COMM-304 names 8 and 2 as examples and they are taken
  -- as-is: 8 weeks is long enough that a holiday, an illness or a work
  -- trip is a dent in the baseline rather than the whole of it, and 2
  -- weeks is the shortest recent window that can tell "stopped coming"
  -- apart from "missed a week", which most members do routinely.
  c_baseline_weeks constant integer := 8;
  c_recent_weeks   constant integer := 2;

  -- The three drop buckets, expressed as the recent rate as a FRACTION of
  -- the baseline rate. Ratios, not absolute session counts, because the
  -- whole point of the feature is "less than they used to", and a member
  -- who trains twice a week and a member who trains five times a week have
  -- not had the same thing happen to them when they both drop to twice.
  --
  -- Read against a 3-sessions-per-week member, which is the shape these
  -- were chosen against:
  --
  --   recent 2.0/wk (67%)  -> nothing. Missing one session in a fortnight
  --                           is the normal texture of a training week and
  --                           a coach must never be shown it.
  --   recent 1.5/wk (50%)  -> mild. Attendance halved. Worth noticing,
  --                           not worth alarm.
  --   recent 1.0/wk (33%)  -> significant. From three times a week to
  --                           once. This is a change in someone's life,
  --                           not a change in their week.
  --   recent 0             -> inactive. Two full weeks with nothing after
  --                           a steady baseline.
  --
  -- 0.60 is set where it is so that the ordinary fortnight (five sessions
  -- where six were expected, 83%) can never reach it, and a halving always
  -- does. 0.35 sits just below one third on purpose, so that the 3/wk
  -- member who drops to exactly once a week lands in `significant` and not
  -- in `mild`. `inactive` is not a ratio at all - it is the zero case, and
  -- it is checked first, because 0 is below both ratios and would
  -- otherwise be reported as the weaker of the three.
  c_mild_ratio        constant numeric := 0.60;
  c_significant_ratio constant numeric := 0.35;

  -- The floor under "had a baseline at all". A member whose baseline is
  -- under half a session a week - four sessions in the whole eight weeks -
  -- is not someone with a training rhythm that could decline; the ratio
  -- arithmetic would still happily flag them, and a coach would be handed
  -- a list of people who have never really been coming. Set at exactly the
  -- point where the baseline window contains a session a fortnight.
  c_min_baseline_sessions_per_week constant numeric := 0.5;

  -- How long a flag a coach has already dealt with suppresses a new one
  -- for that member. Without it, a dismissed flag is re-raised on the very
  -- next run for as long as the member's numbers stay down, which turns
  -- "dismiss" into a button that does nothing and is the fastest way to
  -- make a coach stop reading the section. Measured from the moment the
  -- flag was resolved, not from when it was raised. 30 days is a month of
  -- quiet: long enough that the coach's judgement stands, short enough
  -- that a member who is still drifting a month later comes back.
  c_reflag_cooldown_days constant integer := 30;

  -- ===================================================================

  -- The recent window is [v_recent_start, +inf): inclusive of today and
  -- deliberately open-ended at the top. `attendance_log` legitimately
  -- holds a day one ahead of the server's `current_date` - 202608310001
  -- allows a day of slack so an Asia/Jerusalem member training at 01:00
  -- local does not lose the credit - and excluding that day would
  -- understate a member's recent rate. Every error this open end can make
  -- is in the direction of NOT flagging someone, which is the right
  -- direction for a list a human acts on.
  v_recent_start   date := current_date - (c_recent_weeks * 7) + 1;

  -- The baseline window is the `c_baseline_weeks` weeks immediately BEFORE
  -- the recent window, and does not overlap it. This matters more than it
  -- looks: a baseline that included the recent weeks would be dragged down
  -- by the very decline it is being compared against, compressing every
  -- ratio towards 1 and quietly under-reporting exactly the members the
  -- feature exists to find. COMM-304's own wording - "the PRIOR 8 weeks" -
  -- reads the same way.
  v_baseline_end   date := v_recent_start - 1;
  v_baseline_start date := v_recent_start - (c_baseline_weeks * 7);

  v_member   record;
  v_level    text;
  v_open_id  uuid;
  v_written  integer := 0;
begin
  for v_member in
    select
      a.user_id,
      -- The oldest attendance day this member has ANYWHERE, not just
      -- inside the baseline window. This is the whole of the
      -- no-baseline-no-flag rule; see the eligibility test below.
      min(a.occurred_on) as first_day,
      -- `attendance_log` is unique on (user_id, occurred_on), so a count
      -- of rows is already a count of distinct training days.
      round(count(*) filter (
        where a.occurred_on between v_baseline_start and v_baseline_end
      )::numeric / c_baseline_weeks, 2) as baseline_rate,
      round(count(*) filter (
        where a.occurred_on >= v_recent_start
      )::numeric / c_recent_weeks, 2) as recent_rate,
      -- Provenance only: the club the member most recently trained in, so
      -- the flag is filed where the training happened rather than at
      -- `default_club_id()` by default. Single-club today; this costs one
      -- line and stops being a lie the day it is not.
      (array_agg(a.club_id order by a.occurred_on desc))[1] as club_id
    from public.attendance_log a
    join public.profiles p on p.id = a.user_id and p.deleted_at is null
    group by a.user_id
  loop
    -- ---------------------------------------------------------------
    -- Rule 2: a member with too little history is NEVER flagged.
    -- ---------------------------------------------------------------
    -- The test is on the member's FIRST ATTENDANCE DAY, not on their
    -- tenure and not on how full the baseline window is. Three readings
    -- were available and this is the honest one:
    --
    --   * Tenure (`invite_redemptions.redeemed_at`, or
    --     `profiles.created_at`) says how long ago someone signed up. A
    --     member who joined a year ago and started training last month has
    --     a year of tenure and no baseline. It answers a different
    --     question.
    --   * "Attendance rows covering the full window" - a row in every one
    --     of the eight weeks - is too strict in the other direction: a
    --     member with a rock-solid 4/wk rhythm and one week off for the
    --     holidays would be exempted from detection forever.
    --   * "Their history reaches back to at least the start of the
    --     baseline window" is what a baseline actually requires: there was
    --     a period, before the recent one, over which this member's normal
    --     rate is a measurable thing. What they did inside it is the
    --     baseline rate's job to say, and the floor below is what says
    --     whether it was enough to be called a rhythm.
    --
    -- The boundary is inclusive: a first day exactly on v_baseline_start
    -- is eligible, because that member's history does cover the window.
    -- A member whose first ever session is one day later is not, however
    -- hard they trained in the seven weeks they have been coming - there
    -- is no such thing as a decline with no prior baseline to decline
    -- from, and a brand-new member who trained intensely for a fortnight
    -- and then settled into a normal rhythm is the single most likely
    -- false positive this whole function could produce.
    if v_member.first_day > v_baseline_start then
      continue;
    end if;

    -- The floor. See c_min_baseline_sessions_per_week.
    if v_member.baseline_rate < c_min_baseline_sessions_per_week then
      continue;
    end if;

    -- ---------------------------------------------------------------
    -- Which bucket, if any. Zero first: it is below both ratios.
    -- ---------------------------------------------------------------
    if v_member.recent_rate = 0 then
      v_level := 'inactive';
    elsif v_member.recent_rate < c_significant_ratio * v_member.baseline_rate then
      v_level := 'significant';
    elsif v_member.recent_rate < c_mild_ratio * v_member.baseline_rate then
      v_level := 'mild';
    else
      continue;
    end if;

    -- ---------------------------------------------------------------
    -- Rule 3: never a second open row for the same member.
    -- ---------------------------------------------------------------
    -- `coach_engagement_flags` ships NO uniqueness mechanism for this -
    -- 202608280011 has a primary key on `id` and two plain, non-unique
    -- indexes, and nothing else. So the invariant is this function's to
    -- hold, and it holds it by looking.
    --
    -- A partial unique index on (user_id) where status = 'open' was
    -- considered and deliberately not added, on top of this ticket's
    -- "no new table, one function" outline: the table also takes a direct
    -- staff INSERT under `coach_engagement_flags_staff_insert`, and an
    -- index would turn a coach flagging someone the job had already
    -- flagged into a raw 23505 surfacing in the client, which is a
    -- behaviour change to a shipped path that this ticket has no business
    -- making. The invariant this ticket owns is the job's.
    --
    -- UPDATE IN PLACE rather than skip - COMM-304 allows either. Updating
    -- is the better of the two because the level is a live judgement: a
    -- member who was `mild` last week and has since stopped entirely
    -- should read `inactive` on the coach's list, and a skip would leave
    -- the coach looking at a stale label with fresh urgency behind it.
    --
    -- What the update deliberately does NOT touch: `flagged_at`, which is
    -- when this drift was first noticed and is the only record of how long
    -- it has been going on; and `status` / `reviewed_by` / `reviewed_at`,
    -- which are the coach's, and which this job must never be able to
    -- reset. The row's identity, and its age, survive every re-run.
    select f.id into v_open_id
    from public.coach_engagement_flags f
    where f.user_id = v_member.user_id and f.status = 'open'
    order by f.flagged_at desc
    limit 1;

    if v_open_id is not null then
      update public.coach_engagement_flags
      set level = v_level,
          baseline_sessions_per_week = v_member.baseline_rate,
          recent_sessions_per_week = v_member.recent_rate
      where id = v_open_id;
      v_written := v_written + 1;
      continue;
    end if;

    -- The cooldown. Only reached when there is no open flag, so this is
    -- exactly the "a coach already dealt with this member" case.
    -- `reviewed_at` is nullable and a client can legally resolve a flag
    -- without stamping it, so `flagged_at` is the fallback rather than the
    -- row being treated as infinitely old.
    if exists (
      select 1 from public.coach_engagement_flags f
      where f.user_id = v_member.user_id
        and f.status <> 'open'
        and coalesce(f.reviewed_at, f.flagged_at)
            > now() - make_interval(days => c_reflag_cooldown_days)
    ) then
      continue;
    end if;

    insert into public.coach_engagement_flags
      (club_id, user_id, level, baseline_sessions_per_week, recent_sessions_per_week)
    values (
      coalesce(v_member.club_id, public.default_club_id()),
      v_member.user_id, v_level, v_member.baseline_rate, v_member.recent_rate
    );
    v_written := v_written + 1;
  end loop;

  -- Rows written: inserted plus refreshed. Same "how much did this run
  -- actually do" integer `chal_notify_ending_soon()` returns, and the
  -- number a scheduler log line would carry.
  return v_written;
end $$;

revoke all on function public.coach_detect_engagement_decline() from public, anon, authenticated;
grant execute on function public.coach_detect_engagement_decline() to service_role;

commit;
