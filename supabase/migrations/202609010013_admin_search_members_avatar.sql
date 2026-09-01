begin;

-- COMM-318 client half. admin_search_members (202608270011) never returned
-- avatar_url, so the admin member-management row (cloud.js rowHtml()) could
-- not thread a real photo through to avatarHtml() the way every other
-- member row in the app already can. Adding the one column, everything
-- else byte-identical to the live function.
--
-- DROP first: create or replace cannot change a `returns table(...)`
-- function's OUT-parameter row type, only replace its body under an
-- unchanged signature (Postgres error 42P13). Adding a column is a real
-- row-type change, so the old shape has to go before the new one can exist.
drop function if exists public.admin_search_members(text);
create function public.admin_search_members(p_query text) returns table(
  id uuid, handle text, display_name text, avatar_url text, is_admin boolean, role text,
  redeemed_at timestamptz, last_activity_on date
)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  return query
    select p.id, p.handle, p.display_name, p.avatar_url, p.is_admin, ir.role, ir.redeemed_at,
      (select max(ap.activity_date) from public.activity_pings ap where ap.user_id = p.id) as last_activity_on
    from public.profiles p
    left join public.invite_redemptions ir on ir.user_id = p.id
    where p.deleted_at is null
      and (p.id::text = p_query or p.handle ilike '%' || p_query || '%' or coalesce(p.display_name, '') ilike '%' || p_query || '%')
    order by p.handle
    limit 20;
end $$;
revoke all on function public.admin_search_members(text) from public, anon;
grant execute on function public.admin_search_members(text) to authenticated;

commit;
