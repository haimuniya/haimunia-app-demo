-- COMM-020 shared fixtures and the auth-impersonation shim for the pgTAP
-- RLS suite.
--
-- Every supabase/tests/NNNN_slug_test.sql pulls this in with:
--
--     \set rls_helpers_included true
--     \ir rls_helpers.sql
--
-- inside that file's own transaction, right after `begin;`. All fixture
-- rows and the tests.* helpers are created inside that transaction, so
-- they roll back with the test and no two files can collide.
--
-- `supabase test db` also executes this file on its own. The \if guard
-- below skips all of the SQL in that case and hand-writes one passing TAP
-- line, so the runner does not see a file with no plan.

\if :{?rls_helpers_included}

-- ---------------------------------------------------------------------------
-- The tests schema and the set_auth(uuid) shim.
-- ---------------------------------------------------------------------------

create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

-- Defensive. Supabase already grants these, but the pgTAP assertions
-- (lives_ok, throws_ok, is_empty ...) are called while a test is
-- impersonating `authenticated`, so that role needs to reach the extension
-- schema and its functions. Rolled back with the test like everything else.
grant usage on schema extensions to authenticated;
grant execute on all functions in schema extensions to authenticated;

-- set_auth(uuid): make auth.uid() and auth.role() resolve to the chosen
-- member for the rest of the current transaction.
--
-- There is deliberately no `set search_path` clause on this function. A
-- function that carries a SET clause saves and restores every GUC around
-- its body, which would undo the role switch and the jwt claims the shim
-- exists to set. Every reference in the body is pg_catalog-qualified, so
-- it needs no search_path of its own.
create or replace function tests.set_auth(p_uid uuid) returns void
language plpgsql as $fn$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', p_uid::text,
      'role', 'authenticated',
      'aud', 'authenticated'
    )::text,
    true);
  perform pg_catalog.set_config('request.jwt.claim.sub', p_uid::text, true);
  perform pg_catalog.set_config('role', 'authenticated', true);
end
$fn$;

-- clear_auth(): drop back to the bootstrap superuser to build or inspect
-- fixture rows with RLS out of the way.
create or replace function tests.clear_auth() returns void
language plpgsql as $fn$
begin
  perform pg_catalog.set_config('role', 'postgres', true);
  perform pg_catalog.set_config('request.jwt.claims', NULL, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', NULL, true);
end
$fn$;

-- uid(nickname): the fixed fixture ids, so a test reads
-- tests.set_auth(tests.uid('coach')) rather than a bare uuid literal.
create or replace function tests.uid(p_nick text) returns uuid
language sql immutable as $fn$
  select case p_nick
    when 'm1'    then 'aaaaaaaa-0000-4000-8000-000000000001'
    when 'm2'    then 'aaaaaaaa-0000-4000-8000-000000000002'
    when 'm3'    then 'aaaaaaaa-0000-4000-8000-000000000003'
    when 'norec' then 'aaaaaaaa-0000-4000-8000-00000000000e'
    when 'coach' then 'cccccccc-0000-4000-8000-000000000001'
    when 'admin' then 'dddddddd-0000-4000-8000-000000000001'
    when 'owner' then 'ffffffff-0000-4000-8000-000000000001'
  end::uuid
$fn$;

grant execute on function tests.set_auth(uuid)  to anon, authenticated, service_role;
grant execute on function tests.clear_auth()    to anon, authenticated, service_role;
grant execute on function tests.uid(text)       to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixture rows. Inserted as the bootstrap superuser, so RLS and the
-- protect_* triggers (which only fire for a real 'authenticated' request)
-- are both out of the way here.
-- ---------------------------------------------------------------------------

-- Two members, a stranger member, a member with no recovery method, a
-- coach, an admin, an owner. `on conflict do nothing` keeps the file safe
-- if the runner ever executes it standalone before a test file.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', tests.uid('m1'),    'authenticated', 'authenticated', 'm1@members.haimuniya.invalid',    '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', tests.uid('m2'),    'authenticated', 'authenticated', 'm2@members.haimuniya.invalid',    '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', tests.uid('m3'),    'authenticated', 'authenticated', 'm3@members.haimuniya.invalid',    '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', tests.uid('norec'), 'authenticated', 'authenticated', 'norec@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', tests.uid('coach'), 'authenticated', 'authenticated', 'coach@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', tests.uid('admin'), 'authenticated', 'authenticated', 'admin@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', tests.uid('owner'), 'authenticated', 'authenticated', 'owner@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, handle, display_name, recovery_verified_at)
values
  (tests.uid('m1'),    'member_a',     'Member A',           now()),
  (tests.uid('m2'),    'member_b',     'Member B',           now()),
  (tests.uid('m3'),    'member_c',     'Member C',           now()),
  (tests.uid('norec'), 'member_norec', 'No Recovery Member', null),
  (tests.uid('coach'), 'coach_x',      'Coach X',            now()),
  (tests.uid('owner'), 'owner_x',      'Owner X',            now())
on conflict (id) do nothing;

insert into public.profiles (id, handle, display_name, recovery_verified_at, is_admin)
values (tests.uid('admin'), 'admin_x', 'Admin X', now(), true)
on conflict (id) do nothing;

-- One invite code every redemption points at.
insert into public.invite_codes (id, code_hash, role, active, max_uses, use_count)
values ('11111111-2222-4333-8444-555555555555', repeat('a', 64), 'member', true, 1000, 0)
on conflict (id) do nothing;

insert into public.invite_redemptions (user_id, invite_id, role)
values
  (tests.uid('m1'),    '11111111-2222-4333-8444-555555555555', 'member'),
  (tests.uid('m2'),    '11111111-2222-4333-8444-555555555555', 'member'),
  (tests.uid('m3'),    '11111111-2222-4333-8444-555555555555', 'member'),
  (tests.uid('norec'), '11111111-2222-4333-8444-555555555555', 'member'),
  (tests.uid('coach'), '11111111-2222-4333-8444-555555555555', 'coach'),
  (tests.uid('admin'), '11111111-2222-4333-8444-555555555555', 'member'),
  (tests.uid('owner'), '11111111-2222-4333-8444-555555555555', 'owner')
on conflict (user_id) do nothing;

\else
\echo 1..1
\echo ok 1 - rls_helpers.sql is an include-only file, nothing to assert on its own
\endif
