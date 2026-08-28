begin;

-- COMM-011. The seam for the coach Engage section (COMM-P04 / COMM-304).
-- Ships empty and stays empty: no producer writes to it until an
-- attendance source exists, so wiring it later is data, not schema.

create table public.coach_engagement_flags (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  user_id uuid not null references public.profiles(id) on delete cascade,
  level text not null check (level in ('mild', 'significant', 'inactive')),
  baseline_sessions_per_week numeric,
  recent_sessions_per_week numeric,
  flagged_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed'))
);
create index coach_engagement_flags_open_idx on public.coach_engagement_flags(status, flagged_at desc);
create index coach_engagement_flags_user_idx on public.coach_engagement_flags(user_id);

alter table public.coach_engagement_flags enable row level security;
revoke all on public.coach_engagement_flags from public, anon;
grant select, insert, update, delete on public.coach_engagement_flags to authenticated;

-- `user_id <> auth.uid()` is not decoration. This table says "this member
-- looks like they are drifting away", and a member reading that about
-- themselves is the exact outcome the feature must never produce. The
-- clause is repeated on every policy rather than factored out, because a
-- staff member is also a member and would otherwise read their own flag
-- through the staff branch.
create policy coach_engagement_flags_staff_select on public.coach_engagement_flags for select to authenticated
  using ((public.has_perm('community.member.restrict') or public.is_staff()) and user_id <> auth.uid());
create policy coach_engagement_flags_staff_insert on public.coach_engagement_flags for insert to authenticated
  with check ((public.has_perm('community.member.restrict') or public.is_staff()) and user_id <> auth.uid());
create policy coach_engagement_flags_staff_update on public.coach_engagement_flags for update to authenticated
  using ((public.has_perm('community.member.restrict') or public.is_staff()) and user_id <> auth.uid())
  with check ((public.has_perm('community.member.restrict') or public.is_staff()) and user_id <> auth.uid());
create policy coach_engagement_flags_staff_delete on public.coach_engagement_flags for delete to authenticated
  using ((public.has_perm('community.member.restrict') or public.is_staff()) and user_id <> auth.uid());

commit;
