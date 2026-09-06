-- Launch-readiness audit, findings 5 and 6 (202609060005).
--
--   5. weekly_challenges_insert_admin checked is_staff() where every other
--      write in the challenge model checks has_perm('community.challenge.create'),
--      and the table had no UPDATE or DELETE policy at all.
--   6. challenge_participants.progress_value was directly client-writable, so
--      a member could set their own total to any number in one call - which
--      contradicts the model's own rule that the total is DERIVED from the
--      append-only challenge_progress log.
--
-- THE VECTOR FOR 6, reproduced below verbatim:
--     update public.challenge_participants set progress_value = 999999
--     where challenge_id = <mine> and user_id = auth.uid();
-- accepted before this migration, because challenge_participants_update_self
-- is `using (user_id = auth.uid() or has_perm(...))` with the identical WITH
-- CHECK and no column restriction whatsoever. 202609010005 found the same
-- thing for team_id, fixed that one column, and said in as many words that
-- progress_value and status were "a separate, pre-existing question".

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 5a. The permission sets, read off the seed rather than asserted from
--     memory - this is the whole basis of the finding
-- =====================================================================
select is(
  (select count(*)::int from public.role_permissions
   where role_code = 'staff' and permission_code = 'community.challenge.create'), 0,
  'the `staff` role does NOT hold community.challenge.create...');
select is(
  (select rank::int from public.roles where code = 'staff'), 40,
  '...while ranking 40, comfortably above is_staff()''s threshold of 20 - so the two predicates genuinely disagreed for that role, which is the divergence');
select is(
  (select count(*)::int from public.roles r
   where r.rank >= 20
     and not exists (select 1 from public.role_permissions rp
                     where rp.role_code = r.code
                       and rp.permission_code = 'community.announcement.publish')), 0,
  'and the CONTROL for the finding that was a false alarm: every seeded role of rank >= 20 holds community.announcement.publish, so announcements_insert_admin''s is_staff() gate matches its permission exactly and is deliberately left alone');

-- =====================================================================
-- 5b. weekly_challenges: insert, update, delete
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
     values ('40710000-0000-4000-8000-000000000001', 'movement:clean:est1rm', 'Coach week', current_date, current_date + 3, tests.uid('coach')) $$,
  'a coach holds community.challenge.create and still inserts');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.weekly_challenges (comparison_key, title, starts_on, ends_on, created_by)
     values ('movement:snatch:est1rm', 'Member week', current_date, current_date + 3, tests.uid('m1')) $$,
  '42501',
  null,
  'a plain member still cannot');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.weekly_challenges set title = 'Hijacked'
     where id = '40710000-0000-4000-8000-000000000001' $$,
  'a member''s UPDATE is accepted rather than raised - RLS filters, it does not error...');
select tests.clear_auth();
select is(
  (select title from public.weekly_challenges where id = '40710000-0000-4000-8000-000000000001'),
  'Coach week',
  '...and changed nothing, because weekly_challenges_update_perm requires community.challenge.create');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ delete from public.weekly_challenges where id = '40710000-0000-4000-8000-000000000001' $$,
  'and the same for a DELETE...');
select tests.clear_auth();
select isnt_empty(
  $$ select 1 from public.weekly_challenges where id = '40710000-0000-4000-8000-000000000001' $$,
  '...which also removed nothing');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.weekly_challenges set title = 'Corrected week'
     where id = '40710000-0000-4000-8000-000000000001' $$,
  'THE MISSING HALF: a community.challenge.create holder can now correct a typo...');
select tests.clear_auth();
select is(
  (select title from public.weekly_challenges where id = '40710000-0000-4000-8000-000000000001'),
  'Corrected week',
  '...for real - until this migration the table had UPDATE and DELETE grants and NO policies, so nobody, admin or owner, could fix a bad row from the app');
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ delete from public.weekly_challenges where id = '40710000-0000-4000-8000-000000000001' $$,
  'and an admin can remove one...');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.weekly_challenges where id = '40710000-0000-4000-8000-000000000001' $$,
  '...for real as well');

-- =====================================================================
-- 6. challenge_participants: the fixture
-- =====================================================================
select tests.clear_auth();
insert into public.challenges (id, title, description, challenge_type, metric_type, status, start_at, end_at, target_value, created_by)
values
  ('40710000-0000-4000-8000-000000000010', 'Row 1000m', 'x', 'individual_target', 'meters', 'active',
   now() - interval '1 day', now() + interval '7 days', 1000, tests.uid('coach')),
  ('40710000-0000-4000-8000-000000000011', 'Four weeks', 'x', 'consistency', 'sessions', 'active',
   now() - interval '1 day', now() + interval '7 days', null, tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id) values
  ('40710000-0000-4000-8000-000000000010', tests.uid('m1')),
  ('40710000-0000-4000-8000-000000000011', tests.uid('m1')),
  ('40710000-0000-4000-8000-000000000010', tests.uid('m2'));

select is(
  (select prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'challenge_participants_guard_progress'), true,
  'the progress guard is security definer, like its challenge_participants_guard_team sibling');
select is(
  (select has_function_privilege('authenticated', 'public.challenge_participants_guard_progress()', 'execute')), false,
  'and is callable by no client role');

-- =====================================================================
-- 6a. THE VECTOR: a member inflates their own progress_value
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ update public.challenge_participants set progress_value = 999999
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m1') $$,
  'P0001',
  'progress is server derived',
  'THE FIX: a member can no longer write their own progress_value - this exact statement was accepted before 202609060005 and put them straight to the top of feed_leaderboard(''progress'')');
