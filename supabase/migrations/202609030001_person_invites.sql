begin;

-- COMM-370. The per-person invite: one row per named invitation, minted by
-- staff, single use, revocable while unredeemed, tracked to the member who
-- eventually redeemed it. Sits BESIDE the shared per-role code
-- (`invite_codes`), which this file does not touch at all - COMM-371 gives
-- that table its admin RPCs, COMM-372 teaches redemption to accept either.
--
-- =====================================================================
-- WHY THIS FILE STORES A HASH AND NOT THE CODE - a deliberate deviation
-- from COMM-370's own migration outline, recorded here rather than made
-- silently.
-- =====================================================================
-- COMM-370 and docs/community/contracts.md both specify
--   `code text not null unique check (code ~ '^[A-Z0-9]{8}$')`
-- and an `admin_invite_list` that returns that `code` back to the client.
-- Both were written against `invite_codes` AS IT LOOKED IN 202608270003 -
-- a plaintext `code` primary key. That column does not exist any more.
-- 202608270006_security_hardening.sql ("Replace plaintext invite codes
-- with opaque IDs and hashes. Existing codes are revoked.") dropped
-- `invite_codes.code` outright, replaced it with `code_hash`, re-keyed the
-- table on a uuid `id`, and left this standing note on the throttle it
-- added: "The real protection remains the high-entropy codes from
-- 202608270006."
--
-- So the outline's shape would not extend the current schema, it would
-- reverse the one hardening decision this module has already made about
-- exactly this data. Three concrete consequences settled it:
--
--   1. AN 8-CHARACTER CODE CANNOT BE REDEEMED AT ALL TODAY.
--      `redeem_invite_code` (202608280013) refuses anything that does not
--      match `^[a-f0-9]{40,128}$` BEFORE it looks in any table. A code of
--      the shape the outline names would be minted, handed to a real
--      person, and always answer 'invalid'. Widening that gate to admit
--      short codes re-opens the online guessing surface 202608270006
--      closed, for the whole redemption path, not just this table.
--   2. HASHING AN 8-CHARACTER CODE BUYS NOTHING. 36^8 is 2.8e12 unsalted
--      sha256 candidates - minutes on one GPU. Storage-at-rest protection
--      only exists at all if the code carries real entropy, so the choice
--      is not "plaintext vs hash", it is "short-and-plaintext-equivalent
--      vs long-and-actually-opaque".
--   3. `create_member_invite` (202608270006) ALREADY DOES THE LONG-CODE
--      THING, in this schema, for this exact purpose: 24 random bytes hex
--      encoded, hash stored, plaintext returned once to the caller. This
--      file uses byte-for-byte the same generation and the same digest, so
--      a per-person code and a hardened member code are indistinguishable
--      in shape - which is what lets COMM-372 widen redemption WITHOUT
--      touching the format gate, and what lets COMM-380 ship with no
--      change to the signup field at all.
--
-- WHAT IT COSTS, stated plainly: the raw code is retrievable exactly once,
-- from `admin_invite_create`'s return value, and never again. There is no
-- "show me that code again" and no `code` key in `admin_invite_list`. An
-- admin who loses a code before sending it revokes the invite and mints a
-- new one - which is why `label` exists and is returned by the list: the
-- label, not the code, is how a human tells one pending invite from
-- another. This is the "shown once" reveal contracts.md already describes
-- for COMM-376, made literal.

-- ---------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),

  -- sha256 of the plaintext code, hex. Unique so a collision in the
  -- generator below surfaces as a constraint violation to retry on rather
  -- than as a second invite silently sharing one code.
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),

  -- Only these two are invitable. Deliberately an inline CHECK and not the
  -- FK to roles(code) that `invite_redemptions.role` carries (202608280001):
  -- head_coach/staff/admin/owner are grantable, but not by handing someone
  -- a code - those go through admin_grant_coach and the role machinery,
  -- where a named admin acts on a named existing member. A redemption
  -- writes this value into invite_redemptions.role, and both values here
  -- are valid roles(code) rows, so that FK still holds.
  role text not null default 'member' check (role in ('member', 'coach')),

  -- The admin's own note about who this was for: a name, a phone number, a
  -- "Dana from the Tuesday 06:00". Never shown to the invitee, never
  -- matched against anything, and after the code-hash decision above it is
  -- the ONLY way a human tells two pending invites apart.
  label text check (char_length(label) <= 120),

  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),

  -- Null means never expires. COMM-370's open question 1 default: no
  -- standing default expiry is imposed, an admin may set one per invite.
  expires_at timestamptz,

  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users(id),

  -- A row can be revoked or redeemed, never both. This is what makes
  -- admin_invite_revoke's "already redeemed" refusal a constraint and not
  -- just a convention in one function: even a service-role hand-edit
  -- cannot un-redeem someone by revoking their spent invite.
  constraint invites_not_both_revoked_and_redeemed
    check (revoked_at is null or redeemed_at is null)
);

