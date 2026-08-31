-- COMM-307 (schema half): behavioural coverage for 202608310005,
-- public.attendance_classmates_today().
--
-- The ticket names six boundaries and every one of them gets a direct
-- assertion here rather than an indirect one:
--
--   1. A pair who BOTH logged today appear for each other, and a pair who
--      logged on DIFFERENT days do not - asserted from both sides, so the
--      "today only, no lookback" rule is proved by a member who trained
--      yesterday with show_attendance ON, where nothing but the day can be
--      doing the excluding. This is the whole distinction from COMM-302's
--      classmate_day_counts(), which would have counted that pair.
--   2. show_attendance off on a CANDIDATE excludes them, asserted by flipping
--      the toggle on an unchanged attendance_log row and watching the same
--      data go from absent to listed and back - the proof style 0039 and 0040
--      both use, because a member with no data and a member with private data
--      are different claims and only the flip can tell which one the code
--      makes.
--   3. show_attendance off on the CALLER produces an EMPTY SET - the whole
--      card, not one row - while their own attendance row still exists. That
--      is COMM-307's "off means the card never renders for them, even though
--      their own attendance is still logged and still counts elsewhere", and
--      it is the ticket's one real product decision, so it is asserted
--      explicitly rather than left to the client half.
--   4. A block edge in EITHER direction excludes the pair, whatever the day.
--   5. The caller never appears in their own results.
--   6. p_limit clamps 1..20 and defaults to 6, asserted against a pool of 27
--      eligible candidates so the upper clamp is a real cut and not "all of
--      them".
--
-- Plus the two boundaries this file draws that the ticket states as a
-- distinction rather than a rule: the admin short-circuit applies to the
-- per-candidate gate and NOT to the caller's own toggle (an admin who never
-- opted in gets an empty card like anybody else), and a static pin that the
-- function does not reach for classmate_day_counts() or any interval
-- arithmetic at all.
--
-- The caller for every substantive assertion is tests.uid('m1'), a plain
-- member. can_view_profile_field() short-circuits true for is_admin(), so a
-- privacy test run as an admin would pass whatever the toggles said and prove
-- nothing - the same reason 0034, 0039 and 0040 give for the same choice. The
-- one deliberately admin-called section says so in its own header.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures. Bootstrap superuser, so RLS and attendance_log's "no client
-- write" rule stay out of the way while the world is built. Nothing here
-- asserts anything about who may write that table - 0037 owns that end, and
-- the rows are written directly rather than through private_records because
-- what is under test is the reader, not the trigger that fills it.
--
-- recorded_at is set explicitly on every row. now() is frozen for the whole
-- transaction, so a fixture that let it default would tie every row and the
-- documented "most recently logged first" order would never be exercised.
--
--   m1    (the caller) logged today, 30 minutes ago. show_attendance ON.
--   m2    logged today, 10 minutes ago.              show_attendance ON.
--   coach logged today, 1 minute ago - the most recent, so it must come
--         first.                                     show_attendance ON.
--   m3    logged YESTERDAY and not today.            show_attendance ON, so
--         nothing but the day can exclude them. Boundary 1's fixture.
--   norec logged today, 5 minutes ago, show_attendance OFF (the column
--         default). Boundary 2's fixture.
--   admin logged today, 2 minutes ago, show_attendance OFF (the default).
--         The admin-short-circuit fixture.
--   owner no attendance at all.                      show_attendance ON.
-- =====================================================================
select tests.clear_auth();

insert into public.attendance_log (user_id, occurred_on, recorded_at) values
  (tests.uid('m1'),    current_date,     now() - interval '30 minutes'),
  (tests.uid('m2'),    current_date,     now() - interval '10 minutes'),
  (tests.uid('coach'), current_date,     now() - interval '1 minute'),
  (tests.uid('norec'), current_date,     now() - interval '5 minutes'),
  (tests.uid('admin'), current_date,     now() - interval '2 minutes'),
  (tests.uid('m3'),    current_date - 1, now() - interval '1 day');

