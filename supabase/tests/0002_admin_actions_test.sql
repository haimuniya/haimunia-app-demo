-- COMM-020: real two-user RLS enforcement for 202608280002 (admin_actions).
-- Boundary: readable only by a community.analytics.view holder. No client
-- insert, update, or delete, admin included. log_admin_action not callable
-- by authenticated at all.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- one audit row, written the only way it can be: bypassing RLS as the
-- bootstrap superuser (mirrors log_admin_action running as definer).
select tests.clear_auth();
insert into public.admin_actions (admin_id, action_type, target_type, target_id)
values (tests.uid('admin'), 'role_change', 'role', tests.uid('m1'));

-- --- read boundary ----------------------------------------------------
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.admin_actions $$,
  'a plain member reads nothing from admin_actions');

select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.admin_actions $$,
  'a coach without community.analytics.view reads nothing from admin_actions');

select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select count(*)::int from public.admin_actions $$,
  $$ values (1) $$,
  'an admin (community.analytics.view holder) reads the audit row');

-- --- write boundary: closed to everyone, admin included -------------
select throws_ok(
  $$ insert into public.admin_actions (admin_id, action_type, target_type)
     values (tests.uid('admin'), 'content_hide', 'post') $$,
  '42501',
  null,
  'an admin cannot insert an audit row from the client');

select throws_ok(
  $$ update public.admin_actions set action_type = 'content_delete' $$,
  '42501',
  null,
  'an admin cannot update an audit row');

select throws_ok(
  $$ delete from public.admin_actions $$,
  '42501',
  null,
  'an admin cannot delete an audit row');

-- --- log_admin_action is not client-callable ------------------------
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.log_admin_action('role_change', 'role', null, null, null) $$,
  '42501',
  null,
  'log_admin_action is not executable by authenticated');

select * from finish();
rollback;
