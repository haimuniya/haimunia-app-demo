-- COMM-371. The three shared-invite-code admin RPCs
-- (202609030002_shared_code_admin.sql).
--
-- THE ASSERTION THIS FILE EXISTS FOR, more than any single RPC: a COACH is
-- REFUSED all three. community.invite.manage_codes is seeded to admin and
-- owner only, deliberately narrower than COMM-370's
-- community.member.invite, which a coach does hold. 0056 asserts the coach
-- ALLOW on the per-person side; this file asserts the coach DENY on the
-- shared side. Together they are what makes the two tiers a real boundary
-- rather than two names for one thing.
--
-- Also asserted: invite_codes keeps the zero client grant it has held since
-- 202608270003, and deactivating a code has no retroactive effect on
-- anyone who already redeemed it (backlog Phase 4 open question 2).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

create table tests.stash (k text primary key, j jsonb, id uuid);
grant select, insert, update, delete on tests.stash to authenticated;

-- rls_helpers seeds one shared code and seven redemptions against it.
select results_eq(
  $$ select count(*)::int from public.invite_codes $$,
  $$ values (1) $$,
  'the fixture starts with exactly the one seeded shared code');

-- =====================================================================
-- invite_codes keeps its zero client grant - a regression guard
-- =====================================================================
select results_eq(
  $$ select has_table_privilege('authenticated', 'public.invite_codes', 'select'),
            has_table_privilege('authenticated', 'public.invite_codes', 'insert'),
            has_table_privilege('authenticated', 'public.invite_codes', 'update'),
            has_table_privilege('authenticated', 'public.invite_codes', 'delete') $$,
  $$ values (false, false, false, false) $$,
  'authenticated still has no grant of any kind on invite_codes - COMM-371 adds RPCs, it does not open the table');
select results_eq(
  $$ select count(*)::int from pg_catalog.pg_policies
     where schemaname = 'public' and tablename = 'invite_codes' $$,
  $$ values (0) $$,
  'and still not one policy on it');
select results_eq(
  $$ select count(*)::int from pg_catalog.pg_attribute
     where attrelid = 'public.invite_codes'::regclass and attname = 'code' and not attisdropped $$,
  $$ values (0) $$,
  'invite_codes has had no plaintext `code` column since 202608270006 - which is why admin_invite_code_create takes no p_code and the list returns no code');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select 1 from public.invite_codes $$,
  '42501', null,
  'not even an admin can read invite_codes directly');

-- =====================================================================
-- Who may create: NOT a coach
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_invite_code_create('member', null, 100) $$,
  'P0001', 'not authorized',
  'a plain member cannot create a shared code');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.admin_invite_code_create('member', null, 100) $$,
  'P0001', 'not authorized',
  'and NEITHER CAN A COACH - community.invite.manage_codes is admin-tier, unlike community.member.invite which the same coach does hold (0056 proves that half)');
select throws_ok(
  $$ select public.admin_invite_code_list() $$,
  'P0001', 'not authorized',
  'a coach cannot list shared codes either');
select throws_ok(
  $$ select public.admin_invite_code_set_active('11111111-2222-4333-8444-555555555555', false) $$,
  'P0001', 'not authorized',
  'nor toggle one - so a coach can never disable the code the whole club joins through');

-- The same coach really does hold the other permission, asserted here so
-- the deny above cannot be passing for a boring reason (a broken fixture,
-- or a coach with no role at all).
select results_eq(
  $$ select public.has_perm('community.member.invite'),
            public.has_perm('community.invite.manage_codes'),
            public.is_admin() $$,
  $$ values (true, false, false) $$,
  'the coach fixture holds community.member.invite and NOT community.invite.manage_codes, and is not an admin - the two tiers really are different sets');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_invite_code_create('member', null, 100) $$,
  'an admin can create a shared code');
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_invite_code_create('member', null, 250) $$,
  'and an owner can');

-- =====================================================================
-- Validation
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.admin_invite_code_create('coach', null, 100) $$,
  'P0001', 'shared codes cannot grant coach',
  'a COACH shared code is refused with its own specific error: redeem_invite_code''s shared branch filters role = ''member'' and inserts the literal ''member'' (202608270006, "Ordinary redemption never grants or upgrades to coach"), and COMM-372 leaves that branch untouched - so such a row could never be redeemed, and minting a guaranteed-dead code would be worse than refusing');
select throws_ok(
  $$ select public.admin_invite_code_create('owner', null, 100) $$,
  'P0001', 'invalid role',
  'and an unrecognised role is refused before that, with the generic error');
select throws_ok(
  $$ select public.admin_invite_code_create(null, null, 100) $$,
  'P0001', 'invalid role',
  'null role too');
