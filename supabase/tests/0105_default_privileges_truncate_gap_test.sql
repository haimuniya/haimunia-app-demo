-- Security hunt, round 9 (202609120008): 202608270002's default-privilege
-- lockdown named only SELECT/INSERT/UPDATE/DELETE, so every table created
-- afterward silently re-inherited TRUNCATE/REFERENCES/TRIGGER/MAINTAIN for
-- anon and authenticated - none of those are gated by RLS at all (RLS only
-- applies to the four DML operations), so this was a real way to
-- TRUNCATE TABLE admin_actions or role_permissions with nothing to stop
-- it. This proves both that the gap is closed on every existing table AND
-- that the default-privileges guard actually applies to a table created
-- fresh after this migration, not just a one-time cleanup - the whole
-- point of 202608270002's own "close it for good" framing, and exactly
-- the framing this migration's own gap slipped through.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- No existing public table grants any of the four gap privileges to
-- anon or authenticated.
select is_empty(
  $$ select c.relname, r.rolname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('anon'), ('authenticated')) as r(rolname)
     where n.nspname = 'public' and c.relkind = 'r'
       and (
         has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
         or has_table_privilege(r.rolname, c.oid, 'REFERENCES')
         or has_table_privilege(r.rolname, c.oid, 'TRIGGER')
         or has_table_privilege(r.rolname, c.oid, 'MAINTAIN')
       ) $$,
  'no public table grants TRUNCATE, REFERENCES, TRIGGER or MAINTAIN to anon or authenticated');

-- The empirical repro from the hunt itself, now refused.
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ truncate table public.admin_actions $$,
  '42501',
  null,
  'authenticated can no longer truncate the audit log');
select throws_ok(
  $$ truncate table public.role_permissions $$,
  '42501',
  null,
  'authenticated can no longer truncate the entire RBAC matrix');

select tests.clear_auth();
set local role anon;
select throws_ok(
  $$ truncate table public.invite_redemptions $$,
  '42501',
  null,
  'anon can no longer truncate invite_redemptions');
reset role;
select tests.clear_auth();

-- The default-privileges guard itself, not just a cleanup of what already
-- existed: a table created fresh, right here, after the migration ran,
-- must not re-inherit the gap privileges either.
create table public.hunt_0105_throwaway (id uuid primary key default gen_random_uuid());
select is_empty(
  $$ select r.rolname
     from (values ('anon'), ('authenticated')) as r(rolname)
     where has_table_privilege(r.rolname, 'public.hunt_0105_throwaway', 'TRUNCATE')
        or has_table_privilege(r.rolname, 'public.hunt_0105_throwaway', 'REFERENCES')
        or has_table_privilege(r.rolname, 'public.hunt_0105_throwaway', 'TRIGGER')
        or has_table_privilege(r.rolname, 'public.hunt_0105_throwaway', 'MAINTAIN')
        or has_table_privilege(r.rolname, 'public.hunt_0105_throwaway', 'SELECT') $$,
  'a table created after this migration does not re-inherit any of the closed default privileges, TRUNCATE or the original four DML ones');

-- Sequences get the same structural guard, proven the same way (none
-- exist in this schema today - all tables use UUID primary keys - so
-- this is entirely about the default, not an existing leak).
create sequence public.hunt_0105_throwaway_seq;
select is_empty(
  $$ select r.rolname
     from (values ('anon'), ('authenticated')) as r(rolname)
     where has_sequence_privilege(r.rolname, 'public.hunt_0105_throwaway_seq', 'USAGE')
        or has_sequence_privilege(r.rolname, 'public.hunt_0105_throwaway_seq', 'SELECT')
        or has_sequence_privilege(r.rolname, 'public.hunt_0105_throwaway_seq', 'UPDATE') $$,
  'a sequence created after this migration does not inherit any default privilege for anon or authenticated');

-- Sanity check the fix is scoped correctly: it must not have touched the
-- four DML privileges real tables still explicitly grant - an existing,
-- already-tested RLS-gated read must still work exactly as before.
select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.profiles where id = tests.uid('m1') $$,
  'authenticated can still SELECT via RLS as before - this migration only removed the four extra, RLS-blind privileges');

select * from finish();
rollback;
