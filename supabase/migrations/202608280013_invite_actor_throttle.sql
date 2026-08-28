begin;

-- COMM-017. The invite-guess limit currently keys on auth.uid(), which an
-- attacker resets for free: anonymous sign-in costs nothing, so five
-- guesses per fifteen minutes is really five guesses per fifteen minutes
-- PER SESSION, and sessions are unlimited. Re-key the existing
-- invite_attempts store on an opaque actor key the client persists across
-- sessions, and count against both keys so neither one alone is a bypass.
--
-- Signal chosen: a client-persisted device key. A proof-of-work token was
-- the alternative and was rejected - it costs every honest member a
-- visible delay on the one screen where a first impression matters, and it
-- does nothing against an attacker willing to spend CPU. An IP hash was
-- rejected because Postgres never sees the client IP through PostgREST,
-- so it would have to be passed by the client, which makes it exactly as
-- forgeable as the device key while also being personal data.
--
-- The device key is forgeable too - a determined attacker rotates it. It
-- is not a security boundary, it is a cost floor: it stops the trivial
-- "clear the session and retry" loop, and the uid key underneath it still
-- holds for anyone who does not bother. The real protection remains the
-- high-entropy codes from 202608270006.

alter table public.invite_attempts add column actor_key_hash text;

-- Existing rows keep their meaning under the new key space.
update public.invite_attempts set actor_key_hash = 'uid:' || user_id::text where actor_key_hash is null;

alter table public.invite_attempts drop constraint invite_attempts_pkey;
alter table public.invite_attempts alter column user_id drop not null;
alter table public.invite_attempts alter column actor_key_hash set not null;
alter table public.invite_attempts add constraint invite_attempts_pkey primary key (actor_key_hash);
create index invite_attempts_window_idx on public.invite_attempts(window_started_at);

-- Still no grants and no policies for anon or authenticated: the table is
-- reachable only from the definer functions below. RLS stays enabled so a
-- future accidental grant does not open it.

-- One sliding window bump, returning the count inside the window. Same
-- pattern as check_rate_limit(), kept separate because the invite
-- throttle is keyed on an actor rather than a user.
create or replace function public.bump_invite_attempt(p_key text, p_user_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.invite_attempts (actor_key_hash, user_id, window_started_at, attempt_count, last_attempt_at)
  values (p_key, p_user_id, now(), 1, now())
  on conflict (actor_key_hash) do update set
    window_started_at = case
      when public.invite_attempts.window_started_at < now() - interval '15 minutes' then now()
      else public.invite_attempts.window_started_at end,
    attempt_count = case
      when public.invite_attempts.window_started_at < now() - interval '15 minutes' then 1
      else public.invite_attempts.attempt_count + 1 end,
    user_id = coalesce(excluded.user_id, public.invite_attempts.user_id),
    last_attempt_at = now()
  returning attempt_count into v_count;
  return v_count;
end $$;
revoke all on function public.bump_invite_attempt(text, uuid) from public, anon, authenticated;

create or replace function public.redeem_invite_code(p_code text, p_actor_key text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_uid_key text;
  v_actor_key text;
  v_attempts integer;
  v_invite_id uuid;
  v_existing_role text;
begin
  v_uid := auth.uid();
  if v_uid is null then return 'invalid'; end if;

  select role into v_existing_role from public.invite_redemptions where user_id = v_uid;
  if v_existing_role is not null then return v_existing_role; end if;

  v_uid_key := 'uid:' || v_uid::text;
  -- The raw actor key never lands in a column. Only its digest does, so a
  -- dump of this table cannot be correlated back to a device.
  if p_actor_key is null or char_length(p_actor_key) = 0 or char_length(p_actor_key) > 128 then
    v_actor_key := null;
  else
    v_actor_key := 'ak:' || encode(extensions.digest(p_actor_key, 'sha256'), 'hex');
  end if;

  v_attempts := public.bump_invite_attempt(v_uid_key, v_uid);
  if v_actor_key is not null then
    v_attempts := greatest(v_attempts, public.bump_invite_attempt(v_actor_key, v_uid));
  end if;

  -- Identical answer, and an identical increment, whether the actor is new
  -- or has been guessing for an hour. Nothing here tells a caller how many
  -- attempts remain or whether the key was recognised.
  if v_attempts > 5 then return 'rate_limited'; end if;
  if p_code is null or p_code !~ '^[a-f0-9]{40,128}$' then return 'invalid'; end if;

  update public.invite_codes set use_count = use_count + 1
  where code_hash = encode(extensions.digest(p_code, 'sha256'), 'hex')
    and role = 'member' and active and revoked_at is null
    and (expires_at is null or expires_at > now()) and use_count < max_uses
  returning id into v_invite_id;
  if v_invite_id is null then return 'invalid'; end if;

  insert into public.invite_redemptions (user_id, invite_id, role)
  values (v_uid, v_invite_id, 'member');
  return 'member';
end $$;
revoke all on function public.redeem_invite_code(text, text) from public, anon;
grant execute on function public.redeem_invite_code(text, text) to authenticated;

-- The one-argument form stays, so the current client keeps working
-- unchanged while identity-privacy wires the actor key in COMM-017. It is
-- now a thin wrapper: no actor key means the uid key alone, which is
-- exactly the old behaviour and no weaker than it.
create or replace function public.redeem_invite_code(p_code text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  return public.redeem_invite_code(p_code, null::text);
end $$;
revoke all on function public.redeem_invite_code(text) from public, anon;
grant execute on function public.redeem_invite_code(text) to authenticated;

commit;
