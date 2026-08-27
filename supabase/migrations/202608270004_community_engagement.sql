begin;

-- 1. Fix a real bug from the previous migration: protect_is_admin() fired
-- on EVERY update to profiles, including a legitimate one-time grant run
-- directly in the SQL editor (no RLS bypass needed there — the trigger
-- itself doesn't care who's running the UPDATE, only that a row changed).
-- That's why "update profiles set is_admin = true ..." silently did
-- nothing: the trigger reset it back to the old value before the write
-- ever landed. Client requests always carry a JWT and auth.role() reads
-- 'authenticated' from it; a direct SQL editor session has no JWT context
-- at all, so auth.role() reads null there. Scoping the trigger to only
-- fire for real 'authenticated' API requests keeps the original intent
-- (no client-side path can ever change is_admin) while letting a genuine
-- manual dashboard grant actually work.
create or replace function public.protect_is_admin() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated' then
    new.is_admin = old.is_admin;
  end if;
  return new;
end $$;

-- 2. Photo attachment on a shared post — one optional photo, uploaded to
-- Storage under the author's own uid-prefixed path. workout_posts stores
-- only the path, never a public URL. This has to run before the
-- community_feed view below, which selects p.photo_path.
alter table public.workout_posts add column photo_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('post-photos', 'post-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
  on conflict (id) do nothing;

create policy post_photos_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'post-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy post_photos_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'post-photos' and (storage.foldername(name))[1] = auth.uid()::text);
-- Read access mirrors the post itself: viewable only if the workout_post
-- whose photo_path matches this object's name is visible to the viewer.
-- post_visible_to_viewer() already exists from an earlier migration.
create policy post_photos_select_if_post_visible on storage.objects for select to authenticated
  using (bucket_id = 'post-photos' and exists (
    select 1 from public.workout_posts p where p.photo_path = storage.objects.name and public.post_visible_to_viewer(p.id)
  ));

-- 3. Lightweight comments — same visibility rule reactions already use,
-- so a comment can never be more exposed than the post it's on.
create table public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.workout_posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 280),
  created_at timestamptz not null default now()
);
create index post_comments_post_idx on public.post_comments(post_id, created_at);
alter table public.post_comments enable row level security;
grant select, insert, delete on public.post_comments to authenticated;
create policy post_comments_visible on public.post_comments for select to authenticated using (public.post_visible_to_viewer(post_id));
create policy post_comments_insert_self on public.post_comments for insert to authenticated with check (author_id = auth.uid() and public.post_visible_to_viewer(post_id));
create policy post_comments_delete_self on public.post_comments for delete to authenticated using (author_id = auth.uid());

-- community_feed gains a comment count (same pattern as cheer_count) and
-- the new photo_path. CREATE OR REPLACE VIEW can only ever append new
-- columns at the end — it errors if an existing column's name or
-- position changes — so cheer_count has to stay exactly where it was
-- (last column of the original view) and both new columns go after it.
create or replace view public.community_feed with (security_invoker = true) as
select p.id, p.author_id, pr.handle, pr.display_name, pr.avatar_url, p.title, p.result_text,
       p.comparison_key, p.score_value, p.score_direction, p.rx, p.occurred_on, p.published_at,
       count(distinct r.post_id)::integer as cheer_count,
       count(distinct c.id)::integer as comment_count,
       p.photo_path
from public.workout_posts p
join public.profiles pr on pr.id = p.author_id
left join public.reactions r on r.post_id = p.id
left join public.post_comments c on c.post_id = p.id
where p.deleted_at is null
  and not exists (select 1 from public.reports rp where rp.post_id = p.id and rp.reporter_id = auth.uid())
group by p.id, pr.id;
grant select on public.community_feed to authenticated;

-- 4. "Who's new" — the mirror of coach_inactive_members: whose EARLIEST
-- activity_pings row falls inside the window, not their latest.
create or replace function public.coach_new_members(p_within_days integer default 14)
returns table(user_id uuid, handle text, display_name text, first_activity_on date)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
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
revoke all on function public.coach_new_members(integer) from public, anon;
grant execute on function public.coach_new_members(integer) to authenticated;

-- 5. Pinned daily note — same announcements table, one nullable column.
-- A non-null pinned_date surfaces it as "today's note" instead of a plain
-- list item once pinned_date = current_date.
alter table public.announcements add column pinned_date date;
create index announcements_pinned_idx on public.announcements(pinned_date) where pinned_date is not null;

commit;
