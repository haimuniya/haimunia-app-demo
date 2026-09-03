-- COMM-370. public.invites, its three admin RPCs, and the
-- reachable-by-nobody boundary (202609030001_person_invites.sql).
--
-- The permission matrix is the point of this file and it is asserted in
-- both directions for every RPC: a plain member is refused, a COACH is
-- allowed (community.member.invite is seeded coach-and-above, which is what
-- makes this ticket's tier different from COMM-371's), an admin is allowed.
--
-- Also asserted, because it is this migration's deliberate deviation from
-- COMM-370's written outline: no plaintext code is ever stored, and the raw
-- code is returned by admin_invite_create and by nothing else.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- A holding table for values that have to survive a role switch, created
-- as the superuser and granted, so the tests never depend on whether
-- `authenticated` may create temp tables.
create table tests.stash (k text primary key, j jsonb, id uuid);
grant select, insert, update, delete on tests.stash to authenticated;

select is_empty(
  $$ select 1 from public.invites $$,
  'invites starts empty on a fresh database - every row below is written by an RPC during this test');

-- =====================================================================
-- The table is reachable by nobody
-- =====================================================================
select results_eq(
  $$ select relrowsecurity from pg_catalog.pg_class where oid = 'public.invites'::regclass $$,
  $$ values (true) $$,
  'row level security is enabled on invites');
select results_eq(
  $$ select has_table_privilege('authenticated', 'public.invites', 'select'),
            has_table_privilege('authenticated', 'public.invites', 'insert'),
            has_table_privilege('authenticated', 'public.invites', 'update'),
            has_table_privilege('authenticated', 'public.invites', 'delete') $$,
  $$ values (false, false, false, false) $$,
  'authenticated has no grant of any kind on invites - not even select, the same shape invite_codes and invite_attempts already hold');
select results_eq(
  $$ select has_table_privilege('anon', 'public.invites', 'select'),
            has_table_privilege('anon', 'public.invites', 'insert') $$,
  $$ values (false, false) $$,
  'anon cannot reach invites at all');
select results_eq(
  $$ select count(*)::int from pg_catalog.pg_policies
     where schemaname = 'public' and tablename = 'invites' $$,
  $$ values (0) $$,
  'and there is not one policy, for any role or any command: RLS enabled with zero policies is deny-all, so the three definer RPCs really are the whole API');
select results_eq(
  $$ select count(*)::int from pg_catalog.pg_attribute
     where attrelid = 'public.invites'::regclass and attname = 'code' and not attisdropped $$,
  $$ values (0) $$,
  'there is no plaintext `code` column on invites at all - this migration deliberately did not build COMM-370''s proposed one, because 202608270006 dropped exactly that column from invite_codes as a hardening step');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ insert into public.invites (code_hash, role, created_by)
     values (repeat('b', 64), 'coach', tests.uid('admin')) $$,
  '42501', null,
  'an admin cannot hand-write an invite row - the grant, not a policy, is what refuses it');
select throws_ok(
  $$ select 1 from public.invites $$,
  '42501', null,
  'and an admin cannot even read the table directly, so a stored code hash never reaches a client');

-- =====================================================================
-- invite_status(): the one lifecycle definition
-- =====================================================================
select results_eq(
  $$ select public.invite_status(null, null, null, now()),
            public.invite_status(null, null, now() + interval '1 day', now()),
            public.invite_status(null, null, now() - interval '1 day', now()),
            public.invite_status(now(), null, null, now()),
            public.invite_status(null, now(), null, now()) $$,
  $$ values ('pending'::text, 'pending'::text, 'expired'::text, 'revoked'::text, 'redeemed'::text) $$,
  'invite_status maps the four states, and a future expiry is still pending');
select results_eq(
  $$ select public.invite_status(null, now(), now() - interval '1 day', now()),
            public.invite_status(now(), null, now() - interval '1 day', now()) $$,
  $$ values ('redeemed'::text, 'revoked'::text) $$,
  'precedence: a spent or revoked invite whose expiry also passed reads as redeemed/revoked, not expired - what happened to it beats a deadline it never reached');

-- =====================================================================
-- admin_invite_create: who may, who may not
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_invite_create('member', null, null) $$,
  'P0001', 'not authorized',
  'a plain member cannot mint an invite');

select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select public.admin_invite_create('member', null, null) $$,
  'P0001', 'not authorized',
  'nor can a member with no verified recovery method');

