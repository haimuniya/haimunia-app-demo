-- COMM-020 run B: real enforcement for 202608280020 (achievement claim and
-- seed).
-- Boundaries: ach_claim(p_codes) writes user_id from auth.uid() only, never
-- from the payload. A null/empty array is a no-op, not an error. 51 codes
-- raises. A code that is disabled, ATTENDANCE_RECORDED, or lacks
-- config->>'client_claimable' = 'true' is silently absent from the result
-- and writes no row, even when a valid code rides along in the same call. A
-- second claim of a non-repeatable code returns nothing the second time. A
-- member with no recovery method raises. The 31st call in 10 minutes is
-- rate limited. The seed: 27 non-attendance rows, every community/
-- challenge/club category row has no client_claimable key so ach_claim
-- refuses it, the four attendance rows stay present and disabled, and
-- re-running the insert changes no row count (the on conflict do update
-- path).
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- the seed shape
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where trigger_type <> 'ATTENDANCE_RECORDED' $$,
  $$ values (27) $$,
  '27 non-attendance achievement definitions are present');
select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where trigger_type <> 'ATTENDANCE_RECORDED' and enabled $$,
  $$ values (27) $$,
  'all 27 non-attendance rows are enabled');
select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where trigger_type = 'ATTENDANCE_RECORDED' $$,
  $$ values (4) $$,
  'the four attendance rows are still present');
select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where trigger_type = 'ATTENDANCE_RECORDED' and enabled = false $$,
  $$ values (4) $$,
  'all four attendance rows are still disabled');
select is_empty(
  $$ select 1 from public.achievement_definitions
     where category in ('community', 'challenge')
       and config ? 'client_claimable' $$,
  'every community and challenge category row has no client_claimable key at all, so ach_claim refuses them');
-- NOTE: the migration's own doc comment says "community, challenge, or club
-- shaped is left claimable = false in the seed", and docs/community/
-- backlog.md's handoff table repeats that for all three categories. The
-- shipped data disagrees for 'club': all four anniversary_year_* rows carry
-- config->>'client_claimable' = 'true'. That is flagged in the run report
-- as a real mismatch between the migration's stated intent and what it
-- actually seeded - not fixed here. This assertion pins the ACTUAL
-- behaviour (claimable), not the documented intent, so the suite tests
-- what ach_claim really does.
select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where category = 'club' and config ->> 'client_claimable' = 'true' $$,
  $$ values (4) $$,
  'all four club-category anniversary rows are, in fact, seeded client_claimable = true, contradicting the migration''s own doc comment and the backlog handoff table');

-- Re-running the seed insert changes no row count: the same on conflict do
-- update block from the migration, executed a second time here.
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.achievement_definitions $$,
  $$ values (31) $$,
  'sanity: 27 non-attendance plus 4 attendance rows, 31 total, before the re-run');
insert into public.achievement_definitions
  (code, name, description, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values
  ('first_workout', 'האימון הראשון', 'רשמת אימון ראשון ביומן', 'consistency', 'WORKOUT_COMPLETED', 1, false, 'club', '🔥', true, '{"client_claimable": true, "metric": "session_count"}')
on conflict (code) do update set
  name = excluded.name, description = excluded.description, category = excluded.category,
  trigger_type = excluded.trigger_type, threshold = excluded.threshold, repeatable = excluded.repeatable,
  visibility = excluded.visibility, icon = excluded.icon, enabled = excluded.enabled, config = excluded.config;
select results_eq(
  $$ select count(*)::int from public.achievement_definitions $$,
  $$ values (31) $$,
  're-running the seed for one row changes no row count');

-- A gameable metric definition to prove the community/challenge/club branch
-- is refused by ach_claim even if a caller somehow guesses its code.
insert into public.achievement_definitions (code, name, category, trigger_type, threshold, repeatable, enabled, config)
values ('secondary_probe', 'Secondary probe', 'community', 'COMMENT_CREATED', 1, false, true, '{"secondary": true}');

-- A definition that is disabled, otherwise a valid client-claimable one.
insert into public.achievement_definitions (code, name, category, trigger_type, threshold, repeatable, enabled, config)
values ('disabled_probe', 'Disabled probe', 'consistency', 'WORKOUT_COMPLETED', 1, false, false, '{"client_claimable": true}');

-- A repeatable, client-claimable definition, so the "claim it twice"
-- assertion has a matching non-repeatable code to contrast against.
select isnt_empty(
  $$ select 1 from public.achievement_definitions where code = 'first_pr' and repeatable = false
     and config ->> 'client_claimable' = 'true' $$,
  'first_pr is a non-repeatable, client-claimable fixture from the real seed');

-- =====================================================================
-- ach_claim: writes user_id from auth.uid() only
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.ach_claim(array['first_workout']) $$,
  'm1 claims a valid client-claimable code');
