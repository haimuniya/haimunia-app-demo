begin;

-- COMM-371. `invite_codes` has existed since 202608270003 with no
-- client-reachable read or write path of any kind - not even a select
-- grant. There is no way from the app to see which shared codes exist,
-- whether they are active, or how many people joined through each one.
-- This file adds that, and nothing else: redemption itself is untouched
-- here (COMM-372), and `invite_codes` keeps its zero client grant.
--
-- =====================================================================
-- WHY THERE IS NO `p_code text` PARAMETER - the second deliberate
-- deviation in this cluster, for the same underlying reason as COMM-370's.
-- =====================================================================
-- COMM-371 and contracts.md both specify
--   `admin_invite_code_create(p_code text, p_role text)`
-- with "p_code must match invite_codes' existing CHECK
-- (^[A-Za-z0-9_-]{4,32}$)" and a rationale of "an admin picks the shared
-- code by hand (it is meant to be short and easy to say aloud or print on
-- a flyer)". Every part of that describes 202608270003's table.
--
-- 202608270006_security_hardening.sql dropped `invite_codes.code` and that
-- CHECK along with it. The live table is:
--     id uuid pk, code_hash text unique, role text, active boolean,
--     created_at, expires_at, max_uses int (1..1000), use_count int,
--     revoked_at
-- There is no plaintext column to write a hand-picked code into, and
-- `redeem_invite_code` (202608280013) refuses any code not matching
-- `^[a-f0-9]{40,128}$` before it looks anything up. So an
-- admin_invite_code_create that accepted "SUMMER26" would mint a row that
-- can never be redeemed by anyone - a broken feature, not a lenient one.
--
-- Making it work would mean widening that format gate to admit 4-character
-- codes, for the whole redemption path, which is precisely the online
-- guessing surface 202608270006 closed and which 202608280013 leans on
-- ("The real protection remains the high-entropy codes from
-- 202608270006"). A shared code is the worst place to spend that: it is
-- club-wide, standing, and reusable up to max_uses times, so one guess
-- buys an attacker a membership repeatedly rather than once.
--
-- So this file keeps the hardened model and server-generates the shared
-- code too, returning the plaintext exactly once - the same shape
-- create_member_invite() (202608270006) and admin_invite_create()
-- (COMM-370) both already use. WHAT IS LOST: an admin cannot choose a
-- memorable code, and cannot print one on a flyer. WHAT IS DELIVERED, and
-- it is the whole of COMM-371's stated user outcome: an admin can see
-- every shared code, how many people joined through each, create a new
-- one, and turn one on or off, all from the app and never from the
-- database console.
--
-- ROLE, and why creation is member-only here. `redeem_invite_code`'s
-- shared-code branch filters `role = 'member'` and inserts the literal
-- 'member', under 202608270006's comment "Ordinary redemption never grants
-- or upgrades to coach." COMM-372 leaves that branch untouched by
-- explicit instruction, so a shared code with role = 'coach' would be
-- unredeemable in exactly the way described above. Rather than mint a
-- guaranteed-dead row, this function refuses 'coach' with a specific
-- error. Coach access has two live paths already: admin_grant_coach on an
-- existing member, and COMM-370's per-person invite, whose branch DOES
-- grant the row's role.

-- ---------------------------------------------------------------------
-- 1. New permission
-- ---------------------------------------------------------------------
-- Narrower than COMM-370's community.member.invite on purpose: a shared
-- code is club-wide and standing rather than one invitation to one named
-- person, so creating or disabling one stays admin-tier. Same pair
-- 202609010012 seeded community.club.manage_modules to.
insert into public.permissions (code, description) values
  ('community.invite.manage_codes', 'Create, list and activate or deactivate a shared invite code');
insert into public.role_permissions (role_code, permission_code) values
  ('admin', 'community.invite.manage_codes'),
  ('owner', 'community.invite.manage_codes');

-- ---------------------------------------------------------------------
-- 2. admin_actions labels
-- ---------------------------------------------------------------------
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review',
  'member_of_week_publish',
  'monthly_recap_publish',
  'club_feature_toggle',
  'invite_created', 'invite_revoked',
  -- COMM-371.
  'shared_code_created', 'shared_code_status_changed'
));

alter table public.admin_actions drop constraint if exists admin_actions_target_type_check;
alter table public.admin_actions add constraint admin_actions_target_type_check check (target_type in (
  'post', 'comment', 'member', 'role', 'challenge', 'achievement',
  'event', 'announcement', 'report', 'club',
  'monthly_club_recap',
  'challenge_participant', 'challenge_team',
  'invite',
  -- COMM-371.
  'invite_code'
));

