begin;

-- Security hunt, round 10 (2026-09-12), business-logic-chaining agent.
--
-- request_idempotency's claim key is (user_id, action, idempotency_key)
-- only - never bound to WHAT the call was actually about. Confirmed live
-- against real local Postgres: calling toggle_reaction(post_A, key=K)
-- then toggle_reaction(post_B, key=K) - two different real posts, one
-- reused key - returned `true` for both, but only post A actually got a
-- reactions row. The second call was told it succeeded and silently did
-- nothing, with no way for the caller to tell from the response, and the
-- key is now "used up" so even a legitimate retry of post B's reaction
-- under that key can never succeed either.
--
-- Not reachable through ordinary use of the shipped client -
-- newIdempotencyKey() (cloud.js) mints a fresh crypto.randomUUID() per
-- call, so this needs a caller that deliberately reuses a key across two
-- logically separate actions (a raw script, or a future client-side bug
-- that clones a stored key onto a new call) - but this hunt's own
-- established threat model already treats "call the RPC directly" as
-- real attacker capability (rounds 2 and 7 both confirmed real bugs
-- exactly that way), and a silent phantom-success is a genuine trust-
-- boundary gap regardless of how hard it is to trigger by accident.
--
-- THE FIX. An optional p_fingerprint text, stored alongside the claim.
-- Backward compatible by construction, the same incremental-rollout shape
-- p_idempotency_key itself shipped with (202609060014's own comment:
-- "this migration changes no existing call's semantics until the client
-- starts sending keys") - a caller that doesn't pass a fingerprint keeps
-- today's exact behavior. When a caller DOES pass one and a later call
-- reuses the same key with a DIFFERENT fingerprint, that is a genuinely
-- different request wearing a stale key, not a retry of the same one -
-- refused outright instead of quietly returning the first call's cached
-- result for a second call that never ran.
--
-- Wired up for chal_record_progress and toggle_reaction - the two the
-- 202609060014 migration's own comment already singled out as the worst
-- of the idempotency-covered writes ("the worst of the four", "the
-- second worst in a different way") and the one this finding was
-- actually reproduced against. post_create, add_post_comment, event_rsvp,
-- pr_share and ach_share keep the exact-replay-only assumption for now -
-- event_rsvp is idempotent by convergence already (a key reused across
-- two different events changes which RSVP wins, never oversells or
-- double-books), and the others were not part of what this round
-- reproduced - left for an incremental follow-up rather than widened
-- here without a live-confirmed case behind each one.

alter table public.request_idempotency add column if not exists fingerprint text;

create or replace function public.idem_begin(p_action text, p_key uuid, p_fingerprint text default null)
returns table(is_replay boolean, prior_result jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_inserted boolean;
  v_result jsonb;
  v_fingerprint text;
begin
  -- No key supplied: caller opted out, behave exactly as before.
  if p_key is null then
    return query select false, null::jsonb;
    return;
  end if;
  if v_uid is null then raise exception 'not authorized'; end if;

  insert into public.request_idempotency (user_id, action, idempotency_key, fingerprint)
  values (v_uid, p_action, p_key, p_fingerprint)
  on conflict (user_id, action, idempotency_key)
    -- A no-op assignment, present only so this is DO UPDATE and therefore
    -- takes a row lock a concurrent duplicate will wait on.
    do update set user_id = public.request_idempotency.user_id
  returning (xmax = 0), public.request_idempotency.result, public.request_idempotency.fingerprint
    into v_inserted, v_result, v_fingerprint;

  if not v_inserted and p_fingerprint is not null and v_fingerprint is not null and v_fingerprint <> p_fingerprint then
    raise exception 'idempotency key already used for a different request';
  end if;

  return query select (not v_inserted), v_result;
end $$;
revoke all on function public.idem_begin(text, uuid, text) from public, anon, authenticated;
drop function if exists public.idem_begin(text, uuid);

comment on function public.idem_begin(text, uuid, text) is
  'Write-idempotency claim, launch-readiness audit (202609060014), fingerprint binding added round 10 (202609120011). A caller passes a client-generated key; the first call claims it and stores its result, a later call with the same key returns that stored result without re-running the write. p_fingerprint is optional and, when supplied, must match what the key was originally claimed with - a mismatch means the same key is being reused for a materially different request, refused with ''idempotency key already used for a different request'' rather than silently replaying the first call''s result for a second call that never ran.';

-- ---------------------------------------------------------------------
-- chal_record_progress: fingerprint = which challenge, which participant.
-- A key reused across two different (challenge, member) pairs is refused
-- rather than silently no-op'd.
-- ---------------------------------------------------------------------
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
  from public.idem_begin('chal_record_progress', p_idempotency_key,
    p_challenge_id::text || '|' || p_user_id::text) i;
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

-- ---------------------------------------------------------------------
-- toggle_reaction: fingerprint = which post. A key reused across two
-- different posts is refused rather than silently no-op'd on the second.
-- ---------------------------------------------------------------------
create or replace function public.toggle_reaction(p_post_id uuid, p_idempotency_key uuid default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_existing boolean;
  v_replay boolean;
  v_prior jsonb;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('toggle_reaction', p_idempotency_key, p_post_id::text) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::boolean; end if;

  select exists(select 1 from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer') into v_existing;
  if v_existing then
    delete from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer';
    perform public.idem_complete('toggle_reaction', p_idempotency_key, to_jsonb(false));
    return false;
  end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.check_rate_limit('reaction', 60, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;
  insert into public.reactions(post_id, user_id, kind) values (p_post_id, auth.uid(), 'cheer');
  perform public.idem_complete('toggle_reaction', p_idempotency_key, to_jsonb(true));
  return true;
end $$;
revoke all on function public.toggle_reaction(uuid, uuid) from public, anon;
grant execute on function public.toggle_reaction(uuid, uuid) to authenticated;

commit;
