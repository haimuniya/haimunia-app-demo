-- COMM-020: real two-user RLS enforcement for 202608280011
-- (coach_engagement_flags).
-- The single most important assertion in the handoff: the flagged member
-- can never read their own row, even when that member is themselves a coach
-- or an admin. Staff read and write rows about other members. A plain
-- non-staff member reads nothing at all.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- flags about a plain member, a coach, and an admin
select tests.clear_auth();
insert into public.coach_engagement_flags (user_id, level) values
  (tests.uid('m1'),    'mild'),
  (tests.uid('coach'), 'significant'),
  (tests.uid('admin'), 'inactive');

-- --- the flagged member never reads their own row --------------
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.coach_engagement_flags where user_id = tests.uid('m1') $$,
  'a flagged plain member cannot read their own flag');

select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.coach_engagement_flags where user_id = tests.uid('coach') $$,
  'a flagged coach cannot read their own flag even through the staff branch');
select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags where user_id <> tests.uid('coach') $$,
  $$ values (2) $$,
  'staff read flags about other members');

select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select 1 from public.coach_engagement_flags where user_id = tests.uid('admin') $$,
  'a flagged admin cannot read their own flag');
select results_eq(
  $$ select count(*)::int from public.coach_engagement_flags where user_id <> tests.uid('admin') $$,
  $$ values (2) $$,
  'an admin reads flags about other members');

-- --- staff write about others, never about self --------------
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.coach_engagement_flags (user_id, level)
     values (tests.uid('m2'), 'mild') $$,
  'staff can flag another member');
select throws_ok(
  $$ insert into public.coach_engagement_flags (user_id, level)
     values (tests.uid('coach'), 'mild') $$,
  '42501',
  null,
  'staff cannot insert a flag about themselves');
select is_empty(
  $$ with u as (
       update public.coach_engagement_flags set status = 'dismissed'
       where user_id = tests.uid('coach') returning id
     ) select id from u $$,
  'staff cannot update their own flag (self-exclusion in USING)');
select results_eq(
  $$ with u as (
       update public.coach_engagement_flags set status = 'reviewed'
       where user_id = tests.uid('m1') returning id
     ) select count(*)::int from u $$,
  $$ values (1) $$,
  'staff can update a flag about another member');

-- --- a plain non-staff member reads nothing -----------------
select tests.set_auth(tests.uid('m3'));
select is_empty(
  $$ select 1 from public.coach_engagement_flags $$,
  'a plain non-staff member reads nothing from coach_engagement_flags');

select * from finish();
rollback;
