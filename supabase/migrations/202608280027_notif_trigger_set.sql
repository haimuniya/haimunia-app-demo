begin;

-- Community Phase 1 schema follow-up, run 3 of 3, part 2 of 3: the AFTER
-- INSERT trigger set that turns a comment, mention, reaction, announcement,
-- or achievement unlock into a notification, per the routing table in
-- docs/community/contracts.md.
--
-- Immediate types go through `notif_create()` (202608280026). Batched types
-- go through `notif_queue_batched()` (202608280018); because that function
-- never reads `notification_preferences`, each trigger checks
-- `notif_pref_allows()` and `notif_blocked_between()` itself before it
-- enqueues.
--
-- DEVIATION, recorded here and in contracts.md: the brief's item 3 assumed
-- a server-side product-event bus that `ach_evaluate` / `ach_claim` emit
-- `ACHIEVEMENT_UNLOCKED` on. Run 2 confirmed no such bus exists in the repo
-- (`POST_CREATED`, `COMMENT_CREATED`, `REACTION_CREATED` are all client-only
-- emits). So, exactly as the brief instructs for that case, the achievement
-- notification path is wired off an AFTER INSERT trigger on
-- `public.member_achievements` - the same shape as `notif_on_reaction`,
-- built from the row rather than an event. Both `ach_claim` and a future
-- `ach_evaluate` write that row, so neither can forget to fire.

------------------------------------------------------------------------
-- 1. Comments: reply -> parent author, and first comment -> post author.
------------------------------------------------------------------------
-- A reply notifies the parent author immediately (`comment_reply`). The
-- post author is notified `comment_on_post` immediately the first time a
-- given commenter comments on the post, and `comment_also` (batched) every
-- time that same commenter comments again - "someone ALSO commented". The
-- post-author branch is skipped when the post author is the commenter or is
-- the very person being replied to - that member gets the reply
-- notification instead of a second row.
--
-- Mentions are deliberately NOT handled here. They fire from their own
-- trigger on `comment_mentions` (section 2), because the mention rows are
-- written after this row inside the same transaction and the client
-- `COMMENT_CREATED` mention array is not a trusted source.
create or replace function public.notif_on_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := new.author_id;
  v_post_author uuid;
  v_parent_author uuid;
  v_link text;
begin
  select author_id into v_post_author from public.workout_posts where id = new.post_id;

  if new.parent_comment_id is not null then
    select author_id into v_parent_author
      from public.post_comments where id = new.parent_comment_id;
    if v_parent_author is not null and v_parent_author <> v_actor then
      perform public.notif_create(
        v_parent_author, 'comment_reply', 'community',
        'New reply to your comment', new.body,
        'comment', new.id,
        '/community/feed?post=' || new.post_id::text
          || '&comment=' || new.parent_comment_id::text
      );
    end if;
  end if;

  if v_post_author is not null
     and v_post_author <> v_actor
     and (new.parent_comment_id is null or v_post_author is distinct from v_parent_author) then
    if exists (
      select 1 from public.post_comments c
      where c.post_id = new.post_id and c.author_id = v_actor and c.id <> new.id
    ) then
      if not public.notif_blocked_between(v_post_author, v_actor)
         and public.notif_pref_allows(v_post_author, 'comment_also') then
        perform public.notif_queue_batched(v_post_author, 'community', 'comment_also', new.post_id);
      end if;
    else
      v_link := '/community/feed?post=' || new.post_id::text || '&comment=' || new.id::text;
      perform public.notif_create(
        v_post_author, 'comment_on_post', 'community',
        'New comment on your post', new.body,
        'comment', new.id, v_link
      );
    end if;
  end if;

  return null;
end $$;
revoke all on function public.notif_on_comment() from public, anon, authenticated;

create trigger post_comments_notify after insert on public.post_comments
  for each row execute function public.notif_on_comment();

------------------------------------------------------------------------
-- 2. Mentions: one row per accepted mention.
------------------------------------------------------------------------
-- Fires AFTER INSERT on `comment_mentions`, whose rows are written only by
-- the four-argument `add_post_comment` after it re-checks
-- `can_view_profile_field(target, 'allow_mentions')` (false across a block
-- edge). `notif_create` then applies the target's `mentions` preference
-- and the block-edge filter a second time. `coach_mention` when the
-- comment author holds `coach` or `head_coach`.
create or replace function public.notif_on_mention() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_target uuid := new.mentioned_user_id;
  v_comment public.post_comments;
  v_actor uuid;
  v_is_coach boolean;
  v_type text;
begin
  select * into v_comment from public.post_comments where id = new.comment_id;
  if not found then return null; end if;
  v_actor := v_comment.author_id;
  if v_target = v_actor then return null; end if;

  select exists (
    select 1 from public.invite_redemptions ir
    where ir.user_id = v_actor and ir.role in ('coach', 'head_coach')
  ) into v_is_coach;
  v_type := case when v_is_coach then 'coach_mention' else 'mention' end;

  perform public.notif_create(
    v_target, v_type, 'community',
    case when v_is_coach then 'A coach mentioned you' else 'You were mentioned' end,
    v_comment.body,
    'comment', v_comment.id,
    '/community/feed?post=' || v_comment.post_id::text || '&comment=' || v_comment.id::text
  );
  return null;
end $$;
revoke all on function public.notif_on_mention() from public, anon, authenticated;

create trigger comment_mentions_notify after insert on public.comment_mentions
  for each row execute function public.notif_on_mention();

