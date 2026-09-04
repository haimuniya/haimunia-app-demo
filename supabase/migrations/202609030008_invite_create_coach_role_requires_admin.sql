begin;

-- Narrowing of ONE authorization path in admin_invite_create, decided by the
-- product owner after 202609030001 shipped and flagged it. Nothing else in
-- COMM-370 changes: not the table, not the permission seeding, not
-- admin_invite_list, not admin_invite_revoke, not redemption.
--
-- =====================================================================
-- WHAT WAS FLAGGED
-- =====================================================================
-- 202609030001's section 3 named this consequence out loud rather than
-- quietly narrowing it: `invites.role` admits 'coach', `admin_invite_create`
-- gated on `has_perm('community.member.invite') or is_admin()`, and that
-- permission is seeded coach-and-above. So any coach could mint an invite
-- whose redemption grants the invitee `coach` outright (COMM-372's per-person
-- branch grants the invite ROW's role, tested in supabase/tests/0058).
--
-- That made a code the ONLY way to reach the coach tier without an admin.
-- The other path, admin_grant_coach (202608270011), has always required a
-- real `profiles.is_admin` account acting on a named existing member. A coach
-- could therefore not promote a colleague they can see, but could promote an
-- unlimited number of strangers they cannot - and each new coach inherits the
-- same minting power, so the tier is self-propagating from a single coach.
--
-- =====================================================================
-- THE DECISION
-- =====================================================================
-- Product owner: a coach-ROLE invite requires an admin. A member-role invite
-- does not, and stays exactly as coach-and-above as it was - inviting a new
-- gym member remains a normal coach task, which is the whole reason
-- `community.member.invite` was seeded to coach in the first place. The
-- permission is not re-seeded and no role loses anything it uses day to day;
-- one argument value gets a second, higher gate.
--
-- The new rule, stated as one sentence:
--   p_role = 'member'  ->  has_perm('community.member.invite') or is_admin()
--   p_role = 'coach'   ->  is_admin() specifically, and nothing else
--
-- Three things worth being explicit about, since each is a real behaviour
-- change and not a restatement:
--
--   1. head_coach AND staff LOSE THE COACH-ROLE INVITE TOO, not just coach.
--      `is_admin()` is `role_rank(my_role_code()) >= 50` (202608280001), and
--      the ranks are member 10, coach 20, head_coach 30, staff 40, admin 50,
--      owner 60. All three of coach/head_coach/staff hold
--      `community.member.invite` and none of them is is_admin(). This is the
--      intended reading of "must require admin, not just
--      community.member.invite" - the gate is the admin tier, not the
--      complement of one role. `owner` still passes, by rank, not by
--      has_perm's owner-shortcut.
--   2. THE MESSAGE STAYS 'not authorized', deliberately not a new distinct
--      one. It is the same P0001 string every other refusal in this cluster
--      raises, the client already maps it, and a bespoke "coach invites are
--      admin-only" string would tell a caller which tier they are missing.
--      The tradeoff, named rather than hidden: an admin UI cannot tell this
--      refusal apart from a missing permission, so COMM-376 should not offer
--      the coach option at all unless the viewer is_admin() - and if it does
--      offer it anyway, the server still refuses, which is the point.
--   3. ORDERING. The check sits AFTER the existing base-permission gate and
--      AFTER the 'invalid role' validation, so: a plain member still gets
--      'not authorized' before any role is examined (no probing which roles
--      exist), and a coach passing 'owner' still gets 'invalid role', the
--      same answer as before this file. Only the coach + 'coach' combination
--      changes answer, and it changes from success to 'not authorized'.
--
-- Everything below the guard - label cap, expiry rule, the retry-on-collision
-- loop, log_admin_action, the returned jsonb shape - is byte-identical to
-- 202609030001. Drop-and-recreate rather than create-or-replace, matching
-- 202609030007's in-place function fix, so this file is safe to re-run
-- against either shape.
drop function if exists public.admin_invite_create(text, text, timestamptz);
create function public.admin_invite_create(
  p_role text,
  p_label text default null,
  p_expires_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_code text;
  v_row  public.invites;
  v_try  integer := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.member.invite') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  if p_role is null or p_role not in ('member', 'coach') then
    raise exception 'invalid role';
  end if;

  -- The narrowing. Minting an invite that hands out an elevated tier is an
  -- admin act; minting one that hands out membership is not. Same P0001
  -- 'not authorized' as the gate above, on purpose - see this file's header.
  if p_role = 'coach' and not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if p_label is not null and char_length(p_label) > 120 then
    raise exception 'label too long';
  end if;
  -- Null is allowed and means "never expires". Only a NON-null past value
  -- is refused, and it is refused rather than clamped forward: an invite
  -- silently given a different deadline than the admin typed is worse than
  -- one that failed loudly.
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'expiry must be in the future';
  end if;

  -- Retry on a code-hash collision. At 192 bits this loop will not run
  -- twice in the life of the universe; it exists so the impossible case is
  -- a retry rather than an error surfaced to an admin, which is the same
  -- posture COMM-370's own outline asked for.
  loop
    v_try := v_try + 1;
    v_code := public.invite_generate_code();
    begin
      insert into public.invites (code_hash, role, label, created_by, expires_at)
      values (encode(extensions.digest(v_code, 'sha256'), 'hex'),
              p_role, nullif(p_label, ''), v_uid, p_expires_at)
      returning * into v_row;
      exit;
    exception when unique_violation then
      if v_try >= 5 then raise exception 'could not generate a unique invite code'; end if;
    end;
  end loop;

  perform public.log_admin_action(
    'invite_created', 'invite', v_row.id, null,
    jsonb_build_object('role', v_row.role, 'label', v_row.label, 'expires_at', v_row.expires_at));

  -- `code` appears here and nowhere else, ever.
  return jsonb_build_object(
    'id', v_row.id,
    'code', v_code,
    'role', v_row.role,
    'label', v_row.label,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at,
    'status', public.invite_status(v_row.revoked_at, v_row.redeemed_at, v_row.expires_at, now()));
end $$;
revoke all on function public.admin_invite_create(text, text, timestamptz) from public, anon;
grant execute on function public.admin_invite_create(text, text, timestamptz) to authenticated;

comment on function public.admin_invite_create(text, text, timestamptz) is
  'COMM-370. Mint one per-person invite and return it, INCLUDING the raw code - the only point in this module''s lifetime that code is retrievable, because public.invites stores only its sha256 (see 202609030001''s header). AUTH: security definer; auth.uid() checked first, then has_perm(''community.member.invite'') or is_admin(), and then - NARROWED 202609030008 - a SECOND gate that applies only when p_role = ''coach'': is_admin() specifically, so coach, head_coach and staff may mint member-role invites (unchanged) but not coach-role ones, which now match admin_grant_coach''s admin-only tier. p_role = ''member'' is unaffected. Raises ''not authorized'' (no session, no base permission, or the coach-role narrowing - the same string for all three, deliberately), ''invalid role'' (anything but member/coach), ''label too long'' (>120), ''expiry must be in the future'' (a non-null past value; null means never expires), all P0001. The coach-role check runs AFTER ''invalid role'' and BEFORE the label and expiry checks. RETURNS jsonb {id, code, role, label, created_at, expires_at, status}, not the public.invites row type contracts.md originally proposed - a row type cannot carry the plaintext code. SIDE EFFECTS: one invites row with created_by = auth.uid(); one admin_actions row (invite_created / invite / target_id = the new invite, after_data {role, label, expires_at}).';

commit;
