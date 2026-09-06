-- Launch-readiness audit, finding 2 (202609060002). community_streaks now
-- applies the privacy toggles every sibling leaderboard surface applies.
--
-- THE VECTOR THIS FILE REPRODUCES, verified live before the fix: a member
-- switches visible_to_club, in_leaderboards AND show_attendance all off and
-- is still fully readable through this view - handle, display name, streak
-- length and a raw last_activity_on date - by any authenticated caller. The
-- view is deliberately not security_invoker (it has to aggregate past
-- activity_pings' owner-only RLS), which is exactly why it has to re-apply
-- every rule by hand, and it only ever re-applied two of them.
--
-- THE ONE DELIBERATE ASYMMETRY, asserted below rather than left to the
-- migration comment: show_attendance gates the last_activity_on COLUMN, not
-- the row. It is the only raw per-day date here and it defaults to FALSE,
-- while visible_to_club and in_leaderboards default to true; gating the row
-- on it would empty the view for the whole club for a toggle whose subject
-- (verified class attendance) this view's source - activity_pings, days the
-- member opened the app - does not expose.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0068-4000-8000-000000000001',
        'authenticated', 'authenticated', 'ghost68@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

-- m2 has a live three-day run ending today. m1 has one day, so the view has
-- something to show for the caller as well as for the subject.
insert into public.activity_pings (user_id, activity_date) values
  (tests.uid('m2'), current_date),
  (tests.uid('m2'), current_date - 1),
  (tests.uid('m2'), current_date - 2),
  (tests.uid('m1'), current_date);

-- =====================================================================
-- 1. The view is still a definer view
-- =====================================================================
-- If it ever becomes security_invoker it stops being able to aggregate
-- activity_pings at all and every number below silently becomes the
-- caller's own. Pinned here because this file's whole premise is "definer,
-- therefore it must check by hand".
select is(
  (select coalesce(array_to_string(c.reloptions, ','), '') ilike '%security_invoker%'
   from pg_catalog.pg_class c where c.oid = 'public.community_streaks'::regclass),
  false,
  'community_streaks is still NOT security_invoker - it aggregates past activity_pings'' owner-only RLS, which is why it re-applies every access rule itself');

-- =====================================================================
-- 2. The default club: visible, with the raw date withheld
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is(
  (select current_streak from public.community_streaks where user_id = tests.uid('m2')), 3,
  'with the shipped defaults a member still reads another member''s streak length - visible_to_club and in_leaderboards both default to true, so the fix costs the club nothing');
select is(
  (select last_activity_on from public.community_streaks where user_id = tests.uid('m2')), null,
  'but NOT the raw last_activity_on date: show_attendance defaults to false, and that date is the piece 202608270001 kept out of activity_pings'' own RLS and routed through the admin-gated coach_inactive_members() instead');
select is(
  (select last_activity_on from public.community_streaks where user_id = tests.uid('m1')), current_date,
  'while the caller reads their OWN date unconditionally');

-- =====================================================================
-- 3. show_attendance, opted in
-- =====================================================================
select tests.clear_auth();
update public.profiles set show_attendance = true where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is(
  (select last_activity_on from public.community_streaks where user_id = tests.uid('m2')), current_date,
  'a member who opts into show_attendance publishes the date, which is what the toggle means everywhere else in the module');
select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('m2');

-- =====================================================================
-- 4. THE HOLE, one toggle at a time
-- =====================================================================
select tests.clear_auth();
update public.profiles set in_leaderboards = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select user_id from public.community_streaks where user_id = tests.uid('m2') $$,
  'in_leaderboards off removes the member from the view entirely - this view IS a board, and contracts.md already calls that column "the real, server-enforced opt-out" for exactly this figure');
select tests.set_auth(tests.uid('m2'));
select is(
  (select current_streak from public.community_streaks where user_id = tests.uid('m2')), 3,
  'and it still never hides them from themselves, the same rule feed_leaderboard follows');
select tests.clear_auth();
update public.profiles set in_leaderboards = true where id = tests.uid('m2');

update public.profiles set visible_to_club = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select user_id from public.community_streaks where user_id = tests.uid('m2') $$,
  'visible_to_club off removes them too, on its own');
select tests.clear_auth();
update public.profiles set visible_to_club = true where id = tests.uid('m2');

-- =====================================================================
-- 5. THE HOLE, exactly as the audit found it: all three off
-- =====================================================================
select tests.clear_auth();
update public.profiles
set visible_to_club = false, in_leaderboards = false, show_attendance = false
where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select user_id, handle, display_name, current_streak, last_activity_on
     from public.community_streaks where user_id = tests.uid('m2') $$,
  'THE FIX: a member who opted out of all three is now unreadable through this view - before 202609060002 this returned their handle, display name, streak and raw last-activity date to any authenticated caller');
select tests.set_auth(tests.uid('m2'));
select is(
  (select last_activity_on from public.community_streaks where user_id = tests.uid('m2')), current_date,
  'and even then they still read their own row and their own date');

-- An admin does not get to override this one. can_view_profile_field()
-- short-circuits to true for an admin, which is why the raw columns are
-- tested as well: an admin's rank governs what THEY may see, never what the
-- club may be told. Same reasoning member_of_week_candidate_set spells out.
select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select user_id from public.community_streaks where user_id = tests.uid('m2') $$,
  'not even an admin reads an opted-out member here - the raw columns are checked alongside can_view_profile_field precisely so the admin short-circuit cannot decide this');
select tests.clear_auth();
update public.profiles
set visible_to_club = true, in_leaderboards = true, show_attendance = false
where id = tests.uid('m2');

-- ...but an admin DOES get the raw date for a member who is otherwise
-- visible, through can_view_profile_field's own admin branch. That is the
-- documented staff path to raw activity dates and it must keep working.
select tests.set_auth(tests.uid('admin'));
select is(
  (select last_activity_on from public.community_streaks where user_id = tests.uid('m2')), current_date,
  'while an admin still reads the raw date of a visible member, which is the staff path coach_inactive_members() also serves');

-- =====================================================================
-- 6. The anonymous read gate reaches this view too
-- =====================================================================
select tests.set_auth('aaaaaaaa-0068-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from public.community_streaks), 0,
  'a ghost session - a real authenticated JWT with no profile and no redemption - reads nothing here either; 202608270002 revoked the anon ROLE, which an anonymous SESSION is not');

-- =====================================================================
-- 7. What did not change
-- =====================================================================
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select user_id from public.community_streaks where user_id = tests.uid('m2') $$,
  'the explicit block check from 202608270001 is still there and still cuts in both directions');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m1') and blocked_id = tests.uid('m2');

update public.profiles set deleted_at = now() where id = tests.uid('m3');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select user_id from public.community_streaks where user_id = tests.uid('m3') $$,
  'and so is the soft-delete check');
select tests.clear_auth();
update public.profiles set deleted_at = null where id = tests.uid('m3');

select tests.set_auth(tests.uid('m1'));
select is(
  (select current_streak from public.community_streaks where user_id = tests.uid('m3')), 0,
  'a member with no pings is still 0 rather than absent, so "never active" and "streak broken" read the same way they always did');

-- The raw rows behind the aggregate are still private, which is the whole
-- reason this view is definer in the first place.
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select activity_date from public.activity_pings where user_id = tests.uid('m2') $$,
  'and the per-day rows the streak is computed from are still unreadable directly - the aggregate crossing that boundary is what the view is for');

select * from finish();
rollback;
