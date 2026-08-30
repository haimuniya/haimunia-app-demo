begin;

-- Community Phase 2, challenges cluster, part 4 of 4: the notification side
-- COMM-208 needs, exactly the shape "Needs from schema, notifications
-- (Phase 2)" documents. No change to notif_create or the Phase 1 trigger
-- set's signatures - every piece here is new, following their pattern.

-- 1. challenge_ending_soon: an immediate notification, sent once per
-- challenge (not once per participant - challenges.ending_soon_notified_at
-- gates the whole challenge's fan-out in one pass, so a race between two
-- calls of chal_notify_ending_soon() cannot double-send once the column is
-- stamped inside the same loop iteration).
alter table public.challenges
  add column ending_soon_notified_at timestamptz;

-- Same shape as notif_batch_flush_due (202608280028): service-role only,
-- selects what is due, does the work, stamps state so it is not selected
-- again. SCHEDULER is not built here - same open item as the batch
-- flusher, needs a pg_cron entry or a scheduled Edge Function once one
-- exists for either.
create or replace function public.chal_notify_ending_soon() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_challenge record;
  v_participant record;
  v_written integer := 0;
begin
  for v_challenge in
    select id, title, end_at
    from public.challenges
    where status = 'active'
      and ending_soon_notified_at is null
      and end_at > now()
      and end_at <= now() + interval '48 hours'
  loop
    for v_participant in
      select user_id from public.challenge_participants
      where challenge_id = v_challenge.id and status = 'active'
    loop
      if public.notif_create(
        v_participant.user_id, 'challenge_ending_soon', 'challenges',
        'Challenge ending soon',
        v_challenge.title,
        'challenge', v_challenge.id,
        '/community/boards?challenge=' || v_challenge.id::text
      ) is not null then
        v_written := v_written + 1;
      end if;
    end loop;

    update public.challenges
    set ending_soon_notified_at = now()
    where id = v_challenge.id;
  end loop;

  return v_written;
end $$;
revoke all on function public.chal_notify_ending_soon() from public, anon, authenticated;
grant execute on function public.chal_notify_ending_soon() to service_role;

-- 2. notif_on_challenge_join: batched challenge_update to every other
-- active participant. Never immediate, never to the joiner.
create or replace function public.notif_on_challenge_join() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_other uuid;
begin
  if new.status <> 'active' then
    return new;
  end if;

  for v_other in
    select cp.user_id
    from public.challenge_participants cp
    where cp.challenge_id = new.challenge_id
      and cp.status = 'active'
      and cp.user_id <> new.user_id
  loop
    if not public.notif_blocked_between(v_other, new.user_id)
       and public.notif_pref_allows(v_other, 'challenge_update') then
      perform public.notif_queue_batched(v_other, 'challenges', 'challenge_update', new.challenge_id);
    end if;
  end loop;

  return new;
end $$;
revoke all on function public.notif_on_challenge_join() from public, anon, authenticated;

create trigger challenge_participants_notify_join after insert on public.challenge_participants
  for each row execute function public.notif_on_challenge_join();

-- 3. notif_on_challenge_complete: same batched fan-out, fired on the
-- transition into 'completed'. The trigger declaration fires on any UPDATE
-- that touches the status column (challenge_progress_apply's UPDATE always
-- includes status in its SET list, even on rows that were not actually
-- transitioning), so the function itself re-checks old.status <> 'completed'
-- and returns early otherwise - the real guard is not "fired" but "actually
-- just completed". The completer is excluded from the fan-out by the same
-- `cp.user_id <> new.user_id` used above; they get a client-side
-- celebration, never a notification about their own completion.
create or replace function public.notif_on_challenge_complete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_other uuid;
begin
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  for v_other in
    select cp.user_id
    from public.challenge_participants cp
    where cp.challenge_id = new.challenge_id
      and cp.status = 'active'
      and cp.user_id <> new.user_id
  loop
    if not public.notif_blocked_between(v_other, new.user_id)
       and public.notif_pref_allows(v_other, 'challenge_update') then
      perform public.notif_queue_batched(v_other, 'challenges', 'challenge_update', new.challenge_id);
    end if;
  end loop;

  return new;
end $$;
revoke all on function public.notif_on_challenge_complete() from public, anon, authenticated;

create trigger challenge_participants_notify_complete after update of status on public.challenge_participants
  for each row execute function public.notif_on_challenge_complete();

commit;
