-- COMM-372. redeem_invite_code widened to accept a per-person invite
-- (202609030003_redeem_person_invite.sql).
--
-- This is the one file in the Phase 4 cluster that exercises an already-
-- hardened path, so it asserts BOTH halves: that the new branch works, and
-- that the old one is unchanged. The generic-'invalid' anti-enumeration
-- property gets its own block, because it is the property the throttle
-- design leans on and the easiest one to regress by "improving" an error
-- message.
--
-- Redemption needs accounts that have NOT redeemed anything, and every
-- rls_helpers fixture already has an invite_redemptions row, so this file
-- creates its own auth.users rows the way 0013 does.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

create table tests.stash (k text primary key, j jsonb, id uuid, code text);
grant select, insert, update, delete on tests.stash to authenticated;

-- Fresh, un-redeemed accounts. n1..n5 redeem things below; the fixture
-- members cannot, because redeem_invite_code returns their existing role
-- before it ever reaches a lookup.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'n1@members.haimuniya.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'n2@members.haimuniya.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'n3@members.haimuniya.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000a4', 'authenticated', 'authenticated', 'n4@members.haimuniya.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000a5', 'authenticated', 'authenticated', 'n5@members.haimuniya.invalid', now(), now());

-- =====================================================================
-- The column and its constraint
-- =====================================================================
select has_column('public', 'invite_redemptions', 'person_invite_id',
  'invite_redemptions gained person_invite_id');
select col_is_null('public', 'invite_redemptions', 'person_invite_id',
  'it is nullable - a shared-code redemption has no per-person invite to name');
select col_is_null('public', 'invite_redemptions', 'invite_id',
  'and invite_id was RELAXED to nullable, because a per-person redemption has no invite_codes row to name - it was NOT NULL from 202608270006 until this migration');
select results_eq(
  $$ select count(*)::int from pg_catalog.pg_constraint
     where conrelid = 'public.invite_redemptions'::regclass
       and conname = 'invite_redemptions_one_invite_source' $$,
  $$ values (1) $$,
  'and a CHECK enforces that exactly one of the two id columns is set');

-- Every pre-existing fixture row satisfies the new CHECK with no backfill.
select results_eq(
  $$ select count(*)::int from public.invite_redemptions
     where invite_id is not null and person_invite_id is null $$,
  $$ values (7) $$,
  'all seven pre-existing redemptions keep invite_id set and person_invite_id null - the new CHECK is satisfied by the existing data, no backfill needed');

select throws_ok(
  $$ insert into public.invite_redemptions (user_id, role)
     values ('00000000-0000-4000-8000-0000000000a1', 'member') $$,
  '23514', null,
  'a redemption naming NEITHER invite source is refused - so a row can never lose track of where the membership came from');
select throws_ok(
  $$ insert into public.invite_redemptions (user_id, invite_id, person_invite_id, role)
     values ('00000000-0000-4000-8000-0000000000a1',
             '11111111-2222-4333-8444-555555555555',
             '00000000-0000-4000-8000-00000000dead', 'member') $$,
  '23514', null,
  'and one naming BOTH is refused too - the partition registration_funnel counts on is total and disjoint');

-- =====================================================================
-- BRANCH 1: the shared code still works, unchanged
-- =====================================================================
select tests.clear_auth();
-- Give the seeded code a real hash we know the plaintext for.
insert into tests.stash (k, code) values
  ('shared', encode(extensions.gen_random_bytes(24), 'hex'));
update public.invite_codes
   set code_hash = encode(extensions.digest((select code from tests.stash where k = 'shared'), 'sha256'), 'hex')
 where id = '11111111-2222-4333-8444-555555555555';

select tests.set_auth('00000000-0000-4000-8000-0000000000a1');
select results_eq(
  $$ select public.redeem_invite_code((select code from tests.stash where k = 'shared'), 'device-a1') $$,
  $$ values ('member'::text) $$,
  'a shared code still redeems to member - today''s dominant path is untouched, and it is still tried FIRST');
select tests.clear_auth();
select results_eq(
  $$ select invite_id = '11111111-2222-4333-8444-555555555555', person_invite_id is null, role
     from public.invite_redemptions where user_id = '00000000-0000-4000-8000-0000000000a1' $$,
  $$ values (true, true, 'member'::text) $$,
  'and it writes invite_id with person_invite_id null, exactly as every existing row does');

