begin;

-- Independent adversarial review, 2026-09-10, of 202609100002 (shipped and
-- deployed to production the same day). Confirmed real: coach_notify_
-- engagement_flags() could notify a flagged member about their OWN
-- engagement decline, if that member also holds a coach/admin/owner role -
-- a realistic shape in a small gym, where the coach is often also a
-- training member.
--
-- THE PROBLEM. mod_alert_recipients(v_flag.club_id) returns every
-- coach/admin/owner of the club with no exclusion for the flag's own
-- subject. notif_create()'s self-actor guard
-- (`v_actor is not null and p_user = v_actor`) never fires here because
-- v_actor is auth.uid(), which is NULL in this function's cron/service_role
-- context - there is no "actor" to compare against. Net effect: a coach
-- whose own attendance is declining could receive "חבר/ה עשוי/ה להתרחק"
-- about themselves.
--
-- coach_engagement_flags' OWN founding migration (202608280011) already
-- named this exact outcome, in these words, as the thing the whole feature
-- must never do: "this table says 'this member looks like they are
-- drifting away', and a member reading that about themselves - including a
-- member who is themselves a coach, an admin or the owner - is the exact
-- outcome the feature must never produce." The RLS policy on the table
-- itself still holds that line (user_id <> auth.uid() on every staff
-- policy) - this notify function opened a second channel to the same
-- information that policy never anticipated, because a push/in-app
-- notification is not a table read.
--
-- THE FIX. One added predicate: skip the flag's own subject when fanning
-- out. Same function, re-declared whole (this migration cannot edit
-- 202609100002 - already applied, migration-immutable) - every other line
-- is byte-identical to the version that shipped today.
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
    select f.id, f.club_id, f.level, f.user_id
    from public.coach_engagement_flags f
    where f.status = 'open' and f.notified_at is null
  loop
    v_level_label := case v_flag.level
      when 'inactive' then 'לא התאמן/ה שבועיים'
      when 'significant' then 'ירידה משמעותית בתדירות'
      else 'ירידה קלה בתדירות'
    end;
    for v_mod in select * from public.mod_alert_recipients(coalesce(v_flag.club_id, public.default_club_id())) loop
      -- THE FIX. A coach/admin/owner who is also this flag's own subject
      -- never receives this notification about themselves.
      if v_mod = v_flag.user_id then continue; end if;
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
  'Community structure research, 2026-09-10, self-notify fix (202609100003). Daily job, run after coach-engagement-decline: notifies every mod_alert_recipients() member of an open, not-yet-notified coach_engagement_flags row EXCEPT the flag''s own subject - a coach/admin/owner never gets notified about their own decline, per coach_engagement_flags'' founding guarantee (202608280011). One notification per flag row (notified_at gates it, same "notify once" idiom as challenges.ending_soon_notified_at). Deliberately carries no member name or handle in the notification title/body - PRIVACY.md documents this signal as hidden from the member it is about. No-ops (returns 0) while club_features.engagement_alerts is disabled. Scheduled as ''coach-engagement-decline-notify'' (unchanged, still fires at 06:29 UTC daily).';

commit;
