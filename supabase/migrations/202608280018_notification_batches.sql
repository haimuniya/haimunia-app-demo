begin;

-- COMM-142, the schema half. Batched notification state: one open batch per
-- member per category, with a next-flush timestamp.
--
-- What this table is NOT is a second notification stream. It holds counters
-- only. When a batch flushes it produces exactly one row in `notifications`
-- and resets, which is what makes "reactions roll up into one notification
-- per type per window" true rather than aspirational.
--
-- The member can read their own batch and nothing else. There is no insert,
-- update, or delete grant and no policy for any of the three: a batch is
-- written by the trigger or event-bus consumer that queued the item, and
-- reset by the flusher. If a member could write here they could set their
-- own next_flush_at to now() and turn the batched channel back into a
-- stream of pings, which is the exact thing COMM-142 exists to prevent.

-- The window in one place, so a test asserts against the same value the
-- default does and neither can drift. COMM-142 fixes it at 6 hours.
create or replace function public.notification_batch_window() returns interval
language sql immutable set search_path = '' as $$
  select interval '6 hours';
$$;
revoke all on function public.notification_batch_window() from public, anon;
grant execute on function public.notification_batch_window() to authenticated;

create table public.notification_batches (
  user_id uuid not null references public.profiles(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  -- The same five labels notifications.category uses. Repeated as a CHECK
  -- rather than shared through a lookup table because notifications already
  -- did it that way in 202608280008 and one of them being wrong is easier
  -- to spot when they look identical.
  category text not null check (category in ('community', 'training', 'challenges', 'events', 'club')),
  -- How many items are waiting, and the per-type breakdown that decides how
  -- many notifications the flush produces. Shape:
  --   {"reaction": {"count": 4, "last_source_id": "..."}, ...}
  pending_count integer not null default 0 check (pending_count >= 0),
  pending jsonb not null default '{}'::jsonb,
  window_started_at timestamptz not null default now(),
  next_flush_at timestamptz not null default (now() + public.notification_batch_window()),
  last_flushed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

-- The flusher's only query: everything overdue that has something in it.
create index notification_batches_due_idx on public.notification_batches(next_flush_at)
  where pending_count > 0;

alter table public.notification_batches enable row level security;

revoke all on public.notification_batches from public, anon;
grant select on public.notification_batches to authenticated;

create policy notification_batches_self_select on public.notification_batches for select to authenticated
  using (user_id = auth.uid());

-- The two write paths. Neither is granted to anon or authenticated, so
-- neither is reachable from a client at all - same shape as
-- log_admin_action() in 202608280002. They are called from inside a
-- consumer function or by the service role.
--
-- Neither checks auth.uid(), and that is deliberate rather than an
-- oversight of the definer rule. The whole point of these two is that they
-- act on a member OTHER than the actor: the person who reacted is not the
-- person whose batch is being filled. A caller check would have to be
-- "auth.uid() is null or auth.uid() <> p_user", which asserts nothing. The
-- boundary here is the missing grant, not an identity test.
create or replace function public.notif_queue_batched(
  p_user uuid,
  p_category text,
  p_type text,
  p_source_id uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
  v_now timestamptz := now();
begin
  if p_user is null then raise exception 'target member required'; end if;
  if p_category not in ('community', 'training', 'challenges', 'events', 'club') then
    raise exception 'unknown notification category %', p_category;
  end if;
  if p_type is null or p_type !~ '^[a-z][a-z0-9_.]{2,63}$' then
    raise exception 'unknown notification type %', p_type;
  end if;
  v_key := p_type;

  insert into public.notification_batches
    (user_id, category, pending_count, pending, window_started_at, next_flush_at, updated_at)
  values (
    p_user, p_category, 1,
    jsonb_build_object(v_key, jsonb_build_object('count', 1, 'last_source_id', p_source_id)),
    v_now, v_now + public.notification_batch_window(), v_now
  )
  on conflict (user_id, category) do update set
    pending_count = public.notification_batches.pending_count + 1,
    pending = jsonb_set(
      public.notification_batches.pending,
      array[v_key],
      jsonb_build_object(
        'count',
        coalesce((public.notification_batches.pending #>> array[v_key, 'count'])::integer, 0) + 1,
        'last_source_id', p_source_id
      ),
      true
    ),
    -- An empty batch starts a fresh window. A batch that already holds
    -- something keeps its original deadline, so a steady trickle of
    -- reactions cannot push the flush out forever.
    window_started_at = case
      when public.notification_batches.pending_count = 0 then v_now
      else public.notification_batches.window_started_at end,
    next_flush_at = case
      when public.notification_batches.pending_count = 0
        then v_now + public.notification_batch_window()
      else public.notification_batches.next_flush_at end,
    updated_at = v_now;
end $$;
revoke all on function public.notif_queue_batched(uuid, text, text, uuid) from public, anon, authenticated;

-- Called by the flusher after it has written the rolled-up notifications
-- row. Resets the counters and arms the next window. Idempotent: a second
-- call on an already-empty batch changes nothing but last_flushed_at.
create or replace function public.notif_batch_flushed(p_user uuid, p_category text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := now();
begin
  if p_user is null then raise exception 'target member required'; end if;
  update public.notification_batches set
    pending_count = 0,
    pending = '{}'::jsonb,
    window_started_at = v_now,
    next_flush_at = v_now + public.notification_batch_window(),
    last_flushed_at = v_now,
    updated_at = v_now
  where user_id = p_user and category = p_category;
end $$;
revoke all on function public.notif_batch_flushed(uuid, text) from public, anon, authenticated;

commit;