-- show_attendance defaults to FALSE (202608280003), so this is what an
-- opted-in member looks like. norec and admin are left at the default.
update public.profiles set show_attendance = true
where id in (tests.uid('m1'), tests.uid('m2'), tests.uid('m3'),
             tests.uid('coach'), tests.uid('owner'));

-- =====================================================================
-- Reachability. Unlike classmate_day_counts() this one IS a client entry
-- point, so the grant story is the opposite of 0039's and is asserted as
-- such.
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'attendance_classmates_today'),
  true,
  'attendance_classmates_today is SECURITY DEFINER - attendance_log is own-row plus staff, so without elevation it could only ever return the caller''s own row, which is the one row it excludes');

select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.attendance_classmates_today(int)', 'execute'),
  'authenticated can execute it - it is the card''s own entry point, not an internal helper');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.attendance_classmates_today(int)', 'execute'),
  'anon cannot');
select ok(
  not pg_catalog.has_function_privilege('public', 'public.attendance_classmates_today(int)', 'execute'),
  'and neither can PUBLIC, so the default grant every new function starts with really was revoked');

select throws_ok(
  $$ select * from public.attendance_classmates_today() $$,
  'P0001',
  'not authorized',
  'a null auth.uid() raises rather than returning empty - this is an entry point, and auth.uid() is checked before anything is read');

-- =====================================================================
-- Boundary 1 and 5: who is on the card, in what order, and who is not.
--
-- The zero-argument call form is used throughout, which is also the form
-- contracts.md''s forward reference promised - the defaulted p_limit did not
-- take it away.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select item ->> 'user_id' from public.attendance_classmates_today() as t(item) $$,
  format($$ values (%L), (%L) $$, tests.uid('coach')::text, tests.uid('m2')::text),
  'exactly the two opted-in members who also logged a session today, most recently logged first - coach at one minute ago ahead of m2 at ten');

select results_eq(
  $$ select item from public.attendance_classmates_today() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  format($$ values ('{"user_id": %s, "handle": "member_b", "avatar_url": null, "display_name": "Member B"}'::jsonb) $$,
         to_json(tests.uid('m2')::text)::text),
  'four keys and no more - user_id, display_name, handle, avatar_url. Asserted as a whole-object equality so an added key fails here rather than slipping past a key-by-key check: no date, no time, no count and no streak may leave this function');

select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item)
     where item ->> 'user_id' = tests.uid('m1')::text $$,
  'the caller never appears in their own results - a member is not their own classmate');

select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item)
     where item ->> 'user_id' = tests.uid('m3')::text $$,
  'a member who trained YESTERDAY is absent, with show_attendance on, so nothing but the day is excluding them - this is the entire distinction from classmate_day_counts(), which would have counted that pair');

select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item)
     where item ->> 'user_id' = tests.uid('owner')::text $$,
  'and a member with no attendance rows at all is simply absent');

-- The same day rule read from the other side: m3 has an opted-in profile and
-- an attendance row, just not one for today, so they have no anchor and get
-- no card at all.
select tests.set_auth(tests.uid('m3'));
select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item) $$,
  'and a caller who did not log a session TODAY gets nothing, however many members did - no anchor row, no card, which the self-join does on its own rather than by a separate check');

-- =====================================================================
-- Boundary 2: show_attendance off on a CANDIDATE. The rows do not move; only
-- the toggle does.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item)
     where item ->> 'user_id' = tests.uid('norec')::text $$,
  'norec logged a session today and is not on the card, because show_attendance is off - attendance has its own privacy toggle, separate from visible_to_club, and it defaults to off');

-- Counted as the bootstrap superuser: attendance_log's select policy is
-- own-row for a member (202608310001), so an authenticated count here would
-- read 0 for the wrong reason.
select tests.clear_auth();
select is(
  (select count(*)::integer from public.attendance_log
   where user_id = tests.uid('norec') and occurred_on = current_date),
  1,
  'while their attendance row for today still exists - the toggle governs what other members may be told, never whether the member trained, and that row still counts toward their own achievements and their own leaderboard rank');

