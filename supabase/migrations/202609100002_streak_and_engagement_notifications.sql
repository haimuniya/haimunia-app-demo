begin;

-- Community structure research, 2026-09-10: the owner asked for the Community
-- tab to be "effective, easy to use, fun to use, and users and owner will
-- benefit from" - a strategic research pass (not this migration) found the
-- retention loop weak (every notification type is reactive or administrative,
-- nothing gives a member a reason to open the app on a rest day) and coach
-- tooling proactive but still pull-only (coach_engagement_flags exists and is
-- detected daily, but nothing tells a coach a new flag exists - they have to
-- open the Coach tab to find out). This migration closes both gaps with two
-- new, independently toggleable notification types.
--
-- =====================================================================
-- 0. Two new club_features - the "off switch" the owner explicitly asked
--    for, same generic module_key mechanism 202609010012 already built
--    (club_feature_enabled(), admin_set_club_feature()). No new table, no
--    new RPC - just two more rows, exactly like every toggle since.
-- =====================================================================
insert into public.club_features (module_key, enabled) values
  ('streak_risk_nudges', true),
  ('engagement_alerts', true)
on conflict (club_id, module_key) do nothing;

-- =====================================================================
-- 1. Streak-at-risk nudges - the retention gap.
-- =====================================================================
-- THE SIGNAL. community_streaks() (202609080005) already computes a
-- member's current activity streak (consecutive days activity_pings has a
-- row) with an island/run-length aggregation. This function re-derives the
-- same runs rather than calling that one, on purpose: community_streaks()
-- is written for ONE caller's viewpoint (auth.uid()) with leaderboard
-- privacy filtering (visible_to_club/in_leaderboards) baked in, because its
-- job is "what may I show this viewer about the club's board". This job is
-- the opposite question - "does THIS member's own streak need a nudge" -
-- and must never be filtered by whether the member opted into the public
-- leaderboard; a member who keeps their streak private still deserves the
-- reminder about their own private number.
--
-- "AT RISK" = current_streak >= 3 (long enough that losing it is a real
-- loss, not "I skipped once") AND the member has not opened the app YET
-- today (their last activity island ends yesterday, not today). This is
-- naturally self-limiting without a notified_at column: the predicate
-- "last activity = yesterday" is true for exactly one calendar day per
-- streak-risk event (today the member either opens the app - last activity
-- becomes today, predicate stops matching this member - or does not - the
-- streak recomputes to 0 tomorrow per community_streaks()'s own
-- `case when run_end >= current_date - 1 then run_length else 0 end`
-- logic, and the predicate again stops matching). Scheduled once daily, so
-- at most one notification per member per at-risk evening.
--
-- NO DEEP LINK. The obvious target is the Add/log tab, but every existing
-- deep-link resolver (resolveNotifTarget/navigateToNotifTarget, cloud.js)
-- unconditionally routes into Community first (window.switchToCommunityTopTab())
-- - there is no established client-side pattern for a notification to open
-- a top-level app tab instead, and building one is a real, separately-
-- reviewable client change, not a one-line addition to a migration that
-- already touches two other systems. Left null rather than guessed at:
-- the member still gets the reminder in their notification centre and push,
-- and is one bottom-nav tap from Add regardless.
create or replace function public.notif_streak_at_risk() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_written integer := 0;
  v_member record;
  c_min_streak constant integer := 3;
begin
  if not public.club_feature_enabled('streak_risk_nudges') then
    return 0;
  end if;

  for v_member in
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
    select lr.user_id, lr.run_length
    from latest_run lr
    join public.profiles pr on pr.id = lr.user_id
    where pr.deleted_at is null
      and exists (select 1 from public.invite_redemptions ir where ir.user_id = pr.id)
      and lr.run_end = current_date - 1
      and lr.run_length >= c_min_streak
  loop
    if public.notif_create(
      v_member.user_id, 'streak_at_risk', 'training',
      'הרצף שלך בסכנה',
      v_member.run_length || ' ימים רצופים - היכנסו היום כדי לשמור על הרצף',
      'streak', null, null
    ) is not null then
      v_written := v_written + 1;
    end if;
  end loop;

  return v_written;
end $$;
revoke all on function public.notif_streak_at_risk() from public, anon, authenticated;
grant execute on function public.notif_streak_at_risk() to service_role;
comment on function public.notif_streak_at_risk() is
  'Community structure research, 2026-09-10. Daily job: notifies every member with a current activity streak (consecutive activity_pings days) of 3+ who has not opened the app yet today, that their streak is at risk. Re-derives the same island/run-length aggregation community_streaks() (202609080005) uses, deliberately NOT gated on visible_to_club/in_leaderboards - this is a private reminder about the member''s own number, not a leaderboard read. No-ops (returns 0) while club_features.streak_risk_nudges is disabled. Self-limiting by construction: the run_end = current_date - 1 predicate matches a given member on at most one calendar day per at-risk episode, so one daily cron run cannot double-notify. Scheduled as ''streak-at-risk-notify''.';

