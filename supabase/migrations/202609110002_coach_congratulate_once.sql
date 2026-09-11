begin;

-- Security hunt, round 2 (2026-09-11), business-logic abuse / rate-limit
-- bypass agent.
--
-- THE FINDING. congratulateCelebrateItem() (cloud.js) enforces "one
-- congratulation per coach per achievement/PR" entirely client-side: a
-- SELECT for an exact-body-text match against post_comments/workout_posts,
-- run BEFORE the write, plus an in-memory congratulated[key] guard. Neither
-- is a real server boundary. Confirmed live against real local Postgres:
-- firing add_post_comment directly and concurrently (bypassing the UI
-- entirely) produced 4 byte-identical duplicate congratulation comments on
-- one post in under 2ms. The only real server-side control on that RPC is
-- the generic check_rate_limit('post_comment', 20, 10) volume cap, which
-- has nothing to do with duplication. Impact: feed/comment spam on a
-- member's post, and a gameable coach_congratulate_sent metric (the exact
-- number the admin analytics dashboard reports per coach) - a coach could
-- cheaply inflate their own engagement numbers. Not an authorization
-- bypass, not cross-member data exposure - Medium, not Critical.
--
-- A CLIENT-DERIVED IDEMPOTENCY KEY (the mechanism 202609060014 already adds
-- to add_post_comment/post_create) WOULD NOT HAVE FIXED THIS: it is scoped
-- to (user_id, action, client_supplied_key), and a caller bypassing the UI
-- controls that key too - trivially defeated by omitting it or randomizing
-- it per call, exactly the attack already reproduced. The one thing a
-- raw-script attacker cannot forge is which achievement/PR genuinely
-- happened, so THE FIX makes THAT the uniqueness key, enforced by a real
-- unique index the server - not the caller - decides the identity of.
--
-- THE FIX. A dedicated claim table, unique on (coach_id, kind,
-- target_user_id, occurred_at) - the same "kind|user_id|occurred_at" triple
-- cloud.js's own celebrateItemKey() already uses to identify a celebrate
-- item, now enforced server-side instead of trusted client-side - and one
-- new SECURITY DEFINER RPC that claims the row (on conflict do nothing,
-- same atomic-claim shape member_achievements_once_idx and
-- request_idempotency already use in this codebase) BEFORE ever attempting
-- the comment/post write, not after. A second concurrent or replayed
-- congratulation for the same (coach, kind, member, moment) loses the claim
-- and writes nothing - returns null, not an error, matching how the client
-- already treated "already congratulated" as a silent no-op.

create table public.coach_congratulations (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id) on delete cascade,
  -- Mirrors cloud.js's celebrateItemKey() shape exactly (item.kind,
  -- item.user_id, item.occurred_at) - see that function's own comment.
  kind text not null check (char_length(kind) between 1 and 40),
  target_user_id uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null,
  comment_id uuid references public.post_comments(id) on delete set null,
  post_id uuid references public.workout_posts(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index coach_congratulations_once_idx
  on public.coach_congratulations(coach_id, kind, target_user_id, occurred_at);
-- DB-M3 (202609060015): every FK column outside club_id must lead an index.
-- coach_id already leads the unique index above; these three do not appear
-- as a leading column anywhere else.
create index coach_congratulations_target_user_id_idx on public.coach_congratulations(target_user_id);
create index coach_congratulations_comment_id_idx on public.coach_congratulations(comment_id);
create index coach_congratulations_post_id_idx on public.coach_congratulations(post_id);

alter table public.coach_congratulations enable row level security;
-- Same shape as request_idempotency/rate_limits: written and read only by
-- the definer function below. No client has any reason to read or forge a
-- claim row directly.
revoke all on public.coach_congratulations from public, anon, authenticated;

comment on table public.coach_congratulations is
  'Security hunt round 2 (202609110002). One row per (coach, achievement/PR item) a congratulation has actually been sent for - unique on (coach_id, kind, target_user_id, occurred_at), the server-enforced version of cloud.js celebrateItemKey(). Claimed by coach_congratulate() before it writes the comment/post, closing a confirmed live duplicate-congratulation bypass (client-only dedup, defeated by calling add_post_comment directly). No client grant, no RLS policy - only coach_congratulate() touches it.';

-- ---------------------------------------------------------------------
-- coach_congratulate(): claim-then-write, atomic, staff-only.
-- ---------------------------------------------------------------------
-- Mirrors congratulateCelebrateItem()'s own two write paths (a comment on
-- an existing post, or a new standalone POST_COACH post) - same shape, now
-- gated by the claim above instead of trusting the caller not to repeat
-- itself. p_post_id/p_parent_comment_id null selects the "new post" path,
-- exactly like the client's own `item.post_id ? ... : ...` branch.
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
  v_claim_id uuid;
  v_comment_id uuid;
  v_post_id uuid;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;
  if p_kind is null or char_length(p_kind) = 0 or char_length(p_kind) > 40 then
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
  insert into public.coach_congratulations (coach_id, kind, target_user_id, occurred_at)
  values (v_uid, p_kind, p_target_user_id, p_occurred_at)
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
  'Security hunt round 2 (202609110002). Staff-only. Atomically claims a coach_congratulations row for (caller, kind, target member, occurred_at) before writing anything - a second call for the same real-world event, from any source (UI double-tap, a raw script, a retried request), claims nothing and returns null instead of creating a duplicate comment/post. Replaces the client-only dedup in cloud.js congratulateCelebrateItem(), which a direct RPC call bypassed entirely.';

commit;
