begin;

-- Community Phase 1 schema follow-up, run 3 of 3, part 3 of 3: the batch
-- flusher. The "flush routing" the 202608280018 note assigns to the
-- notifications agent.
--
-- `notification_batches` (202608280018) holds per-member, per-category
-- counters with a per-type breakdown in `pending`:
--   {"reaction": {"count": 4, "last_source_id": "..."}, ...}
-- `notif_batch_flush_due()` turns every overdue batch into one
-- `notifications` row per pending type - keeping the batched type key as
-- `notifications.type` so the client folds it as a batched group - then
-- calls `notif_batch_flushed(user_id, category)` to zero the counters and
-- arm the next window.
--
-- This is the SECOND server-side insert path into `notifications`, next to
-- `notif_create()`. It does not re-run the preference, block-edge, or
-- de-dupe filters: every item was already filtered at enqueue time by the
-- trigger that called `notif_queue_batched()`, and a rolled-up row is by
-- definition not a duplicate of anything.
--
-- SCHEDULER: this function still needs something to call it on a timer.
-- That is infra, not schema, and pg_cron is not guaranteed present in the
-- CI Supabase stack, so nothing is scheduled here. Wire it up as EITHER:
--   - a pg_cron entry once the extension is enabled on the project:
--       select cron.schedule('notif-batch-flush', '*/15 * * * *',
--         $$select public.notif_batch_flush_due()$$);
--   - or a Supabase Edge Function on a schedule that calls
--     `notif_batch_flush_due()` with the service role.
-- Until then batched notifications accumulate in `notification_batches` and
-- are not delivered. See docs/community/backlog.md.

-- Category -> in-app surface, for a rolled-up row that has no single
-- dominant source to point at.
create or replace function public.notif_category_surface(p_category text) returns text
language sql immutable set search_path = '' as $$
  select case p_category
    when 'community'  then '/community/feed'
    when 'training'   then '/community/account/achievements'
    when 'challenges' then '/community/boards'
    when 'events'     then '/community/feed'
    when 'club'       then '/community/feed'
    else '/community/feed'
  end;
$$;
revoke all on function public.notif_category_surface(text) from public, anon, authenticated;

create or replace function public.notif_batch_flush_due(p_limit integer default 500) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_batch record;
  v_key text;
  v_entry jsonb;
  v_count integer;
  v_last uuid;
  v_dominates boolean;
  v_title text;
  v_body text;
  v_link text;
  v_written integer := 0;
begin
  for v_batch in
    select user_id, category, pending, pending_count
    from public.notification_batches
    where next_flush_at <= now() and pending_count > 0
    order by next_flush_at
    limit greatest(coalesce(p_limit, 500), 1)
  loop
    for v_key, v_entry in select key, value from jsonb_each(v_batch.pending)
    loop
      v_count := coalesce((v_entry->>'count')::integer, 0);
      if v_count <= 0 then
        continue;
      end if;

      begin
        v_last := nullif(v_entry->>'last_source_id', '')::uuid;
      exception when others then
        v_last := null;
      end;

      -- One type "dominates" when it is the only thing in the batch. Then
      -- the deep link can point at its last source; otherwise at the
      -- category surface.
      v_dominates := (v_count = v_batch.pending_count);

      v_title := case v_key
        when 'reaction'           then 'New reactions'
        when 'comment_also'       then 'New comments on your posts'
        when 'friend_achievement' then 'Friends unlocked achievements'
        else 'New activity'
      end;

      v_body := case v_key
        when 'reaction' then v_count::text
          || (case when v_count = 1 then ' person reacted to your posts'
                   else ' reactions on your posts' end)
        when 'comment_also' then v_count::text
          || (case when v_count = 1 then ' new comment on your posts'
                   else ' new comments on your posts' end)
        when 'friend_achievement' then v_count::text
          || (case when v_count = 1 then ' friend unlocked an achievement'
                   else ' friends unlocked achievements' end)
        else v_count::text || ' new updates'
      end;

      v_link := case
        when v_dominates and v_last is not null and v_key in ('reaction', 'comment_also')
          then '/community/feed?post=' || v_last::text
        else public.notif_category_surface(v_batch.category)
      end;

      insert into public.notifications
        (user_id, type, category, title, body, source_type, source_id, deep_link)
      values (
        v_batch.user_id, v_key, v_batch.category,
        left(v_title, 160), left(v_body, 500),
        null, v_last, v_link
      );
      v_written := v_written + 1;
    end loop;

    perform public.notif_batch_flushed(v_batch.user_id, v_batch.category);
  end loop;

  return v_written;
end $$;
revoke all on function public.notif_batch_flush_due(integer) from public, anon, authenticated;
grant execute on function public.notif_batch_flush_due(integer) to service_role;

commit;
