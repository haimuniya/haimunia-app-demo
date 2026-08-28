begin;

-- COMM-001 part 2 (the visibility rules that need the enum labels added in
-- 202608280004) and COMM-002 (post_media).
--
-- Five visibility labels are live now, and post_visible_to_viewer() is the
-- single place that says what each one means:
--   club     - any signed-in club member
--   public   - legacy alias of club, still written by the current client
--   friends  - a MUTUAL follow edge, per the 2026-08-28 decision
--   followers- legacy one-way follower scope, still written by the client
--   only_me  - the author alone
-- 'friends' is strictly narrower than 'followers'. Existing rows are left
-- on whichever label they already carry rather than remapped, so this
-- migration neither widens nor narrows anything a member already posted.

alter table public.workout_posts alter column visibility set default 'club';

create or replace function public.post_visible_to_viewer(p_post_id uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.workout_posts p
    where p.id = p_post_id
      and p.deleted_at is null
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = p.author_id)
           or (b.blocker_id = p.author_id and b.blocked_id = auth.uid())
      )
      and (
        p.author_id = auth.uid()
        -- Moderation read, unchanged from 202608270009: a real admin can
        -- see the content they are being asked to review.
        or exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null)
        or (
          p.status = 'active'
          and (
            p.visibility in ('public', 'club')
            or (p.visibility = 'followers' and exists (
                  select 1 from public.follows f
                  where f.follower_id = auth.uid() and f.followed_id = p.author_id))
            or (p.visibility = 'friends' and public.are_friends(p.author_id))
          )
        )
      )
  );
$$;
revoke all on function public.post_visible_to_viewer(uuid) from public, anon;
grant execute on function public.post_visible_to_viewer(uuid) to authenticated;

-- The same rule, written inline. It cannot call post_visible_to_viewer():
-- that function selects from workout_posts, so a policy ON workout_posts
-- calling it would re-enter this policy and recurse. The duplication is
-- why the admin branch lives in posts_select_admin_review (202608270009)
-- instead of being repeated here.
drop policy posts_feed_select on public.workout_posts;
create policy posts_feed_select on public.workout_posts for select to authenticated using (
  deleted_at is null
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = author_id)
       or (b.blocker_id = author_id and b.blocked_id = auth.uid())
  )
  and (
    author_id = auth.uid()
    or (
      status = 'active'
      and (
        visibility in ('public', 'club')
        or (visibility = 'followers' and exists (
              select 1 from public.follows f
              where f.follower_id = auth.uid() and f.followed_id = author_id))
        or (visibility = 'friends' and public.are_friends(author_id))
      )
    )
  )
);

-- Posting now requires a verified recovery method and the permission
-- string, not just a session. This is the locked identity decision landing
-- on the write path.
drop policy posts_insert_self on public.workout_posts;
create policy posts_insert_self on public.workout_posts for insert to authenticated with check (
  author_id = auth.uid()
  and public.is_community_member()
  and public.has_perm('community.post.create')
);

-- Commenting and reacting go through these two definer functions
-- (202608270010), so the same gate goes inside them rather than on the
-- tables. Everything else about both functions is unchanged.
create or replace function public.add_post_comment(p_post_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.check_rate_limit('post_comment', 20, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;
  insert into public.post_comments(post_id, author_id, body)
  values (p_post_id, auth.uid(), left(coalesce(p_body, ''), 280))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.toggle_reaction(p_post_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_existing boolean;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  -- Removing your own reaction is allowed unconditionally; only adding one
  -- is a community write.
  select exists(select 1 from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer') into v_existing;
  if v_existing then
    delete from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer';
    return false;
  end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.check_rate_limit('reaction', 60, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;
  insert into public.reactions(post_id, user_id, kind) values (p_post_id, auth.uid(), 'cheer');
  return true;
end $$;

-- COMM-002. Up to four photos per post, each with its own alt text.
--
-- The cap is structural, not a trigger: `position` is constrained to 0..3
-- and (post_id, position) is unique, so a fifth row has no free slot to
-- take. That holds under concurrency, which a count-rows trigger would
-- not.
create table public.post_media (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  post_id uuid not null references public.workout_posts(id) on delete cascade,
  storage_path text not null check (char_length(storage_path) between 1 and 400),
  alt_text text check (alt_text is null or char_length(alt_text) <= 200),
  "position" smallint not null check ("position" between 0 and 3),
  width integer check (width is null or width between 1 and 20000),
  height integer check (height is null or height between 1 and 20000),
  created_at timestamptz not null default now(),
  unique (post_id, "position")
);
create index post_media_post_idx on public.post_media(post_id, "position");
create unique index post_media_storage_path_idx on public.post_media(storage_path);

-- Same rule the single-photo path already enforces (202608270006): the
-- first path segment must be the author's own uid, so one member can never
-- attach another member's upload.
create or replace function public.enforce_post_media_ownership() returns trigger
language plpgsql set search_path = '' as $$
declare v_author uuid;
begin
  select author_id into v_author from public.workout_posts where id = new.post_id;
  if v_author is null then
    raise exception 'media cannot be attached to an authorless post';
  end if;
  if split_part(new.storage_path, '/', 1) <> v_author::text then
    raise exception 'media path must belong to the post author';
  end if;
  return new;
end $$;
create trigger post_media_owner before insert or update of storage_path, post_id
  on public.post_media for each row execute function public.enforce_post_media_ownership();

alter table public.post_media enable row level security;
revoke all on public.post_media from public, anon;
grant select, insert, update, delete on public.post_media to authenticated;

create policy post_media_visible on public.post_media for select to authenticated
  using (public.post_visible_to_viewer(post_id));

create policy post_media_insert_author on public.post_media for insert to authenticated with check (
  public.is_community_member()
  and exists (
    select 1 from public.workout_posts p
    where p.id = post_id and p.author_id = auth.uid()
      and p.deleted_at is null and p.status <> 'removed'
  )
);

-- Update is alt_text only in practice; storage_path and post_id changes
-- are re-checked by the ownership trigger above.
create policy post_media_update_author on public.post_media for update to authenticated
  using (exists (
    select 1 from public.workout_posts p
    where p.id = post_id and p.author_id = auth.uid() and p.deleted_at is null and p.status <> 'removed'
  ))
  with check (exists (
    select 1 from public.workout_posts p
    where p.id = post_id and p.author_id = auth.uid() and p.deleted_at is null and p.status <> 'removed'
  ));

create policy post_media_delete_author on public.post_media for delete to authenticated
  using (exists (
    select 1 from public.workout_posts p where p.id = post_id and p.author_id = auth.uid()
  ));

-- Storage read for the multi-photo path. The existing
-- post_photos_select_if_post_visible policy only matches
-- workout_posts.photo_path; this one matches a post_media row, so both
-- the legacy single photo and the new set stay readable exactly as far as
-- their post is. Upload stays governed by can_upload_post_photo(), which
-- already pins the uid prefix.
create policy post_photos_select_if_media_visible on storage.objects for select to authenticated
  using (bucket_id = 'post-photos' and exists (
    select 1 from public.post_media m
    where m.storage_path = storage.objects.name and public.post_visible_to_viewer(m.post_id)
  ));

commit;
