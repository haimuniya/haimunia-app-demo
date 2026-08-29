begin;

-- COMM-121 mentions and COMM-122 self-delete, the schema half of both.
--
-- Mentions. The open item in "Needs from schema, notifications" was that a
-- trigger on post_comments cannot see a mention list that only ever existed
-- in the client. Two of the three options there are closed here, and on
-- purpose: add_post_comment gains a p_mentions argument (option 3) AND the
-- accepted mentions are stored in a table (option 1). The argument is what
-- lets the definer function re-check every target with
-- can_view_profile_field() before anything is written, so a hand-rolled RPC
-- call cannot mention a member who turned mentions off or who sits behind a
-- block edge. The table is what lets the notification trigger set stay
-- declarative: notif_on_comment() reads rows, not a function argument, so
-- the same trigger serves any future write path.
--
-- The mention marker in the body text (@[Display Name](uuid)) is NOT the
-- source of truth and is never parsed server-side. Parsing it would make
-- the mention list editable by comment_edit(), which is exactly the sort of
-- "edit an old comment into a new ping" path COMM-153 closes elsewhere.

create table public.comment_mentions (
  comment_id uuid not null references public.post_comments(id) on delete cascade,
  mentioned_user_id uuid not null references public.profiles(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  created_at timestamptz not null default now(),
  primary key (comment_id, mentioned_user_id)
);
create index comment_mentions_user_idx on public.comment_mentions(mentioned_user_id, created_at desc);

alter table public.comment_mentions enable row level security;
revoke all on public.comment_mentions from public, anon;
-- Select only. There is no insert, update, or delete grant and no policy
-- for any of the three: add_post_comment is the only writer, the same way
-- post_comments itself has no insert grant.
grant select on public.comment_mentions to authenticated;

-- Readable by the mentioned member and by the comment author, and by
-- nobody else. A third member cannot enumerate who was tagged in a thread,
-- which is the piece that would otherwise leak a private mention list to
-- everyone who can read the comment. The mentioned member still has to be
-- able to read the comment itself for the row to be useful, which
-- post_comments_visible already decides.
create policy comment_mentions_read on public.comment_mentions for select to authenticated using (
  mentioned_user_id = auth.uid()
  or exists (
    select 1 from public.post_comments c
    where c.id = comment_id and c.author_id = auth.uid()
  )
);

-- The four-argument form. The two- and three-argument forms are untouched
-- and keep working: separate functions rather than a default parameter,
-- because a default would make the current client's shorter calls
-- ambiguous and fail at call time. Same pattern 202608280016 and
-- 202608280013 used.
--
-- It delegates the whole create path to the three-argument function, so
-- the recovery gate, the posting restriction, the rate limit, the
-- visibility check, and the depth cap are checked in exactly one place and
-- cannot drift between the two signatures.
create or replace function public.add_post_comment(
  p_post_id uuid,
  p_body text,
  p_parent_comment_id uuid,
  p_mentions uuid[]
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_uid uuid;
  v_targets uuid[];
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  -- Capped at the same 10 the client contract caps the bus event at. Over
  -- the cap is a raise, not a silent trim: a comment that mentions 40
  -- members is a fan-out, not a mention. Checked before the comment is
  -- created, so an over-cap call is refused without writing anything.
  if p_mentions is not null and array_length(p_mentions, 1) > 10 then
    raise exception 'at most 10 mentions per comment';
  end if;

  v_id := public.add_post_comment(p_post_id, p_body, p_parent_comment_id);
  if p_mentions is null or array_length(p_mentions, 1) is null then return v_id; end if;

  select array_agg(distinct t.target) into v_targets
  from unnest(p_mentions) as t(target)
  where t.target is not null and t.target <> v_uid;
  if v_targets is null then return v_id; end if;

  -- A target that fails the check is skipped, not rejected. The client has
  -- already rewritten those to plain text before sending, so raising here
  -- would turn "your mention did not go through" into "your comment did
  -- not go through". can_view_profile_field() is false across a block edge
  -- in either direction, so that case is covered by the same call.
  insert into public.comment_mentions (comment_id, mentioned_user_id)
  select v_id, t.target
  from unnest(v_targets) as t(target)
  where exists (select 1 from public.profiles p where p.id = t.target and p.deleted_at is null)
    and public.can_view_profile_field(t.target, 'allow_mentions')
  on conflict do nothing;

  return v_id;
end $$;
revoke all on function public.add_post_comment(uuid, text, uuid, uuid[]) from public, anon;
grant execute on function public.add_post_comment(uuid, text, uuid, uuid[]) to authenticated;

-- COMM-122 self-delete, the soft path.
--
-- Today deleteComment is a hard DELETE under post_comments_delete_self.
-- That works, but parent_comment_id is ON DELETE SET NULL, so deleting a
-- parent silently flattens other members' replies to top level and the
-- thread loses its shape. This gives the member the same soft removal a
-- moderator gets.
--
-- deleted_by is the column that lets the two paths coexist. comment_moderate
-- (run 2) writes the same status and deleted_at plus an admin_actions row,
-- and stamps itself here. A client can then tell "the author removed this"
-- from "a moderator removed this" without a second query, and a moderator
-- removal is never quietly overwritten by the author calling delete after
-- the fact - see the already-deleted no-op below.
alter table public.post_comments
  add column deleted_by uuid references public.profiles(id) on delete set null;

-- A definer function rather than a narrow own-row UPDATE policy. A policy
-- cannot say "you may set these two columns and no others" - USING and
-- WITH CHECK see whole rows, so an own-row UPDATE policy would also hand
-- the author a second, unlogged body-edit path that skips comment_edit's
-- restriction check and its mandatory edited_at stamp. Keeping post_comments
-- with no UPDATE grant at all is what makes comment_edit and comment_delete
-- the complete list of ways a comment can change.
create or replace function public.comment_delete(p_comment_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.post_comments;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select * into v_row from public.post_comments where id = p_comment_id;
  if not found then raise exception 'comment not found'; end if;
  if v_row.author_id <> v_uid then raise exception 'not authorized'; end if;

  -- Idempotent, and it deliberately does not re-stamp. A moderator removal
  -- that already happened keeps its deleted_by, so the audit trail behind
  -- admin_actions still points at a row that agrees with it.
  if v_row.deleted_at is not null or v_row.status <> 'active' then return; end if;

  -- No is_community_member() and no is_posting_restricted() gate here.
  -- Removing your own words is not a community write, and a restricted or
  -- not-yet-verified member must always be able to take their content
  -- down. Same reasoning toggle_reaction uses for removing your own
  -- reaction.
  update public.post_comments
    set status = 'removed', deleted_at = now(), deleted_by = v_uid
  where id = p_comment_id;
end $$;
revoke all on function public.comment_delete(uuid) from public, anon;
grant execute on function public.comment_delete(uuid) to authenticated;

commit;
