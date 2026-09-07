-- 202609060026 and 202609060027: the two follow-ups to fbf5a43.
--
-- fbf5a43 turned the weekly-challenge comparison_key field from a free-text
-- box into a <select> and added two client checks (shape, and "does this name
-- something real"). Neither is a boundary: weekly_challenges is INSERT-able
-- and UPDATE-able over PostgREST by any holder of community.challenge.create,
-- so one HTTP call still stored a key that can never match a post - which is
-- how the six rows the UX audit found got there.
--
-- This file pins the half a database CAN enforce (shape, on every writer, on
-- INSERT and on UPDATE), the fact that it is VALIDATED rather than trusted,
-- what happened to the rows that violated it, and that club_summary() now
-- carries the key so the client does not have to read the table twice to find
-- out whether the challenge is real.
--
-- It deliberately does NOT assert that the key names a real movement or WOD.
-- That catalog is client-side and Postgres cannot see it; see the assertion
-- at the end of section 1, which pins that limit so nobody later reads this
-- constraint as more than it is.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. The constraint exists, is validated, and is exactly the client's
-- =====================================================================
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.weekly_challenges'::regclass
     and conname = 'weekly_challenges_comparison_key_shape'),
  'CHECK ((comparison_key ~ ''^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$''::text))',
  'the CHECK is byte-for-byte cloud.js COMPARISON_KEY_SHAPE_RE - if the client regex ever moves, this assertion is where the two are forced back together');
select is(
  (select convalidated from pg_constraint
   where conrelid = 'public.weekly_challenges'::regclass
     and conname = 'weekly_challenges_comparison_key_shape'),
  true,
  'and it is VALIDATED, not NOT VALID - the existing rows were dealt with rather than exempted, so a reader can trust every row in the table and not just the new ones');
select is_empty(
  $$ select id from public.weekly_challenges
     where comparison_key !~ '^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$' $$,
  'and no row in the live table violates it');

-- =====================================================================
-- 2. THE VECTOR: the exact insert the picker cannot stop
-- =====================================================================
-- A <select> is an affordance. This is the same call made without one, which
-- is what a coach with the network tab open, a stale cached bundle, or any
-- other REST client makes.
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('סקוואט אחורי', 'אתגר הסקוואט', current_date, current_date + 3, tests.uid('coach')) $$,
  '23514',
  null,
  'THE FIX: the literal key the UX audit found - a movement NAME typed into the old free-text box - is now refused by the database for a coach who holds community.challenge.create');
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('back squat', 'Back squat week', current_date, current_date + 3, tests.uid('coach')) $$,
  '23514',
  null,
  'and so is the English equivalent - the rule is the shape, not the alphabet');

-- The near misses, one per way a hand-written key goes wrong. Each of these
-- was accepted before this migration and each produces a challenge no post
-- can ever match.
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('movement:back-squat', 'Missing metric', current_date, current_date + 3, tests.uid('coach')) $$,
  '23514', null, 'a missing metric segment is refused');
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('movement:back-squat:1rm', 'Wrong metric', current_date, current_date + 3, tests.uid('coach')) $$,
  '23514', null, 'a metric that is not est1rm or duration is refused - publishWorkout() writes est1rm, so 1rm matches nothing');
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('movement:Back-Squat:est1rm', 'Cased id', current_date, current_date + 3, tests.uid('coach')) $$,
  '23514', null, 'an upper-cased movement id is refused - the ids in src/constants.js are lower-case and text equality is what the leaderboard join uses');
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('wod:fran:time:RX', 'Cased rx', current_date, current_date + 3, tests.uid('coach')) $$,
  '23514', null, 'and so is an upper-cased Rx marker');
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('wod:fran:time', 'Missing rx', current_date, current_date + 3, tests.uid('coach')) $$,
  '23514', null, 'a WOD key with no rx/scaled marker is refused - publishWorkout() always writes one');
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('movement:back-squat:est1rm ', 'Trailing space', current_date, current_date + 3, tests.uid('coach')) $$,
  '23514', null, 'a trailing space is refused - it is invisible in a form field and fatal to a text-equality join');
-- The one real portability risk between a JavaScript regex and a POSIX one:
-- in JS, `$` without the m flag matches only the very end of the input, so
-- "key\n" fails. Postgres regexes are newline-insensitive by default and
-- behave the same way - asserted rather than assumed, because if it did not,
-- the database would be laxer than the client it claims to mirror.
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values (E'movement:back-squat:est1rm\n', 'Trailing newline', current_date, current_date + 3, tests.uid('coach')) $$,
  '23514', null, 'and so is a trailing newline - Postgres `$` is end-of-string here, exactly as the JS regex is without the m flag');

