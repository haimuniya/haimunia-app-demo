begin;

-- Coach signal honesty. Fixes the two coach-facing reads that were
-- confidently wrong in front of staff, and makes the third state - "we have
-- no data about this person" - representable instead of being silently
-- rendered as a fact.
--
-- =====================================================================
-- WHAT WAS ACTUALLY BROKEN
-- =====================================================================
-- `activity_pings` (202608270001) has exactly one writer in the whole
-- system: `pingActivity()` in cloud.js, which upserts TODAY only, from a
-- live browser session, once the member's profile has loaded. No trigger,
-- no backfill, no server-side producer. 202609060002 says what the table
-- means in one line: "one row per day the member OPENED THE APP".
--
-- `coach_inactive_members()` and `coach_new_members()` (202608270005,
-- re-gated in 202608270006) are the only two coach-facing functions still
-- built on it, and both were presented to coaches in TRAINING language.
-- Measured against a seeded, visibly active club - 41 posts, reactions,
-- comments, multiple members posting - `coach_inactive_members()` returned
-- 8 of 8 members as never-active, including the coach who had posted
-- moments earlier, and `coach_new_members()` returned 4 of 12 members who
-- had all joined that same day.
--
-- Three separate defects, fixed separately below:
--
--   (a) NULL WAS RENDERED AS AN ASSERTION. The old HAVING clause was
--       `max(activity_date) is null or max(activity_date) < p_since`, which
--       merges "we have never recorded anything for this member" with "this
--       member was active and stopped". The client then printed the literal
--       string "מעולם לא" ("never") for the null branch. That is the whole
--       of the 8-of-8 result: an absence of data reported as a fact about a
--       person. A coach acting on it contacts everyone or no one.
--
--   (b) coach_new_members() ASKED THE WRONG QUESTION. It defined "new" as
--       `min(activity_date) >= current_date - p_within_days` over an INNER
--       JOIN on activity_pings. Two consequences, both bad:
--
--         * The inner join structurally excludes the single most important
--           member in a retention feature - someone who registered and
--           never opened the app again. They have no pings, so they can
--           never appear in the new-member list. The feature could not see
--           the churn it exists to prevent.
--         * min(activity_date) is not a join date. It is "the first day we
--           happened to see this person open the app", which for every
--           member predating the feature is the feature's own deploy date.
--
--       The real join date was available the entire time and is used below.
--
--   (c) THE LABEL WAS WRONG EVEN WHEN THE DATA WAS RIGHT. A member who
--       trains at 6am five days a week and dislikes phone apps has no
--       pings, and read as lapsed. The client half of this fix relabels
--       these lists as what they measure - app activity - and says plainly
--       that class attendance lives in Arbox.
--
-- =====================================================================
-- WHAT THIS FILE DELIBERATELY DOES NOT DO: switch to attendance_log
-- =====================================================================
-- The obvious fix - point these two functions at `attendance_log`
-- (202608310001), the real training source - is WRONG here, and was
-- rejected on evidence rather than taste.
--
-- 202609060013 deliberately NARROWED `attendance_log_staff_select` from
-- `has_perm('community.analytics.view') or is_staff()` down to
-- `has_perm('community.analytics.view')` alone, as an explicit product
-- decision (SEC-009/PRIV-001), because PRIVACY.md:60-70 promises members
-- that coaches see "your baseline rate and your recent rate, NOT a detailed
-- log". Verified live against this schema: a real coach has is_staff() = t,
-- has_perm('community.analytics.view') = f, and reads zero attendance rows.
--
-- So returning a per-member last-trained date to a coach - which is what
-- pointing coach_inactive_members() at attendance_log would do - reopens
-- the exact privacy hole a product decision closed eight migrations ago, in
-- order to fix a UX bug. It is not on the table.
--
-- The sanctioned attendance-based coach surface already exists and is
-- already honest: `coach_engagement_flags` fed by
-- `coach_detect_engagement_decline()` (202608310008), which compares a
-- member's recent rate against their own baseline, refuses to flag anyone
-- without an eight-week baseline, and exposes rates rather than days. That
-- is the training signal. These two functions stay on activity_pings and
-- are labelled as the app-engagement signal they have always been.
--
-- The one place attendance is read below is a COUNT, for the Welcome list,
-- and see the note on `sessions_logged` for why a count is not a log.

