begin;

-- COMM-372. Teach redemption to accept EITHER a shared code from
-- `invite_codes` or a per-person invite from `invites` (COMM-370), through
-- the same unchanged signature and the same unchanged signup field.
--
-- =====================================================================
-- WHAT DID NOT NEED TO CHANGE, and why that is the good news
-- =====================================================================
-- COMM-372's outline expected to widen the format gate and add a nullable
-- `invite_redemptions.invite_id -> invites(id)`. Neither is what happened:
--
--   * THE FORMAT GATE IS UNTOUCHED. `redeem_invite_code` refuses anything
--     not matching `^[a-f0-9]{40,128}$` before it reads a table.
--     202609030001 mints per-person codes with the same
--     `encode(gen_random_bytes(24), 'hex')` create_member_invite has used
--     since 202608270006, so a per-person code is 48 hex characters and
--     already satisfies that gate. Had COMM-370's proposed 8-uppercase
--     code shape been built, this file would have had to widen the gate
--     for the whole redemption path - see 202609030001's header.
--   * THE SIGNATURE IS UNTOUCHED, both overloads. Which is what lets
--     COMM-380 be a copy review rather than a client change.
--
-- =====================================================================
-- THE COLUMN, and why it is a NEW one rather than the proposed reuse
-- =====================================================================
-- contracts.md proposed "invite_redemptions.invite_id uuid references
-- public.invites(id), nullable, added by this migration". That column
-- already exists and cannot serve: 202608270006 added
-- `invite_redemptions.invite_id`, made it NOT NULL, and pointed its
-- foreign key at `invite_codes(id)`. Writing an `invites` id into it would
-- violate that FK.
--
-- So: a separate nullable `person_invite_id -> invites(id)`, `invite_id`
-- relaxed to nullable (a per-person redemption has no invite_codes row to
-- name), and a CHECK that exactly one of the two is set. Every row that
-- exists today has invite_id set and person_invite_id null, so the CHECK
-- is satisfied by the existing data without a backfill, and "which kind of
-- invite did this member come through" becomes readable off the row -
-- which is what registration_funnel (COMM-375) counts.

alter table public.invite_redemptions
  add column person_invite_id uuid references public.invites(id);

alter table public.invite_redemptions alter column invite_id drop not null;

-- num_nonnulls, not a hand-written OR: it says "exactly one" once, rather
-- than twice in mirrored halves that can drift.
alter table public.invite_redemptions
  add constraint invite_redemptions_one_invite_source
  check (num_nonnulls(invite_id, person_invite_id) = 1);

comment on column public.invite_redemptions.person_invite_id is
  'COMM-372. The public.invites row this member redeemed, or null for a shared-code redemption. Exactly one of (invite_id, person_invite_id) is set, enforced by invite_redemptions_one_invite_source. Not a reuse of invite_id: that column has pointed at invite_codes(id) and been NOT NULL since 202608270006, so it could not carry an invites id. No RLS change - invite_redemptions_self_select (202608270003) is own-row and already covers this column, and member_roles() (202609010011) returns only user_id and role.';

