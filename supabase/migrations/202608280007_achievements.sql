begin;

-- COMM-004. Achievements are rows, not code.

create table public.achievement_definitions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{2,63}$'),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  category text not null check (category in ('consistency', 'performance', 'progress', 'community', 'challenge', 'club')),
  trigger_type text not null check (trigger_type in (
    'WORKOUT_COMPLETED', 'PR_CREATED', 'MEMBER_JOINED', 'COMMENT_CREATED',
    'REACTION_CREATED', 'CHALLENGE_COMPLETED', 'EVENT_ATTENDED', 'ATTENDANCE_RECORDED'
  )),
  threshold numeric,
  repeatable boolean not null default false,
  visibility text not null default 'club' check (visibility in ('club', 'friends', 'only_me')),
  icon text check (icon is null or char_length(icon) <= 80),
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index achievement_definitions_trigger_idx on public.achievement_definitions(trigger_type) where enabled;

create table public.member_achievements (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  user_id uuid not null references public.profiles(id) on delete cascade,
  achievement_id uuid not null references public.achievement_definitions(id) on delete cascade,
  source_id uuid,
  unlocked_at timestamptz not null default now(),
  shared_at timestamptz,
  visibility text not null default 'club' check (visibility in ('club', 'friends', 'only_me')),
  -- Copied from the definition by the trigger below, purely so the
  -- "unlock once" rule can be a partial unique INDEX. A partial index
  -- cannot reach into another table, and a unique index is the only form
  -- of this rule that holds when ach_evaluate() runs twice concurrently
  -- for the same member.
  repeatable boolean not null default false
);
create unique index member_achievements_once_idx
  on public.member_achievements(user_id, achievement_id) where not repeatable;
create index member_achievements_user_idx on public.member_achievements(user_id, unlocked_at desc);

create or replace function public.sync_member_achievement_repeatable() returns trigger
language plpgsql set search_path = '' as $$
begin
  select d.repeatable into new.repeatable
  from public.achievement_definitions d where d.id = new.achievement_id;
  if new.repeatable is null then raise exception 'unknown achievement definition'; end if;
  return new;
end $$;
create trigger member_achievements_sync_repeatable before insert or update of achievement_id
  on public.member_achievements for each row execute function public.sync_member_achievement_repeatable();

alter table public.achievement_definitions enable row level security;
alter table public.member_achievements enable row level security;

revoke all on public.achievement_definitions, public.member_achievements from public, anon;
grant select on public.achievement_definitions to authenticated;
grant insert, update, delete on public.achievement_definitions to authenticated;
grant select on public.member_achievements to authenticated;

create policy achievement_definitions_read on public.achievement_definitions for select to authenticated
  using (true);
create policy achievement_definitions_insert_admin on public.achievement_definitions for insert to authenticated
  with check (public.is_admin());
create policy achievement_definitions_update_admin on public.achievement_definitions for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy achievement_definitions_delete_admin on public.achievement_definitions for delete to authenticated
  using (public.is_admin());

-- The owner always sees their own unlocks. Another member sees one only
-- when the unlock is club-visible AND the owner has not switched
-- show_achievements off AND no block edge sits between them - all three
-- resolved by can_view_profile_field(), so the leaderboard, profile, and
-- feed paths cannot drift apart.
create policy member_achievements_read on public.member_achievements for select to authenticated using (
  user_id = auth.uid()
  or (
    visibility = 'club'
    and public.can_view_profile_field(user_id, 'show_achievements')
  )
  or (
    visibility = 'friends'
    and public.are_friends(user_id)
    and public.can_view_profile_field(user_id, 'show_achievements')
  )
);

-- No insert, update, or delete policy and no write grant: unlocks come
-- from ach_evaluate() (COMM-130) under the service role, and the share
-- stamp comes from ach_share(). A member cannot award themselves.

-- The attendance-triggered seams the plan asks Phase 0 to leave behind:
-- present, described, and disabled until an attendance source exists
-- (COMM-P03). Enabling them later is an UPDATE, not a migration.
insert into public.achievement_definitions
  (code, name, description, category, trigger_type, threshold, repeatable, enabled)
values
  ('attendance_first_class', 'First class', 'Attended a first class', 'consistency', 'ATTENDANCE_RECORDED', 1, false, false),
  ('attendance_25_classes', '25 classes', 'Attended 25 classes', 'consistency', 'ATTENDANCE_RECORDED', 25, false, false),
  ('attendance_100_classes', '100 classes', 'Attended 100 classes', 'consistency', 'ATTENDANCE_RECORDED', 100, false, false),
  ('attendance_weekly_streak', 'Weekly streak', 'Trained every week in a row', 'consistency', 'ATTENDANCE_RECORDED', 4, true, false)
on conflict (code) do nothing;

commit;
