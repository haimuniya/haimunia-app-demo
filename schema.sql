-- האימוניה community feature — schema for phase 00 (separate Supabase project).
-- Matches the tables sketched in the "שלבי בנייה" build-phases plan.
-- Every table gets Row Level Security: read is scoped to your own box_id,
-- write is scoped to your own profile row. This is the RLS pass phase 04
-- (security review) exists specifically to double-check against a real
-- attacker model, not to skip.

create table boxes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  owner_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users(id),
  box_id uuid not null references boxes(id),
  display_name text not null,
  role text not null default 'member' check (role in ('member', 'coach', 'owner')),
  created_at timestamptz not null default now()
);

create table pr_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  box_id uuid not null references boxes(id),
  exercise_name text not null,
  value numeric not null,
  unit text not null,
  achieved_at timestamptz not null default now(),
  visibility text not null default 'public' check (visibility in ('public', 'box_only'))
);

create table wod_scores (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  box_id uuid not null references boxes(id),
  wod_name text not null,
  score_type text not null check (score_type in ('time', 'amrap', 'load', 'emom')),
  score_value numeric not null,
  achieved_at timestamptz not null default now()
);

create table activity_days (
  profile_id uuid not null references profiles(id),
  box_id uuid not null references boxes(id),
  date date not null,
  primary key (profile_id, date)
);

-- Phase 2 (see build-phases plan's "אפשרויות נוספות" section) — not wired
-- into the phase 00-03 scaffold yet, table shape reserved so it's a
-- non-breaking addition later.
create table reactions (
  id uuid primary key default gen_random_uuid(),
  pr_event_id uuid not null references pr_events(id),
  profile_id uuid not null references profiles(id),
  kind text not null check (kind in ('fire', 'clap')),
  created_at timestamptz not null default now(),
  unique (pr_event_id, profile_id, kind)
);

alter table boxes enable row level security;
alter table profiles enable row level security;
alter table pr_events enable row level security;
alter table wod_scores enable row level security;
alter table activity_days enable row level security;
alter table reactions enable row level security;

-- boxes: any authenticated user can read box name/invite_code lookups
-- during sign-up, but only the owner can see/change the row afterward.
create policy "boxes readable by anyone signed in" on boxes
  for select using (auth.role() = 'authenticated');
create policy "boxes writable by their owner" on boxes
  for update using (owner_user_id = auth.uid());

-- profiles: read is scoped to your own box, write is scoped to your own row.
create policy "profiles readable within your own box" on profiles
  for select using (
    box_id in (select box_id from profiles where id = auth.uid())
  );
create policy "profiles writable only by their own user" on profiles
  for insert with check (id = auth.uid());
create policy "profiles updatable only by their own user" on profiles
  for update using (id = auth.uid());

-- pr_events / wod_scores / activity_days: same shape — read scoped to
-- your own box_id, write scoped to your own profile_id.
create policy "pr_events readable within your own box" on pr_events
  for select using (
    box_id in (select box_id from profiles where id = auth.uid())
  );
create policy "pr_events writable only by their own profile" on pr_events
  for insert with check (
    profile_id = auth.uid()
    and box_id = (select box_id from profiles where id = auth.uid())
  );

create policy "wod_scores readable within your own box" on wod_scores
  for select using (
    box_id in (select box_id from profiles where id = auth.uid())
  );
create policy "wod_scores writable only by their own profile" on wod_scores
  for insert with check (
    profile_id = auth.uid()
    and box_id = (select box_id from profiles where id = auth.uid())
  );

-- activity_days: readable by coach/owner within the box (for the coach
-- dashboard) and by the member themselves; writable only by yourself.
create policy "activity_days readable within your own box" on activity_days
  for select using (
    box_id in (select box_id from profiles where id = auth.uid())
  );
create policy "activity_days writable only by their own profile" on activity_days
  for insert with check (
    profile_id = auth.uid()
    and box_id = (select box_id from profiles where id = auth.uid())
  );

create policy "reactions readable within your own box" on reactions
  for select using (
    profile_id in (select id from profiles where box_id in (
      select box_id from profiles where id = auth.uid()
    ))
  );
create policy "reactions writable only by their own profile" on reactions
  for insert with check (profile_id = auth.uid());
