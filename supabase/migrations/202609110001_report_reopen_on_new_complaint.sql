begin;

-- Live bug hunt, round 4 (2026-09-11), moderation & blocking depth agent.
--
-- report()'s ON CONFLICT clause (unchanged since 202608280025, carried
-- forward verbatim by 202609050002's profile-target rebuild) has always
-- just refreshed `reason`/`details` on a duplicate
-- (reporter_id, target_type, target_id) key, never touching `status`. Live-
-- reproduced against the mock (which intentionally mirrors this same real
-- SQL): reporter-1 reports a post ("spam"), a head_coach dismisses it, then
-- reporter-1 reports the SAME post again with a genuinely different reason
-- ("unsafe_advice"). The row's reason/details update in place, but its
-- status stays 'dismissed' forever - the escalation never reappears in the
-- open queue on its own. A repeat offense (or a report dismissed too
-- hastily, now filed again with a stronger complaint) can go permanently
-- unreviewed.
--
-- THE FIX. Reopen (status -> 'open', reviewed_by/reviewed_at/
-- resolution_notes cleared) ONLY when the resubmission is genuinely
-- different from what is already on file (a different reason, or different
-- free-text details) AND the row isn't already 'open'. An exact repeat of
-- the identical complaint - same reason, same note - does NOT reopen a
-- closed case: check_rate_limit('report', 10, 10) throttles report
-- frequency but does not by itself stop a bad-faith reporter from spamming
-- identical resubmissions to force review churn on someone already cleared,
-- so an unconditional reopen-on-any-resubmit was rejected as its own,
-- narrower version of the same abuse this fix is meant to reduce.
--
-- Everything else below is byte-identical to 202609050002's body - only the
-- ON CONFLICT clause changes.
create or replace function public.report(
  p_target_type text,
  p_target_id uuid,
  p_reason text,
  p_note text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_post_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if p_target_type not in ('post', 'comment', 'profile') then
    raise exception 'unknown target type %', p_target_type;
  end if;
  if p_reason not in ('harassment', 'spam', 'inappropriate', 'privacy', 'unsafe_advice', 'other') then
    raise exception 'unknown reason %', p_reason;
  end if;
  if not public.check_rate_limit('report', 10, 10) then raise exception 'rate_limited'; end if;

  if p_target_type = 'post' then
    select id into v_post_id from public.workout_posts where id = p_target_id;
    if v_post_id is null then raise exception 'target not found'; end if;
  elsif p_target_type = 'comment' then
    if not exists (select 1 from public.post_comments where id = p_target_id) then
      raise exception 'target not found';
    end if;
    v_post_id := null;
  else
    -- A deleted profile is not reportable: `deleted_at is not null` is the
    -- module's "this member is gone" state everywhere else, and a report on a
    -- gone member has nothing a moderator can act on.
    if not exists (
      select 1 from public.profiles where id = p_target_id and deleted_at is null
    ) then
      raise exception 'target not found';
    end if;
    v_post_id := null;
  end if;

  -- A duplicate by the same reporter on the same target collapses on the
  -- unique key. The reporter count (distinct reporter_id in mod_queue) does
  -- not move; reason and the reporter note refresh; status reopens only for
  -- a genuinely new complaint on an already-closed report (see header).
  insert into public.reports (reporter_id, post_id, target_type, target_id, reason, details)
  values (v_uid, v_post_id, p_target_type, p_target_id, p_reason, left(coalesce(p_note, ''), 500))
  on conflict (reporter_id, target_type, target_id) do update
    set reason = excluded.reason,
        details = excluded.details,
        status = case
          when public.reports.status <> 'open'
            and (public.reports.reason is distinct from excluded.reason
                 or public.reports.details is distinct from excluded.details)
            then 'open'::public.report_status
          else public.reports.status
        end,
        reviewed_by = case
          when public.reports.status <> 'open'
            and (public.reports.reason is distinct from excluded.reason
                 or public.reports.details is distinct from excluded.details)
            then null
          else public.reports.reviewed_by
        end,
        reviewed_at = case
          when public.reports.status <> 'open'
            and (public.reports.reason is distinct from excluded.reason
                 or public.reports.details is distinct from excluded.details)
            then null
          else public.reports.reviewed_at
        end,
        resolution_notes = case
          when public.reports.status <> 'open'
            and (public.reports.reason is distinct from excluded.reason
                 or public.reports.details is distinct from excluded.details)
            then ''
          else public.reports.resolution_notes
        end;
end $$;
revoke all on function public.report(text, uuid, text, text) from public, anon;
grant execute on function public.report(text, uuid, text, text) to authenticated;
comment on function public.report(text, uuid, text, text) is
  'Live bug hunt round 4 (202609110001): reopens an already-reviewed report (status -> open, reviewed_by/reviewed_at/resolution_notes cleared) when the same reporter resubmits on the same target with a genuinely different reason or note - an exact repeat resubmission does not reopen a closed case. Otherwise byte-identical to 202609050002''s body (post/comment/profile targets, deleted-profile guard).';

commit;