select throws_ok(
  $$ update public.challenge_participants set progress_value = progress_value + 1
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m1') $$,
  'P0001',
  'progress is server derived',
  'and a one-point nudge is refused exactly as a six-figure one is - the rule is "not by hand", not "not too much"');

-- Not even a coach. There is no legitimate direct writer of this column at
-- all; a correction is a compensating negative delta.
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ update public.challenge_participants set progress_value = 500
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m1') $$,
  'P0001',
  'progress is server derived',
  'and neither can a community.challenge.create holder - "server-derived" that a staff role may overwrite by hand is not server-derived');

-- =====================================================================
-- 6b. The derived path still works, end to end
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('40710000-0000-4000-8000-000000000010', tests.uid('m1'), 400) $$,
  'the legitimate path - one append-only challenge_progress row - is untouched...');
select is(
  (select progress_value from public.challenge_participants
   where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m1')), 400::numeric,
  '...and challenge_progress_apply still lands it on the participant row, through the app.allow_progress_apply pin');
select lives_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('40710000-0000-4000-8000-000000000010', tests.uid('m1'), 600) $$,
  'a second contribution crosses the target...');
select is(
  (select status from public.challenge_participants
   where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m1')), 'completed',
  '...and the trigger''s own auto-completion still flips status, which the same pin has to cover');

-- The pin is transaction-local and is put back down, so the guard is live
-- again for the very next statement in the same session.
select throws_ok(
  $$ update public.challenge_participants set progress_value = 5
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m1') $$,
  'P0001',
  'progress is server derived',
  'and the pin is cleared immediately after that one UPDATE - the very next statement in the same session is refused again');

-- =====================================================================
-- 6c. status: the one legitimate direct write, and everything else
-- =====================================================================
-- logConsistencyWeekHit() (cloud.js) is the only client code that writes
-- status directly: own row, active -> completed, alongside completed_at, on a
-- consistency challenge whose required weeks it has just checked.
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.challenge_participants set status = 'completed', completed_at = now()
     where challenge_id = '40710000-0000-4000-8000-000000000011' and user_id = tests.uid('m1') $$,
  'COMM-205''s consistency self-completion still works: the member''s own row, active -> completed, with completed_at in the same statement');
select is(
  (select status from public.challenge_participants
   where challenge_id = '40710000-0000-4000-8000-000000000011' and user_id = tests.uid('m1')), 'completed',
  'and really moved - this is the one legitimate direct status write and locking it out would have broken a shipped feature');

select throws_ok(
  $$ update public.challenge_participants set status = 'active'
     where challenge_id = '40710000-0000-4000-8000-000000000011' and user_id = tests.uid('m1') $$,
  'P0001',
  'status is server derived',
  'but only in that one direction - completed -> active is refused');
select throws_ok(
  $$ update public.challenge_participants set status = 'withdrawn'
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m1') $$,
  'P0001',
  'status is server derived',
  'and so is anything else a member might reach for');
-- Somebody else's row is stopped one layer earlier, by
-- challenge_participants_update_self's own USING clause, so it is a silent
-- no-op rather than the trigger's message. Asserted because "refused" and
-- "silently filtered" look identical to a client and only one of them means
-- the guard was consulted.
select lives_ok(
  $$ update public.challenge_participants set status = 'completed'
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m2') $$,
  'completing SOMEBODY ELSE''S row raises nothing...');
select tests.clear_auth();
select is(
  (select status from public.challenge_participants
   where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m2')), 'active',
  '...because challenge_participants_update_self filters the row out before the trigger is reached - the guard narrows the self-row case, it is not what stops a cross-member write');
select tests.set_auth(tests.uid('m1'));

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.challenge_participants set status = 'withdrawn'
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m2') $$,
  'while a community.challenge.create holder administering the challenge can still move a status');

-- =====================================================================
-- 6d. What the guard did NOT change
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('40710000-0000-4000-8000-000000000011', tests.uid('m2')) $$,
  'joining is untouched - the guard is UPDATE only');
select lives_ok(
  $$ delete from public.challenge_participants
     where challenge_id = '40710000-0000-4000-8000-000000000011' and user_id = tests.uid('m2') $$,
  'and so is leaving');

-- 202609010005's team guard is still the one that answers for team_id, and
-- the two triggers do not interfere.
select tests.clear_auth();
insert into public.challenge_teams (id, challenge_id, name)
values ('40710000-0000-4000-8000-000000000020', '40710000-0000-4000-8000-000000000010', 'Reds'),
       ('40710000-0000-4000-8000-000000000021', '40710000-0000-4000-8000-000000000010', 'Blues');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.challenge_participants set team_id = '40710000-0000-4000-8000-000000000020'
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m1') $$,
  'the one-time team pick from null still goes through...');
select throws_ok(
  $$ update public.challenge_participants set team_id = '40710000-0000-4000-8000-000000000021'
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m1') $$,
  'P0001',
  'team already chosen',
  '...and a second move still hits 202609010005''s own guard, with its own message - the two triggers answer for different columns and neither swallows the other');

-- The service role is out of scope for both guards, the same way
-- challenge_participants_guard_team scopes itself.
select tests.clear_auth();
select lives_ok(
  $$ update public.challenge_participants set progress_value = 42
     where challenge_id = '40710000-0000-4000-8000-000000000010' and user_id = tests.uid('m2') $$,
  'and a non-authenticated session - the service role, a dashboard fix, a future backfill - is unaffected by either guard');

select * from finish();
rollback;