-- ---------------------------------------------------------------------
-- 3. admin_invite_code_create()
-- ---------------------------------------------------------------------
-- Signature deviates from contracts.md: `(p_role text, p_expires_at
-- timestamptz default null, p_max_uses integer default 100)` instead of
-- `(p_code text, p_role text)`, and it returns jsonb rather than the
-- public.invite_codes row type - the plaintext code is not a column, so no
-- row type can carry it, same as admin_invite_create.
--
-- p_max_uses defaults to 100 rather than create_member_invite's 1: the
-- point of a SHARED code is that many people redeem the same one. 1..1000
-- is the table's own existing CHECK range, re-asserted here so an admin
-- gets a clear error instead of a raw constraint violation.
--
-- p_expires_at defaults to null, meaning never expires, unlike
-- create_member_invite which requires a future expiry. A standing club
-- code that silently dies is worse than one an admin deactivates
-- deliberately, and deactivation is exactly what this ticket adds.
create or replace function public.admin_invite_code_create(
  p_role text default 'member',
  p_expires_at timestamptz default null,
  p_max_uses integer default 100)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_code text;
  v_row  public.invite_codes;
  v_try  integer := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.invite.manage_codes') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  if p_role is null or p_role not in ('member', 'coach') then
    raise exception 'invalid role';
  end if;
  -- See the header: a coach shared code cannot be redeemed by the
  -- unchanged shared-code branch, so it is refused at creation with its own
  -- error rather than stored as a dead row.
  if p_role = 'coach' then
    raise exception 'shared codes cannot grant coach';
  end if;
  if p_max_uses is null or p_max_uses < 1 or p_max_uses > 1000 then
    raise exception 'max uses must be between 1 and 1000';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'expiry must be in the future';
  end if;

  loop
    v_try := v_try + 1;
    v_code := public.invite_generate_code();
    begin
      insert into public.invite_codes (id, code_hash, role, active, expires_at, max_uses)
      values (gen_random_uuid(), encode(extensions.digest(v_code, 'sha256'), 'hex'),
              p_role, true, p_expires_at, p_max_uses)
      returning * into v_row;
      exit;
    exception when unique_violation then
      if v_try >= 5 then raise exception 'could not generate a unique invite code'; end if;
    end;
  end loop;

  -- target_id IS the row's uuid, correcting contracts.md's note that it
  -- would have to be null "since invite_codes' primary key is text, not
  -- uuid". That was true of 202608270003; 202608270006 re-keyed the table
  -- on a uuid id, so the audit row can point at it properly.
  perform public.log_admin_action(
    'shared_code_created', 'invite_code', v_row.id, null,
    jsonb_build_object('role', v_row.role, 'max_uses', v_row.max_uses, 'expires_at', v_row.expires_at));

  return jsonb_build_object(
    'id', v_row.id,
    'code', v_code,
    'role', v_row.role,
    'active', v_row.active,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at,
    'max_uses', v_row.max_uses,
    'use_count', v_row.use_count);
end $$;
revoke all on function public.admin_invite_code_create(text, timestamptz, integer) from public, anon;
grant execute on function public.admin_invite_code_create(text, timestamptz, integer) to authenticated;

comment on function public.admin_invite_code_create(text, timestamptz, integer) is
  'COMM-371. Create one shared, reusable invite code and return it INCLUDING the raw code - retrievable here and never again, because invite_codes has stored only code_hash since 202608270006. AUTH: security definer; auth.uid() first, then has_perm(''community.invite.manage_codes'') or is_admin() - narrower than COMM-370''s community.member.invite by design. Raises ''not authorized'', ''invalid role'', ''shared codes cannot grant coach'' (redeem_invite_code''s shared branch inserts the literal ''member'', so a coach shared code would be permanently unredeemable - use admin_grant_coach or a per-person coach invite), ''max uses must be between 1 and 1000'', ''expiry must be in the future''. SIGNATURE DEVIATES from contracts.md''s (p_code text, p_role text): there is no plaintext code column to accept a hand-picked code into, and redeem_invite_code refuses anything outside ^[a-f0-9]{40,128}$, so codes are server-generated. RETURNS jsonb {id, code, role, active, created_at, expires_at, max_uses, use_count}. SIDE EFFECTS: one invite_codes row, active = true; one admin_actions row (shared_code_created / invite_code / target_id = the new row''s uuid).';