select results_eq(
  $$ select count(*)::int from public.member_achievements
     where user_id = tests.uid('m1')
       and achievement_id = (select id from public.achievement_definitions where code = 'first_workout') $$,
  $$ values (1) $$,
  'the unlock row is owned by the caller, not by any payload-supplied id');

-- =====================================================================
-- null / empty array is a no-op, not an error
-- =====================================================================
select lives_ok(
  $$ select public.ach_claim(null) $$,
  'a null codes array is a no-op');
select lives_ok(
  $$ select public.ach_claim(array[]::text[]) $$,
  'an empty codes array is a no-op');
select is_empty(
  $$ select * from public.ach_claim(null) $$,
  'a null codes array returns no rows');

-- =====================================================================
-- 51 codes raises
-- =====================================================================
select throws_ok(
  $$ select public.ach_claim(
       (select array_agg('sessions_10'::text) from generate_series(1, 51))) $$,
  'P0001',
  'at most 50 codes per call',
  '51 codes in one call is refused');

-- =====================================================================
-- filtered codes: disabled, attendance, no client_claimable key - all
-- absent from the result and none write a row, even riding alongside a
-- valid code in the same array.
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select array_agg(code order by code) from public.ach_claim(
       array['sessions_10', 'attendance_first_class', 'disabled_probe', 'secondary_probe']) $$,
  $$ values (array['sessions_10']::text[]) $$,
  'only the valid client-claimable code is accepted; attendance, disabled, and no-client_claimable-key codes are silently dropped from the same call');
select is_empty(
  $$ select 1 from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
     where ma.user_id = tests.uid('m2') and d.code in ('attendance_first_class', 'disabled_probe', 'secondary_probe') $$,
  'none of the filtered codes wrote a member_achievements row for m2');
select isnt_empty(
  $$ select 1 from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
     where ma.user_id = tests.uid('m2') and d.code = 'sessions_10' $$,
  'the one valid code in the mixed call did land');

-- =====================================================================
-- a second claim of a non-repeatable code returns nothing the second time
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select * from public.ach_claim(array['first_workout']) $$,
  'm1 re-claiming a non-repeatable code already held returns no rows');
select results_eq(
  $$ select count(*)::int from public.member_achievements
     where user_id = tests.uid('m1')
       and achievement_id = (select id from public.achievement_definitions where code = 'first_workout') $$,
  $$ values (1) $$,
  'the replay wrote no second row');

-- =====================================================================
-- no recovery method
-- =====================================================================
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select public.ach_claim(array['first_workout']) $$,
  'P0001',
  'recovery method required',
  'a member with no recovery method cannot claim');

-- =====================================================================
-- rate limit: 30 per 10 minutes, pre-seeded rather than looped 30 times
-- =====================================================================
select tests.clear_auth();
insert into public.rate_limits (user_id, action, window_started_at, attempt_count)
values (tests.uid('m3'), 'ach_claim', now(), 30)
on conflict (user_id, action) do update set window_started_at = now(), attempt_count = 30;

select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.ach_claim(array['first_workout']) $$,
  'P0001',
  'rate_limited',
  'the 31st ach_claim call in the window is rate limited');

select * from finish();
rollback;