-- =====================================================================
-- 3. What the constraint accepts - it must never refuse the picker
-- =====================================================================
-- Every one of these is a key the shipped <select> can produce. A constraint
-- stricter than the client would break challenge creation for a real coach,
-- which is a worse failure than the one being fixed.
select lives_ok(
  $$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
     values ('40880000-0000-4000-8000-000000000001', 'movement:back-squat:est1rm', 'Squat week', current_date, current_date + 3, tests.uid('coach')) $$,
  'movement:<id>:est1rm, the commonest key the picker offers, is accepted');
select lives_ok(
  $$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
     values ('40880000-0000-4000-8000-000000000002', 'movement:row-500m:duration', 'Row week', current_date + 10, current_date + 13, tests.uid('coach')) $$,
  'so is the duration metric, with digits in the movement id');
select lives_ok(
  $$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
     values ('40880000-0000-4000-8000-000000000003', 'wod:fran:time:rx', 'Fran week', current_date + 20, current_date + 23, tests.uid('coach')) $$,
  'and both WOD forms - wod:<id>:<scoretype>:rx ...');
select lives_ok(
  $$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
     values ('40880000-0000-4000-8000-000000000004', 'wod:cindy:amrap:scaled', 'Cindy week', current_date + 30, current_date + 33, tests.uid('coach')) $$,
  '... and :scaled, with the amrap score type');
-- A custom WOD's id is uid("customwod") -> "customwod-<lower-case uuid>",
-- which the picker offers and which therefore must pass.
select lives_ok(
  $$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
     values ('40880000-0000-4000-8000-000000000005',
             'wod:customwod-6f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d:time:rx', 'Custom week', current_date + 40, current_date + 43, tests.uid('coach')) $$,
  'including a custom WOD id (uid("customwod") produces "customwod-<lower-case uuid>") - the picker offers these, so the database must not be the thing that refuses them');

-- =====================================================================
-- 4. UPDATE is covered too, which is where the client has no say at all
-- =====================================================================
-- 202609060005 granted UPDATE so a coach could fix a typo. Nothing in the
-- client validates that path: setWeeklyChallenge() only ever INSERTs.
select throws_ok(
  $$ update public.weekly_challenges set comparison_key = 'סקוואט אחורי'
     where id = '40880000-0000-4000-8000-000000000001' $$,
  '23514',
  null,
  'a good row cannot be UPDATEd into a bad one - the client has no validation on this path at all, since setWeeklyChallenge() only ever inserts');
select lives_ok(
  $$ update public.weekly_challenges set comparison_key = 'movement:front-squat:est1rm'
     where id = '40880000-0000-4000-8000-000000000001' $$,
  'while a correction to another well-formed key still goes through - the UPDATE grant 202609060005 added is not taken away');

-- An admin is no more exempt than a coach. A CHECK has no notion of role,
-- which is the point: this is a data-integrity rule, not a permission.
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('anything', 'Admin week', current_date + 50, current_date + 53, tests.uid('admin')) $$,
  '23514', null, 'an admin is refused identically - a CHECK has no notion of role, and the rule is about the data being usable, not about trust');

-- =====================================================================
-- 5. THE LIMIT, pinned deliberately
-- =====================================================================
-- The other half of the client's check - "does this key name something the
-- app actually has" - cannot be enforced here and is NOT enforced here. The
-- movement and WOD catalog lives in src/constants.js and in each device's
-- own custom WODs; there is no table to join. This row is well-shaped, dead,
-- and accepted, and cloud.js challengeKeyExists() remains the only thing
-- standing between it and the club home.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
     values ('40880000-0000-4000-8000-000000000009', 'movement:not-a-real-lift:est1rm', 'Ghost week', current_date + 60, current_date + 63, tests.uid('coach')) $$,
  'THE LIMIT: a well-shaped key naming a movement that does not exist is ACCEPTED. The database cannot check the client-side catalog and this constraint does not pretend to - challengeKeyExists() in cloud.js is still the only check for that half, and removing it because "the database validates it now" would reopen the original defect');

-- =====================================================================
-- 6. The rows that had to move before the constraint could be validated
-- =====================================================================
select has_table('public', 'weekly_challenges_archive', 'the archive exists...');
select is(
  (select relrowsecurity from pg_class where oid = 'public.weekly_challenges_archive'::regclass),
  true,
  '...with RLS enabled...');
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'weekly_challenges_archive'),
  1,
  '...and a policy, so it is not a table that exists with no way in');
select ok(
  has_table_privilege('authenticated', 'public.weekly_challenges_archive', 'select'),
  'authenticated may SELECT it (the policy narrows that to community.challenge.create)...');