-- admin_invite_list paginates on created_at desc, always. One index for it.
create index invites_created_at_idx on public.invites(created_at desc);

-- The lookup COMM-372's redemption branch issues. `code_hash` is already
-- unique (and so indexed), but the redemption predicate also filters the
-- three lifecycle columns, and a pending-invite partial index keeps that
-- probe off every spent and revoked row for the life of the club.
create index invites_pending_idx on public.invites(code_hash)
  where revoked_at is null and redeemed_at is null;

-- ---------------------------------------------------------------------
-- 2. RLS: enabled, and reachable by nobody
-- ---------------------------------------------------------------------
-- No grant and no policy for any client role, which is the same shape
-- `invite_codes` (202608270003: "Deliberately no grant to authenticated at
-- all") and `invite_attempts` (202608280013: "Still no grants and no
-- policies for anon or authenticated") already hold. The three definer
-- functions below are the entire API of this table.
--
-- On the standing "every new table gets at least one policy" rule: RLS
-- enabled with zero policies is deny-all for every non-superuser role, so
-- the table is not reachable, which is the outcome that rule protects. A
-- permissive policy here would be strictly weaker. The revoke is stated
-- explicitly anyway rather than relying on default privileges, for the
-- reason 202608280001 gives: a default-privilege revoke is a setting on a
-- role in another migration, and a future accidental grant on this table
-- would otherwise open it.
alter table public.invites enable row level security;
revoke all on public.invites from public, anon, authenticated;

comment on table public.invites is
  'COMM-370. Per-person, single-use invitations, beside (never replacing) the shared per-role codes in invite_codes. RLS enabled with zero policies and zero grants: reachable only through admin_invite_create/admin_invite_list/admin_invite_revoke and the per-person branch of redeem_invite_code. Stores code_hash (sha256 hex of a 24-random-byte code), never the plaintext code - see this migration''s header for why COMM-370''s proposed 8-char plaintext column was not built. The raw code is returned exactly once, by admin_invite_create.';

-- ---------------------------------------------------------------------
-- 3. New permission
-- ---------------------------------------------------------------------
-- Backlog Phase 4 open question 6, resolved to coach-and-above: inviting
-- one named person is a normal coach task in a small gym. Note the
-- parenthetical in that open question ("the same tier
-- community.member.restrict already uses") does not describe the live
-- mapping - `community.member.restrict` is seeded to head_coach, admin and
-- owner only, NOT to coach (202608280001). The explicit role list in the
-- ticket and the open question is what is built here, and it does include
-- coach; the comparison to member.restrict is simply inaccurate.
--
-- Consequence worth naming, since it is a privilege boundary rather than a
-- preference: `invites.role` admits 'coach', so a coach holding this
-- permission can mint an invite that makes a stranger a coach, and coach
-- is a real elevated tier (is_staff() gates the roster, attendance reads
-- and the coach tools). That is what COMM-370's acceptance criteria and
-- open question 6's chosen default jointly specify, it is audited on
-- creation, and it is flagged for confirmation rather than quietly
-- narrowed here.
insert into public.permissions (code, description) values
  ('community.member.invite', 'Generate, list and revoke a per-person invite');
insert into public.role_permissions (role_code, permission_code) values
  ('coach',      'community.member.invite'),
  ('head_coach', 'community.member.invite'),
  ('staff',      'community.member.invite'),
  ('admin',      'community.member.invite'),
  ('owner',      'community.member.invite');

-- ---------------------------------------------------------------------
-- 4. admin_actions labels
-- ---------------------------------------------------------------------
-- Drop-and-recreate with the full cumulative list, the pattern 202609010001,
-- 202609010002, 202609010005 and 202609010012 all used.
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review',
  'member_of_week_publish',
  'monthly_recap_publish',
  'club_feature_toggle',
  -- COMM-370.
  'invite_created', 'invite_revoked'
));

alter table public.admin_actions drop constraint if exists admin_actions_target_type_check;
alter table public.admin_actions add constraint admin_actions_target_type_check check (target_type in (
  'post', 'comment', 'member', 'role', 'challenge', 'achievement',
  'event', 'announcement', 'report', 'club',
  'monthly_club_recap',
  'challenge_participant', 'challenge_team',
  -- COMM-370.
  'invite'
));

