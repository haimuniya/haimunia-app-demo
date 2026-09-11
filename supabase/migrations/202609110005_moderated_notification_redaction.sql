begin;

-- Security hunt, round 4 (2026-09-11), moderation/abuse-bypass agent.
--
-- THE FINDING. notif_create() (202608280026) is fed a raw text SNAPSHOT of
-- a comment/post body at the moment a notification is created
-- (notif_on_comment/notif_on_mention, 202608280027, pass new.body/
-- v_comment.body straight through) and nothing ever revisits that snapshot.
-- Confirmed live against real local Postgres: a member comments on another
-- member's post, the post author gets a notifications row carrying the
-- comment's exact text; a moderator then removes that same comment via
-- comment_moderate(comment_id, 'remove') - the comment itself correctly
-- disappears from every read of post_comments - but re-reading
-- notifications for that recipient still returns the row with the
-- ORIGINAL, UNMODERATED TEXT, rendered verbatim by renderNotifRow()
-- (cloud.js) in the Notification Center. The entire point of a moderator
-- "remove" action - very often taken BECAUSE the text was reported as
-- abusive - is defeated for the one person it was already pushed to.
--
-- THE FIX. comment_moderate('remove') and post_delete() now also redact
-- (blank the title/body of, never delete the row - read_at/created_at and
-- the fact that something happened there stay meaningful) any
-- notifications row whose source points at the content just removed.
-- notifications.body/title are NOT NULL, so redaction is an empty string,
-- matching the column's own default - not a new sentinel value a reader
-- would have to learn. deep_link is left alone: it already resolves to a
-- comment/post that post_visible_to_viewer()/the moderated-status filter
-- will refuse to render, so following it after redaction shows nothing
-- extra. Restoring a comment does NOT restore its notification text -
-- once redacted stays redacted, so a moderation flip-flop cannot briefly
-- re-expose it and then hide it again in a way a client could race.
--
-- NOT IN SCOPE OF THIS FIX, same root cause, lower severity, recorded for a
-- follow-up: a block does not retroactively redact the blocked party's
-- PRE-BLOCK notification snapshots (confirmed by the same agent this
-- round) - everything created AFTER a block is already correctly refused
-- (add_post_comment, mentions), only old snapshots survive, and unlike a
-- moderator's "remove" there is no explicit signal here that the content
-- itself was wrong, only that the relationship changed.
--
-- ONE MORE THING THIS FIX HAD TO CLOSE ON THE WAY IN: protect_notification_content()
-- (202608280008) unconditionally reverts title/body/every other column on
-- ANY authenticated-role UPDATE to notifications, with no pin - unlike
-- every other protect_*/guard trigger in this schema, it was never given
-- one, because nothing had ever needed a legitimate server-side exception
-- to it before. Without one, comment_moderate()'s/post_delete()'s own
-- redaction UPDATE ran, reported a row updated, and was silently reverted
-- back to the original text by this same trigger one statement later -
-- caught by this migration's own regression test before it ever shipped.
-- Given the same app.allow_moderation_write pin comment_moderate()/
-- post_delete() already reach for on workout_posts.

create or replace function public.protect_notification_content() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated'
     and coalesce(current_setting('app.allow_moderation_write', true), '') <> 'on' then
    new.user_id = old.user_id;
    new.club_id = old.club_id;
    new.type = old.type;
    new.category = old.category;
    new.title = old.title;
    new.body = old.body;
    new.source_type = old.source_type;
    new.source_id = old.source_id;
    new.deep_link = old.deep_link;
    new.push_sent_at = old.push_sent_at;
    new.created_at = old.created_at;
  end if;
  return new;
end $$;
comment on function public.protect_notification_content() is
  'Security hunt round 4 (202609110005), pinnable. BEFORE UPDATE on notifications. Reverts every column to its prior value on an authenticated-role UPDATE, EXCEPT inside the transaction-local app.allow_moderation_write pin - set only by comment_moderate()/post_delete() around their own redaction UPDATE (title/body only, in practice). Without the pin: same as always, an owning member cannot rewrite the title/body/source of a notification the server wrote, which would make the stream untrustworthy as an audit surface. A service-role or dashboard write still passes regardless (auth.role() is not authenticated).';