-- =====================================================================
-- BRANCH 2: a per-person MEMBER invite
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
insert into tests.stash (k, j)
  select 'pp_member', public.admin_invite_create('member', 'for n2', null);

select tests.set_auth('00000000-0000-4000-8000-0000000000a2');
select results_eq(
  $$ select public.redeem_invite_code((select j ->> 'code' from tests.stash where k = 'pp_member'), 'device-a2') $$,
  $$ values ('member'::text) $$,
  'a per-person member invite redeems to member through the same unchanged signature');
select tests.clear_auth();
select results_eq(
  $$ select invite_id is null, person_invite_id = (select (j ->> 'id')::uuid from tests.stash where k = 'pp_member'), role
     from public.invite_redemptions where user_id = '00000000-0000-4000-8000-0000000000a2' $$,
  $$ values (true, true, 'member'::text) $$,
  'and it writes person_invite_id with invite_id null - the two redemption kinds are distinguishable on the row, which is what registration_funnel partitions on');
select results_eq(
  $$ select redeemed_at is not null, redeemed_by = '00000000-0000-4000-8000-0000000000a2'
     from public.invites where id = (select (j ->> 'id')::uuid from tests.stash where k = 'pp_member') $$,
  $$ values (true, true) $$,
  'the invite itself is stamped redeemed_at/redeemed_by in the SAME transaction as the redemption insert');
select results_eq(
  $$ select public.invite_status(revoked_at, redeemed_at, expires_at, now())
     from public.invites where id = (select (j ->> 'id')::uuid from tests.stash where k = 'pp_member') $$,
  $$ values ('redeemed'::text) $$,
  'so the admin who created it now sees it flip to redeemed - COMM-372''s stated user outcome');

-- =====================================================================
-- BRANCH 2: a per-person COACH invite really grants coach
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
insert into tests.stash (k, j)
  select 'pp_coach', public.admin_invite_create('coach', 'for n3', null);

select tests.set_auth('00000000-0000-4000-8000-0000000000a3');
select results_eq(
  $$ select public.redeem_invite_code((select j ->> 'code' from tests.stash where k = 'pp_coach'), 'device-a3') $$,
  $$ values ('coach'::text) $$,
  'a per-person COACH invite grants coach - the branch grants the invite ROW''s role, unlike branch 1 which still hardcodes ''member''. This is the one real privilege widening in the cluster and it is deliberate: the row was minted by a named community.member.invite holder and audited on creation');
select tests.clear_auth();
select results_eq(
  $$ select role from public.invite_redemptions where user_id = '00000000-0000-4000-8000-0000000000a3' $$,
  $$ values ('coach'::text) $$,
  'and the redemption records the coach role');

-- Staff rank is asserted only AFTER a profile exists, and that ordering is
-- the real behaviour rather than a convenience: the live is_staff() is
-- 202608280001's `role_rank(my_role_code()) >= 20`, and my_role_code()
-- returns null for a caller with no non-deleted profiles row. So between
-- redeeming and completing the profile form a new coach is NOT yet staff -
-- which is the correct order (profiles_insert_self requires the redemption
-- first, so every member passes through that window) and worth pinning
-- down, because the roster RPC in COMM-374 is gated on exactly is_staff().
select tests.set_auth('00000000-0000-4000-8000-0000000000a3');
select results_eq(
  $$ select public.is_staff(), public.my_role_code() is null $$,
  $$ values (false, true) $$,
  'immediately after redeeming, before any profile exists, the new coach is NOT yet staff - is_staff() resolves through my_role_code(), which needs a profiles row');

select tests.clear_auth();
insert into public.profiles (id, handle, display_name, recovery_verified_at)
values ('00000000-0000-4000-8000-0000000000a3', 'n3_coach', 'N3 Coach', now());

select tests.set_auth('00000000-0000-4000-8000-0000000000a3');
select results_eq(
  $$ select public.is_staff(), public.my_role_code() $$,
  $$ values (true, 'coach'::text) $$,
  'once they finish signup and a profile exists, the coach invite really has made them staff - so this path is a genuine elevation and not a cosmetic label');