-- ---------------------------------------------------------------------
-- 4. admin_invite_code_list()
-- ---------------------------------------------------------------------
-- No `code` key, for the reason in the header. `id`, `created_at`, the
-- use counters and the redemption count are what identify a row instead.
create or replace function public.admin_invite_code_list() returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.invite.manage_codes') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  return query
    select jsonb_build_object(
             'id', c.id,
             'role', c.role,
             'active', c.active,
             'created_at', c.created_at,
             'expires_at', c.expires_at,
             'revoked_at', c.revoked_at,
             'max_uses', c.max_uses,
             'use_count', c.use_count,
             -- The count COMM-371 asks for: how many people actually joined
             -- through this code. Read from invite_redemptions rather than
             -- from use_count, and the two are NOT the same number by
             -- construction - the shared branch of redeem_invite_code bumps
             -- use_count in one statement and inserts the redemption in the
             -- next, and a caller who already holds a redemption returns
             -- early without touching either. use_count is the rate-limit
             -- counter; this is the membership figure.
             'redemption_count', (select count(*) from public.invite_redemptions r where r.invite_id = c.id))
    from public.invite_codes c
    order by c.created_at desc, c.id;
end $$;
revoke all on function public.admin_invite_code_list() from public, anon;
grant execute on function public.admin_invite_code_list() to authenticated;

comment on function public.admin_invite_code_list() is
  'COMM-371. Every shared invite code, newest first. AUTH: security definer; auth.uid() first, then has_perm(''community.invite.manage_codes'') or is_admin(). Raises ''not authorized''. Each row is jsonb {id, role, active, created_at, expires_at, revoked_at, max_uses, use_count, redemption_count}. NO `code` key, deviating from contracts.md: only code_hash is stored (202608270006). redemption_count is count(invite_redemptions) for the code - deliberately not use_count, which is the rate-limit counter and can differ. Unpaginated: a club has a handful of shared codes, not a feed of them. Read-only.';

-- ---------------------------------------------------------------------
-- 5. admin_invite_code_set_active()
-- ---------------------------------------------------------------------
-- Keyed on the uuid id, not on `p_code text` as contracts.md proposed:
-- there is no plaintext code to key on, and admin_invite_code_list hands
-- the id out precisely so this call can use it.
create or replace function public.admin_invite_code_set_active(
  p_code_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.invite_codes;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.invite.manage_codes') or public.is_admin()) then
    raise exception 'not authorized';
  end if;
  if p_active is null then raise exception 'active required'; end if;

  select * into v_row from public.invite_codes where id = p_code_id;
  if v_row.id is null then raise exception 'code not found'; end if;

  -- Idempotent and unaudited when nothing changes, the same shape
  -- admin_invite_revoke uses for a re-revoke.
  if v_row.active = p_active then return; end if;

  update public.invite_codes set active = p_active where id = p_code_id;

  -- Backlog Phase 4 open question 2, resolved to "no retroactive effect":
  -- invite_redemptions is deliberately NOT touched here, in either
  -- direction. Deactivating stops future matches only, because
  -- redeem_invite_code's shared branch already filters on `active` - so
  -- this is a change to what the code will do next, never a retraction of
  -- anyone's membership. That is also why this is a softer act than
  -- COMM-370's per-person revoke, which can only ever target an invite
  -- nobody has used.
  perform public.log_admin_action(
    'shared_code_status_changed', 'invite_code', p_code_id,
    jsonb_build_object('active', v_row.active),
    jsonb_build_object('active', p_active));
end $$;
revoke all on function public.admin_invite_code_set_active(uuid, boolean) from public, anon;
grant execute on function public.admin_invite_code_set_active(uuid, boolean) to authenticated;

comment on function public.admin_invite_code_set_active(uuid, boolean) is
  'COMM-371. Turn one shared invite code on or off. AUTH: security definer; auth.uid() first, then has_perm(''community.invite.manage_codes'') or is_admin(). Raises ''not authorized'', ''active required'', ''code not found''. KEYED ON THE UUID id, deviating from contracts.md''s (p_code text, p_active boolean): invite_codes has been keyed on a uuid id with no plaintext code column since 202608270006, and admin_invite_code_list returns that id for this call. NO RETROACTIVE EFFECT (backlog Phase 4 open question 2): existing invite_redemptions rows are untouched either way; deactivating only stops future matches, since redeem_invite_code''s shared branch already filters on active. Setting the value it already has is an idempotent no-op and writes no audit row. SIDE EFFECTS: updates active; one admin_actions row (shared_code_status_changed / invite_code / target_id = the code''s uuid, before/after {active}).';

commit;
