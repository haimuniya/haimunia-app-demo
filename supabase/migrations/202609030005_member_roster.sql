begin;

-- COMM-374. The browse path onto membership that admin_search_members
-- (202608270011, widened for avatar_url in 202609010013) does not offer:
-- that function needs a query and caps at 20 rows, so there has never been
-- a way to simply page through the whole club.
--
-- SHAPE. Returns admin_search_members' exact eight columns, in its exact
-- order, so COMM-377's roster screen shares one row renderer with the
-- existing search UI rather than growing a second one. `returns table(...)`
-- and not the `setof jsonb` contracts.md proposed - the ticket's own
-- migration outline specifies the table form, and it is what makes the
-- "identical shape" claim checkable by the type system instead of by
-- convention.
--
-- AUTH IS is_staff(), NOT the is_admin() admin_search_members uses. A
-- coach may browse the roster read-only, which is COMM-374's explicit
-- criterion and the same rank the coach dashboard already requires. The
-- ROLE-CHANGE actions are untouched by this file and stay where they are -
-- admin_grant_coach / admin_revoke_coach, each with a real inline
-- is_admin() check - so a coach paging the roster sees every row and can
-- act on none of them. The client disabling those controls is a courtesy;
-- the server refusing them is the boundary.
--
-- ORDER AND CURSOR. coalesce(invite_redemptions.redeemed_at,
-- profiles.created_at) descending - this module's existing tenure-fallback
-- convention (community_profile, consistency_week_streaks). The fallback is
-- what keeps COMM-374's last criterion true: a member with no
-- invite_redemptions row (mid-signup, or a pre-invite-gate legacy account)
-- still appears, with redeemed_at null, instead of being dropped by the
-- ordering key being null.
create or replace function public.admin_member_roster(
  p_cursor timestamptz default null,
  p_limit integer default 25)
returns table(
  id uuid, handle text, display_name text, avatar_url text, is_admin boolean, role text,
  redeemed_at timestamptz, last_activity_on date
)
language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;

  -- Clamped 1..100, admin_actions_page and mod_queue's convention.
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);

  return query
    select p.id, p.handle, p.display_name, p.avatar_url, p.is_admin, ir.role, ir.redeemed_at,
      (select max(ap.activity_date) from public.activity_pings ap where ap.user_id = p.id) as last_activity_on
    from public.profiles p
    left join public.invite_redemptions ir on ir.user_id = p.id
    where p.deleted_at is null
      and (p_cursor is null or coalesce(ir.redeemed_at, p.created_at) < p_cursor)
    -- p.id is the tie-break, not decoration: the coalesced join date is not
    -- unique (a club that imported members shares one timestamp across
    -- many rows), and a cursor paginator whose sort key repeats can loop or
    -- skip. The client pages on the last row's join date, so a duplicated
    -- timestamp is still a real edge here - the tie-break at least makes
    -- the server-side order total and stable between calls.
    order by coalesce(ir.redeemed_at, p.created_at) desc, p.id
    limit v_limit;
end $$;
revoke all on function public.admin_member_roster(timestamptz, integer) from public, anon;
grant execute on function public.admin_member_roster(timestamptz, integer) to authenticated;

comment on function public.admin_member_roster(timestamptz, integer) is
  'COMM-374. One page of the full member roster, newest-joined first, cursor-paginated on coalesce(invite_redemptions.redeemed_at, profiles.created_at) desc with profiles.id as tie-break. AUTH: security definer; auth.uid() first, then is_staff() - a coach may browse read-only, deliberately looser than admin_search_members'' is_admin(). Raises ''not authorized''. p_limit clamped 1..100. RETURNS admin_search_members'' exact eight columns in its exact order (id, handle, display_name, avatar_url, is_admin, role, redeemed_at, last_activity_on) so one client row renderer serves both surfaces - `returns table(...)`, not the setof jsonb contracts.md proposed. Excludes soft-deleted profiles. A profile with no invite_redemptions row still appears with role and redeemed_at null, rather than being dropped. Read-only; grants nothing - role changes remain on admin_grant_coach/admin_revoke_coach with their own inline is_admin() checks.';

commit;
