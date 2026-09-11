begin;

-- Security hunt, round 10 (2026-09-12), business-logic-chaining agent.
--
-- Neither challenge_progress_insert_self's WITH CHECK nor
-- chal_record_progress() ever looked at the parent challenge's own
-- status - both only checked that the calling member's
-- challenge_participants row was active. Confirmed live against real
-- local Postgres: create a cooperative challenge, join it, archive it
-- (a plain client-side UPDATE through challenges_update_perm - archiving
-- is not a dedicated RPC in this schema), then call chal_record_progress
-- or insert a progress row directly - both still succeed on an already-
-- archived challenge. The append-only progress log kept accepting
-- deltas, the completion trigger kept flipping participants to
-- 'completed', and cooperative milestones kept auto-posting real,
-- club-visible feed cards for a challenge that had already been closed
-- out.
--
-- The codebase already treats 'archived' as terminal elsewhere -
-- enforce_pin_target() (202608280017) refuses to pin an archived
-- challenge - this just brings the progress-log write path in line with
-- that same invariant. Scoped to exactly 'active', not "not archived":
-- challenge_participants_join_self already requires c.status = 'active'
-- to join in the first place, so requiring the same for logging progress
-- is symmetric with how a member gets into a challenge at all, and closes
-- the gap for a 'completed' or 'draft' challenge too, not just archived.

drop policy challenge_progress_insert_self on public.challenge_progress;
create policy challenge_progress_insert_self on public.challenge_progress for insert to authenticated
  with check (
    user_id = auth.uid()
    and entered_by is null
    and public.is_community_member()
    and exists (
      select 1 from public.challenge_participants cp
      where cp.challenge_id = challenge_progress.challenge_id
        and cp.user_id = auth.uid()
        and cp.status in ('active', 'completed')
    )
    and exists (
      select 1 from public.challenges c
      where c.id = challenge_progress.challenge_id and c.status = 'active'
    )
  );

create or replace function public.chal_record_progress(
  p_challenge_id uuid,
  p_user_id uuid,
  p_delta numeric,
  p_note text,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_note text;
  v_id uuid;
  v_replay boolean;
  v_prior jsonb;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('chal_record_progress', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;
  if p_challenge_id is null or p_user_id is null then raise exception 'challenge and target participant are required'; end if;
  if p_delta is null then raise exception 'delta is required'; end if;

  if not exists (select 1 from public.challenges where id = p_challenge_id and status = 'active') then
    raise exception 'challenge is not active';
  end if;

  if not exists (
    select 1 from public.challenge_participants
    where challenge_id = p_challenge_id and user_id = p_user_id and status = 'active'
  ) then
    raise exception 'not an active participant';
  end if;

  v_note := nullif(left(btrim(coalesce(p_note, '')), 500), '');

  insert into public.challenge_progress
    (challenge_id, user_id, delta, source_type, note, entered_by)
  values (p_challenge_id, p_user_id, p_delta, 'coach_entry', v_note, v_uid)
  returning id into v_id;

  perform public.idem_complete('chal_record_progress', p_idempotency_key, to_jsonb(v_id));
  return v_id;
end $$;
revoke all on function public.chal_record_progress(uuid, uuid, numeric, text, uuid) from public, anon;
grant execute on function public.chal_record_progress(uuid, uuid, numeric, text, uuid) to authenticated;

commit;