create or replace function public.comment_moderate(p_comment_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.post_comments;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_action not in ('remove', 'restore') then
    raise exception 'unknown action %', p_action;
  end if;
  if not (public.has_perm('community.comment.moderate')
          or exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null)) then
    raise exception 'not authorized';
  end if;

  select * into v_row from public.post_comments where id = p_comment_id;
  if not found then raise exception 'comment not found'; end if;

  if p_action = 'remove' then
    if v_row.status = 'removed' and v_row.deleted_at is not null then return; end if;
    update public.post_comments
      set status = 'removed', deleted_at = now(), deleted_by = v_uid
    where id = p_comment_id;
    -- Security hunt round 4 (202609110005): blank any notification snapshot
    -- of this exact comment's text - the fix this migration adds. Runs
    -- inside the pin protect_notification_content() now checks, or this
    -- UPDATE would report success and be silently reverted one statement
    -- later by that same trigger.
    perform set_config('app.allow_moderation_write', 'on', true);
    update public.notifications
       set title = '', body = ''
     where source_type = 'comment' and source_id = p_comment_id
       and (title <> '' or body <> '');
    perform set_config('app.allow_moderation_write', 'off', true);
    perform public.log_admin_action(
      'content_delete', 'comment', p_comment_id,
      jsonb_build_object('status', v_row.status::text),
      jsonb_build_object('status', 'removed'),
      'remove', null, v_row.author_id
    );
  else
    if v_row.status = 'active' and v_row.deleted_at is null then return; end if;
    update public.post_comments
      set status = 'active', deleted_at = null, deleted_by = null
    where id = p_comment_id;
    perform public.log_admin_action(
      'content_delete', 'comment', p_comment_id,
      jsonb_build_object('status', v_row.status::text),
      jsonb_build_object('status', 'active'),
      'restore', null, v_row.author_id
    );
  end if;
end $$;
revoke all on function public.comment_moderate(uuid, text) from public, anon;
grant execute on function public.comment_moderate(uuid, text) to authenticated;

comment on function public.comment_moderate(uuid, text) is
  'Security hunt round 4 (202609110005): the remove branch now also blanks title/body on any notifications row snapshotting this comment''s text (source_type=''comment'', source_id=p_comment_id) - closes a confirmed live finding where a removed comment''s exact text survived, fully readable, in the recipient''s Notification Center. Restore does not un-redact. Otherwise unchanged from 202609060022: staff-only (community.comment.moderate or is_admin), raises ''unknown action %'', ''not authorized'', ''comment not found''; both branches are idempotent no-ops when the row is already in the target state and log one content_delete admin action naming the real author.';

create or replace function public.post_delete(post_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.workout_posts;
  v_is_mod boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select * into v_row from public.workout_posts where id = post_id;
  if not found then raise exception 'post not found'; end if;

  v_is_mod := public.has_perm('community.post.delete_any')
              or public.has_perm('community.comment.moderate')
              or exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null);

  if v_row.author_id is distinct from v_uid and not v_is_mod then
    raise exception 'not authorized';
  end if;

  if v_row.deleted_at is not null and v_row.status = 'removed' then return; end if;

  perform set_config('app.allow_moderation_write', 'on', true);
  update public.workout_posts
    set deleted_at = now(), status = 'removed'
  where id = post_id;
  perform set_config('app.allow_moderation_write', 'off', true);

  -- Security hunt round 4 (202609110005): same redaction as
  -- comment_moderate(), for any notification snapshot pointing at this post
  -- directly (e.g. a 'new_report' alert, whose source_type/source_id point
  -- at the reported target per 202609050003) - not the post's OWN comments,
  -- which are a separate content type this function never touches. Its own
  -- pin window, separate from the one above: unrelated tables, unrelated
  -- guard triggers.
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.notifications
     set title = '', body = ''
   where source_type = 'post' and source_id = post_id
     and (title <> '' or body <> '');
  perform set_config('app.allow_moderation_write', 'off', true);

  if v_row.author_id is distinct from v_uid then
    perform public.log_admin_action(
      'content_delete', 'post', post_id,
      jsonb_build_object('status', v_row.status::text, 'deleted_at', v_row.deleted_at),
      jsonb_build_object('status', 'removed'),
      'remove', null, v_row.author_id
    );
  end if;
end $$;
revoke all on function public.post_delete(uuid) from public, anon;
grant execute on function public.post_delete(uuid) to authenticated;

comment on function public.post_delete(uuid) is
  'Security hunt round 4 (202609110005): also blanks title/body on any notifications row pointing directly at this post (source_type=''post'', source_id=post_id) - same fix and reasoning as comment_moderate(). Otherwise unchanged from 202609060022: author or moderator (community.post.delete_any, community.comment.moderate, or is_admin) only, idempotent no-op when already removed, logs one content_delete admin action only when a moderator (not the author) acted.';

commit;