-- ---------------------------------------------------------------------
-- 5. invite_status(): the one definition of an invite's lifecycle
-- ---------------------------------------------------------------------
-- admin_invite_list both FILTERS on a status and RETURNS one, and
-- registration_funnel (COMM-375) counts pending and expired invites. All
-- three read this, so a status shown to an admin and a status the filter
-- selected on cannot drift - the same "keep the definition in one callable
-- place" reasoning attendance_session_record_types() (202608310001) and
-- analytics_wcam_events() (202609010006) use.
--
-- Precedence is redeemed > revoked > expired > pending. redeemed and
-- revoked are mutually exclusive by the table CHECK, so the only real
-- ordering decision is that a spent or revoked invite whose expiry has
-- also passed reads as redeemed/revoked rather than as expired: what
-- happened to it is more informative than a deadline it never reached.
--
-- Takes the three timestamps rather than a row type so it stays IMMUTABLE
-- and can be used in a WHERE clause without re-reading the table. STRICT
-- is deliberately NOT used: every argument is legitimately nullable, and a
-- strict function would return null for the pending case, which is the
-- common one.
create or replace function public.invite_status(
  p_revoked_at timestamptz, p_redeemed_at timestamptz, p_expires_at timestamptz, p_now timestamptz)
returns text
language sql immutable set search_path = '' as $$
  select case
    when p_redeemed_at is not null then 'redeemed'
    when p_revoked_at is not null then 'revoked'
    when p_expires_at is not null and p_expires_at <= p_now then 'expired'
    else 'pending'
  end;
