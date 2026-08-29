begin;

-- Community Phase 1 schema follow-up, run 3 of 3: the notifications server
-- side, part 1 of 3 - the single trusted insert path into
-- `public.notifications` plus the helpers it and the trigger set share.
--
-- `notifications` has no INSERT policy and no INSERT grant (202608280008).
-- A row is created only by `notif_create()` below (immediate types) or by
-- the batch flusher in 202608280028 (rolled-up batched types). Both run as
-- the migration owner, on purpose: they cross the `notifications` RLS
-- boundary that a member can never cross themselves.
--
-- `notif_create()` follows the exact reasoning `notif_queue_batched()`
-- (202608280018) records: it does read `auth.uid()`, but only to identify
-- the actor for the self-notify and block-edge filters. It is NOT an
-- identity gate, because the function always acts on a member OTHER than
-- the caller, so "auth.uid() is null or auth.uid() <> p_user" would assert
-- nothing. The boundary is the missing EXECUTE grant.

-- 0. Fix a latent bug in the 202608280008 `notifications_deep_link_check`
-- constraint. Its regex `^/[A-Za-z0-9_/?=&.%-]{0,300}$` has a bound of 300,
-- but a Postgres regex repetition bound may not exceed 255 - so the regex
-- raises "invalid repetition count(s)" the moment it is evaluated. Nothing
-- has ever inserted a `notifications` row with a non-null `deep_link`
-- before this run, so the bug has sat dormant. `notif_create` and every
-- trigger below write a `deep_link`, so it has to work. Re-create the
-- constraint with a 255 bound, same intent: an in-app route only, leading
-- slash enforced, no open redirect. Every real deep link here is ~100
-- chars. The name is the deterministic single-column inline-check name.
alter table public.notifications drop constraint if exists notifications_deep_link_check;
alter table public.notifications add constraint notifications_deep_link_check
  check (deep_link is null or deep_link ~ '^/[A-Za-z0-9_/?=&.%-]{0,255}$');

-- 1. The single important flag COMM-142 / COMM-144 need. Phase 1 has one
-- level of override; the full priority enum is COMM-218 (Phase 2). An
-- announcement with `important = true` is "operational": it reaches every
-- member regardless of their `announcements` preference.
alter table public.announcements
  add column if not exists important boolean not null default false;
comment on column public.announcements.important is
  'COMM-144 operational override. When true the announcement notification bypasses a members off announcements preference.';

-- 2. The de-dupe window. One place, so a qa test asserts against the same
-- value the function uses. Kept generous: the de-dupe key is now the
-- specific event row id (a comment id, a member_achievement id), so this
-- only ever catches a trigger firing twice for one event, never two real
-- events.
create or replace function public.notif_dedupe_window() returns interval
language sql immutable set search_path = '' as $$
  select interval '1 hour';
$$;
revoke all on function public.notif_dedupe_window() from public, anon;
grant execute on function public.notif_dedupe_window() to authenticated;

-- 3. notification type -> preference key. The client writes
-- `notification_preferences` rows keyed by the coarse label a settings
-- screen shows ("mentions", "reactions", "announcements"), not by the
-- fine-grained `notifications.type`. This is the one mapping between the
-- two vocabularies. A type with no coarser bucket maps to itself.
create or replace function public.notif_pref_key(p_type text) returns text
language sql immutable set search_path = '' as $$
  select case p_type
    when 'comment_reply'        then 'comment_reply'
    when 'comment_on_post'      then 'comment_on_post'
    when 'comment_also'         then 'comment_on_post'
    when 'mention'              then 'mentions'
    when 'coach_mention'        then 'mentions'
    when 'reaction'             then 'reactions'
    when 'announcement'         then 'announcements'
    when 'friend_achievement'   then 'friend_achievements'
    when 'achievement_unlocked' then 'achievement_unlocked'
    else p_type
  end;
$$;
revoke all on function public.notif_pref_key(text) from public, anon, authenticated;

-- 4. Block edge in either direction. Internal helper: no grant to any
-- client role. A null on either side is "no edge" so a system caller with
-- no `auth.uid()` is not filtered out.
create or replace function public.notif_blocked_between(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_a is not null and p_b is not null and exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$$;
revoke all on function public.notif_blocked_between(uuid, uuid) from public, anon, authenticated;

-- 5. Does the recipient's preference allow this type? A missing row is
-- `in_app`, i.e. allowed. Only an explicit `off` row on the mapped key
-- suppresses. The batched path (`notif_queue_batched`) does not read
-- preferences at all, so the triggers call this before enqueueing;
-- `notif_create` calls it for the immediate path.
create or replace function public.notif_pref_allows(p_user uuid, p_type text) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public.notification_preferences np
    where np.user_id = p_user
      and np.type = public.notif_pref_key(p_type)
      and np.channel = 'off'
  );
$$;
revoke all on function public.notif_pref_allows(uuid, text) from public, anon, authenticated;

-- 6. Is this specific notification operational, i.e. does it override an
-- `off` preference? Only `announcement` can be, and only when its row
-- carries `important = true`. Keeping the 8-argument `notif_create`
-- signature fixed means the "is this operational" decision has to be a
-- lookup on the source row rather than a parameter.
create or replace function public.notif_is_operational(p_type text, p_source_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_type = 'announcement' then coalesce(
      (select a.important from public.announcements a where a.id = p_source_id), false)
    else false
  end;
$$;
revoke all on function public.notif_is_operational(text, uuid) from public, anon, authenticated;

-- 7. The one immediate-notification insert path.
--
-- Returns the new row id, or NULL when the row was suppressed:
--   - recipient is the actor (except the self-directed types, whose whole
--     purpose is to land in the actor's own stream)
--   - a block edge sits between recipient and actor
--   - the recipient has an `off` preference for the type and the row is
--     not operational
--   - an identical (user, type, source_id) row already exists inside
--     `notif_dedupe_window()` - one event fired twice, not two events
--
-- No grant to anyone. Called only from a trigger, another definer
-- function, or the service role.
create or replace function public.notif_create(
  p_user uuid,
  p_type text,
  p_category text,
  p_title text,
  p_body text,
  p_source_type text,
  p_source_id uuid,
  p_deep_link text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if p_user is null then return null; end if;
  if p_type is null or p_type !~ '^[a-z][a-z0-9_.]{2,63}$' then
    raise exception 'unknown notification type %', p_type;
  end if;
  if p_category not in ('community', 'training', 'challenges', 'events', 'club') then
    raise exception 'unknown notification category %', p_category;
  end if;

  -- Recipient is never the actor, except the self-directed types.
  if v_actor is not null and p_user = v_actor
     and p_type not in ('achievement_unlocked', 'weekly_recap') then
    return null;
  end if;

  if public.notif_blocked_between(p_user, v_actor) then
    return null;
  end if;

  if not public.notif_pref_allows(p_user, p_type)
     and not public.notif_is_operational(p_type, p_source_id) then
    return null;
  end if;

  if exists (
    select 1 from public.notifications n
    where n.user_id = p_user
      and n.type = p_type
      and n.source_id is not distinct from p_source_id
      and n.created_at > now() - public.notif_dedupe_window()
  ) then
    return null;
  end if;

  insert into public.notifications
    (user_id, type, category, title, body, source_type, source_id, deep_link)
  values (
    p_user, p_type, p_category,
    coalesce(left(p_title, 160), ''),
    coalesce(left(p_body, 500), ''),
    p_source_type, p_source_id, p_deep_link
  )
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.notif_create(uuid, text, text, text, text, text, uuid, text)
  from public, anon, authenticated;

commit;
