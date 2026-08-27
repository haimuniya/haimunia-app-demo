begin;

-- 1. Close the reactions RLS gap. The original policies only checked that
-- the referenced post row existed, not that it was still visible to the
-- viewer — a deleted post, a blocked author, or a followers-only post from
-- someone you don't follow all leaked reaction rows (who cheered, and that
-- the post existed at all) even though the post itself was correctly
-- hidden by posts_feed_select. This factors the exact visibility rule
-- posts_feed_select already uses into a function so both stay in sync.
create or replace function public.post_visible_to_viewer(p_post_id uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.workout_posts p
    where p.id = p_post_id
      and p.deleted_at is null
      and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = p.author_id) or (b.blocker_id = p.author_id and b.blocked_id = auth.uid()))
      and (p.author_id = auth.uid() or p.visibility = 'public' or (p.visibility = 'followers' and exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followed_id = p.author_id)))
  );
$$;
revoke all on function public.post_visible_to_viewer(uuid) from public, anon;
grant execute on function public.post_visible_to_viewer(uuid) to authenticated;

drop policy reactions_visible on public.reactions;
drop policy reactions_insert_self on public.reactions;
create policy reactions_visible on public.reactions for select to authenticated using (public.post_visible_to_viewer(post_id));
create policy reactions_insert_self on public.reactions for insert to authenticated with check (user_id = auth.uid() and public.post_visible_to_viewer(post_id));

-- 2. Achievement unlocks become a third kind of shareable post, alongside
-- strength/WOD entries. source_record_id holds the achievement id.
alter table public.workout_posts drop constraint workout_posts_source_type_check;
alter table public.workout_posts add constraint workout_posts_source_type_check check (source_type in ('strength_entry', 'wod_entry', 'achievement'));

-- 3. Coach/admin announcements. Anyone authenticated reads; only an admin
-- profile can post or edit one.
create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index announcements_feed_idx on public.announcements(created_at desc) where deleted_at is null;
alter table public.announcements enable row level security;
grant select, insert, update on public.announcements to authenticated;

create policy announcements_read on public.announcements for select to authenticated using (deleted_at is null);
create policy announcements_insert_admin on public.announcements for insert to authenticated
  with check (author_id = auth.uid() and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
create policy announcements_update_admin on public.announcements for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- 4. Activity pings — one row per user per day they opened/logged in the
-- app, used for streaks. Kept private per-user (raw dates are a bit more
-- personal than a headline number): only the owner can read their own rows
-- directly. The community_streaks view below exposes only the aggregate
-- streak length to everyone, and coach_inactive_members() below exposes
-- raw last-activity dates to admins only, both via security-definer access
-- rather than widening this table's own RLS.
create table public.activity_pings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  activity_date date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, activity_date)
);
alter table public.activity_pings enable row level security;
grant select, insert on public.activity_pings to authenticated;
create policy activity_pings_self_select on public.activity_pings for select to authenticated using (user_id = auth.uid());
create policy activity_pings_self_insert on public.activity_pings for insert to authenticated with check (user_id = auth.uid());

-- Deliberately NOT security_invoker: this view runs with the migration
-- owner's rights so it can aggregate across every user's activity_pings
-- rows despite activity_pings' own RLS restricting each user to their own
-- rows — the raw per-day rows stay private, only the resulting streak
-- length and the two block/deleted checks (done explicitly here, since
-- definer mode bypasses the RLS that would otherwise apply them) are
-- exposed.
create or replace view public.community_streaks as
with islands as (
  select user_id, activity_date,
         (activity_date - (row_number() over (partition by user_id order by activity_date))::integer * interval '1 day')::date as grp
  from public.activity_pings
),
runs as (
  select user_id, grp, count(*)::integer as run_length, max(activity_date) as run_end
  from islands
  group by user_id, grp
),
latest_run as (
  select distinct on (user_id) user_id, run_length, run_end
  from runs
  order by user_id, run_end desc
)
select pr.id as user_id, pr.handle, pr.display_name,
       case when lr.run_end >= current_date - 1 then coalesce(lr.run_length, 0) else 0 end as current_streak,
       lr.run_end as last_activity_on
from public.profiles pr
left join latest_run lr on lr.user_id = pr.id
where pr.deleted_at is null
  and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = pr.id) or (b.blocker_id = pr.id and b.blocked_id = auth.uid()));
grant select on public.community_streaks to authenticated;

-- Coach-only "who hasn't logged recently" — self-gated inside the function
-- (raises if the caller isn't an admin profile) rather than widening
-- activity_pings' RLS, so this stays admin-only without a second table.
create or replace function public.coach_inactive_members(p_since date default (current_date - 7))
returns table(user_id uuid, handle text, display_name text, last_activity_on date)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
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
revoke all on function public.coach_inactive_members(date) from public, anon;
grant execute on function public.coach_inactive_members(date) to authenticated;

-- 5. Weekly box-wide challenge — admin sets a comparison_key and a date
-- range; the leaderboard view below reads straight from workout_posts, so
-- entries already shared to the community for that lift/WOD in that
-- window just show up, no separate submission step.
create table public.weekly_challenges (
  id uuid primary key default gen_random_uuid(),
  comparison_key text not null check (char_length(comparison_key) between 1 and 160),
  title text not null check (char_length(title) between 1 and 120),
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index weekly_challenges_active_idx on public.weekly_challenges(ends_on desc);
alter table public.weekly_challenges enable row level security;
grant select, insert on public.weekly_challenges to authenticated;
create policy weekly_challenges_read on public.weekly_challenges for select to authenticated using (true);
create policy weekly_challenges_insert_admin on public.weekly_challenges for insert to authenticated
  with check (created_by = auth.uid() and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- security_invoker: reuses posts_feed_select/profiles_read_authenticated
-- as-is, so a challenge leaderboard never shows a post its own visibility
-- rules would otherwise hide from this viewer.
create or replace view public.weekly_challenge_leaderboard with (security_invoker = true) as
select wc.id as challenge_id, wc.title, wc.comparison_key, wc.starts_on, wc.ends_on,
       p.id as post_id, p.author_id, pr.handle, pr.display_name, p.score_value, p.score_direction, p.result_text, p.occurred_on
from public.weekly_challenges wc
join public.workout_posts p on p.comparison_key = wc.comparison_key and p.occurred_on between wc.starts_on and wc.ends_on
join public.profiles pr on pr.id = p.author_id
where p.deleted_at is null
  and current_date between wc.starts_on and wc.ends_on;
grant select on public.weekly_challenge_leaderboard to authenticated;

commit;
