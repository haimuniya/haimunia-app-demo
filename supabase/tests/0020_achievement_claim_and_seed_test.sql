-- COMM-020 run B: real enforcement for 202608280020 (achievement claim and
-- seed), plus 202608290002 (tenure verification).
-- Boundaries: ach_claim(p_codes) writes user_id from auth.uid() only, never
-- from the payload. A null/empty array is a no-op, not an error. 51 codes
-- raises. A code that is disabled, ATTENDANCE_RECORDED, or lacks
-- config->>'client_claimable' = 'true' is silently absent from the result
-- and writes no row, even when a valid code rides along in the same call. A
-- second claim of a non-repeatable code returns nothing the second time. A
-- member with no recovery method raises. The 31st call in 10 minutes is
-- rate limited. The seed: 27 non-attendance rows, every community/challenge
-- category row (and, distinctly, every non-club-anniversary club row) has
-- no client_claimable key so ach_claim refuses it, the four attendance rows
-- stay present (enabled since COMM-305/202608310007 gave them a producer,
-- and still refused by ach_claim on trigger_type alone), and re-running the
-- insert changes no row count
-- (the on conflict do update path). The four club-category
-- anniversary_year_* rows ARE client_claimable, but ach_claim independently
-- verifies their config->>'metric' = 'tenure_days' threshold against
-- invite_redemptions.redeemed_at rather than trusting the caller.
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
-- Enabled by 202608310007 (COMM-305), which gave them their first producer.
-- This makes the ach_claim refusal below a STRONGER assertion than it was:
-- an attendance code used to be refused twice over (disabled, and
-- ATTENDANCE_RECORDED), and could have passed on the wrong one of the two.
-- Now `enabled` is true and `client_claimable` is absent, so the only things
-- left refusing it are trigger_type and the missing key - which is what
-- COMM-305 needs proven, since these four are the one category in this
-- schema that is purely server-derived.
select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where trigger_type = 'ATTENDANCE_RECORDED' and enabled $$,
  $$ values (4) $$,
  'all four attendance rows are enabled since COMM-305, so the refusal below is no longer resting on the disabled flag');
select is_empty(
  $$ select 1 from public.achievement_definitions
     where category in ('community', 'challenge')
       and config ? 'client_claimable' $$,
  'every community and challenge category row has no client_claimable key at all, so ach_claim refuses them');
-- The four club-category anniversary_year_* rows ARE seeded
-- client_claimable = true, unlike every other community/challenge/club row.
-- That is deliberate, not a leftover gap: unlike session count, PR count,
-- week streak, or Rx count, membership tenure is not something only the
-- device can see. 202608290002 makes ach_claim independently verify any
-- config->>'metric' = 'tenure_days' code against
-- invite_redemptions.redeemed_at, a server-set timestamp, rather than
-- trusting the client's say-so. See the "tenure verification" section
-- below for that coverage.
select results_eq(
  $$ select count(*)::int from public.achievement_definitions
     where category = 'club' and config ->> 'client_claimable' = 'true' $$,
  $$ values (4) $$,
  'all four club-category anniversary rows are seeded client_claimable = true, independently verified server-side by ach_claim rather than left ungated');

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
-- tenure verification (202608290002): config->>'metric' = 'tenure_days'
-- is independently checked against invite_redemptions.redeemed_at, a
-- server-set timestamp, rather than trusted from the client the way every
-- other client_claimable metric is. anniversary_year_1's threshold is 365
-- days, anniversary_year_2's is 730.
-- =====================================================================

-- m2 redeemed their invite moments ago, in this same transaction, via the
-- rls_helpers fixture, so they are nowhere near 365 days in.
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select * from public.ach_claim(array['anniversary_year_1']) $$,
  'm2, redeemed less than a year ago, cannot claim anniversary_year_1 even though the definition is client_claimable');
select is_empty(
  $$ select 1 from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
     where ma.user_id = tests.uid('m2') and d.code = 'anniversary_year_1' $$,
  'the refused tenure claim wrote no row for m2');

-- Backdate m3's redemption to exactly 365 days ago, the anniversary_year_1
-- threshold. The check is redeemed_at <= now() - threshold days, so a
-- redemption exactly on the boundary already qualifies.
select tests.clear_auth();
update public.invite_redemptions set redeemed_at = now() - interval '365 days'
where user_id = tests.uid('m3');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.ach_claim(array['anniversary_year_1']) $$,
  'm3, redeemed exactly 365 days ago, can claim anniversary_year_1 at the >= boundary');
select results_eq(
  $$ select count(*)::int from public.member_achievements
     where user_id = tests.uid('m3')
       and achievement_id = (select id from public.achievement_definitions where code = 'anniversary_year_1') $$,
  $$ values (1) $$,
  'the boundary claim wrote exactly one member_achievements row for m3');

-- The check is metric-keyed and re-evaluated per code, not a one-time
-- grant: the same m3, still 365 days in, does not clear anniversary_year_2,
-- whose threshold is 730 days.
select is_empty(
  $$ select * from public.ach_claim(array['anniversary_year_2']) $$,
  'm3 at 365 days tenure cannot claim anniversary_year_2, whose threshold is 730 days');
select is_empty(
  $$ select 1 from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
     where ma.user_id = tests.uid('m3') and d.code = 'anniversary_year_2' $$,
  'the refused anniversary_year_2 claim wrote no row for m3');

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