-- The tier that distinguishes COMM-370 from COMM-371.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.admin_invite_create('member', 'Dana, Tuesday 06:00', null) $$,
  'a COACH can mint an invite - community.member.invite is seeded coach-and-above, deliberately looser than the shared-code permission');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_invite_create('member', null, null) $$,
  'an admin can, via is_admin()');
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_invite_create('coach', 'a new coach', null) $$,
  'and an owner can, and may mint a COACH invite - invites.role admits member and coach');

-- =====================================================================
-- admin_invite_create: validation
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.admin_invite_create('owner', null, null) $$,
  'P0001', 'invalid role',
  'only member and coach are invitable - owner is refused, so a code cannot be a back door to the top tier');
select throws_ok(
  $$ select public.admin_invite_create('head_coach', null, null) $$,
  'P0001', 'invalid role',
  'head_coach too, even though it is a real roles(code) row - those tiers go through admin_grant_coach on an existing member');
select throws_ok(
  $$ select public.admin_invite_create(null, null, null) $$,
  'P0001', 'invalid role',
  'and a null role');
select throws_ok(
  $$ select public.admin_invite_create('member', repeat('x', 121), null) $$,
  'P0001', 'label too long',
  'a 121-character label is refused');
select lives_ok(
  $$ select public.admin_invite_create('member', repeat('x', 120), null) $$,
  'exactly 120 is accepted - the boundary is inclusive');
select throws_ok(
  $$ select public.admin_invite_create('member', null, now() - interval '1 second') $$,
  'P0001', 'expiry must be in the future',
  'a past expiry is refused rather than clamped forward');
select lives_ok(
  $$ select public.admin_invite_create('member', null, null) $$,
  'a NULL expiry is accepted and means never expires - open question 1''s chosen default, no standing expiry imposed');

-- Five invites now exist: coach 1, owner 1, admin 3.
select results_eq(
  $$ select count(*)::int from public.admin_invite_list('all', null, 100) $$,
  $$ values (5) $$,
  'five invites were created and none of the six refusals above created anything');

-- =====================================================================
-- The code: returned once, stored only as a hash
-- =====================================================================
insert into tests.stash (k, j)
  select 'made', public.admin_invite_create('coach', 'hash check', null);

select results_eq(
  $$ select (j ->> 'code') ~ '^[a-f0-9]{48}$' from tests.stash where k = 'made' $$,
  $$ values (true) $$,
  'the returned code is 48 hex characters - 24 random bytes, byte-for-byte create_member_invite''s generator, which is why it already satisfies redeem_invite_code''s ^[a-f0-9]{40,128}$ gate with no change to that gate');
select results_eq(
  $$ select (j ->> 'role'), (j ->> 'label'), (j ->> 'status') from tests.stash where k = 'made' $$,
  $$ values ('coach'::text, 'hash check'::text, 'pending'::text) $$,
  'and the returned row carries the role, the label and a computed status');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.invites i
     where i.code_hash = encode(extensions.digest(
       (select j ->> 'code' from tests.stash where k = 'made'), 'sha256'), 'hex') $$,
  $$ values (1) $$,
  'the stored code_hash is exactly sha256(the returned code) - the code is verifiable but not recoverable');
select results_eq(
  $$ select count(*)::int from public.invites i
     where i.code_hash = (select j ->> 'code' from tests.stash where k = 'made') $$,
  $$ values (0) $$,
  'and the plaintext code appears nowhere in the table');
select results_eq(
  $$ select count(distinct code_hash)::int = count(*)::int from public.invites $$,
  $$ values (true) $$,
  'every generated code hash is distinct - the retry loop never had to fire, and could not silently produce a shared code if it did');
select results_eq(
  $$ select count(*)::int from public.invites where created_by = tests.uid('coach') $$,
  $$ values (1) $$,
  'created_by is stamped with auth.uid(): exactly one invite is attributed to the coach, the one the coach created, and the other five to the admin and owner who created those');
select results_eq(
  $$ select (select count(*)::int from public.invites where created_by = tests.uid('admin')),
            (select count(*)::int from public.invites where created_by = tests.uid('owner')) $$,
  $$ values (4, 1) $$,
  'and the admin''s four and the owner''s one are attributed correctly too - the definer function acts for its caller, never for its owner');