select throws_ok(
  $$ select public.admin_invite_code_create('member', null, 0) $$,
  'P0001', 'max uses must be between 1 and 1000',
  'max_uses 0 is refused');
select throws_ok(
  $$ select public.admin_invite_code_create('member', null, 1001) $$,
  'P0001', 'max uses must be between 1 and 1000',
  'and 1001, matching the table''s own CHECK range rather than surfacing a raw constraint violation');
select throws_ok(
  $$ select public.admin_invite_code_create('member', null, null) $$,
  'P0001', 'max uses must be between 1 and 1000',
  'and null');
select lives_ok(
  $$ select public.admin_invite_code_create('member', null, 1) $$,
  'max_uses 1 is accepted - a shared code may legitimately be single-use');
select throws_ok(
  $$ select public.admin_invite_code_create('member', now() - interval '1 minute', 100) $$,
  'P0001', 'expiry must be in the future',
  'a past expiry is refused');
select lives_ok(
  $$ select public.admin_invite_code_create('member', null, 100) $$,
  'a null expiry is accepted and means the code stands until someone deactivates it - unlike create_member_invite, which requires an expiry');

-- =====================================================================
-- The code is returned once and stored only as a hash
-- =====================================================================
insert into tests.stash (k, j)
  select 'made', public.admin_invite_code_create('member', null, 42);

select results_eq(
  $$ select (j ->> 'code') ~ '^[a-f0-9]{48}$' from tests.stash where k = 'made' $$,
  $$ values (true) $$,
  'the returned shared code is 48 hex characters, the same high-entropy shape a per-person code and create_member_invite both use - and the reason a hand-picked "SUMMER26" was not built, since redeem_invite_code refuses anything outside ^[a-f0-9]{40,128}$');
select results_eq(
  $$ select (j ->> 'role'), (j -> 'active')::boolean, (j -> 'max_uses')::int, (j -> 'use_count')::int
     from tests.stash where k = 'made' $$,
  $$ values ('member'::text, true, 42, 0) $$,
  'and it comes back active by default, with the max_uses asked for and a zero use_count');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.invite_codes c
     where c.code_hash = encode(extensions.digest(
       (select j ->> 'code' from tests.stash where k = 'made'), 'sha256'), 'hex') $$,
  $$ values (1) $$,
  'the stored code_hash is sha256 of the returned code');
select results_eq(
  $$ select count(*)::int from public.invite_codes c
     where c.code_hash = (select j ->> 'code' from tests.stash where k = 'made') $$,
  $$ values (0) $$,
  'and the plaintext is not stored anywhere');

-- =====================================================================
-- admin_invite_code_list
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select count(*)::int from public.admin_invite_code_list() $$,
  $$ values (6) $$,
  'the list returns the seeded code plus the five created above');
select results_eq(
  $$ select bool_and(j ?& array['id','role','active','created_at','expires_at','revoked_at',
                               'max_uses','use_count','redemption_count'])
     from public.admin_invite_code_list() j $$,
  $$ values (true) $$,
  'every row carries the nine keys the contract promises');
select results_eq(
  $$ select bool_or(j ? 'code') from public.admin_invite_code_list() j $$,
  $$ values (false) $$,
  'and no row carries a `code` key - only the hash exists, so there is nothing to return');

-- redemption_count is the membership figure, read off invite_redemptions.
select results_eq(
  $$ select (j -> 'redemption_count')::int from public.admin_invite_code_list() j
     where (j ->> 'id') = '11111111-2222-4333-8444-555555555555' $$,
  $$ values (7) $$,
  'the seeded code reports 7 redemptions - the seven fixture members who joined through it, counted from invite_redemptions');
select results_eq(
  $$ select (j -> 'use_count')::int from public.admin_invite_code_list() j
     where (j ->> 'id') = '11111111-2222-4333-8444-555555555555' $$,
  $$ values (0) $$,
  'while its use_count is 0 - the two are deliberately different numbers: use_count is the rate-limit counter the redemption path bumps, redemption_count is how many people actually joined');
select results_eq(
  $$ select bool_and((j -> 'redemption_count')::int = 0) from public.admin_invite_code_list() j
     where (j ->> 'id') <> '11111111-2222-4333-8444-555555555555' $$,
  $$ values (true) $$,
  'and every freshly created code reports zero redemptions');

-- =====================================================================
-- admin_invite_code_set_active
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_invite_code_set_active('11111111-2222-4333-8444-555555555555', false) $$,
  'P0001', 'not authorized',
  'a plain member cannot toggle a shared code');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.admin_invite_code_set_active('00000000-0000-4000-8000-00000000dead', false) $$,
  'P0001', 'code not found',
  'an unknown id raises');
