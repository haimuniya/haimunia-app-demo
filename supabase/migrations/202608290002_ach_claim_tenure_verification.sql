begin;

-- COMM-130 follow-up. Closes a gaming gap in ach_claim() found while writing
-- pgTAP coverage for 202608280020: the four club-category anniversary rows
-- (anniversary_year_1/2/3/5) are seeded config->>'client_claimable' = 'true'
-- like every other client-detected milestone, but unlike session count, PR
-- count, week streak, and Rx count, membership tenure is not something only
-- the device can see. It is a pure function of a server-set timestamp this
-- database already owns: public.invite_redemptions.redeemed_at, defaulted
-- now() at redemption, one row per user_id, never client-writable (see
-- 202608270003 - there is no insert policy for authenticated on that table,
-- only redeem_invite_code()). Trusting the client's say-so on a number the
-- server can check for free was the bug: any member could call
-- ach_claim(array['anniversary_year_5']) the day they joined and be granted
-- the 5-year badge.
--
-- The fix is metric-keyed, not code-keyed: any accepted definition whose
-- config->>'metric' = 'tenure_days' must also satisfy
-- redeemed_at <= now() - threshold days, independent of what the client
-- claims. Every other client_claimable metric (session_count, pr_count,
-- week_streak, pr_category_spread, rx_count) is untouched by this change and
-- still relies on the definition row as the only boundary, because those
-- counts genuinely have no server-side source yet (see the 202608280020
-- doc comment on why ach_claim exists at all). If a future definition ever
-- reuses config->>'metric' = 'tenure_days' it is covered automatically,
-- with no further migration required.
create or replace function public.ach_claim(p_codes text[]) returns setof public.ach_claim_row
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_codes text[];
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  -- Same gate every other community write carries. Reading achievements
  -- stays open; awarding one does not.
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

  -- A null or empty array is a no-op, not an error: the client calls this
  -- on every sync and usually has nothing to claim.
  if p_codes is null or array_length(p_codes, 1) is null then return; end if;
  if array_length(p_codes, 1) > 50 then raise exception 'at most 50 codes per call'; end if;

  -- The write side is bounded by the definitions themselves (once per
  -- non-repeatable code), but a repeatable client-claimable definition
  -- would otherwise be an unbounded insert loop, so the call itself is
  -- limited the same way every other member write path is.
  if not public.check_rate_limit('ach_claim', 30, 10) then raise exception 'rate_limited'; end if;

  select array_agg(distinct t.code) into v_codes
  from unnest(p_codes) as t(code)
  where t.code is not null and t.code <> '';
  if v_codes is null then return; end if;

  return query
  with accepted as (
    select d.id, d.code, d.visibility, d.repeatable
    from public.achievement_definitions d
    where d.code = any(v_codes)
      and d.enabled
      and d.trigger_type <> 'ATTENDANCE_RECORDED'
      and coalesce(d.config ->> 'client_claimable', '') = 'true'
      -- A non-repeatable code already held is silently absent from the
      -- result rather than an error, so a replay after a reinstall
      -- celebrates nothing.
      and (
        d.repeatable
        or not exists (
          select 1 from public.member_achievements ma
          where ma.user_id = v_uid and ma.achievement_id = d.id
        )
      )
      -- Tenure is independently verified against invite_redemptions, a
      -- server-set timestamp, rather than trusted from the client like the
      -- other client_claimable metrics. Anything not tenure-metered short
      -- circuits true here and is unaffected.
      and (
        coalesce(d.config ->> 'metric', '') <> 'tenure_days'
        or exists (
          select 1 from public.invite_redemptions ir
          where ir.user_id = v_uid
            and ir.redeemed_at <= now() - (d.threshold || ' days')::interval
        )
      )
  ), ins as (
    insert into public.member_achievements (user_id, achievement_id, visibility)
    select v_uid, a.id, a.visibility from accepted a
    -- member_achievements_once_idx is what actually holds the once rule
    -- under two concurrent claims; the NOT EXISTS above only narrows the
    -- common case. A lost race is swallowed, never surfaced.
    on conflict do nothing
    returning id, achievement_id, visibility
  )
  select a.code, ins.id, ins.visibility
  from ins join accepted a on a.id = ins.achievement_id;
end $$;

revoke all on function public.ach_claim(text[]) from public, anon;
grant execute on function public.ach_claim(text[]) to authenticated;

commit;