-- =====================================================================
-- 2. Engagement-decline alerts to staff - the coach-tooling gap.
-- =====================================================================
-- coach_detect_engagement_decline() (202608310008) already runs daily
-- (cron job 'coach-engagement-decline', 202609050005) and writes/refreshes
-- coach_engagement_flags rows - but only ever writes the FLAG, never tells
-- a coach one exists. A coach only ever learns about a new flag by opening
-- the Coach tab and looking. This closes that loop without touching the
-- detection function at all (migration-immutable, and its own comment is
-- explicit that flagged_at is deliberately never bumped on a re-flag - see
-- notified_at below for why this function does not try to read that).
--
-- notified_at is a NEW column, not a re-declaration of anything: the
-- established "notify once" idiom this exact schema already uses
-- (challenges.ending_soon_notified_at, 202608290006), applied to the one
-- table that did not yet have it. One notification per flag ROW, not per
-- re-run: a flag row already represents one continuous drift episode (it
-- is updated in place while open - see that function's own comment - and
-- only a NEW row after the 30-day cooldown represents a genuinely new
-- episode), so notifying once at first detection and staying quiet while
-- the same open episode's severity is refreshed is the low-noise choice,
-- the same one challenge_ending_soon already made for its own "once per
-- thing, not once per check" shape.
alter table public.coach_engagement_flags add column if not exists notified_at timestamptz;

-- NO MEMBER NAME IN THE NOTIFICATION TEXT. PRIVACY.md is explicit that this
-- signal is "deliberately hidden from the member it is about", and a push
-- notification banner is the one surface in this whole feature that could
-- put a member's name in front of someone other than the coach who opened
-- the Coach tab to look (a lock screen, a glanced-at phone). The level
-- alone is enough to prompt a coach to go check the list; the level and
-- identity stay server-side/in-dashboard, same as today.
create or replace function public.coach_notify_engagement_flags() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_written integer := 0;
  v_flag record;
  v_mod uuid;
  v_level_label text;
begin
  if not public.club_feature_enabled('engagement_alerts') then
    return 0;
  end if;

  for v_flag in
    select f.id, f.club_id, f.level
    from public.coach_engagement_flags f
    where f.status = 'open' and f.notified_at is null
  loop
    v_level_label := case v_flag.level
      when 'inactive' then 'לא התאמן/ה שבועיים'
      when 'significant' then 'ירידה משמעותית בתדירות'
      else 'ירידה קלה בתדירות'
    end;
    for v_mod in select * from public.mod_alert_recipients(coalesce(v_flag.club_id, public.default_club_id())) loop
      if public.notif_create(
        v_mod, 'engagement_decline_flagged', 'community',
        'חבר/ה עשוי/ה להתרחק',
        v_level_label || ' - פרטים בלוח המאמנים',
        'coach_engagement_flag', v_flag.id, '/community/coach'
      ) is not null then
        v_written := v_written + 1;
      end if;
    end loop;
    update public.coach_engagement_flags set notified_at = now() where id = v_flag.id;
  end loop;

  return v_written;
end $$;
revoke all on function public.coach_notify_engagement_flags() from public, anon, authenticated;
grant execute on function public.coach_notify_engagement_flags() to service_role;
comment on function public.coach_notify_engagement_flags() is
  'Community structure research, 2026-09-10. Daily job, run after coach-engagement-decline: notifies every mod_alert_recipients() member of an open, not-yet-notified coach_engagement_flags row - one notification per flag row (notified_at gates it, same "notify once" idiom as challenges.ending_soon_notified_at), fanned out to every coach/admin the same way notif_on_report() already does for new_report. Deliberately carries no member name or handle in the notification title/body - PRIVACY.md documents this signal as hidden from the member it is about, and a push banner is a surface a coach''s notification centre does not otherwise expose to; the level alone routes a coach to the dashboard where the identity already lives. No-ops (returns 0) while club_features.engagement_alerts is disabled. Scheduled as ''coach-engagement-decline-notify'', after ''coach-engagement-decline'' so the same run''s new flags are caught the same morning.';

-- =====================================================================
-- 3. Scheduling. cron.schedule() upserts on job name (202609050005's own
--    convention), so this is idempotent. Odd minutes, same habit.
-- =====================================================================

-- DAILY at 16:11 UTC - Israel local evening (18:11-19:11 depending on DST),
-- late enough that "log a workout today" is still a real, makeable ask, not
-- a 6am reminder nobody can act on for another twelve hours.
select cron.schedule('streak-at-risk-notify', '11 16 * * *',
  $$select public.notif_streak_at_risk()$$);

-- DAILY at 06:29 UTC - twelve minutes after 'coach-engagement-decline'
-- (06:17), long enough that job to have finished writing/refreshing every
-- flag for the day before this one reads coach_engagement_flags.
select cron.schedule('coach-engagement-decline-notify', '29 6 * * *',
  $$select public.coach_notify_engagement_flags()$$);

commit;
