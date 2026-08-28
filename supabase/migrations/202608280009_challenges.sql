begin;

-- COMM-006. A home for the six challenge types, their participants,
-- teams, and an append-only progress log. Nothing reads these until
-- Phase 2 (COMM-201 onward); the existing weekly_challenges table keeps
-- serving the current weekly challenge until COMM-201 generalizes it.

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  challenge_type text not null check (challenge_type in (
    'individual_target', 'individual_performance', 'cooperative', 'team', 'consistency', 'coach'
  )),
  metric_type text not null check (char_length(metric_type) between 1 and 60),
  target_value numeric,
  start_at timestamptz not null,
  end_at timestamptz not null,
  join_mode text not null default 'open' check (join_mode in ('open', 'invite', 'auto')),
  visibility text not null default 'club' check (visibility in ('club', 'friends', 'only_me')),
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'archived')),
  created_by uuid references public.profiles(id) on delete set null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index challenges_active_idx on public.challenges(status, end_at desc);

create table public.challenge_teams (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (challenge_id, name)
);

create table public.challenge_participants (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  team_id uuid references public.challenge_teams(id) on delete set null,
  joined_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'completed', 'withdrawn')),
  progress_value numeric not null default 0,
  completed_at timestamptz,
  primary key (challenge_id, user_id)
);
create index challenge_participants_user_idx on public.challenge_participants(user_id);
create index challenge_participants_team_idx on public.challenge_participants(team_id);

-- Append-only contribution log. progress_value on the participant row is
-- the running total; this is the audit trail behind it, which is what
-- makes a recomputation possible after a correction.
create table public.challenge_progress (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delta numeric not null,
  source_type text check (source_type is null or char_length(source_type) <= 40),
  source_id uuid,
  created_at timestamptz not null default now()
);
create index challenge_progress_challenge_idx on public.challenge_progress(challenge_id, created_at desc);
create index challenge_progress_user_idx on public.challenge_progress(challenge_id, user_id);

alter table public.challenges enable row level security;
alter table public.challenge_teams enable row level security;
alter table public.challenge_participants enable row level security;
alter table public.challenge_progress enable row level security;

revoke all on public.challenges, public.challenge_teams, public.challenge_participants, public.challenge_progress from public, anon;
grant select, insert, update, delete on public.challenges to authenticated;
grant select, insert, update, delete on public.challenge_teams to authenticated;
grant select, insert, update, delete on public.challenge_participants to authenticated;
grant select, insert on public.challenge_progress to authenticated;

-- A draft is visible only to its author and to whoever may edit
-- challenges. Everything else is club-wide, which is what a leaderboard
-- needs to work at all.
create policy challenges_read on public.challenges for select to authenticated using (
  status <> 'draft'
  or created_by = auth.uid()
  or public.has_perm('community.challenge.create')
);
create policy challenges_insert_perm on public.challenges for insert to authenticated
  with check (public.has_perm('community.challenge.create') and created_by = auth.uid());
create policy challenges_update_perm on public.challenges for update to authenticated
  using (public.has_perm('community.challenge.create'))
  with check (public.has_perm('community.challenge.create'));
create policy challenges_delete_perm on public.challenges for delete to authenticated
  using (public.has_perm('community.challenge.create'));

create policy challenge_teams_read on public.challenge_teams for select to authenticated
  using (exists (select 1 from public.challenges c where c.id = challenge_id));
create policy challenge_teams_insert_perm on public.challenge_teams for insert to authenticated
  with check (public.has_perm('community.challenge.create'));
create policy challenge_teams_update_perm on public.challenge_teams for update to authenticated
  using (public.has_perm('community.challenge.create'))
  with check (public.has_perm('community.challenge.create'));
create policy challenge_teams_delete_perm on public.challenge_teams for delete to authenticated
  using (public.has_perm('community.challenge.create'));

-- Joining is a community write, so it carries the recovery gate. Reading
-- who joined does not: a leaderboard with hidden participants is not a
-- leaderboard. in_leaderboards is applied by the Phase 2 read functions,
-- not here, so a member who opts out still sees their own standing.
create policy challenge_participants_read on public.challenge_participants for select to authenticated
  using (exists (select 1 from public.challenges c where c.id = challenge_id));
create policy challenge_participants_join_self on public.challenge_participants for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_community_member()
    and exists (select 1 from public.challenges c where c.id = challenge_id and c.status = 'active')
  );
create policy challenge_participants_update_self on public.challenge_participants for update to authenticated
  using (user_id = auth.uid() or public.has_perm('community.challenge.create'))
  with check (user_id = auth.uid() or public.has_perm('community.challenge.create'));
create policy challenge_participants_leave_self on public.challenge_participants for delete to authenticated
  using (user_id = auth.uid() or public.has_perm('community.challenge.create'));

-- Append only. No update or delete policy and no grant for either: a
-- contribution is corrected by writing a compensating negative delta, not
-- by editing history.
create policy challenge_progress_read on public.challenge_progress for select to authenticated
  using (exists (select 1 from public.challenges c where c.id = challenge_id));
create policy challenge_progress_insert_self on public.challenge_progress for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_community_member()
    and exists (
      select 1 from public.challenge_participants cp
      where cp.challenge_id = challenge_id and cp.user_id = auth.uid() and cp.status = 'active'
    )
  );

commit;