-- ---------------------------------------------------------------------
-- Spread created_at so ordering and the cursor are testable at all.
-- ---------------------------------------------------------------------
-- Every invite above was created inside THIS transaction, and now() is the
-- transaction timestamp - so all six carry a byte-identical created_at and
-- any "newest first" or cursor assertion would pass vacuously on a single
-- distinct value. Re-dating them as the superuser is what makes the two
-- assertions below real tests of the ORDER BY and the cursor predicate
-- rather than of nothing.
select tests.clear_auth();
update public.invites i
   set created_at = now() - (o.rn || ' hours')::interval
  from (select id, row_number() over (order by id) as rn from public.invites) o
 where o.id = i.id;
select results_eq(
  $$ select count(distinct created_at)::int from public.invites $$,
  $$ values (6) $$,
  'the six invites now have six distinct created_at values, so the ordering assertions below can fail');

-- =====================================================================
-- admin_invite_list
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_invite_list('all', null, 25) $$,
  'P0001', 'not authorized',
  'a plain member cannot list invites');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.admin_invite_list('all', null, 25) $$,
  'a coach can');
select throws_ok(
  $$ select public.admin_invite_list('nonsense', null, 25) $$,
  'P0001', 'invalid status',
  'an unknown p_status is refused rather than silently treated as `all`');
select results_eq(
  $$ select count(*)::int from public.admin_invite_list('all', null, 100) $$,
  $$ values (6) $$,
  'a coach sees every invite in the club, not only the one they created - the permission is club-scoped');
select results_eq(
  $$ select count(*)::int from public.admin_invite_list('all', null, 3) $$,
  $$ values (3) $$,
  'p_limit is honoured');
select results_eq(
  $$ select count(*)::int from public.admin_invite_list('all', null, 0) $$,
  $$ values (1) $$,
  'p_limit 0 is CLAMPED up to 1, not refused - admin_actions_page''s convention');
select results_eq(
  $$ select count(*)::int from public.admin_invite_list('all', null, 1000) $$,
  $$ values (6) $$,
  'and an over-large limit is clamped down to 100, which is more than the six rows here');

select results_eq(
  $$ select count(*)::int from public.admin_invite_list('pending', null, 100) $$,
  $$ values (6) $$,
  'all six are pending: none has been redeemed, revoked, or given a past expiry');
select is_empty(
  $$ select 1 from public.admin_invite_list('redeemed', null, 100) $$,
  'and none is redeemed yet');
select is_empty(
  $$ select 1 from public.admin_invite_list('revoked', null, 100) $$,
  'nor revoked');
select is_empty(
  $$ select 1 from public.admin_invite_list('expired', null, 100) $$,
  'nor expired');

select results_eq(
  $$ select bool_or(j ? 'code') from public.admin_invite_list('all', null, 100) j $$,
  $$ values (false) $$,
  'no row carries a `code` key - deviating from contracts.md''s proposed list shape on purpose, since only the hash is stored and the code was revealed once at creation');
select results_eq(
  $$ select bool_and(j ?& array['id','role','label','created_at','expires_at','revoked_at',
                               'redeemed_at','redeemed_by','redeemed_by_display_name',
                               'redeemed_by_handle','status'])
     from public.admin_invite_list('all', null, 100) j $$,
  $$ values (true) $$,
  'and every row carries the eleven keys the contract promises');

-- Newest first, and the cursor really walks backwards through that order.
select results_eq(
  $$ select bool_and(a >= b) from (
       select (j ->> 'created_at')::timestamptz as a,
              lead((j ->> 'created_at')::timestamptz) over () as b
       from public.admin_invite_list('all', null, 100) j) w
     where b is not null $$,
  $$ values (true) $$,
  'the page is ordered created_at descending');
select results_eq(
  $$ select count(*)::int from public.admin_invite_list(
       'all',
       (select (j ->> 'created_at')::timestamptz from public.admin_invite_list('all', null, 1) j),
       100) $$,
  $$ values (5) $$,
  'passing the newest row''s created_at as p_cursor returns the remaining five - the cursor is exclusive, so paging cannot repeat a row');

