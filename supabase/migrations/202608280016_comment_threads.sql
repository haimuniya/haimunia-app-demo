begin;

-- COMM-121 (two-level replies) and COMM-122 (edit and delete own), the
-- schema half of both.
--
-- The table is public.post_comments. The tickets call it `comments`, the
-- same way they call workout_posts `posts`. It is not renamed: cloud.js
-- reads and writes it by name and the feed view joins it.
--
-- Depth is capped at 2 by a trigger rather than by a CHECK because a CHECK
-- cannot see another row. The trigger closes both directions: a reply
-- cannot be given a parent that already has a parent, AND a comment that
-- already has replies cannot itself become a reply. Without that second
-- rule a depth-3 thread is one UPDATE away, since the first rule only ever
-- looks upward from the row being written.

alter table public.post_comments
  add column club_id uuid not null default public.default_club_id() references public.clubs(id),
  -- ON DELETE SET NULL, not CASCADE. A hard delete of a parent must not
  -- destroy other members' replies; the replies flatten to top level and
  -- survive. The intended moderation and self-delete path is the soft one
  -- below (status plus deleted_at), which keeps the thread shape.
  add column parent_comment_id uuid references public.post_comments(id) on delete set null,
  add column edited_at timestamptz,
  add column deleted_at timestamptz,
  -- Same enum workout_posts.status already uses, so "removed" means one
  -- thing across posts and comments and mod_review has one vocabulary.
  add column status public.post_status not null default 'active';

create index post_comments_parent_idx on public.post_comments(parent_comment_id, created_at)
  where parent_comment_id is not null;
create index post_comments_live_idx on public.post_comments(post_id, created_at)
  where deleted_at is null;

-- COMM-121 and COMM-122 both set the comment body limit at 1000, matching
-- the post body limit added in 202608280004. The old inline CHECK capped it
-- at 280. Widening only ever accepts more rows, so no existing row can be
-- invalidated. The constraint was declared inline in 202608270004, so its
-- name is whatever Postgres generated - it is looked up rather than
-- guessed, the same way 202608280001 handled invite_redemptions.
do $$
declare v_name text;
begin
  select conname into v_name from pg_constraint
  where conrelid = 'public.post_comments'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%280%';
  if v_name is not null then
    execute format('alter table public.post_comments drop constraint %I', v_name);
  end if;
end $$;
alter table public.post_comments
  add constraint post_comments_body_check check (char_length(body) between 1 and 1000);

-- SECURITY DEFINER for the same reason enforce_event_capacity() is: the
-- parent lookup must see the real row, not the subset the writer's own
-- select policy exposes. It takes no caller-supplied argument and can only
-- ever be reached as a trigger on the row being written, so there is no
-- input to validate against auth.uid().
create or replace function public.enforce_comment_depth() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_parent public.post_comments;
begin
  if new.parent_comment_id is null then return new; end if;
  if new.parent_comment_id = new.id then
    raise exception 'a comment cannot reply to itself';
  end if;

  select * into v_parent from public.post_comments where id = new.parent_comment_id;
  if not found then raise exception 'parent comment not found'; end if;
  if v_parent.post_id <> new.post_id then
    raise exception 'a reply must sit on the same post as its parent';
  end if;
  if v_parent.parent_comment_id is not null then
    raise exception 'reply depth is capped at 2';
  end if;
  -- The upward rule alone is not enough. Attaching a parent to a comment
  -- that already has children would push those children to depth 3.
  if exists (select 1 from public.post_comments c where c.parent_comment_id = new.id) then
    raise exception 'a comment that already has replies cannot become a reply';
  end if;
  return new;
end $$;
create trigger post_comments_depth before insert or update of parent_comment_id, post_id
  on public.post_comments for each row execute function public.enforce_comment_depth();

