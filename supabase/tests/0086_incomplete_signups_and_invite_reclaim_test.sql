-- Five-persona UX audit, defect 3 (202609060023). Ghost accounts are
-- visible, and the invite they are holding is reclaimable.
--
-- WHAT WAS BROKEN. Signup is two-stage: redeem_invite_code() consumes the
-- invite, and the profiles row is written only after a three-slide carousel.
-- Abandon the carousel and what is left is a real authenticated account with
-- a spent invite and NO profiles row - which makes it invisible to every
-- roster surface in the module, because all of them start `from
-- public.profiles`, and untouchable by purge_abandoned_profiles(), because
-- that job requires the account to have NEVER redeemed.
--
-- The first assertion below is the shape of the hole itself, so the file
-- fails loudly if a future change makes a ghost visible some other way and
-- these functions become redundant.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- Two ghosts, one per invite type.
--
-- ghost1: redeemed the SHARED code 20 days ago, got as far as choosing a
-- username (so auth.users.email carries the synthetic address the app mints)
-- and then abandoned the carousel.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '40850000-0000-4000-8000-000000000001',
        'authenticated', 'authenticated', 'dana_cohen@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now() - interval '20 days', now(), true);
insert into public.invite_redemptions (user_id, invite_id, role, redeemed_at)
values ('40850000-0000-4000-8000-000000000001', '11111111-2222-4333-8444-555555555555',
        'member', now() - interval '20 days');

-- ghost2: redeemed a PER-PERSON invite 9 days ago and never even set
-- credentials, so the invite's own label is the only identifying string that
-- exists anywhere for them.
insert into auth.users (instance_id, id, aud, role, encrypted_password, created_at, updated_at, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '40850000-0000-4000-8000-000000000002',
        'authenticated', 'authenticated',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now() - interval '9 days', now(), true);
insert into public.invites (id, code_hash, role, label, redeemed_at, redeemed_by)
values ('40850000-0000-4000-8000-00000000000a', repeat('b', 64), 'member',
        'דנה מהבוקר של שני', now() - interval '9 days', '40850000-0000-4000-8000-000000000002');
insert into public.invite_redemptions (user_id, person_invite_id, role, redeemed_at)
values ('40850000-0000-4000-8000-000000000002', '40850000-0000-4000-8000-00000000000a',
        'member', now() - interval '9 days');

-- ghost3: redeemed 20 minutes ago. Someone who is on slide two RIGHT NOW.
insert into auth.users (instance_id, id, aud, role, encrypted_password, created_at, updated_at, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '40850000-0000-4000-8000-000000000003',
        'authenticated', 'authenticated',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), true);
insert into public.invite_redemptions (user_id, invite_id, role, redeemed_at)
values ('40850000-0000-4000-8000-000000000003', '11111111-2222-4333-8444-555555555555',
        'member', now() - interval '20 minutes');

update public.invite_codes set use_count = 5 where id = '11111111-2222-4333-8444-555555555555';

-- =====================================================================
-- 0. The hole, stated as a test
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select is(
  (select count(*)::int from public.admin_member_roster(null, 100)
    where id in ('40850000-0000-4000-8000-000000000001', '40850000-0000-4000-8000-000000000002')),
  0,
  'THE DEFECT: three accounts hold spent invites and the member roster shows none of them - every roster surface starts `from public.profiles`, and these have no profiles row');

select tests.clear_auth();
select is(
  ((select public.purge_abandoned_profiles(1)) ->> 'checked')::int, 0,
  'and purge_abandoned_profiles() correctly refuses to touch them either: it requires an account that NEVER redeemed, which is exactly what these did');

-- =====================================================================
-- 1. admin_incomplete_signups() makes them visible and identifiable
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::int from public.admin_incomplete_signups(null, 100)
    where user_id::text like '40850000%'), 3,
  'all three unfinished signups are listed - a coach may browse them, the same read-only rank admin_member_roster grants');
select is(
  (select username from public.admin_incomplete_signups(null, 100)
    where user_id = '40850000-0000-4000-8000-000000000001'),
  'dana_cohen',
  'the username the member typed at signup identifies the first one, taken from the local part of the synthetic login address');
select is(
  (select label from public.admin_incomplete_signups(null, 100)
    where user_id = '40850000-0000-4000-8000-000000000002'),
  'דנה מהבוקר של שני',
  'and the per-person invite''s own label identifies the second, who never got as far as a username');
select is(
  (select invite_source from public.admin_incomplete_signups(null, 100)
    where user_id = '40850000-0000-4000-8000-000000000002'),
  'person_invite',
  'the list says which kind of invite is being held, because reclaiming the two is not the same operation');
select ok(
  (select stalled_days >= 19 from public.admin_incomplete_signups(null, 100)
    where user_id = '40850000-0000-4000-8000-000000000001'),
  'and how long it has been stuck');

-- A real email is never handed to staff, only this app's synthetic one.
select tests.clear_auth();
update auth.users set email = 'someone@example.com'
 where id = '40850000-0000-4000-8000-000000000003';
select tests.set_auth(tests.uid('coach'));
select is(
  (select username from public.admin_incomplete_signups(null, 100)
    where user_id = '40850000-0000-4000-8000-000000000003'),
  null,
  'an address that is NOT the synthetic <username>@members.haimuniya.invalid form returns null - a real login address is not roster data');