-- =====================================================================
-- 1. coach_inactive_members(p_since)
-- =====================================================================
-- DROP first, not CREATE OR REPLACE: the OUT parameter list changes, and
-- Postgres refuses to replace a function whose `returns table(...)` columns
-- differ (42P13, "cannot change return type of existing function").
drop function if exists public.coach_inactive_members(date);

-- Same name, same single date parameter, same staff gate, same source
-- table. What changes is that the answer is now honest about its own
-- confidence.
--
-- `state` is the whole point of this rewrite, and it is a real enum-shaped
-- contract the client branches on rather than something it infers from a
-- null:
--
--   'lapsed'  - we HAVE recorded app activity for this member, and the most
--               recent of it is older than p_since. This is a fact about a
--               person and a coach may act on it.
--   'no_data' - we have recorded NOTHING for this member, ever. This is a
--               fact about our data, not about the member. It must never be
--               rendered as "never trained", and the client renders it in a
--               separate, non-alarming group.
--
-- The two are returned from one call, rather than the client filtering, so
-- that "how many members are genuinely lapsed" has exactly one definition
-- and the Manage tab's attention row cannot drift from the list it links
-- to. That row previously counted the whole result set, which is why a club
-- with no data at all reported every member as inactive on its landing
-- screen.
--
-- NEW MEMBERS ARE EXCLUDED. A member who joined two days ago has not
-- lapsed; they are new, and they belong in Welcome, which is the list with
-- the actions for them on it. Without this rule every single new member
-- appears in BOTH lists from the day they join, and the inactive list -
-- the one with the alarming colour on it - is the one a coach sees them in
-- first. The comparison is against the same join date coach_new_members()
-- below uses, so a member can never be in a gap between the two.
create function public.coach_inactive_members(p_since date default (current_date - 7))
returns table(
  user_id uuid,
  handle text,
  display_name text,
  last_activity_on date,
  state text,
  days_since_activity integer,
  joined_on date
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'not authorized'; end if;

  return query
  with member as (
    select
      pr.id,
      pr.handle,
      pr.display_name,
      -- invite_redemptions.redeemed_at is the exact moment someone became a
      -- member. Its only SELECT policy is self-scoped
      -- (invite_redemptions_self_select, 202608270003), so a coach cannot
      -- read it directly - but this function is SECURITY DEFINER and owned
      -- by the table owner, so it reads it the same way
      -- coach_celebrate_feed()'s anniversary branch (202608290013) already
      -- does. profiles.created_at is the fallback for a profile with no
      -- redemption row at all.
      coalesce(ir.redeemed_at::date, pr.created_at::date) as joined_on,
      (select max(ap.activity_date)
         from public.activity_pings ap
        where ap.user_id = pr.id) as last_seen
    from public.profiles pr
    left join public.invite_redemptions ir on ir.user_id = pr.id
    where pr.deleted_at is null
  )
  select
    m.id,
    m.handle,
    m.display_name,
    m.last_seen,
    case when m.last_seen is null then 'no_data' else 'lapsed' end,
    -- Null for a no_data member, deliberately: there is no "days since" a
    -- thing that never happened, and returning 0 or a huge number would
    -- hand the client something to accidentally render.
    case when m.last_seen is null then null else (current_date - m.last_seen) end,
    m.joined_on
  from member m
  where m.joined_on <= p_since
    and (m.last_seen is null or m.last_seen < p_since)
  -- Genuinely lapsed first and longest-gone first within that, because that
  -- is the actionable half of the list. no_data members sort last: they are
  -- context, not a queue.
  order by (m.last_seen is null), m.last_seen asc, m.handle asc;
end $$;

revoke all on function public.coach_inactive_members(date) from public, anon;
grant execute on function public.coach_inactive_members(date) to authenticated;

comment on function public.coach_inactive_members(date) is
  'Coach list of members with no recent APP ACTIVITY - activity_pings, one row per day the member opened the app. This is NOT a training or class-attendance signal and must never be labelled as one: a member who trains five times a week and rarely opens the app has no pings. Class attendance lives in Arbox and is out of scope for this product; the sanctioned attendance-based coach signal is coach_engagement_flags via coach_detect_engagement_decline() (202608310008), which reports rates rather than days per PRIVACY.md. Staff-only, is_staff() inline. Returns state = ''lapsed'' (we recorded activity and it stopped before p_since) or ''no_data'' (we have recorded nothing ever - a fact about our data, not about the member). REWRITTEN 202609060020: before this migration the two states were merged by a `max(activity_date) is null or ...` HAVING clause and the client rendered the null branch as "never", so on any club whose members had not yet produced pings every member was reported as never active, including staff who had posted moments earlier. Members who joined on or after p_since are excluded - they are new, not lapsed, and belong in coach_new_members().';

-- =====================================================================
-- 2. coach_new_members(p_within_days)
-- =====================================================================
drop function if exists public.coach_new_members(integer);

-- Same name, same single integer parameter, same staff gate. Everything
-- about how the question is answered changes.
--
-- THE JOIN DATE IS THE JOIN DATE. coalesce(redeemed_at, created_at), not
-- min(activity_date). See (b) at the top of this file for why the old form
-- could not answer the question it was asked, and why the members it
-- silently dropped were the ones the feature exists for.
--
-- The join on activity_pings is a LEFT JOIN and appears only as
-- `has_opened_app` / `last_seen_on`. A member who registered and has not
-- opened the app since is not merely included, they sort to the top of the
-- coach's attention, which is the correct product behaviour: day-0 outreach
-- exists precisely for the person who signed up and vanished.
create function public.coach_new_members(p_within_days integer default 14)
returns table(
  user_id uuid,
  handle text,
  display_name text,
  avatar_url text,
  joined_on date,
  days_since_join integer,
  sessions_logged integer,
  has_opened_app boolean,
  last_seen_on date,
  contacted boolean,
  contacted_at timestamptz,
  assigned_coach_id uuid
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_days integer;
begin
  if not public.is_staff() then raise exception 'not authorized'; end if;

  -- Clamped rather than rejected, the same shape coach_celebrate_feed()
  -- (202608290013) uses for p_days: this is a read a dashboard makes on
  -- load, and a bad number is a client bug, not something worth turning
  -- into an error toast in front of a coach. 1..365 because a club's first
  -- year is a legitimate thing to want to look at.
  v_days := least(greatest(coalesce(p_within_days, 14), 1), 365);

  return query
  with member as (
    select
      pr.id,
      pr.handle,
      pr.display_name,
      pr.avatar_url,
      pr.assigned_coach_id,
      coalesce(ir.redeemed_at::date, pr.created_at::date) as joined_on
    from public.profiles pr
    left join public.invite_redemptions ir on ir.user_id = pr.id
    where pr.deleted_at is null
  )
  select
    m.id,
    m.handle,
    coalesce(nullif(m.display_name, ''), m.handle),
    m.avatar_url,
    m.joined_on,
    (current_date - m.joined_on),
    -- A COUNT, not a log, and the distinction is load-bearing. PRIVACY.md
    -- promises members that coaches see rates rather than "a detailed log",
    -- and 202609060013 enforced that by taking raw attendance_log reads
    -- away from coach rank. An aggregate count of training days for a
    -- member inside their first few weeks is what COMM-224 specified
    -- ("sessions attended") and discloses no individual session, no date
    -- and no result. It replaces the client's previous stand-in for this
    -- number, community_streaks.current_streak, which counts CONSECUTIVE
    -- DAYS THE MEMBER OPENED THE APP and was being shown beside a new
    -- member's name where a coach would read it as training.
    --
    -- attendance_log is read here rather than through a coach's own grant
    -- precisely because this function is SECURITY DEFINER and can return
    -- the aggregate without handing the coach the rows behind it.
    (select count(*)
       from public.attendance_log al
      where al.user_id = m.id)::integer,
    exists (select 1 from public.activity_pings ap where ap.user_id = m.id),
    (select max(ap.activity_date) from public.activity_pings ap where ap.user_id = m.id),
    exists (select 1 from public.member_contact_log mcl where mcl.user_id = m.id),
    (select max(mcl.contacted_at) from public.member_contact_log mcl where mcl.user_id = m.id),
    m.assigned_coach_id
  from member m
  where m.joined_on >= (current_date - v_days)
  -- Newest first. Within a single day, the members nobody has contacted yet
  -- come before the ones who have already been welcomed, so the list reads
  -- as a work queue rather than as a roster.
  order by
    m.joined_on desc,
    exists (select 1 from public.member_contact_log mcl where mcl.user_id = m.id) asc,
    m.handle asc;
end $$;

revoke all on function public.coach_new_members(integer) from public, anon;
grant execute on function public.coach_new_members(integer) to authenticated;

comment on function public.coach_new_members(integer) is
  'Coach list of members who JOINED within p_within_days (clamped 1..365), newest first, uncontacted first within a day. Join date is coalesce(invite_redemptions.redeemed_at, profiles.created_at) - read across users because this is SECURITY DEFINER, the same way coach_celebrate_feed() reads redeemed_at for anniversaries. Staff-only, is_staff() inline. REWRITTEN 202609060020: before this migration "new" meant min(activity_pings.activity_date) over an INNER JOIN, which (1) is a first-app-open date rather than a join date, so for any member predating the feature it reported the feature''s own deploy date, and (2) structurally excluded every member who registered and never opened the app again - exactly the member day-0 retention outreach exists for. sessions_logged is an aggregate count of attendance_log days and deliberately not a log: it discloses no session, date or result, which is what lets a coach see it under PRIVACY.md while 202609060013 keeps raw attendance rows at admin rank.';

-- =====================================================================
-- 3. coach_activity_signal_status()
-- =====================================================================
-- The honest-empty-state input, and the reason it is a function rather than
-- something the client infers.
--
-- "The list came back empty" has two completely different meanings that a
-- client CANNOT tell apart from the list alone: "every member is active"
-- (good news, and the old client said exactly that - "כולם פעילים") or "we
-- have never received a single ping from anybody, so this section knows
-- nothing". A club that has just turned the community on gets the second,
-- and was shown the first. That is the same class of error as (a) above -
-- an absence of data reported as a finding - and it needs a fact to fix,
-- not a heuristic.
--
-- Returns one row, always. Counts only, no member identities: this is a
-- question about the dataset.
create or replace function public.coach_activity_signal_status()
returns table(
  members_total integer,
  members_with_app_activity integer,
  members_with_logged_sessions integer,
  last_app_activity_on date,
  last_logged_session_on date
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'not authorized'; end if;

  return query
  select
    count(*)::integer,
    count(*) filter (
      where exists (select 1 from public.activity_pings ap where ap.user_id = pr.id)
    )::integer,
    count(*) filter (
      where exists (select 1 from public.attendance_log al where al.user_id = pr.id)
    )::integer,
    (select max(ap.activity_date) from public.activity_pings ap),
    (select max(al.occurred_on) from public.attendance_log al)
  from public.profiles pr
  where pr.deleted_at is null;
end $$;

revoke all on function public.coach_activity_signal_status() from public, anon;
grant execute on function public.coach_activity_signal_status() to authenticated;

comment on function public.coach_activity_signal_status() is
  'Whether the coach-facing activity signals have any data at all, so the client can tell "everyone is active" apart from "this section knows nothing yet" and render an honest empty state instead of an all-clear. Staff-only, is_staff() inline. Aggregate counts only, no member identities. members_with_app_activity counts members with any activity_pings row (days the app was opened); members_with_logged_sessions counts members with any attendance_log row (training logged in the app - never an Arbox class check-in, which this product does not see).';

commit;
