-- Security hunt, round 8 (202609120007): profiles_guard_staff_impersonation
-- was `before update of display_name` only, so a brand-new member's FIRST
-- profile write - an INSERT, since no row exists yet to update - was never
-- checked at all, and `bio` had no equivalent guard on either insert or
-- update. This proves both gaps are closed without breaking an honest
-- first-time signup or an honest later edit.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- A brand-new person, invite-redeemed but with NO profiles row yet -
-- exactly the moment the old UPDATE-only guard could never reach.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'b1040000-0000-4000-8000-000000000001',
        'authenticated', 'authenticated', 'newmember-0104@members.haimuniya.invalid', now(), now());
insert into public.invite_redemptions (user_id, invite_id, role)
values ('b1040000-0000-4000-8000-000000000001', '11111111-2222-4333-8444-555555555555', 'member');

select tests.set_auth('b1040000-0000-4000-8000-000000000001');
select throws_ok(
  $$ insert into public.profiles (id, handle, display_name, recovery_verified_at)
     values ('b1040000-0000-4000-8000-000000000001', 'newmember_0104_a', 'מאמן דני', null) $$,
  'P0001', 'display name may not claim a staff role',
  'a brand-new member''s FIRST profile write (an insert, not an update) is checked too, not just a later edit');

select throws_ok(
  $$ insert into public.profiles (id, handle, display_name, bio, recovery_verified_at)
     values ('b1040000-0000-4000-8000-000000000001', 'newmember_0104_b', 'דנה כהן', 'מנהלת המועדון הרשמית', null) $$,
  'P0001', 'bio may not claim a staff role',
  'bio gets the same guard as display_name, insert included, and its own distinct error message');

select lives_ok(
  $$ insert into public.profiles (id, handle, display_name, bio, recovery_verified_at)
     values ('b1040000-0000-4000-8000-000000000001', 'newmember_0104_c', 'דנה כהן', 'אוהבת קרוספיט', null) $$,
  'an honest first profile insert with neither field claiming a role still works');

-- bio, update path: an existing member cannot retro-fit a staff claim
-- into bio either.
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ update public.profiles set bio = 'Club Admin here to help' where id = tests.uid('m1') $$,
  'P0001', 'bio may not claim a staff role',
  'an existing member cannot claim a staff role through bio on update');
select lives_ok(
  $$ update public.profiles set bio = 'love the 6am class' where id = tests.uid('m1') $$,
  'an honest bio update still works');

-- Real staff are still exempt, bio included (display_name's update-path
-- exemption is already covered by 0081; this is the new bio case).
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.profiles set bio = 'מאמן ותיק של המועדון' where id = tests.uid('coach') $$,
  'a real coach may describe themselves as a coach in bio too');

select * from finish();
rollback;