-- =====================================================================
-- admin_invite_revoke
-- =====================================================================
select tests.clear_auth();
insert into tests.stash (k, id)
  select 'target', id from public.invites where created_by = tests.uid('coach')
  order by created_at limit 1;

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_invite_revoke((select id from tests.stash where k = 'target')) $$,
  'P0001', 'not authorized',
  'a plain member cannot revoke an invite');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.admin_invite_revoke('00000000-0000-4000-8000-00000000dead') $$,
  'P0001', 'invite not found',
  'an unknown id raises rather than silently succeeding');
select throws_ok(
  $$ select public.admin_invite_revoke(null) $$,
  'P0001', 'invite not found',
  'and so does null');

select lives_ok(
  $$ select public.admin_invite_revoke((select id from tests.stash where k = 'target')) $$,
  'a coach revokes a pending invite');
select results_eq(
  $$ select (j ->> 'status') from public.admin_invite_list('all', null, 100) j
     where (j ->> 'id')::uuid = (select id from tests.stash where k = 'target') $$,
  $$ values ('revoked'::text) $$,
  'and it now reads as revoked through the same invite_status() the filter uses');
select results_eq(
  $$ select count(*)::int from public.admin_invite_list('revoked', null, 100) $$,
  $$ values (1) $$,
  'the revoked filter finds exactly it');
select results_eq(
  $$ select count(*)::int from public.admin_invite_list('pending', null, 100) $$,
  $$ values (5) $$,
  'and the pending count dropped by one');

select lives_ok(
  $$ select public.admin_invite_revoke((select id from tests.stash where k = 'target')) $$,
  'revoking an ALREADY-revoked invite is an idempotent no-op, not an error - a double click is not a failure');

select tests.clear_auth();
select results_eq(
  $$ select revoked_by = tests.uid('coach') from public.invites
     where id = (select id from tests.stash where k = 'target') $$,
  $$ values (true) $$,
  'revoked_by is stamped with the revoking coach');

-- =====================================================================
-- Revoking a REDEEMED invite is refused outright
-- =====================================================================
insert into tests.stash (k, id)
  select 'spent', id from public.invites where created_by = tests.uid('owner') limit 1;
update public.invites set redeemed_at = now(), redeemed_by = tests.uid('m2')
 where id = (select id from tests.stash where k = 'spent');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.admin_invite_revoke((select id from tests.stash where k = 'spent')) $$,
  'P0001', 'already redeemed',
  'revoking a redeemed invite is refused outright - never a silent no-op, and never an un-redemption of the member who used it');
select tests.clear_auth();
select results_eq(
  $$ select redeemed_at is not null, revoked_at is null from public.invites
     where id = (select id from tests.stash where k = 'spent') $$,
  $$ values (true, true) $$,
  'and the row is untouched by the attempt');

-- The CHECK behind that refusal, asserted as the superuser: it is a
-- constraint, not just a rule one function happens to follow.
select throws_ok(
  $$ update public.invites set revoked_at = now()
     where id = (select id from tests.stash where k = 'spent') $$,
  '23514', null,
  'even a service-role or SQL-editor hand edit cannot mark a redeemed invite revoked - invites_not_both_revoked_and_redeemed refuses it');

select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select (j ->> 'redeemed_by_handle'), (j ->> 'redeemed_by_display_name')
     from public.admin_invite_list('redeemed', null, 100) j $$,
  $$ values ('member_b'::text, 'Member B'::text) $$,
  'a redeemed invite lists the redeeming member''s handle and display name');

-- And an invite redeemed by an account with no profile row yet still lists.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000f1',
        'authenticated', 'authenticated', 'noprofile@members.haimuniya.invalid', now(), now());
insert into tests.stash (k, id)
  select 'noprof', id from public.invites
  where redeemed_at is null and revoked_at is null and created_by = tests.uid('admin')
  order by created_at limit 1;
update public.invites set redeemed_at = now(), redeemed_by = '00000000-0000-4000-8000-0000000000f1'
 where id = (select id from tests.stash where k = 'noprof');

select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select (j ->> 'redeemed_by_handle') is null, (j ->> 'redeemed_by') is not null
     from public.admin_invite_list('all', null, 100) j
     where (j ->> 'id')::uuid = (select id from tests.stash where k = 'noprof') $$,
  $$ values (true, true) $$,
  'an invite redeemed by an account with no profile row yet still lists, with the two name keys null - that window is guaranteed for every member, since profiles_insert_self requires the redemption to exist first, and it is exactly when an admin is most likely to look');

