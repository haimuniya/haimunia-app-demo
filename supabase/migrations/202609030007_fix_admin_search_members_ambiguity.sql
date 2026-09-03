begin;

-- Standalone fix, found while building COMM-374's roster RPC. Not a Phase 4
-- ticket; filed here because COMM-377 (the roster screen) is specified to
-- reuse admin_search_members' row renderer and its role-change controls,
-- and that surface does not currently work at all.
--
-- THE BUG. public.admin_search_members(text) has raised
--   42702  column reference "id" is ambiguous
-- for EVERY caller, including a real admin, since the day it was written
-- (202608270011, Phase 0). It is not a regression from 202609010013, which
-- only added avatar_url and copied the defect forward verbatim.
--
-- The function is declared `returns table(id uuid, handle text, ...)`, and
-- in PL/pgSQL those OUT parameters are in scope as variables for the whole
-- body. Its very first statement is:
--
--   if not exists (select 1 from public.profiles
--                  where id = auth.uid() and is_admin and deleted_at is null)
--
-- `id` there could mean the OUT parameter or profiles.id, and `is_admin`
-- and `deleted_at` are equally ambiguous (`is_admin` is both an OUT
-- parameter and a profiles column). PL/pgSQL's default variable_conflict
-- setting is `error`, so it refuses rather than guessing - and it refuses
-- BEFORE the permission check can succeed or fail, which is why the failure
-- looks like a hard error rather than a permission denial.
--
-- WHY NOBODY CAUGHT IT. The two pgTAP files that touch this function only
-- ever assert the REFUSAL path for a non-admin (throws_ok ... 'not
-- authorized'), and a caller who is not an admin gets an exception either
-- way - just with a different SQLSTATE than the one asserted. There has
-- never been an assertion that an admin gets ROWS back. This file adds one
-- (supabase/tests/0062).
--
-- The sibling functions in 202608270011 - admin_grant_coach,
-- admin_revoke_coach - carry the byte-identical WHERE clause and are FINE,
-- because they return void and so have no OUT parameters to collide with.
-- That is exactly why the defect survived: the guard was copy-pasted into
-- three functions and only the one with a result table was poisoned by it.
--
-- THE FIX is to alias the table in the guard so every reference is
-- qualified. Nothing else about the function changes: same signature, same
-- returned columns in the same order, same query, same limit, same order
-- by, same grants. DROP first for the same reason 202609010013 gives -
-- create or replace cannot alter a `returns table(...)` row type - except
-- here the row type is unchanged, so a plain create or replace would do;
-- the drop is kept only so this file reads the same as its predecessor and
-- is safe to re-run against either shape.
drop function if exists public.admin_search_members(text);
create function public.admin_search_members(p_query text) returns table(
  id uuid, handle text, display_name text, avatar_url text, is_admin boolean, role text,
  redeemed_at timestamptz, last_activity_on date
)
language plpgsql security definer set search_path = '' as $$
begin
  -- `pr`, not a bare `public.profiles`: with OUT parameters named id and
  -- is_admin in scope, every column in this guard has to be qualified.
  if not exists (select 1 from public.profiles pr
                 where pr.id = auth.uid() and pr.is_admin and pr.deleted_at is null) then
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

comment on function public.admin_search_members(text) is
  'Admin member search, backing the Account tab''s member-management list. Requires a real is_admin() profile (the literal inline check from 202608270011, deliberately NOT is_staff() - COMM-374''s admin_member_roster is the coach-readable browse path). Raises ''not authorized'' (P0001). Returns up to 20 matches on id, handle or display_name, ordered by handle: id, handle, display_name, avatar_url, is_admin, role, redeemed_at, last_activity_on. SECURITY DEFINER for invite_redemptions (self-select only) and activity_pings. FIXED 202609030007: from 202608270011 until this migration the function raised 42702 "column reference id is ambiguous" for every caller including admins, because its `returns table(id uuid, ...)` OUT parameters shadowed profiles.id/is_admin/deleted_at in its own authorization guard. Behaviour is otherwise unchanged.';

commit;
