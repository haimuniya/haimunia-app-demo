begin;

-- "What's next" research, 2026-09-10: coach_notify_engagement_flags()
-- (202609100002, self-notify fix in 202609100003) fans out ONE
-- notif_create() call per (flag x recipient) pair, and the client
-- registers engagement_decline_flagged as mode:"immediate". Production had
-- zero open un-notified flags at deploy time, so the very first real run
-- was a non-event - but the underlying shape is still a real risk, not a
-- hypothetical one: coach_detect_engagement_decline() runs daily
-- regardless of whether anyone is listening, so ANY stretch where
-- engagement_alerts sits disabled (the admin toggle this feature shipped
-- specifically so an owner could turn it off) accumulates un-notified
-- flags silently. Re-enabling it then dumps the whole backlog as N
-- separate immediate pings to every coach/admin in one run - exactly the
-- "3 members need attention" case reading as 3 separate interruptions
-- instead of one, the failure mode the research flagged.
--
-- THE FIX. Not the generic cross-type notification_batches/
-- notif_queue_batched() mechanism (202608280018) that reaction/
-- comment_also/feed_activity already use: that pools by (user, category),
-- and engagement_decline_flagged shares category 'community' with casual
-- social batched types (reactions, comment activity) - mixing a "a member
-- may be drifting away, a human should reach out" signal into the same
-- rolled-up digest as reaction counts would bury exactly the thing that
-- needs to stand out. Instead: per run, per recipient, count how many
-- open un-notified flags actually apply to THEM (excluding their own, per
-- 202609100003's fix) - one flag still gets today's specific, single-flag
-- wording and its own deep link; more than one gets ONE consolidated
-- notification naming the count, not N separate ones. The common case
-- (flags trickle in roughly one per day, matching the daily detection
-- cadence) is unchanged; only a genuine burst is affected.
create or replace function public.coach_notify_engagement_flags() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_written integer := 0;
  v_flag_count integer;
  v_club uuid;
  v_mod uuid;
  v_applicable integer;
  v_solo record;
  v_level_label text;
begin
  if not public.club_feature_enabled('engagement_alerts') then
    return 0;
  end if;

  select count(*) into v_flag_count
  from public.coach_engagement_flags f
  where f.status = 'open' and f.notified_at is null;

  if coalesce(v_flag_count, 0) = 0 then
    return 0;
  end if;

  -- Single implicit club throughout this schema (default_club_id() is the
  -- one club_features/mod_alert_recipients ever resolve against) - no
  -- per-flag club_id aggregation needed, and uuid has no max()/min()
  -- aggregate to do one with anyway.
  v_club := public.default_club_id();

  for v_mod in select * from public.mod_alert_recipients(v_club) loop
    -- How many of the due flags actually apply to THIS recipient, once
    -- their own (if any) is excluded - 202609100003's self-notify rule,
    -- preserved exactly, just computed per-recipient instead of per-flag
    -- now that one notification can cover several flags at once.
    select count(*) into v_applicable
    from public.coach_engagement_flags f
    where f.status = 'open' and f.notified_at is null and f.user_id <> v_mod;

    if v_applicable = 0 then
      continue;
    elsif v_applicable = 1 then
      -- Exactly one flag applies - today's original, specific wording and
      -- deep link to that one flag, unchanged from 202609100002/3.
      select f.id, f.level into v_solo
      from public.coach_engagement_flags f
      where f.status = 'open' and f.notified_at is null and f.user_id <> v_mod
      limit 1;
      v_level_label := case v_solo.level
        when 'inactive' then 'לא התאמן/ה שבועיים'
        when 'significant' then 'ירידה משמעותית בתדירות'
        else 'ירידה קלה בתדירות'
      end;
      if public.notif_create(
        v_mod, 'engagement_decline_flagged', 'community',
        'חבר/ה עשוי/ה להתרחק',
        v_level_label || ' - פרטים בלוח המאמנים',
        'coach_engagement_flag', v_solo.id, '/community/coach'
      ) is not null then
        v_written := v_written + 1;
      end if;
    else
      -- A genuine burst for this recipient - one consolidated notification
      -- naming the count, not v_applicable separate pings. source_id is
      -- null: there is no single flag this notification is "about" any
      -- more, same reasoning notif_create() already applies to every
      -- system-generated type with no one source row (weekly_recap,
      -- monthly_club_recap).
      if public.notif_create(
        v_mod, 'engagement_decline_flagged', 'community',
        v_applicable || ' חברים עשויים להתרחק',
        'כמה חברים עשויים להתרחק מהמועדון - פרטים בלוח המאמנים',
        'coach_engagement_flag', null, '/community/coach'
      ) is not null then
        v_written := v_written + 1;
      end if;
    end if;
  end loop;

  update public.coach_engagement_flags
  set notified_at = now()
  where status = 'open' and notified_at is null;

  return v_written;
end $$;
revoke all on function public.coach_notify_engagement_flags() from public, anon, authenticated;
grant execute on function public.coach_notify_engagement_flags() to service_role;
comment on function public.coach_notify_engagement_flags() is
  'Community structure research, 2026-09-10, burst guard (202609100004). Daily job, run after coach-engagement-decline: notifies every mod_alert_recipients() member of the club about open, not-yet-notified coach_engagement_flags rows, EXCLUDING the recipient''s own (202609100003) - one specific per-flag notification when exactly one applies to a given recipient (unchanged wording/deep-link from 202609100002/3), ONE consolidated count-only notification when several apply at once (a burst - e.g. engagement_alerts was disabled for a while and re-enabled), never N separate immediate pings for N flags in one run. No member name or handle in either case - PRIVACY.md: hidden from the member it is about. No-ops (returns 0) while club_features.engagement_alerts is disabled or no flags are due. Scheduled as ''coach-engagement-decline-notify'' (unchanged, 06:29 UTC daily).';

commit;