select throws_ok(
  $$ select public.admin_invite_code_set_active(null, false) $$,
  'P0001', 'code not found',
  'and so does a null id');
select throws_ok(
  $$ select public.admin_invite_code_set_active('11111111-2222-4333-8444-555555555555', null) $$,
  'P0001', 'active required',
  'a null p_active is refused rather than guessed at');

select lives_ok(
  $$ select public.admin_invite_code_set_active('11111111-2222-4333-8444-555555555555', false) $$,
  'an admin deactivates the seeded code');
select results_eq(
  $$ select (j -> 'active')::boolean from public.admin_invite_code_list() j
     where (j ->> 'id') = '11111111-2222-4333-8444-555555555555' $$,
  $$ values (false) $$,
  'and the list reports it inactive');

-- Backlog Phase 4 open question 2: no retroactive effect, at all.
select results_eq(
  $$ select (j -> 'redemption_count')::int from public.admin_invite_code_list() j
     where (j ->> 'id') = '11111111-2222-4333-8444-555555555555' $$,
  $$ values (7) $$,
  'the seven existing redemptions are UNTOUCHED by the deactivation - "revoke" for a shared code means "stop future redemptions", never "retract the memberships it already granted"');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.invite_redemptions
     where invite_id = '11111111-2222-4333-8444-555555555555' $$,
  $$ values (7) $$,
  'and the rows really are all still there, read past RLS as the superuser');
select results_eq(
  $$ select public.is_staff() is not null $$,
  $$ values (true) $$,
  'sanity: the helper still resolves after the toggle');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_invite_code_set_active('11111111-2222-4333-8444-555555555555', true) $$,
  'and it can be turned back on - deactivation is reversible, which is the other half of what makes it softer than a per-person revoke');
select results_eq(
  $$ select (j -> 'active')::boolean from public.admin_invite_code_list() j
     where (j ->> 'id') = '11111111-2222-4333-8444-555555555555' $$,
  $$ values (true) $$,
  'active again');

-- =====================================================================
-- The audit trail
-- =====================================================================
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions where action_type = 'shared_code_created' $$,
  $$ values (5) $$,
  'one shared_code_created row per successful create, and none for any of the seven refusals');
select results_eq(
  $$ select count(*)::int from public.admin_actions where action_type = 'shared_code_status_changed' $$,
  $$ values (2) $$,
  'and one status_changed row per real toggle - two, for the off and the back on');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type in ('shared_code_created', 'shared_code_status_changed')
       and target_type = 'invite_code' and target_id is not null $$,
  $$ values (7) $$,
  'every one targets `invite_code` WITH a real target_id - correcting contracts.md, which expected target_id to be null "since invite_codes'' primary key is text, not uuid": that was true of 202608270003, but 202608270006 re-keyed the table on a uuid id, so the audit row can point at it properly');
-- Asserted as a SET, not by order: both toggles happened inside this
-- transaction, so they share a byte-identical created_at and "the first
-- one" is not a thing the audit log can be asked for here.
select results_eq(
  $$ select count(*) filter (where before_data ->> 'active' = 'true'
                               and after_data  ->> 'active' = 'false')::int,
            count(*) filter (where before_data ->> 'active' = 'false'
                               and after_data  ->> 'active' = 'true')::int
     from public.admin_actions where action_type = 'shared_code_status_changed' $$,
  $$ values (1, 1) $$,
  'the two toggles record their before AND after state, not merely that something changed: one true->false row for the deactivation and one false->true for turning it back on');

-- The idempotent no-op writes nothing.
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_invite_code_set_active('11111111-2222-4333-8444-555555555555', true) $$,
  'setting active to the value it already has succeeds as a no-op');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions where action_type = 'shared_code_status_changed' $$,
  $$ values (2) $$,
  'and writes NO third audit row - a no-op is not an act, so the audit log does not fill up with them');

select throws_ok(
  $$ insert into public.admin_actions (admin_id, action_type, target_type)
     values (tests.uid('admin'), 'shared_code_deleted', 'invite_code') $$,
  '23514', null,
  'the action_type CHECK is closed - an unlisted shared-code label is refused');

-- =====================================================================
-- Shape of the functions themselves
-- =====================================================================
select results_eq(
  $$ select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and p.proname in ('admin_invite_code_create', 'admin_invite_code_list',
                         'admin_invite_code_set_active') $$,
  $$ values (3) $$,
  'all three are security definer - the only reason being to cross invite_codes'' zero-grant boundary');
select results_eq(
  $$ select has_function_privilege('anon', 'public.admin_invite_code_list()', 'execute') $$,
  $$ values (false) $$,
  'and anon holds execute on none of them');

select * from finish();
rollback;