-- =====================================================================
-- Expiry is a real filter, not decoration
-- =====================================================================
select tests.clear_auth();
insert into tests.stash (k, id)
  select 'exp', id from public.invites
  where redeemed_at is null and revoked_at is null and created_by = tests.uid('admin')
  order by created_at limit 1;
update public.invites set expires_at = now() - interval '1 hour'
 where id = (select id from tests.stash where k = 'exp');

select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select count(*)::int from public.admin_invite_list('expired', null, 100) $$,
  $$ values (1) $$,
  'an invite whose expires_at has passed moves to the expired bucket with no other change to the row');
select results_eq(
  $$ select (j ->> 'status') from public.admin_invite_list('all', null, 100) j
     where (j ->> 'id')::uuid = (select id from tests.stash where k = 'exp') $$,
  $$ values ('expired'::text) $$,
  'and its status key agrees with the bucket it filtered into - one definition, read twice');
select results_eq(
  $$ select (select count(*)::int from public.admin_invite_list('pending', null, 100)),
            (select count(*)::int from public.admin_invite_list('redeemed', null, 100)),
            (select count(*)::int from public.admin_invite_list('revoked', null, 100)),
            (select count(*)::int from public.admin_invite_list('expired', null, 100)) $$,
  $$ values (2, 2, 1, 1) $$,
  'the four buckets now partition the six invites exactly: 2 pending, 2 redeemed, 1 revoked, 1 expired, summing to the six that exist - so no row falls into two buckets or none');

-- =====================================================================
-- The audit trail
-- =====================================================================
-- Read as the superuser: admin_actions' own policy is gated on
-- community.analytics.view, which a coach does not hold, so an
-- authenticated count would read 0 for the wrong reason.
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions where action_type = 'invite_created' $$,
  $$ values (6) $$,
  'one invite_created audit row per successful create, and none for any of the six refusals');
select results_eq(
  $$ select count(*)::int from public.admin_actions where action_type = 'invite_revoked' $$,
  $$ values (1) $$,
  'exactly one invite_revoked row: the idempotent second revoke deliberately did not write a duplicate, because re-revoking is not a new act');
select results_eq(
  $$ select count(distinct target_type)::int, min(target_type) from public.admin_actions
     where action_type in ('invite_created', 'invite_revoked') $$,
  $$ values (1, 'invite'::text) $$,
  'every one of them targets `invite`');
select results_eq(
  $$ select count(*)::int from public.admin_actions a
     where a.action_type = 'invite_created'
       and a.target_id in (select id from public.invites)
       and a.after_data ? 'role' and a.after_data ? 'label' and a.after_data ? 'expires_at' $$,
  $$ values (6) $$,
  'each create row points at a real invite id and records role, label and expires_at in after_data');
select results_eq(
  $$ select admin_id = tests.uid('coach') from public.admin_actions
     where action_type = 'invite_revoked' $$,
  $$ values (true) $$,
  'and the revoke is attributed to the coach who did it');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'invite_created' and admin_id = tests.uid('coach') $$,
  $$ values (1) $$,
  'the coach''s one create is attributed to the coach, not to the function owner - log_admin_action reads auth.uid(), which a definer function does not change');

-- The new labels really are in the CHECK, so a typo cannot invent a third.
select throws_ok(
  $$ insert into public.admin_actions (admin_id, action_type, target_type)
     values (tests.uid('admin'), 'invite_deleted', 'invite') $$,
  '23514', null,
  'admin_actions.action_type is a closed list - an unlisted invite label is refused');
select throws_ok(
  $$ insert into public.admin_actions (admin_id, action_type, target_type)
     values (tests.uid('admin'), 'invite_created', 'invitation') $$,
  '23514', null,
  'and so is an unlisted target_type');

-- =====================================================================
-- The generator is not client-callable; the RPCs are definer
-- =====================================================================
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.invite_generate_code()', 'execute'),
            has_function_privilege('anon', 'public.invite_generate_code()', 'execute') $$,
  $$ values (false, false) $$,
  'invite_generate_code is granted to no client role: it has no auth check of its own, so the grant is the gate and admin_invite_create is the only caller');
select results_eq(
  $$ select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and p.proname in ('admin_invite_create', 'admin_invite_list', 'admin_invite_revoke') $$,
  $$ values (3) $$,
  'all three RPCs are security definer - the deliberate crossing of the zero-grant boundary on invites, and the only reason they need elevation');

select * from finish();
rollback;
