begin;

-- Security hunt, round 9 (2026-09-12), Supabase-config agent.
--
-- 202608270002 closed a real anon read-hole by revoking the default
-- privilege that auto-grants access to every newly created table, but it
-- only named four of the seven relevant privilege types: `revoke select,
-- insert, update, delete on tables from anon, authenticated`. Postgres's
-- own default privilege for a freshly created table also includes
-- TRUNCATE, REFERENCES, TRIGGER and (PG17+) MAINTAIN - none of those were
-- named, so every table created after that migration silently re-inherited
-- them. Confirmed live against real local Postgres:
--
--   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'r'
--     and has_table_privilege('authenticated', c.oid, 'TRUNCATE');
--
-- returned 42 of 61 public tables, including roles, permissions,
-- role_permissions (the entire RBAC model) and admin_actions (the audit
-- log) - and TRUNCATE is not gated by row level security at all (RLS only
-- applies to SELECT/INSERT/UPDATE/DELETE), so this was a real, reproducible
-- way to empirically wipe those tables that no RLS policy could ever have
-- caught. `truncate table public.admin_actions` and `truncate table
-- public.role_permissions` both succeeded live as the authenticated role
-- (run inside a rolled-back transaction; nothing was actually lost).
--
-- 202608270002's own stated intent was "anon should never have standing
-- access to anything in this schema" - this finishes that sentence rather
-- than reopening it, by naming every remaining table-level privilege
-- instead of the four DML ones. Sequences get the same structural guard
-- even though none currently exist in this schema (all tables use UUID
-- primary keys) - the same default-privilege shape would silently leak to
-- the first sequence anyone adds otherwise, for the same reason this gap
-- existed for tables.
--
-- NOT fixed here, recorded instead: a second, independent default-ACL
-- entry grants full CRUD (not just the four gap privileges above) to
-- anon/authenticated for any FUTURE table owned by supabase_admin instead
-- of postgres. Confirmed this is currently dormant (every real table here
-- is postgres-owned) but could not be closed from a migration - altering
-- another role's default privileges requires either being that role or a
-- superuser, and `postgres` (the role migrations run as) is neither for
-- supabase_admin, confirmed live: `alter default privileges for role
-- supabase_admin ...` as postgres raises "permission denied to change
-- default privileges". Whoever owns the Supabase project dashboard access
-- would need to run that ALTER directly as supabase_admin (or avoid ever
-- creating an app table through a path that makes supabase_admin its
-- owner, e.g. via the Studio table editor) - out of reach for this repo's
-- migration history to enforce.

revoke truncate, references, trigger, maintain on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, references, trigger, maintain on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

commit;