------------------------------------------------------------------------
-- 3. Reactions: always batched, never immediate.
------------------------------------------------------------------------
-- Built from the row: `REACTION_CREATED` carries only `{ post_id }`, no
-- actor. `off` on the `reactions` preference suppresses the enqueue.
create or replace function public.notif_on_reaction() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := new.user_id;
  v_author uuid;
begin
  select author_id into v_author from public.workout_posts where id = new.post_id;
  if v_author is null or v_author = v_actor then return null; end if;
  if public.notif_blocked_between(v_author, v_actor) then return null; end if;
  if not public.notif_pref_allows(v_author, 'reaction') then return null; end if;

  perform public.notif_queue_batched(v_author, 'community', 'reaction', new.post_id);
  return null;
end $$;
revoke all on function public.notif_on_reaction() from public, anon, authenticated;

create trigger reactions_notify after insert on public.reactions
  for each row execute function public.notif_on_reaction();

------------------------------------------------------------------------
-- 4. Announcements: fan out to the club.
------------------------------------------------------------------------
-- A normal announcement reaches members whose `announcements` preference
-- is not `off`. An `important` announcement is operational and reaches
-- every member - `notif_create` sees `notif_is_operational()` return true
-- and delivers past the `off` row.
--
-- The whole-club loop is the fan-out cost the contract flags as a schema
-- concern. Phase 1 is a single small club, so the loop is acceptable;
-- batching a large club is a later ticket.
create or replace function public.notif_announcement_fanout(p_id uuid, p_off_only boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.announcements;
  v_member uuid;
begin
  select * into v_row from public.announcements where id = p_id;
  if not found or v_row.deleted_at is not null then return; end if;

  for v_member in
    select p.id
    from public.profiles p
    where p.deleted_at is null
      and p.id <> v_row.author_id
      and exists (select 1 from public.invite_redemptions ir where ir.user_id = p.id)
      and (
        not p_off_only
        or exists (
          select 1 from public.notification_preferences np
          where np.user_id = p.id and np.type = 'announcements' and np.channel = 'off'
        )
      )
  loop
    perform public.notif_create(
      v_member, 'announcement', 'club',
      v_row.title, v_row.body,
      'announcement', v_row.id,
      '/community/feed?announcement=' || v_row.id::text
    );
  end loop;
end $$;
revoke all on function public.notif_announcement_fanout(uuid, boolean) from public, anon, authenticated;

-- INSERT: fan out to everyone; `notif_create` filters the `off` members
-- unless the row is important. UPDATE of `important` (normal -> important):
-- fan out only to the members the INSERT pass deliberately skipped, i.e.
-- those with an explicit `off` row, so nobody is notified twice.
create or replace function public.notif_on_announcement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is null then
      perform public.notif_announcement_fanout(new.id, false);
    end if;
  elsif tg_op = 'UPDATE' then
    if coalesce(new.important, false) and not coalesce(old.important, false)
       and new.deleted_at is null then
      perform public.notif_announcement_fanout(new.id, true);
    end if;
  end if;
  return null;
end $$;
revoke all on function public.notif_on_announcement() from public, anon, authenticated;

create trigger announcements_notify_insert after insert on public.announcements
  for each row execute function public.notif_on_announcement();
create trigger announcements_notify_escalate after update of important on public.announcements
  for each row execute function public.notif_on_announcement();

------------------------------------------------------------------------
-- 5. Achievement unlock: immediate to the unlocker, batched to friends.
------------------------------------------------------------------------
-- See the DEVIATION note at the top of this file. `achievement_unlocked`
-- is a self-directed type, so `notif_create` allows recipient == actor for
-- it. The friend fan-out is a mutual-follow join (the `are_friends`
-- definition) computed directly rather than via the caller-relative
-- `are_friends()` helper, because the trigger's `auth.uid()` is the
-- unlocker on the `ach_claim` path but could be a system id on a future
-- `ach_evaluate` path.
create or replace function public.notif_on_achievement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := new.user_id;
  v_name text;
  v_visible boolean;
  v_friend uuid;
begin
  select d.name into v_name
  from public.achievement_definitions d where d.id = new.achievement_id;

  perform public.notif_create(
    v_user, 'achievement_unlocked', 'training',
    'Achievement unlocked', coalesce(v_name, ''),
    'achievement', new.id,
    '/community/account/achievements?ma=' || new.id::text
  );

  -- Friend fan-out only when the unlocker exposes achievements at all.
  select (p.deleted_at is null and p.visible_to_club and p.show_achievements)
    into v_visible
  from public.profiles p where p.id = v_user;
  if not coalesce(v_visible, false) or new.visibility = 'only_me' then
    return null;
  end if;

  for v_friend in
    select f1.followed_id
    from public.follows f1
    join public.follows f2
      on f2.follower_id = f1.followed_id and f2.followed_id = f1.follower_id
    where f1.follower_id = v_user
  loop
    if not public.notif_blocked_between(v_user, v_friend)
       and public.notif_pref_allows(v_friend, 'friend_achievement') then
      perform public.notif_queue_batched(v_friend, 'training', 'friend_achievement', new.id);
    end if;
  end loop;

  return null;
end $$;
revoke all on function public.notif_on_achievement() from public, anon, authenticated;

create trigger member_achievements_notify after insert on public.member_achievements
  for each row execute function public.notif_on_achievement();

commit;