update public.profiles set show_attendance = true where id = tests.uid('norec');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select count(*)::integer from public.attendance_classmates_today() as t(item) $$,
  $$ values (3) $$,
  'flipping only that toggle, with not one attendance row added or removed, puts them on the card - so it was the privacy choice doing the hiding, not missing data');

select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('norec');
select tests.set_auth(tests.uid('m1'));

select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item)
     where item ->> 'user_id' = tests.uid('norec')::text $$,
  'and turning it back off removes them again');

-- =====================================================================
-- Boundary 3: show_attendance off on the CALLER. The whole card, not a row.
--
-- This is COMM-307's own acceptance criterion and the file's most important
-- assertion: the gate is enforced in the function, not left to the client, so
-- it holds when the client is not asked.
-- =====================================================================
select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));

select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item) $$,
  'a caller with show_attendance off gets an EMPTY SET - not a shorter card, no card - even though two opted-in members trained today and were on it a moment ago');

select lives_ok(
  $$ select * from public.attendance_classmates_today() $$,
  'and it is empty rather than an error: the three ways to get no card - did not train, trained alone, opted out - are indistinguishable from outside, so nothing about the caller''s own setting leaks into the response shape');

select tests.clear_auth();
select is(
  (select count(*)::integer from public.attendance_log
   where user_id = tests.uid('m1') and occurred_on = current_date),
  1,
  'while the caller''s own attendance for today is still logged - opting out hides the card from them, it does not stop their session counting anywhere else');

update public.profiles set show_attendance = true where id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select count(*)::integer from public.attendance_classmates_today() as t(item) $$,
  $$ values (2) $$,
  'and flipping their own toggle back on returns the same two members on the same unchanged rows');

-- =====================================================================
-- The caller's own toggle is a DIRECT COLUMN READ, so it does not inherit
-- can_view_profile_field()'s is_admin() short-circuit. The per-candidate gate
-- does. Called as the admin on purpose - the one section in this file that
-- is, and the reason is the assertion itself.
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item) $$,
  'an admin who never opted into show_attendance gets an empty card like anybody else - the admin short-circuit exists so staff can see members'' data, not to opt an admin into a reciprocal surface they declined');

select tests.clear_auth();
update public.profiles set show_attendance = true where id = tests.uid('admin');
select tests.set_auth(tests.uid('admin'));

select results_eq(
  $$ select count(*)::integer from public.attendance_classmates_today(20) as t(item) $$,
  $$ values (4) $$,
  'and once opted in, an admin sees every member who trained today including the ones who opted out - can_view_profile_field short-circuits true for is_admin on the per-candidate gate, the module-wide behaviour of the one resolution point rather than a rule this function invents');

select isnt_empty(
  $$ select 1 from public.attendance_classmates_today(20) as t(item)
     where item ->> 'user_id' = tests.uid('norec')::text $$,
  'norec specifically, whose toggle is still off - which is what makes the count above the short-circuit and not a coincidence');

select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('admin');

-- =====================================================================
-- Boundary 4: COMM-125 block edges, in either direction. Not re-implemented
-- here - can_view_profile_field settles a block before it consults any
-- toggle, which is the same thing classmate_day_counts() and
-- people_suggestions already rely on.
-- =====================================================================
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m1'));

select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  'a member the caller blocked is never on the card, however plainly they both trained today');
select isnt_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item)
     where item ->> 'user_id' = tests.uid('coach')::text $$,
  'while the unblocked member is still there, so it is the block edge doing it and not a broken fixture');

select tests.clear_auth();
delete from public.blocks;
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));

select is_empty(
  $$ select 1 from public.attendance_classmates_today() as t(item)
     where item ->> 'user_id' = tests.uid('m2')::text $$,
  'and so is a member who blocked the caller - the edge counts in either direction');