-- =====================================================================
-- The widened function
-- =====================================================================
-- Everything above the per-person branch is byte-for-byte 202608280013.
-- Restated rather than edited-in-place because create or replace needs the
-- whole body, and the ordering is load-bearing: the throttle is bumped
-- BEFORE either lookup, so a per-person code is exactly as expensive to
-- guess as a shared one, which is COMM-372's own acceptance criterion.
create or replace function public.redeem_invite_code(p_code text, p_actor_key text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_uid_key text;
  v_actor_key text;
  v_attempts integer;
  v_invite_id uuid;
  v_person_invite_id uuid;
  v_person_role text;
  v_existing_role text;
  v_hash text;
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
  -- attempts remain or whether the key was recognised. The throttle is
  -- bumped before BOTH lookups below, so which table eventually matches
  -- changes nothing about the cost of a wrong guess.
  if v_attempts > 5 then return 'rate_limited'; end if;
  if p_code is null or p_code !~ '^[a-f0-9]{40,128}$' then return 'invalid'; end if;

  -- Hashed once and reused by both branches.
  v_hash := encode(extensions.digest(p_code, 'sha256'), 'hex');

  -- -------------------------------------------------------------------
  -- BRANCH 1: the shared per-role code. Unchanged, and still first.
  -- -------------------------------------------------------------------
  -- Today's dominant path. The predicate, the use_count bump and the
  -- literal 'member' are all exactly as 202608270006 wrote them, including
  -- its rule that "Ordinary redemption never grants or upgrades to coach" -
  -- this file does not relax that, which is why
  -- admin_invite_code_create (202609030002) refuses to mint a coach
  -- shared code rather than minting one that could never be redeemed.
  update public.invite_codes set use_count = use_count + 1
  where code_hash = v_hash
    and role = 'member' and active and revoked_at is null
    and (expires_at is null or expires_at > now()) and use_count < max_uses
  returning id into v_invite_id;

  if v_invite_id is not null then
    insert into public.invite_redemptions (user_id, invite_id, role)
    values (v_uid, v_invite_id, 'member');
    return 'member';
  end if;

  -- -------------------------------------------------------------------
  -- BRANCH 2: the per-person invite (COMM-370). Only reached when no
  -- active shared code matched.
  -- -------------------------------------------------------------------
  -- A single UPDATE ... RETURNING claims the invite, rather than a SELECT
  -- then an UPDATE. That is the same shape branch 1 uses and it is doing
  -- the same job: the row's own `redeemed_at is null` predicate is
  -- evaluated under the update's row lock, so two simultaneous redemptions
  -- of one code cannot both succeed - one of them matches zero rows and
  -- falls through to 'invalid'. A read-then-write would let both through.
  --
  -- Unlike branch 1 this grants the ROW's role, member or coach, which is
  -- COMM-372's explicit criterion ("A match grants that invite's role").
  -- The difference from branch 1 is deliberate and is about who authored
  -- the row: a per-person invite names one person, was minted by a named
  -- holder of community.member.invite, and is audited on creation and
  -- single-use; a shared code is standing and reusable.
  update public.invites
     set redeemed_at = now(), redeemed_by = v_uid
   where code_hash = v_hash
     and revoked_at is null
     and redeemed_at is null
     and (expires_at is null or expires_at > now())
  returning id, role into v_person_invite_id, v_person_role;

  if v_person_invite_id is not null then
    insert into public.invite_redemptions (user_id, person_invite_id, role)
    values (v_uid, v_person_invite_id, v_person_role);
    return v_person_role;
  end if;

  -- ANTI-ENUMERATION (backlog Phase 4 open question 3, resolved to the
  -- generic answer). One return for all of: matched nothing anywhere,
  -- matched a per-person invite that is already redeemed, matched one that
  -- was revoked, matched one that expired, matched a deactivated or
  -- exhausted shared code. A caller cannot tell "never existed" from
  -- "existed and is spent", which is the property that stops the throttle
  -- from becoming a status oracle.
  return 'invalid';
end $$;
revoke all on function public.redeem_invite_code(text, text) from public, anon;
grant execute on function public.redeem_invite_code(text, text) to authenticated;

comment on function public.redeem_invite_code(text, text) is
  'COMM-372 (widening of 202608280013, itself of 202608270006). Redeem EITHER a shared invite_codes code or a per-person invites code (COMM-370) through one unchanged signature. Returns the granted role, ''invalid'', or ''rate_limited''; never raises. Shared code is tried FIRST and its branch is byte-for-byte unchanged, including the literal ''member'' grant - a shared code still never grants coach. The per-person branch is reached only when no active shared code matched, and grants the invite row''s own role (member or coach), claiming it with a single UPDATE ... RETURNING so two simultaneous redemptions of one code cannot both win. On a per-person match: invites.redeemed_at/redeemed_by are stamped and invite_redemptions.person_invite_id is set, in the same transaction as the redemption insert. The ^[a-f0-9]{40,128}$ format gate is UNCHANGED and needed no widening, because per-person codes are generated with the same 24-random-byte hex generator create_member_invite uses. Throttle (5 per 15 minutes, uid key and actor key, whichever is higher) is bumped BEFORE either lookup, so both code kinds cost the same to guess. A code matching neither table, or matching a per-person invite that is spent, revoked or expired, all return the identical generic ''invalid''.';

-- The one-argument wrapper (202608280013) is deliberately NOT redefined:
-- it already delegates to the two-argument form with a null actor key, so
-- it picks the widening up unchanged. Restated here only so a reader of
-- this file does not go looking for it.

commit;