-- =====================================================================
-- Single use: the second person gets nothing
-- =====================================================================
select tests.set_auth('00000000-0000-4000-8000-0000000000a4');
select results_eq(
  $$ select public.redeem_invite_code((select j ->> 'code' from tests.stash where k = 'pp_member'), 'device-a4') $$,
  $$ values ('invalid'::text) $$,
  'a per-person invite is single use: the second person to try the same code gets the generic ''invalid''');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.invite_redemptions where user_id = '00000000-0000-4000-8000-0000000000a4' $$,
  'and no redemption row was created for them');
select results_eq(
  $$ select redeemed_by = '00000000-0000-4000-8000-0000000000a2'
     from public.invites where id = (select (j ->> 'id')::uuid from tests.stash where k = 'pp_member') $$,
  $$ values (true) $$,
  'and the invite still belongs to the person who actually redeemed it - a second attempt cannot steal or overwrite the attribution');

-- =====================================================================
-- ANTI-ENUMERATION: every failure is the same word
-- =====================================================================
-- Revoked, expired, and never-existed, all from one un-redeemed account so
-- the throttle is the only thing that could differ - and it does not,
-- because it is bumped before both lookups.
select tests.set_auth(tests.uid('admin'));
insert into tests.stash (k, j)
  select 'pp_revoked', public.admin_invite_create('member', 'to be revoked', null);
insert into tests.stash (k, j)
  select 'pp_expired', public.admin_invite_create('member', 'to expire', null);
select public.admin_invite_revoke((select (j ->> 'id')::uuid from tests.stash where k = 'pp_revoked'));

select tests.clear_auth();
update public.invites set expires_at = now() - interval '1 hour'
 where id = (select (j ->> 'id')::uuid from tests.stash where k = 'pp_expired');

select tests.set_auth('00000000-0000-4000-8000-0000000000a5');
select results_eq(
  $$ select public.redeem_invite_code((select j ->> 'code' from tests.stash where k = 'pp_revoked'), 'device-a5') $$,
  $$ values ('invalid'::text) $$,
  'a REVOKED per-person invite answers ''invalid''');
select results_eq(
  $$ select public.redeem_invite_code((select j ->> 'code' from tests.stash where k = 'pp_expired'), 'device-a5') $$,
  $$ values ('invalid'::text) $$,
  'an EXPIRED one answers ''invalid''');
select results_eq(
  $$ select public.redeem_invite_code(repeat('f', 48), 'device-a5') $$,
  $$ values ('invalid'::text) $$,
  'a well-formed code that never existed in either table answers ''invalid''');
select results_eq(
  $$ select public.redeem_invite_code((select j ->> 'code' from tests.stash where k = 'pp_member'), 'device-a5') $$,
  $$ values ('invalid'::text) $$,
  'and an ALREADY-SPENT one answers ''invalid'' - four different underlying causes, one indistinguishable answer, which is the property that stops invite_attempts from becoming a status oracle (backlog Phase 4 open question 3)');

select tests.clear_auth();
select is_empty(
  $$ select 1 from public.invite_redemptions where user_id = '00000000-0000-4000-8000-0000000000a5' $$,
  'none of the four attempts granted anything');

-- Malformed input is still refused by the gate, before any lookup. On a
-- FRESH actor: a5 has already spent four of its five attempts above, and a
-- rate_limited answer would prove nothing about the format gate.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000a6',
        'authenticated', 'authenticated', 'n6@members.haimuniya.invalid', now(), now());

select tests.set_auth('00000000-0000-4000-8000-0000000000a6');
select results_eq(
  $$ select public.redeem_invite_code('SUMMER26', 'device-a6'),
            public.redeem_invite_code('', 'device-a6'),
            public.redeem_invite_code(null, 'device-a6') $$,
  $$ values ('invalid'::text, 'invalid'::text, 'invalid'::text) $$,
  'a short human-style code, an empty string and null all answer ''invalid'' at the unchanged format gate - and this is exactly why COMM-371''s hand-picked "print it on a flyer" code could not be built without widening that gate for the whole path');

