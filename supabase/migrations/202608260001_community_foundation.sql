begin;

create extension if not exists pgcrypto;

create type public.post_visibility as enum ('public', 'followers');
create type public.report_status as enum ('open', 'reviewing', 'resolved', 'dismissed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null default '' check (char_length(display_name) <= 80),
  bio text not null default '' check (char_length(bio) <= 160),
  avatar_url text,
  is_admin boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.private_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  record_type text not null check (record_type in ('movement','custom_wod','strength_entry','wod_entry','bodyweight','measure_type','measurement','session_note')),
  record_id text not null check (char_length(record_id) between 1 and 160),
  payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, record_type, record_id)
);
create index private_records_user_type_updated_idx on public.private_records(user_id, record_type, updated_at desc);

create table public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followed_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  check (follower_id <> followed_id)
);

create table public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table public.workout_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  source_type text not null check (source_type in ('strength_entry','wod_entry')),
  source_record_id text not null,
  visibility public.post_visibility not null default 'followers',
  title text not null check (char_length(title) between 1 and 120),
  result_text text not null check (char_length(result_text) between 1 and 240),
  comparison_key text check (char_length(comparison_key) <= 160),
  score_value numeric,
  score_direction text check (score_direction in ('higher','lower') or score_direction is null),
  rx boolean,
  occurred_on date not null,
  published_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (author_id, source_type, source_record_id)
);
create index workout_posts_feed_idx on public.workout_posts(published_at desc) where deleted_at is null;
create index workout_posts_comparison_idx on public.workout_posts(comparison_key, score_value) where deleted_at is null;

create table public.reactions (
  post_id uuid not null references public.workout_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'cheer' check (kind = 'cheer'),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, kind)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.workout_posts(id) on delete cascade,
  reason text not null check (reason in ('spam','harassment','privacy','inappropriate','other')),
  details text not null default '' check (char_length(details) <= 500),
  status public.report_status not null default 'open',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (reporter_id, post_id)
);

create table public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null default (now() + interval '30 days')
);

alter table public.profiles enable row level security;
alter table public.private_records enable row level security;
alter table public.follows enable row level security;
alter table public.blocks enable row level security;
alter table public.workout_posts enable row level security;
alter table public.reactions enable row level security;
alter table public.reports enable row level security;
alter table public.account_deletion_requests enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.private_records, public.follows, public.blocks, public.workout_posts, public.reactions to authenticated;
grant insert, select on public.reports to authenticated;
grant select on public.account_deletion_requests to authenticated;

create policy profiles_read_authenticated on public.profiles for select to authenticated
  using (deleted_at is null and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = id) or (b.blocker_id = id and b.blocked_id = auth.uid())));
create policy profiles_insert_self on public.profiles for insert to authenticated with check (id = auth.uid() and is_admin = false);
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and is_admin = false);

create policy private_records_self_select on public.private_records for select to authenticated using (user_id = auth.uid());
create policy private_records_self_insert on public.private_records for insert to authenticated with check (user_id = auth.uid());
create policy private_records_self_update on public.private_records for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy private_records_self_delete on public.private_records for delete to authenticated using (user_id = auth.uid());

create policy follows_visible on public.follows for select to authenticated using (follower_id = auth.uid() or followed_id = auth.uid());
create policy follows_insert_self on public.follows for insert to authenticated with check (follower_id = auth.uid());
create policy follows_delete_self on public.follows for delete to authenticated using (follower_id = auth.uid());

create policy blocks_self_select on public.blocks for select to authenticated using (blocker_id = auth.uid() or blocked_id = auth.uid());
create policy blocks_self_insert on public.blocks for insert to authenticated with check (blocker_id = auth.uid());
create policy blocks_self_delete on public.blocks for delete to authenticated using (blocker_id = auth.uid());

create policy posts_feed_select on public.workout_posts for select to authenticated using (
  deleted_at is null
  and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = author_id) or (b.blocker_id = author_id and b.blocked_id = auth.uid()))
  and (author_id = auth.uid() or visibility = 'public' or (visibility = 'followers' and exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followed_id = author_id)))
);
create policy posts_insert_self on public.workout_posts for insert to authenticated with check (author_id = auth.uid());
create policy posts_update_self on public.workout_posts for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy posts_delete_self on public.workout_posts for delete to authenticated using (author_id = auth.uid());

create policy reactions_visible on public.reactions for select to authenticated using (exists (select 1 from public.workout_posts p where p.id = post_id));
create policy reactions_insert_self on public.reactions for insert to authenticated with check (user_id = auth.uid() and exists (select 1 from public.workout_posts p where p.id = post_id));
create policy reactions_delete_self on public.reactions for delete to authenticated using (user_id = auth.uid());

create policy reports_insert_self on public.reports for insert to authenticated with check (reporter_id = auth.uid());
create policy reports_read_self_or_admin on public.reports for select to authenticated using (reporter_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
create policy deletion_requests_self_select on public.account_deletion_requests for select to authenticated using (user_id = auth.uid());

create or replace function public.request_account_deletion() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.account_deletion_requests(user_id) values (auth.uid())
  on conflict (user_id) do update set requested_at = now(), purge_after = now() + interval '30 days';
  update public.profiles set deleted_at = now() where id = auth.uid();
  update public.workout_posts set deleted_at = now() where author_id = auth.uid();
end $$;
revoke all on function public.request_account_deletion() from public, anon;
grant execute on function public.request_account_deletion() to authenticated;

-- Invoke daily from a trusted scheduler/Edge Function using the service role.
-- The browser can never execute this function.
create or replace function public.purge_due_accounts() returns integer
language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  with due as (select user_id from public.account_deletion_requests where purge_after <= now()),
  removed as (delete from auth.users u using due d where u.id = d.user_id returning u.id)
  select count(*) into affected from removed;
  return affected;
end $$;
revoke all on function public.purge_due_accounts() from public, anon, authenticated;
grant execute on function public.purge_due_accounts() to service_role;

create or replace view public.community_feed with (security_invoker = true) as
select p.id, p.author_id, pr.handle, pr.display_name, pr.avatar_url, p.title, p.result_text,
       p.comparison_key, p.score_value, p.score_direction, p.rx, p.occurred_on, p.published_at,
       count(r.post_id)::integer as cheer_count
from public.workout_posts p
join public.profiles pr on pr.id = p.author_id
left join public.reactions r on r.post_id = p.id
where p.deleted_at is null
  and not exists (select 1 from public.reports rp where rp.post_id = p.id and rp.reporter_id = auth.uid())
group by p.id, pr.id;
grant select on public.community_feed to authenticated;

create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger private_records_touch before update on public.private_records for each row execute function public.touch_updated_at();

commit;
