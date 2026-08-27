begin;

-- Three real tiers now: admin (full access, including granting
-- admin/coach status to others — still only ever done manually via the
-- dashboard, no client path for that exists), coach (a fixed set of
-- powers, same for every coach — no per-coach member/class scoping,
-- since Arbox already owns classes and who's assigned to whom), member.
--
-- is_staff() is the shared check for "admin or coach" — a plain
-- (non-definer) function, since it only ever reads the caller's own
-- profiles row and their own invite_redemptions row, both of which the
-- caller already has SELECT on via existing self-scoped RLS policies.
create or replace function public.is_staff(p_uid uuid default auth.uid()) returns boolean
language sql stable security invoker set search_path = '' as $$
  select
    exists (select 1 from public.profiles where id = p_uid and is_admin and deleted_at is null)
    or exists (select 1 from public.invite_redemptions where user_id = p_uid and role = 'coach');
$$;
revoke all on function public.is_staff(uuid) from public, anon;
grant execute on function public.is_staff(uuid) to authenticated;

drop policy announcements_insert_admin on public.announcements;
create policy announcements_insert_admin on public.announcements for insert to authenticated
  with check (author_id = auth.uid() and public.is_staff());
drop policy announcements_update_admin on public.announcements;
create policy announcements_update_admin on public.announcements for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy weekly_challenges_insert_admin on public.weekly_challenges;
create policy weekly_challenges_insert_admin on public.weekly_challenges for insert to authenticated
  with check (created_by = auth.uid() and public.is_staff());

create or replace function public.coach_inactive_members(p_since date default (current_date - 7))
returns table(user_id uuid, handle text, display_name text, last_activity_on date)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff(auth.uid()) then
    raise exception 'not authorized';
  end if;
  return query
    select pr.id, pr.handle, pr.display_name, max(ap.activity_date)
    from public.profiles pr
    left join public.activity_pings ap on ap.user_id = pr.id
    where pr.deleted_at is null
    group by pr.id
    having max(ap.activity_date) is null or max(ap.activity_date) < p_since
    order by max(ap.activity_date) asc nulls first;
end $$;

create or replace function public.coach_new_members(p_within_days integer default 14)
returns table(user_id uuid, handle text, display_name text, first_activity_on date)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff(auth.uid()) then
    raise exception 'not authorized';
  end if;
  return query
    select pr.id, pr.handle, pr.display_name, min(ap.activity_date)
    from public.profiles pr
    join public.activity_pings ap on ap.user_id = pr.id
    where pr.deleted_at is null
    group by pr.id
    having min(ap.activity_date) >= (current_date - p_within_days)
    order by min(ap.activity_date) desc;
end $$;

commit;
