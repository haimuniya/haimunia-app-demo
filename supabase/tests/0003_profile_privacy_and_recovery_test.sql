-- COMM-020: real two-user RLS enforcement for 202608280003 (profile privacy
-- and recovery).
-- Boundaries: a self write cannot move is_admin, club_id, or
-- recovery_verified_at, and cannot stamp recovery_verified_at on insert.
-- visible_to_club=false hides a member from other members but not from self
-- or a real admin. allow_follows=false and a block edge are enforced by the
-- follows insert policy. can_view_profile_field flips per toggle, raises on
-- an unknown field, and a block edge short-circuits it before any toggle.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- a redeemed account that has not created its profile yet, and whose auth
-- row has no password and no confirmed email.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000',
        'aaaaaaaa-0000-4000-8000-0000000000f0',
        'authenticated', 'authenticated', 'fresh@members.haimuniya.invalid', now(), now());
insert into public.invite_redemptions (user_id, invite_id, role)
values ('aaaaaaaa-0000-4000-8000-0000000000f0', '11111111-2222-4333-8444-555555555555', 'member');

-- --- the protected columns cannot move on a self update -------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.profiles set is_admin = true where id = tests.uid('m1') $$,
  'a self update naming is_admin is accepted');
select is(
  (select is_admin from public.profiles where id = tests.uid('m1')),
  false,
  'the protect trigger pinned is_admin to its old value');

select lives_ok(
  $$ update public.profiles set club_id = gen_random_uuid() where id = tests.uid('m1') $$,
  'a self update naming club_id is accepted');
select is(
  (select club_id from public.profiles where id = tests.uid('m1')),
  public.default_club_id(),
  'the protect trigger pinned club_id to the seeded club');

select tests.set_auth(tests.uid('norec'));
select lives_ok(
  $$ update public.profiles set recovery_verified_at = now() where id = tests.uid('norec') $$,
  'a self update naming recovery_verified_at is accepted');
select is(
  (select recovery_verified_at from public.profiles where id = tests.uid('norec')),
  null,
  'the protect trigger kept recovery_verified_at null on a self update');

-- --- a first profile insert cannot arrive already stamped ----------
select tests.set_auth('aaaaaaaa-0000-4000-8000-0000000000f0');
select throws_ok(
  $$ insert into public.profiles (id, handle, display_name, recovery_verified_at)
     values ('aaaaaaaa-0000-4000-8000-0000000000f0', 'freshie', 'Fresh', now()) $$,
  '42501',
  null,
  'the insert policy rejects a profile row that carries recovery_verified_at');
select lives_ok(
  $$ insert into public.profiles (id, handle, display_name)
     values ('aaaaaaaa-0000-4000-8000-0000000000f0', 'freshie', 'Fresh') $$,
  'the same insert with a null recovery_verified_at is allowed');

-- --- mark_recovery_verified cannot be self-certified --------------
select throws_ok(
  $$ select public.mark_recovery_verified() $$,
  'P0001',
  'recovery method not verified',
  'mark_recovery_verified refuses an account with no password or confirmed email');

select tests.set_auth(tests.uid('norec'));
select lives_ok(
  $$ select public.mark_recovery_verified() $$,
  'mark_recovery_verified succeeds once auth.users shows a real method');
select isnt(
  (select recovery_verified_at from public.profiles where id = tests.uid('norec')),
  null,
  'mark_recovery_verified stamped the column past the protect trigger');

-- --- visible_to_club ---------------------------------------------
select tests.clear_auth();
update public.profiles set visible_to_club = false where id = tests.uid('m2');

select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.profiles where id = tests.uid('m2') $$,
  'a hidden member is invisible to another member');

select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select count(*)::int from public.profiles where id = tests.uid('m2') $$,
  $$ values (1) $$,
  'a hidden member still sees their own row');

select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select count(*)::int from public.profiles where id = tests.uid('m2') $$,
  $$ values (1) $$,
  'a hidden member is still visible to a real admin');

select tests.clear_auth();
update public.profiles set visible_to_club = true where id = tests.uid('m2');

-- --- allow_follows and block edges gate the follows insert -------
update public.profiles set allow_follows = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.follows (follower_id, followed_id)
     values (tests.uid('m1'), tests.uid('m2')) $$,
  '42501',
  null,
  'a follow targeting allow_follows=false is refused by the policy');

select tests.clear_auth();
update public.profiles set allow_follows = true where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.follows (follower_id, followed_id)
     values (tests.uid('m1'), tests.uid('m2')) $$,
  'the same follow is allowed once allow_follows is back on');

select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.follows (follower_id, followed_id)
     values (tests.uid('m1'), tests.uid('m3')) $$,
  '42501',
  null,
  'a follow across a block edge in either direction is refused by the policy');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m3') and blocked_id = tests.uid('m1');

-- --- can_view_profile_field -----------------------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.profiles set show_prs = true where id = tests.uid('m1') $$,
  'a member can flip their own show_prs toggle');
select tests.set_auth(tests.uid('m2'));
select is( public.can_view_profile_field(tests.uid('m1'), 'show_prs'), true,
  'member B sees show_prs while member A has it on' );

select tests.set_auth(tests.uid('m1'));
update public.profiles set show_prs = false where id = tests.uid('m1');
select tests.set_auth(tests.uid('m2'));
select is( public.can_view_profile_field(tests.uid('m1'), 'show_prs'), false,
  'the answer flips when member A turns show_prs off' );

select throws_ok(
  $$ select public.can_view_profile_field(tests.uid('m1'), 'show_birthday') $$,
  'P0001',
  'unknown profile field show_birthday',
  'an unknown field name raises, and there is no birthday field');

select tests.set_auth(tests.uid('m1'));
select is( public.can_view_profile_field(tests.uid('m1'), 'show_prs'), true,
  'self is always true even with the toggle off' );

select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m2'));
select is( public.can_view_profile_field(tests.uid('m1'), 'show_achievements'), false,
  'a block edge returns false before the show_achievements toggle is read' );

select * from finish();
rollback;