-- A soft-deleted member is a removed member, not an unfinished signup.
select tests.clear_auth();
update public.profiles set deleted_at = now() where id = tests.uid('m3');
select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::int from public.admin_incomplete_signups(null, 100)
    where user_id = tests.uid('m3')), 0,
  'a soft-deleted profile is NOT reported here: that row exists and admin_member_roster already owns it, so this surface must not double-report a removal as an abandoned signup');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.admin_incomplete_signups(null, 25) $$,
  'P0001', 'not authorized',
  'a plain member cannot read the list at all');

-- =====================================================================
-- 2. Who may reclaim
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.admin_reclaim_invite('40850000-0000-4000-8000-000000000001') $$,
  'P0001', 'not authorized',
  'a coach may SEE an unfinished signup and may not un-member it - reclaiming takes a real admin, the same rank admin_remove_member takes');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.admin_reclaim_invite(tests.uid('m2')) $$,
  'P0001', 'member has a profile',
  'a real member is refused by name: they finished signup, and admin_remove_member is the function for removing them');
select throws_ok(
  $$ select public.admin_reclaim_invite('40850000-0000-4000-8000-000000000003') $$,
  'P0001', 'signup is still in progress',
  'and so is someone who redeemed twenty minutes ago and may be on slide two right now');
select throws_ok(
  $$ select public.admin_reclaim_invite('40850000-0000-4000-8000-000000000003', null, 0) $$,
  'P0001', 'signup is still in progress',
  'THE FLOOR: p_older_than_days is clamped to at least 1, so no caller can shorten the grace period to zero');
select throws_ok(
  $$ select public.admin_reclaim_invite(tests.uid('admin')) $$,
  'P0001', 'cannot reclaim your own invite',
  'and an admin cannot start by reclaiming their own - checked before the profile test, so the message names the real reason');

-- =====================================================================
-- 3. The shared code gets its use back
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_reclaim_invite('40850000-0000-4000-8000-000000000001',
                                        'לא השלימ/ה הרשמה, שוחרר לשימוש חוזר') $$,
  'an admin reclaims the shared-code ghost''s invite');
select tests.clear_auth();
select is(
  (select use_count from public.invite_codes where id = '11111111-2222-4333-8444-555555555555'), 4,
  'the shared code''s use_count went back down by one, so the club got its seat back');
select is(
  (select count(*)::int from public.invite_redemptions
    where user_id = '40850000-0000-4000-8000-000000000001'), 0,
  'the redemption row is gone, so the account is no longer a member');

-- =====================================================================
-- 4. The per-person invite goes back to pending, and the SAME code works
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_reclaim_invite('40850000-0000-4000-8000-000000000002', null, 3) $$,
  'and the per-person one');
select tests.clear_auth();
select is(
  (select public.invite_status(revoked_at, redeemed_at, expires_at, now())
     from public.invites where id = '40850000-0000-4000-8000-00000000000a'),
  'pending',
  'THE POINT: the invite reads as pending again through invite_status(), the same function admin_invite_list labels rows with - so it reappears on the invite screen as outstanding and the same code can be handed out or used again');

-- =====================================================================
-- 5. What it must NOT do
-- =====================================================================
select is(
  (select count(*)::int from auth.users where id::text like '40850000%'), 3,
  'NO auth.users ROW IS DELETED. All three accounts still exist: reclaiming releases the INVITE, nothing else, and a signed-in ghost simply lands back on the invite screen');
select is(
  (select count(*)::int from public.workout_posts
    where post_type = 'POST_NEW_MEMBER'
      and (metadata ->> 'member_id') in ('40850000-0000-4000-8000-000000000001',
                                         '40850000-0000-4000-8000-000000000002')
      and deleted_at is null), 0,
  'the "joined the club" welcome posts those two redemptions produced are retracted - the club was told someone joined, and they did not');
select is(
  (select count(*)::int from public.workout_posts
    where post_type = 'POST_NEW_MEMBER'
      and (metadata ->> 'member_id') = '40850000-0000-4000-8000-000000000003'
      and deleted_at is null), 1,
  'and the one still mid-signup keeps its welcome post, because nothing was reclaimed from them');

-- =====================================================================
-- 6. It is a staff action, so it is audited like one
-- =====================================================================
select is(
  (select count(*)::int from public.admin_actions where action_type = 'invite_reclaimed'), 2,
  'both reclaims are in the audit log');
select is(
  (select note from public.admin_actions
    where action_type = 'invite_reclaimed'
      and target_user_id = '40850000-0000-4000-8000-000000000001'),
  'לא השלימ/ה הרשמה, שוחרר לשימוש חוזר',
  'with the admin''s reason, under 202609060022''s rules');
select is(
  (select before_data ->> 'invite_source' from public.admin_actions
    where action_type = 'invite_reclaimed'
      and target_user_id = '40850000-0000-4000-8000-000000000002'),
  'person_invite',
  'and enough of the prior state to undo it by hand if the reclaim was a mistake');

-- =====================================================================
-- 7. The handoff to the purge job that already exists
-- =====================================================================
-- This is the integration, not a duplicate purge: the redemption row was the
-- ONE condition keeping an empty anonymous account out of
-- purge_abandoned_profiles(). With it gone, that job - under its own
-- retention window and its own runbook - collects the account.
select is(
  ((select public.purge_abandoned_profiles(5)) ->> 'success')::int, 2,
  'purge_abandoned_profiles() now collects exactly the two reclaimed ghosts, on its own schedule and its own window - no second purge path was written');
select is(
  (select count(*)::int from auth.users
    where id = '40850000-0000-4000-8000-000000000003'), 1,
  'and leaves the one still mid-signup alone, because its redemption is still there');

select * from finish();
rollback;
