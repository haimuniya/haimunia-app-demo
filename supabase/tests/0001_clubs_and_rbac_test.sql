-- COMM-020: real two-user RLS enforcement for 202608280001 (clubs and RBAC).
-- Boundary source: docs/community/backlog.md, "Phase 0 schema handoff for qa".
-- CI is the first real run of this file. No Docker on the authoring machine,
-- so only SQL shape was checked locally.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- a plain member reads the RBAC tables --------------------------------
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select count(*)::int from public.clubs $$,
  $$ values (1) $$,
  'a plain member reads the one club row');

select isnt_empty(
  $$ select 1 from public.roles $$,
  'a plain member reads roles');

select isnt_empty(
  $$ select 1 from public.permissions $$,
  'a plain member reads permissions');

select isnt_empty(
  $$ select 1 from public.role_permissions $$,
  'a plain member reads role_permissions');

-- --- a plain member cannot write any of them ----------------------------
select throws_ok(
  $$ insert into public.clubs (name) values ('Rogue Club') $$,
  '42501',
  null,
  'a plain member cannot insert a club');

select throws_ok(
  $$ insert into public.roles (code, label, rank) values ('superuser', 'Superuser', 99) $$,
  '42501',
  null,
  'a plain member cannot invent a role');

select throws_ok(
  $$ insert into public.role_permissions (role_code, permission_code)
     values ('member', 'community.analytics.view') $$,
  '42501',
  null,
  'a plain member cannot attach a permission to their own role');

select is_empty(
  $$ with u as (
       update public.roles set rank = 99 where code = 'member' returning code
     ) select code from u $$,
  'a plain member update of roles touches zero rows');

-- --- helper resolution for a plain member ------------------------------
select is( public.has_perm('community.post.create'), true,
  'member role holds community.post.create' );
select is( public.has_perm('community.analytics.view'), false,
  'member role does not hold community.analytics.view' );
select is( public.has_perm('made.up.permission'), false,
  'has_perm is false for an unknown permission string' );
select is( public.is_staff(), false, 'a member is not staff' );
select is( public.is_admin(), false, 'a member is not admin' );

-- --- coach ------------------------------------------------------------
select tests.set_auth(tests.uid('coach'));
select is( public.is_staff(), true,  'a coach is staff' );
select is( public.is_admin(), false, 'a coach is not admin' );
select is( public.has_perm('community.challenge.create'), true,
  'coach role holds community.challenge.create' );
select is( public.has_perm('community.analytics.view'), false,
  'coach role does not hold community.analytics.view' );

-- --- admin ----------------------------------------------------------
select tests.set_auth(tests.uid('admin'));
select is( public.is_admin(), true,  'an admin resolves to is_admin' );
select is( public.is_staff(), true,  'an admin is also staff' );

-- --- owner is the only writer ------------------------------------------
select tests.set_auth(tests.uid('owner'));
select is( public.my_role_code(), 'owner', 'the owner fixture resolves to owner' );
select lives_ok(
  $$ insert into public.permissions (code, description)
     values ('community.test.playground', 'temp') $$,
  'the owner can insert a permission');
select lives_ok(
  $$ update public.roles set label = 'Member.' where code = 'member' $$,
  'the owner can update a role');
select lives_ok(
  $$ insert into public.role_permissions (role_code, permission_code)
     values ('member', 'community.test.playground') $$,
  'the owner can attach a permission to a role');

select * from finish();
rollback;
