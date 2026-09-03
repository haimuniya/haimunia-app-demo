begin;

-- COMM-375. The registration funnel: of everyone invited, how many joined,
-- finished their profile, and verified - and where the drop-off is.
-- Follows analytics_dashboard (COMM-310, 202609010006) exactly: one call,
-- a validated-never-clamped period, community.analytics.view or real
-- is_admin(), aggregate only, ratios null rather than zero over an empty
-- denominator. No new table; reads invite_codes, invites,
-- invite_redemptions and profiles only.
--
-- THE DENOMINATOR QUESTION (backlog Phase 4 open question 7, resolved as
-- built here). funnel.invites_issued counts PER-PERSON invites only. A
-- shared code has no "issued" event to divide by - it is one standing
-- reusable row, not a thing sent to a named person - so folding it in
-- would mean counting a redemption as its own issuance and making the
-- funnel's first step tautological for any club that mostly uses the
-- shared code. Shared-code activity is reported beside the funnel, in its
-- own `shared_codes` key.
--
-- The consequence is stated rather than hidden: redeemed, profile_completed
-- and verified count EVERY account in the period regardless of which invite
-- type it came through, so `redeemed` can legitimately exceed
-- `invites_issued`, and redeemed_rate can legitimately exceed 1. That is a
-- real shape for a shared-code club, not a bug, and COMM-379 should render
-- it as one.

create or replace function public.registration_funnel(
  p_period_start date, p_period_end date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_from timestamptz;
  v_to   timestamptz;
  v_days integer;
  v_now  timestamptz := now();

  v_shared_active      bigint;
  v_shared_redemptions bigint;

  v_pp_created  bigint;
  v_pp_redeemed bigint;
  v_pp_revoked  bigint;
  v_pp_pending  bigint;
  v_pp_expired  bigint;

  v_redeemed  bigint;
  v_completed bigint;
  v_verified  bigint;
begin
  -- -------------------------------------------------------------------
  -- AUTH, before anything is read. Same pair, same order, as
  -- analytics_dashboard - NOT is_staff(), so a coach is refused.
  -- -------------------------------------------------------------------
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.analytics.view') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  -- -------------------------------------------------------------------
  -- PERIOD VALIDATION. Byte-for-byte analytics_dashboard's rules and its
  -- three error strings: validated, never clamped, so a number can never
  -- be labelled with a range it was not computed over.
  -- -------------------------------------------------------------------
  if p_period_start is null or p_period_end is null then
    raise exception 'period required';
  end if;
  if p_period_end < p_period_start then
    raise exception 'period end before start';
  end if;
  if (p_period_end - p_period_start) > 365 then
    raise exception 'period exceeds 366 days';
  end if;

  v_from := p_period_start::timestamptz;
  v_to   := (p_period_end + 1)::timestamptz;   -- p_period_end is INCLUSIVE
  v_days := (p_period_end - p_period_start) + 1;

  -- -------------------------------------------------------------------
  -- SHARED CODES. Reported beside the funnel, never inside it.
  -- -------------------------------------------------------------------
  -- "Active" is as-of-NOW, not as-of-period: it answers "how many shared
  -- codes are live right now", which is a configuration question, not a
  -- period metric. The predicate is exactly redeem_invite_code's own
  -- shared-code liveness test minus the use_count clause, so a code this
  -- counts is a code that would match today.
  select count(*) into v_shared_active
  from public.invite_codes c
  where c.active and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > v_now);

  -- Redemptions THROUGH a shared code in the period. invite_id non-null is
  -- what makes it a shared-code redemption (202609030003's
  -- invite_redemptions_one_invite_source CHECK guarantees exactly one of
  -- the two id columns is set, so this partition is total and disjoint).
  select count(*) into v_shared_redemptions
  from public.invite_redemptions r
  where r.invite_id is not null
    and r.redeemed_at >= v_from and r.redeemed_at < v_to;

  -- -------------------------------------------------------------------
  -- PER-PERSON INVITES.
  -- -------------------------------------------------------------------
  select
    count(*) filter (where i.created_at  >= v_from and i.created_at  < v_to),
    count(*) filter (where i.redeemed_at >= v_from and i.redeemed_at < v_to),
    count(*) filter (where i.revoked_at  >= v_from and i.revoked_at  < v_to)
  into v_pp_created, v_pp_redeemed, v_pp_revoked
  from public.invites i;

  -- pending_now and expired_unredeemed_now are as-of-NOW by name and by
  -- intent - "what is outstanding on my desk today" - so they are
  -- deliberately not period-filtered. Both go through invite_status(), the
  -- same function admin_invite_list filters and labels with, so the count
  -- on the dashboard and the rows on the invite screen cannot disagree.
  select
    count(*) filter (where public.invite_status(i.revoked_at, i.redeemed_at, i.expires_at, v_now) = 'pending'),
    count(*) filter (where public.invite_status(i.revoked_at, i.redeemed_at, i.expires_at, v_now) = 'expired')
  into v_pp_pending, v_pp_expired
  from public.invites i;

  -- -------------------------------------------------------------------
  -- THE THREE DOWNSTREAM STEPS. Every account, both invite types.
  -- -------------------------------------------------------------------
  select count(*) into v_redeemed
  from public.invite_redemptions r
  where r.redeemed_at >= v_from and r.redeemed_at < v_to;

  -- "Profile completed" = a profiles row exists. The flow this schema
  -- enforces is redeem -> set credentials -> the profile form -> the
  -- profiles insert (profiles_insert_self, 202608270003, requires the
  -- redemption to already be there), so the row existing is the
  -- server-observable marker of that step finishing.
  --
  -- deleted_at is NOT filtered, on purpose: a member who completed their
  -- profile in the period and later deleted their account still completed
  -- that step, and excluding them would silently rewrite a past period's
  -- funnel every time someone leaves.
  select count(*) into v_completed
  from public.profiles p
  where p.created_at >= v_from and p.created_at < v_to;

  select count(*) into v_verified
  from public.profiles p
  where p.recovery_verified_at >= v_from and p.recovery_verified_at < v_to;

  -- -------------------------------------------------------------------
  -- Every ratio through analytics_ratio(): null, never 0, over a zero
  -- denominator. An honest zero and an undefined rate are different
  -- claims; the client renders the second as an em dash.
  -- -------------------------------------------------------------------
  return jsonb_build_object(
    'period', jsonb_build_object(
      'start', p_period_start,
      'end', p_period_end,
      'end_exclusive', p_period_end + 1,
      'days', v_days),

    'shared_codes', jsonb_build_object(
      'active_count', v_shared_active,
      'redemptions_in_period', v_shared_redemptions),

    'per_person_invites', jsonb_build_object(
      'created_in_period', v_pp_created,
      'redeemed_in_period', v_pp_redeemed,
      'revoked_in_period', v_pp_revoked,
      'pending_now', v_pp_pending,
      'expired_unredeemed_now', v_pp_expired),

    'funnel', jsonb_build_object(
      'invites_issued', v_pp_created,
      'redeemed', v_redeemed,
      'profile_completed', v_completed,
      'verified', v_verified,
      'redeemed_rate', public.analytics_ratio(v_redeemed, v_pp_created),
      'profile_completed_rate', public.analytics_ratio(v_completed, v_redeemed),
      'verified_rate', public.analytics_ratio(v_verified, v_completed)));