-- Read. The existing rule is kept in full - a comment can never be more
-- exposed than the post it sits on - and a removed or soft-deleted comment
-- now drops out for everyone except its author and a moderator.
--
-- The "comment removed" placeholder COMM-122 asks for does not need the
-- removed row to be readable. A reply carries parent_comment_id, so a
-- client that receives a reply whose parent is absent from the same page
-- knows there is a removed parent and renders the placeholder from that.
-- Nothing about the removed comment's text has to cross the wire for the
-- thread to render correctly, which is the point.
drop policy post_comments_visible on public.post_comments;
create policy post_comments_visible on public.post_comments for select to authenticated using (
  public.post_visible_to_viewer(post_id)
  and (
    (deleted_at is null and status = 'active')
    or author_id = auth.uid()
    or public.has_perm('community.comment.moderate')
  )
);

-- post_comments_delete_self is left exactly as it is: author only. A
-- moderator removal is a status change written by mod_review (COMM-153), so
-- it leaves a row and an admin_actions entry behind. Handing a moderator a
-- hard DELETE would erase the thing the audit log points at.
--
-- There is still no INSERT and no UPDATE grant on this table. Creating and
-- editing a comment go through the two definer functions below, which is
-- what keeps the rate limit, the recovery gate, and the posting restriction
-- impossible to route around.

-- add_post_comment gains a parent argument. The existing two-argument
-- signature is kept as a wrapper rather than replaced with a default
-- parameter: a three-argument function with a default would make the
-- current client's two-argument call ambiguous and fail at call time. Same
-- pattern redeem_invite_code used in 202608280013.
create or replace function public.add_post_comment(p_post_id uuid, p_body text, p_parent_comment_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_parent public.post_comments;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- COMM-153 enforcement point 2. Checked before the rate limit so a
  -- restricted member burns no budget and gets the accurate reason.
  if public.is_posting_restricted(auth.uid()) then raise exception 'posting_restricted'; end if;
  if not public.check_rate_limit('post_comment', 20, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;

  if p_parent_comment_id is not null then
    select * into v_parent from public.post_comments where id = p_parent_comment_id;
    if not found then raise exception 'parent comment not found'; end if;
    if v_parent.post_id <> p_post_id then raise exception 'parent comment is on another post'; end if;
    if v_parent.parent_comment_id is not null then raise exception 'reply depth is capped at 2'; end if;
    if v_parent.deleted_at is not null or v_parent.status <> 'active' then
      raise exception 'parent comment is no longer available';
    end if;
  end if;

  insert into public.post_comments (post_id, author_id, body, parent_comment_id)
  values (p_post_id, auth.uid(), left(coalesce(p_body, ''), 1000), p_parent_comment_id)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.add_post_comment(uuid, text, uuid) from public, anon;
grant execute on function public.add_post_comment(uuid, text, uuid) to authenticated;

-- The pre-existing signature, now a wrapper. Kept so cloud.js keeps working
-- unchanged while engagement wires the parent argument through COMM-121.
-- Behaviour with no parent is identical to what it was, plus the two new
-- gates above, which every comment path is meant to carry.
create or replace function public.add_post_comment(p_post_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  return public.add_post_comment(p_post_id, p_body, null::uuid);
end $$;

-- COMM-122. Author only, body only, and it always stamps edited_at, so an
-- edit can never be silent. Definer because the table has no UPDATE grant:
-- that is deliberate, it makes this the single edit path.
create or replace function public.comment_edit(p_comment_id uuid, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.post_comments;
  v_body text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  v_body := left(coalesce(p_body, ''), 1000);
  if char_length(btrim(v_body)) = 0 then raise exception 'comment body required'; end if;

  select * into v_row from public.post_comments where id = p_comment_id;
  if not found then raise exception 'comment not found'; end if;
  if v_row.author_id <> v_uid then raise exception 'not authorized'; end if;
  if v_row.deleted_at is not null or v_row.status <> 'active' then
    raise exception 'comment is no longer editable';
  end if;
  -- An edit is a community write, so it carries the same gates a create
  -- does. A restricted member cannot rewrite an old comment into new
  -- content, which would otherwise be the obvious way around COMM-153.
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;
  if not public.check_rate_limit('comment_edit', 30, 10) then raise exception 'rate_limited'; end if;

  update public.post_comments
    set body = v_body, edited_at = now()
  where id = p_comment_id;
end $$;
revoke all on function public.comment_edit(uuid, text) from public, anon;
grant execute on function public.comment_edit(uuid, text) to authenticated;

commit;