select ok(
  not has_table_privilege('authenticated', 'public.weekly_challenges_archive', 'insert')
  and not has_table_privilege('authenticated', 'public.weekly_challenges_archive', 'update')
  and not has_table_privilege('authenticated', 'public.weekly_challenges_archive', 'delete'),
  '...and can never write it - it is written by migrations only, so a client cannot forge or erase the record of a removal');
select ok(
  not has_table_privilege('anon', 'public.weekly_challenges_archive', 'select'),
  'and anon cannot read it at all');

-- A stand-in for what the migration moved, so the read rules can be
-- exercised on a clean database as well as on the audit one.
select tests.clear_auth();
insert into public.weekly_challenges_archive
  (id, comparison_key, title, starts_on, ends_on, created_by, created_at, archived_by_migration, archived_reason)
values ('40880000-0000-4000-8000-0000000000a1', 'סקוואט אחורי', 'אתגר הסקוואט',
        current_date - 3, current_date + 3, tests.uid('coach'), now() - interval '1 day',
        '202609060026', 'test fixture standing in for a row the migration moved');

select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select title from public.weekly_challenges_archive where id = '40880000-0000-4000-8000-0000000000a1' $$,
  $$ values ('אתגר הסקוואט'::text) $$,
  'a community.challenge.create holder can read what was removed - title, key and dates survive whole, so restoring a row is an insert with a corrected key, not a retype from memory');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select id from public.weekly_challenges_archive $$,
  'while a plain member sees nothing - the archive is a staff record of a staff action');

-- =====================================================================
-- 7. club_summary() no longer forces a second read
-- =====================================================================
-- Before 202609060027 the active_challenge object carried {id, title, source,
-- ends_at} and no key, so loadWeeklyChallenge() re-selected the same row from
-- weekly_challenges on every club-home render purely to find out whether the
-- challenge was joinable.
select tests.clear_auth();
delete from public.weekly_challenges where id <> '40880000-0000-4000-8000-000000000001';
select tests.set_auth(tests.uid('m1'));
select is(
  (public.club_summary() -> 'active_challenge' ->> 'source'), 'weekly',
  'with no Phase-2 challenge active, club_summary falls back to the weekly row as it always has...');
select is(
  (public.club_summary() -> 'active_challenge' ->> 'comparison_key'), 'movement:front-squat:est1rm',
  '...and now returns its comparison_key, which is the whole point: the caller can decide whether the challenge is joinable without a second read of weekly_challenges');
select is(
  (public.club_summary() -> 'active_challenge' ->> 'id'), '40880000-0000-4000-8000-000000000001',
  'the id is unchanged...');
select is(
  (public.club_summary() -> 'active_challenge' ->> 'ends_at'), (current_date + 3)::text,
  '...and so is ends_at, so an existing reader of this JSON is unaffected - the change is purely additive');
select is(
  (public.club_summary() -> 'active_challenge' ->> 'starts_at'), current_date::text,
  'starts_at is added beside it, so the object now carries every column the second read selected and that read can go away entirely rather than merely shrink');
-- The key is a content identifier, not member data, and every member can
-- already select it straight off the table. A member seeing it here is
-- therefore not new exposure - asserted so the "should this be staff-only"
-- question is answered by the schema rather than re-litigated.
select isnt_empty(
  $$ select comparison_key from public.weekly_challenges where id = '40880000-0000-4000-8000-000000000001' $$,
  'and a plain member can read the same key directly off the table anyway (weekly_challenges_read, 202609060011), so returning it here exposes nothing new');

-- The Phase-2 branch: no key, because public.challenges has no such column.
-- Null there means "this challenge kind needs no key", NOT "invalid" - a
-- caller that treats it as invalid would hide a real challenge.
select tests.clear_auth();
insert into public.challenges (id, title, description, challenge_type, metric_type, status, start_at, end_at, target_value, created_by)
values ('40880000-0000-4000-8000-0000000000b1', 'Phase 2 challenge', 'x', 'individual_target', 'meters', 'active',
        now() - interval '1 day', now() + interval '2 days', 1000, tests.uid('coach'));
select tests.set_auth(tests.uid('m1'));
select is(
  (public.club_summary() -> 'active_challenge' ->> 'source'), 'challenge',
  'a Phase-2 challenge still wins over the weekly fallback, unchanged...');
select ok(
  (public.club_summary() -> 'active_challenge' -> 'comparison_key') = 'null'::jsonb,
  '...and its comparison_key is JSON null, because public.challenges has no such column. The key is present-and-null rather than absent so a caller can tell the two branches apart on `source` and must not read this null as "invalid" - doing so would hide a perfectly real challenge');
select is(
  (public.club_summary() -> 'active_challenge' ->> 'title'), 'Phase 2 challenge',
  'and the rest of that branch is untouched');

select * from finish();
rollback;