end $$;
revoke all on function public.registration_funnel(date, date) from public, anon;
grant execute on function public.registration_funnel(date, date) to authenticated;

comment on function public.registration_funnel(date, date) is
  'COMM-375. The registration funnel for one period, in one call. AUTH: security definer, stable; auth.uid() checked first, then has_perm(''community.analytics.view'') or is_admin() - the same pair and order as analytics_dashboard, NOT is_staff(), so a coach is refused. Raises ''not authorized'', ''period required'', ''period end before start'', ''period exceeds 366 days'' (all P0001); the period is validated, never clamped. p_period_end is INCLUSIVE; the half-open bound is returned as period.end_exclusive. RETURNS jsonb {period{start,end,end_exclusive,days}, shared_codes{active_count,redemptions_in_period}, per_person_invites{created_in_period,redeemed_in_period,revoked_in_period,pending_now,expired_unredeemed_now}, funnel{invites_issued,redeemed,profile_completed,verified,redeemed_rate,profile_completed_rate,verified_rate}}. funnel.invites_issued and redeemed_rate cover PER-PERSON invites only (backlog Phase 4 open question 7): a shared code has no issuance event, so shared activity is reported in shared_codes instead. redeemed/profile_completed/verified count every account regardless of invite type, so redeemed CAN exceed invites_issued and redeemed_rate CAN exceed 1 in a shared-code club - a real shape, not a bug. active_count, pending_now and expired_unredeemed_now are as-of-now by intent, not period-filtered; pending/expired go through invite_status() so they agree with admin_invite_list. Profile completed = a profiles row created in the period (soft-deleted profiles included, so a past period''s funnel does not change when someone leaves); verified = recovery_verified_at in the period. Ratios are null, never 0, over a zero denominator. AGGREGATE ONLY: every value is a count, a ratio or a date - no member id, handle or display name anywhere. Read-only, no side effects. DEFINER because invite_codes and invites have no client grant at all and invite_redemptions is own-row only.';

commit;