$$;
revoke all on function public.invite_status(timestamptz, timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.invite_status(timestamptz, timestamptz, timestamptz, timestamptz) to authenticated;

comment on function public.invite_status(timestamptz, timestamptz, timestamptz, timestamptz) is
  'COMM-370. The single definition of a public.invites row''s lifecycle status: redeemed > revoked > expired > pending, evaluated against a caller-supplied now(). Read by admin_invite_list (both its p_status filter and its returned status key) and registration_funnel''s pending_now/expired_unredeemed_now counts, so none of them can disagree. IMMUTABLE and takes bare timestamps rather than a row, so it is usable inside a WHERE clause. Takes p_now as a parameter precisely BECAUSE it is immutable - it must not call now() itself.';

-- ---------------------------------------------------------------------
-- 6. invite_generate_code(): the code minter
-- ---------------------------------------------------------------------
-- 24 random bytes, hex encoded: 48 characters, 192 bits. Byte-for-byte the
-- same generation `create_member_invite` (202608270006) uses, which is what
-- makes a per-person code satisfy `redeem_invite_code`'s existing
-- `^[a-f0-9]{40,128}$` format gate with no change to that gate.
--
-- Granted to no role. It is a pure generator with no auth check of its own;
-- the standing "definer functions check auth.uid() first" rule is satisfied
-- one level up in admin_invite_create, exactly as analytics_dashboard's
-- helpers do it (202609010006). It is not `security definer` either - it
-- reads nothing and needs no elevation.
create or replace function public.invite_generate_code() returns text
language sql volatile set search_path = '' as $$
  select encode(extensions.gen_random_bytes(24), 'hex');
$$;
revoke all on function public.invite_generate_code() from public, anon, authenticated;

comment on function public.invite_generate_code() is
  'COMM-370 internal. A fresh 48-character hex invite code (24 random bytes, 192 bits), the same shape and the same generator create_member_invite() has used since 202608270006 - which is why a per-person code already matches redeem_invite_code()''s ^[a-f0-9]{40,128}$ gate and that gate needed no widening in COMM-372. Granted to no role: it is called only from admin_invite_create, which has already checked auth.uid() and the permission.';

-- ---------------------------------------------------------------------
-- 7. admin_invite_create()
-- ---------------------------------------------------------------------
-- Returns jsonb, NOT `public.invites` as contracts.md proposed. Forced by
-- the hash-only decision in this file's header: the plaintext code is not a
-- column, so no row type can carry it, and the one-time reveal of that code
-- is the whole point of this function's return value.
create or replace function public.admin_invite_create(
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
  'COMM-370. Mint one per-person invite and return it, INCLUDING the raw code - the only point in this module''s lifetime that code is retrievable, because public.invites stores only its sha256 (see 202609030001''s header). AUTH: security definer; auth.uid() checked first, then has_perm(''community.member.invite'') or is_admin(). Raises ''not authorized'', ''invalid role'' (anything but member/coach), ''label too long'' (>120), ''expiry must be in the future'' (a non-null past value; null means never expires), all P0001. RETURNS jsonb {id, code, role, label, created_at, expires_at, status}, not the public.invites row type contracts.md originally proposed - a row type cannot carry the plaintext code. SIDE EFFECTS: one invites row with created_by = auth.uid(); one admin_actions row (invite_created / invite / target_id = the new invite, after_data {role, label, expires_at}).';

-- ---------------------------------------------------------------------
-- 8. admin_invite_list()
-- ---------------------------------------------------------------------
-- No `code` key: see this file's header. `label`, `created_at` and the
-- redeemer's identity are what distinguish rows for a human.
create or replace function public.admin_invite_list(
  p_status text default 'all',
  p_cursor timestamptz default null,
  p_limit integer default 25)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_limit  integer;
  v_status text;
  v_now    timestamptz := now();
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.member.invite') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  v_status := coalesce(nullif(p_status, ''), 'all');
  if v_status not in ('all', 'pending', 'redeemed', 'revoked', 'expired') then
    raise exception 'invalid status';
  end if;

  -- Clamped, not refused, matching admin_actions_page and mod_queue. A page
  -- size has an obvious sane neighbour; a date range (analytics_dashboard)
  -- does not, which is why that one raises instead.
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);

  return query
    select jsonb_build_object(
             'id', i.id,
             'role', i.role,
             'label', i.label,
             'created_at', i.created_at,
             'expires_at', i.expires_at,
             'revoked_at', i.revoked_at,
             'redeemed_at', i.redeemed_at,
             'redeemed_by', i.redeemed_by,
             'redeemed_by_display_name', p.display_name,
             'redeemed_by_handle', p.handle,
             'status', public.invite_status(i.revoked_at, i.redeemed_at, i.expires_at, v_now))
    from public.invites i
    -- A left join: the redeemer is an auth.users id, and a member can
    -- legitimately redeem an invite and not yet have created a profile
    -- (profiles_insert_self requires the redemption to already exist, so
    -- that window is guaranteed to happen for every single member). The
    -- invite must still list, with both name keys null, rather than
    -- vanishing during exactly the window an admin is most likely to look.
    left join public.profiles p on p.id = i.redeemed_by
    where (p_cursor is null or i.created_at < p_cursor)
      and (v_status = 'all'
           or public.invite_status(i.revoked_at, i.redeemed_at, i.expires_at, v_now) = v_status)
    order by i.created_at desc
    limit v_limit;
end $$;
revoke all on function public.admin_invite_list(text, timestamptz, integer) from public, anon;
grant execute on function public.admin_invite_list(text, timestamptz, integer) to authenticated;

comment on function public.admin_invite_list(text, timestamptz, integer) is
  'COMM-370. One page of per-person invites, newest first, cursor-paginated on created_at desc. AUTH: security definer; auth.uid() first, then has_perm(''community.member.invite'') or is_admin(). Raises ''not authorized'', ''invalid status''. p_status is all|pending|redeemed|revoked|expired, resolved through invite_status() so the filter and the returned status key cannot disagree. p_limit clamped 1..100 (admin_actions_page''s convention). Each row is jsonb {id, role, label, created_at, expires_at, revoked_at, redeemed_at, redeemed_by, redeemed_by_display_name, redeemed_by_handle, status}. NO `code` key, deviating from contracts.md''s proposal: public.invites stores only the sha256, so no plaintext code exists to return after creation. Read-only.';

-- ---------------------------------------------------------------------
-- 9. admin_invite_revoke()
-- ---------------------------------------------------------------------
create or replace function public.admin_invite_revoke(p_invite_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.invites;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.member.invite') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  select * into v_row from public.invites where id = p_invite_id;
  if v_row.id is null then raise exception 'invite not found'; end if;

  -- Refused outright, never a silent no-op and never an un-redemption: the
  -- member who used this invite keeps their membership, and an admin who
  -- clicked the wrong row is told so. COMM-370's acceptance criteria name
  -- this one explicitly.
  if v_row.redeemed_at is not null then raise exception 'already redeemed'; end if;

  -- Idempotent, and deliberately not audited a second time: re-revoking is
  -- not a new act, so a double click does not produce two audit rows.
  if v_row.revoked_at is not null then return; end if;

  update public.invites
     set revoked_at = now(), revoked_by = v_uid
   where id = p_invite_id;

  perform public.log_admin_action(
    'invite_revoked', 'invite', p_invite_id,
    jsonb_build_object('role', v_row.role, 'label', v_row.label, 'status', 'pending'),
    jsonb_build_object('role', v_row.role, 'label', v_row.label, 'status', 'revoked'));
end $$;
revoke all on function public.admin_invite_revoke(uuid) from public, anon;
grant execute on function public.admin_invite_revoke(uuid) to authenticated;

comment on function public.admin_invite_revoke(uuid) is
  'COMM-370. Mark one unredeemed per-person invite revoked, so redeem_invite_code stops matching it. AUTH: security definer; auth.uid() first, then has_perm(''community.member.invite'') or is_admin(). Raises ''not authorized'', ''invite not found'', ''already redeemed'' - revoking a spent invite is refused outright rather than no-opping, and can never un-redeem the member who used it (the invites_not_both_revoked_and_redeemed CHECK enforces that even against a hand edit). Revoking an ALREADY-revoked invite is an idempotent no-op and writes no second audit row. SIDE EFFECTS: revoked_at = now(), revoked_by = auth.uid(); one admin_actions row (invite_revoked / invite / target_id = the invite).';

commit;
