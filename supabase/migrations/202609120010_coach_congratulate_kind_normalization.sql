begin;

-- Security hunt, round 10 (2026-09-12), business-logic-chaining agent.
--
-- coach_congratulate()'s anti-duplication claim (202609110002, itself a
-- prior round's fix for the same RPC) is unique on (coach_id, kind,
-- target_user_id, occurred_at) - but p_kind was validated only for
-- length, never normalized. Confirmed live against real local Postgres:
-- calling coach_congratulate('pr', ...), then coach_congratulate('PR',
-- ...), then coach_congratulate('pr ', ...) - all for the identical real
-- (coach, member, moment) - produced three distinct claim rows and three
-- real duplicate congratulation comments, because 'pr', 'PR' and 'pr '
-- are three different unique-index keys even though they are the same
-- real-world event. That is exactly the invariant 202609110002 exists to
-- guarantee ("one congratulation per real event"), defeated through kind-
-- spelling variance instead of raw replay.
--
-- cloud.js only ever sends one of exactly three literal kinds - 'pr',
-- 'anniversary', 'challenge_completion' (celebrateItemKey() / the
-- congratulateCelebrateItem() call sites) - so this closes it the same
-- way this schema closes every other closed vocabulary: normalize case/
-- whitespace, then reject anything outside the known set outright, rather
-- than just normalizing and hoping nothing else can still slip through.

create or replace function public.coach_congratulate(
  p_kind text,
  p_target_user_id uuid,
  p_occurred_at timestamptz,
  p_post_id uuid,
  p_parent_comment_id uuid,
  p_body text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_kind text;
  v_claim_id uuid;
  v_comment_id uuid;
  v_post_id uuid;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;

  v_kind := lower(btrim(coalesce(p_kind, '')));
  if v_kind not in ('pr', 'anniversary', 'challenge_completion') then
    raise exception 'invalid kind';
  end if;
  if p_target_user_id is null or p_occurred_at is null then
    raise exception 'invalid item';
  end if;

  -- The claim. on conflict do nothing: a second call for the same
  -- (coach, kind, member, moment) - concurrent, retried, or a deliberate
  -- repeat - wins nothing and falls through to `if v_claim_id is null`
  -- below, writing no comment/post at all. This is the actual security
  -- boundary; everything after it only runs once, ever, per real event.
  -- Keyed on v_kind (normalized), not p_kind, so a spelling variant of
  -- the same real event collides with the first claim instead of
  -- minting a new one.
  insert into public.coach_congratulations (coach_id, kind, target_user_id, occurred_at)
  values (v_uid, v_kind, p_target_user_id, p_occurred_at)
  on conflict (coach_id, kind, target_user_id, occurred_at) do nothing
  returning id into v_claim_id;

  if v_claim_id is null then
    return null;
  end if;

  if p_post_id is not null then
    v_comment_id := public.add_post_comment(p_post_id, p_body, p_parent_comment_id);
  else
    v_post_id := public.post_create(p_body, 'club', '[]'::jsonb, null);
    if v_post_id is not null then
      update public.workout_posts set post_type = 'POST_COACH'
        where id = v_post_id and author_id = v_uid;
    end if;
  end if;

  update public.coach_congratulations
    set comment_id = v_comment_id, post_id = v_post_id
    where id = v_claim_id;

  return coalesce(v_comment_id, v_post_id);
end $$;
revoke all on function public.coach_congratulate(text, uuid, timestamptz, uuid, uuid, text) from public, anon;
grant execute on function public.coach_congratulate(text, uuid, timestamptz, uuid, uuid, text) to authenticated;
comment on function public.coach_congratulate(text, uuid, timestamptz, uuid, uuid, text) is
  'Security hunt round 2 (202609110002), kind normalized round 10 (202609120010). Staff-only. Atomically claims a coach_congratulations row for (caller, normalized kind, target member, occurred_at) before writing anything - a second call for the same real-world event, from any source (UI double-tap, a raw script, a retried request, or a differently-cased/spaced kind string for the same kind), claims nothing and returns null instead of creating a duplicate comment/post. p_kind is lowercased/trimmed and restricted to the three kinds cloud.js actually sends (pr, anniversary, challenge_completion) before it ever reaches the claim.';

commit;