select tests.clear_auth();
delete from public.blocks;

-- =====================================================================
-- Boundary 6: the limit. 25 extra opted-in members all logging today, so the
-- eligible pool is 27 and the 20 cap is a real cut rather than "all of them".
--
-- No invite_redemptions for these: my_role_code() is checked for the CALLER,
-- and the caller stays m1. Leaving them out also keeps the POST_NEW_MEMBER
-- trigger (202608290014) from firing 25 times for no reason.
--
-- They log two hours ago, older than every fixture member above, so they sort
-- after coach and m2 and the ordering assertion below reads across both
-- groups: recency between groups, display name inside one.
-- =====================================================================
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000',
       ('c3070000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'authenticated', 'authenticated',
       'bulk' || lpad(g::text, 2, '0') || '@members.haimuniya.invalid',
       '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()
from generate_series(1, 25) g;

insert into public.profiles (id, handle, display_name, recovery_verified_at, show_attendance)
select ('c3070000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'bulk_' || lpad(g::text, 2, '0'),
       'Bulk ' || lpad(g::text, 2, '0'),
       now(), true
from generate_series(1, 25) g;

insert into public.attendance_log (user_id, occurred_on, recorded_at)
select ('c3070000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       current_date, now() - interval '2 hours'
from generate_series(1, 25) g;

select is(
  (select count(*)::integer from public.attendance_log where occurred_on = current_date),
  30,
  'thirty members logged a session today, twenty-seven of them eligible for m1 - so every clamp below cuts something real');

select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select count(*)::integer from public.attendance_classmates_today() as t(item) $$,
  $$ values (6) $$,
  'the default is 6 - a card-sized number for COMM-115''s feed-top slot, not people_suggestions'' strip-sized 10');

select results_eq(
  $$ select item ->> 'handle' from public.attendance_classmates_today() as t(item) $$,
  $$ values ('coach_x'), ('member_b'), ('bulk_01'), ('bulk_02'), ('bulk_03'), ('bulk_04') $$,
  'ordered most recently logged first across the two groups, then by display name inside the group that ties - a total order, so the cut at p_limit is deterministic rather than whatever the plan returned');

select results_eq(
  $$ select count(*)::integer from public.attendance_classmates_today(3) as t(item) $$,
  $$ values (3) $$,
  'a smaller argument is honoured - the parameter exists so the feed agent can revisit the card-side default from the client half without a migration');

select results_eq(
  $$ select count(*)::integer from public.attendance_classmates_today(null) as t(item) $$,
  $$ values (6) $$,
  'an explicit null means the default, not zero rows and not an error');

select results_eq(
  $$ select count(*)::integer from public.attendance_classmates_today(0) as t(item) $$,
  $$ values (1) $$,
  'zero clamps up to 1 rather than returning an empty card that would look exactly like a member who trained alone');

select results_eq(
  $$ select count(*)::integer from public.attendance_classmates_today(-5) as t(item) $$,
  $$ values (1) $$,
  'and so does a negative');

select results_eq(
  $$ select count(*)::integer from public.attendance_classmates_today(50) as t(item) $$,
  $$ values (20) $$,
  'and anything above 20 clamps down to 20 - the same 1..20 range people_suggestions clamps its own limit to, fixed server-side now so the client half cannot widen it');

-- =====================================================================
-- "Today only" as a mechanical property, not a comment.
-- =====================================================================
select isnt_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'attendance_classmates_today'
       and p.prosrc like '%current_date%' $$,
  'the body reads current_date');

select is_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'attendance_classmates_today'
       and (p.prosrc like '%classmate_day_counts%'
            or p.prosrc like '%make_interval%'
            or p.prosrc like '%interval%') $$,
  'and no window arithmetic of any kind, and no call to classmate_day_counts() - COMM-307 is a genuinely simpler query than COMM-302''s signal, not that signal with a narrower window, and reusing the 60-day helper would have returned members who trained beside the caller last week and not today');

select * from finish();
rollback;