-- =====================================================================
-- The throttle applies identically to the new branch
-- =====================================================================
-- A fresh actor key and a fresh uid, guessing per-person-shaped codes.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000b1',
        'authenticated', 'authenticated', 'b1@members.haimuniya.invalid', now(), now());

select tests.set_auth('00000000-0000-4000-8000-0000000000b1');
select results_eq(
  $$ select public.redeem_invite_code(repeat('1', 48), 'device-b1'),
            public.redeem_invite_code(repeat('2', 48), 'device-b1'),
            public.redeem_invite_code(repeat('3', 48), 'device-b1'),
            public.redeem_invite_code(repeat('4', 48), 'device-b1'),
            public.redeem_invite_code(repeat('5', 48), 'device-b1') $$,
  $$ values ('invalid'::text, 'invalid'::text, 'invalid'::text, 'invalid'::text, 'invalid'::text) $$,
  'five wrong guesses are answered ''invalid''');
select results_eq(
  $$ select public.redeem_invite_code(repeat('6', 48), 'device-b1') $$,
  $$ values ('rate_limited'::text) $$,
  'the sixth is rate_limited - the five-per-fifteen-minutes throttle applies to per-person guessing exactly as it does to shared-code guessing, because it is bumped before either lookup');

-- And a real code presented while throttled is still refused, so the
-- throttle cannot be walked around by guessing until you get lucky.
select tests.set_auth(tests.uid('admin'));
insert into tests.stash (k, j)
  select 'pp_late', public.admin_invite_create('member', 'presented while throttled', null);
select tests.set_auth('00000000-0000-4000-8000-0000000000b1');
select results_eq(
  $$ select public.redeem_invite_code((select j ->> 'code' from tests.stash where k = 'pp_late'), 'device-b1') $$,
  $$ values ('rate_limited'::text) $$,
  'even a VALID per-person code is refused while the actor is throttled - the throttle is checked before the lookup, so a guessing run cannot be converted into a redemption by eventually presenting something real');
select tests.clear_auth();
select results_eq(
  $$ select redeemed_at is null from public.invites
     where id = (select (j ->> 'id')::uuid from tests.stash where k = 'pp_late') $$,
  $$ values (true) $$,
  'and that invite is still unredeemed, so nothing was consumed by the refused attempt');

-- =====================================================================
-- An already-redeemed caller gets their role back, never a lookup
-- =====================================================================
select tests.set_auth('00000000-0000-4000-8000-0000000000a3');
select results_eq(
  $$ select public.redeem_invite_code(repeat('9', 48), 'device-a3') $$,
  $$ values ('coach'::text) $$,
  'a caller who already holds a redemption gets their existing role back for ANY input, before the throttle and before either lookup - unchanged from 202608280013');

-- =====================================================================
-- The one-argument wrapper still resolves and still works
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
insert into tests.stash (k, j)
  select 'pp_wrapper', public.admin_invite_create('member', 'via the 1-arg wrapper', null);
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000c1',
        'authenticated', 'authenticated', 'c1@members.haimuniya.invalid', now(), now());

select tests.set_auth('00000000-0000-4000-8000-0000000000c1');
select results_eq(
  $$ select public.redeem_invite_code((select j ->> 'code' from tests.stash where k = 'pp_wrapper')) $$,
  $$ values ('member'::text) $$,
  'the one-argument wrapper picks the widening up unchanged - it was never redefined by this migration, it just delegates with a null actor key, which is why COMM-380 needs no client change');
select tests.clear_auth();
select results_eq(
  $$ select person_invite_id is not null from public.invite_redemptions
     where user_id = '00000000-0000-4000-8000-0000000000c1' $$,
  $$ values (true) $$,
  'and it really went through the per-person branch');

-- =====================================================================
-- Grants unchanged
-- =====================================================================
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.redeem_invite_code(text, text)', 'execute'),
            has_function_privilege('anon', 'public.redeem_invite_code(text, text)', 'execute'),
            has_function_privilege('authenticated', 'public.redeem_invite_code(text)', 'execute'),
            has_function_privilege('anon', 'public.redeem_invite_code(text)', 'execute') $$,
  $$ values (true, false, true, false) $$,
  'both overloads stay granted to authenticated and revoked from anon, exactly as before');

select * from finish();
rollback;
