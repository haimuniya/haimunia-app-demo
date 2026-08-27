begin;

-- review_report() (202608270006) lets an admin resolve a report, but
-- nothing actually let an admin SEE the reported post's content unless
-- they happened to already be the author, follow the author, or the post
-- was public. A "followers"-only post from a stranger stayed invisible to
-- the very moderator meant to review it.
--
-- Deliberately checks is_admin directly here, not the broader staff
-- check that also returns true for a coach-role redemption -
-- review_report() itself only ever authorizes a real admin, and using
-- the broader check here would have quietly handed every coach read
-- access to private "followers"-only posts they have no way to act on -
-- a bigger grant than this fix is meant to make.
create or replace function public.post_visible_to_viewer(p_post_id uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.workout_posts p
    where p.id = p_post_id
      and p.deleted_at is null
      and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = p.author_id) or (b.blocker_id = p.author_id and b.blocked_id = auth.uid()))
      and (
        p.author_id = auth.uid() or p.visibility = 'public'
        or (p.visibility = 'followers' and exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followed_id = p.author_id))
        or exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null)
      )
  );
$$;
revoke all on function public.post_visible_to_viewer(uuid) from public, anon;
grant execute on function public.post_visible_to_viewer(uuid) to authenticated;

create policy posts_select_admin_review on public.workout_posts for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null));

commit;
