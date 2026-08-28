-- COMM-020: real two-user RLS enforcement for 202608280007 (achievements).
-- Boundaries: any member reads achievement_definitions, only a real admin
-- writes them, the four attendance seeds ship disabled. member_achievements:
-- owner always reads own, another member reads a club-visible unlock only
-- when show_achievements is on and no block edge sits between them, no
-- client can insert or update, a second non-repeatable row hits the partial
-- unique index.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- achievement_definitions ---------------------------------
select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.achievement_definitions $$,
  'any member reads achievement_definitions');
select throws_ok(
  $$ insert into public.achievement_definitions (code, name, category, trigger_type)
     values ('member_invented', 'Nope', 'community', 'COMMENT_CREATED') $$,
  '42501',
  null,
  'a member cannot invent an achievement definition');
select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where code like 'attendance\_%' and enabled = false $$,
  $$ values (4) $$,
  'the four seeded attendance definitions are present and disabled');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ insert into public.achievement_definitions (code, name, category, trigger_type)
     values ('admin_made', 'Fine', 'community', 'COMMENT_CREATED') $$,
  'a real admin can insert an achievement definition');

-- --- member_achievements ------------------------------------
select tests.clear_auth();
insert into public.member_achievements (user_id, achievement_id, visibility)
select tests.uid('m1'), d.id, 'club'
from public.achievement_definitions d where d.code = 'attendance_first_class';

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.member_achievements where user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'the owner reads their own unlock');
select throws_ok(
  $$ insert into public.member_achievements (user_id, achievement_id)
     select tests.uid('m1'), d.id from public.achievement_definitions d where d.code = 'attendance_25_classes' $$,
  '42501',
  null,
  'a member cannot award themselves an achievement');

select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select count(*)::int from public.member_achievements where user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'another member reads a club-visible unlock while show_achievements is on');

select tests.clear_auth();
update public.profiles set show_achievements = false where id = tests.uid('m1');
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.member_achievements where user_id = tests.uid('m1') $$,
  'the unlock disappears for another member once show_achievements is off');

select tests.clear_auth();
update public.profiles set show_achievements = true where id = tests.uid('m1');
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('m1'));
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.member_achievements where user_id = tests.uid('m1') $$,
  'a block edge hides the unlock regardless of the toggle');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m2') and blocked_id = tests.uid('m1');

-- --- the unlock-once partial unique index ------------------
select throws_ok(
  $$ insert into public.member_achievements (user_id, achievement_id, visibility)
     select tests.uid('m1'), d.id, 'club'
     from public.achievement_definitions d where d.code = 'attendance_first_class' $$,
  '23505',
  null,
  'a second row for a non-repeatable definition hits the partial unique index');

select * from finish();
rollback;
