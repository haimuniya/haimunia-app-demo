begin;

-- Until now, looking up a member by handle or id, granting/revoking
-- coach, or removing someone required the Supabase SQL editor - there
-- was no in-app way to manage members at all beyond the moderation
-- queue (which only ever surfaces reported posts, not people). All four
-- functions below check real is_admin directly, matching every other
-- admin-only RPC in this file set (review_report, the moderation
-- visibility policy) - never the broader coach-inclusive is_staff().

-- Single search covering both a partial handle/name match and pasting
-- an exact user id, with role/join-date/last-activity in one call so
-- the admin panel doesn't need three separate queries across tables
-- that aren't otherwise readable cross-user (invite_redemptions is
-- self-select-only; activity_pings likewise).
create or replace function public.admin_search_members(p_query text) returns table(
  id uuid, handle text, display_name text, is_admin boolean, role text,
  redeemed_at timestamptz, last_activity_on date
)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  return query
    select p.id, p.handle, p.display_name, p.is_admin, ir.role, ir.redeemed_at,
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

create or replace function public.admin_grant_coach(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  update public.invite_redemptions set role = 'coach' where user_id = p_user_id;
  if not found then raise exception 'user must redeem a member invite before coach access is granted'; end if;
end $$;
revoke all on function public.admin_grant_coach(uuid) from public, anon;
grant execute on function public.admin_grant_coach(uuid) to authenticated;

create or replace function public.admin_revoke_coach(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  update public.invite_redemptions set role = 'member' where user_id = p_user_id;
end $$;
revoke all on function public.admin_revoke_coach(uuid) from public, anon;
grant execute on function public.admin_revoke_coach(uuid) to authenticated;

-- Mirrors request_account_deletion()'s own effect (immediate soft-delete
-- + a 30-day scheduled purge, same as self-service) - just triggered by
-- an admin for someone else instead.
create or replace function public.admin_remove_member(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  if p_user_id = auth.uid() then raise exception 'use account deletion for your own account'; end if;
  insert into public.account_deletion_requests(user_id) values (p_user_id)
    on conflict (user_id) do update set requested_at = now(), purge_after = now() + interval '30 days';
  update public.profiles set deleted_at = now() where id = p_user_id;
  update public.workout_posts set deleted_at = now() where author_id = p_user_id;
end $$;
revoke all on function public.admin_remove_member(uuid) from public, anon;
grant execute on function public.admin_remove_member(uuid) to authenticated;

-- A user id on its own (the only thing auth.users or most other tables
-- show) means nothing at a glance - this view is for browsing directly
-- in the Supabase SQL editor or Table Editor (both run as the project
-- owner and bypass RLS/grants entirely), not for the app: id sits next
-- to the handle, role, and the synthetic login email in one place, so a
-- one-off "who is this user id" or manual SQL fix doesn't need a
-- separate lookup first. No grants to anon/authenticated on purpose -
-- this is a dashboard convenience, not an API surface.
create or replace view public.admin_user_directory as
select
  p.id,
  p.handle,
  p.display_name,
  u.email as login_email,
  coalesce(ir.role, 'no redemption') as role,
  p.is_admin,
  ir.redeemed_at as joined_at,
  p.deleted_at
from public.profiles p
join auth.users u on u.id = p.id
left join public.invite_redemptions ir on ir.user_id = p.id
order by p.handle;
revoke all on public.admin_user_directory from public, anon, authenticated;

commit;
