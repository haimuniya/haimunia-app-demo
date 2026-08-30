-- COMM-220 / COMM-221 / COMM-222: real behavioural coverage for
-- 202608290011 (weekly_recaps, onboarding_progress, and the MEMBER_JOINED
-- seeding trigger).
--
-- Boundaries, weekly_recaps: own-row read and nothing else. A member reads
-- their own recap, reads nothing of another member's, and gets 42501 on
-- insert, update, and delete of their OWN row - there is no client write
-- path at all, only service_role. anon sees nothing.
--
-- Behaviour, weekly_recaps: a real service_role insert succeeds through the
-- actual grants (this is the first table a service-role caller writes
-- directly rather than through a definer function, so it also proves the
-- default_club_id() grant this migration added - without it every
-- recap_weekly insert would 42501 on the club_id default). A minimal
-- insert produces the honest quiet-week shape rather than nulls. The unique
-- (user_id, week_start) key rejects a duplicate outright and carries the
-- on-conflict upsert that makes recap_weekly idempotent: a rerun for a week
-- already generated updates in place and the member still has exactly one
-- row. A non-Monday week_start is refused, because a key on a free-form
-- date would let two runs disagree about where the week starts and both
-- insert.
--
-- Boundaries and behaviour, onboarding_progress: a row is seeded for every
-- member the instant their invite_redemptions row lands, and only then - a
-- member has no insert grant, so they cannot invent a fresh row to re-see a
-- step, and no delete grant either. The member reads and updates their own
-- row, cannot touch another's, and cannot move their own row onto another
-- member's id. A stamp is one-way: once set it cannot be cleared or moved,
-- and a repeat write is a silent no-op rather than an error (COMM-222 wants
-- a failed dismiss-write to retry quietly). An UPDATE to invite_redemptions
-- - what grant_coach_role does - does not re-seed or reset progress.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- weekly_recaps: the service-role write path is the only write path
-- =====================================================================
-- service_role is what recap_weekly runs as. Not the bootstrap superuser:
-- superuser would sail past a missing grant and tell us nothing about
-- whether the Edge Function can actually write this table.
select pg_catalog.set_config('role', 'service_role', true);

select lives_ok(
  $$ insert into public.weekly_recaps (user_id, week_start, sessions_completed, streak)
     values ('aaaaaaaa-0000-4000-8000-000000000001', date '2026-08-24', 4, 3) $$,
  'service_role inserts a recap directly, no definer function in between');

select results_eq(
  $$ select club_id from public.weekly_recaps
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and week_start = date '2026-08-24' $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid) $$,
  'the club_id default resolved for service_role - default_club_id() is executable by it');

-- --- the quiet-week shape -------------------------------------------
select lives_ok(
  $$ insert into public.weekly_recaps (user_id, week_start)
     values ('aaaaaaaa-0000-4000-8000-000000000002', date '2026-08-24') $$,
  'a member with no activity still gets a row');
select results_eq(
  $$ select sessions_completed, streak, prs, achievements, challenge_progress,
            club_challenge_progress, upcoming_event
     from public.weekly_recaps
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000002' and week_start = date '2026-08-24' $$,
  $$ values (0, 0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, null::jsonb) $$,
  'the quiet week is zeros and empty lists, not nulls - the client renders it without guessing');

-- --- the unique key actually rejects a duplicate --------------------
select throws_ok(
  $$ insert into public.weekly_recaps (user_id, week_start, sessions_completed)
     values ('aaaaaaaa-0000-4000-8000-000000000001', date '2026-08-24', 99) $$,
  '23505',
  null,
  'a second row for the same member and week is rejected by the unique key');

-- --- which is what makes the rerun idempotent -----------------------
select lives_ok(
  $$ insert into public.weekly_recaps (user_id, week_start, sessions_completed, streak, generated_at)
     values ('aaaaaaaa-0000-4000-8000-000000000001', date '2026-08-24', 5, 4, now())
     on conflict (user_id, week_start) do update set
       sessions_completed = excluded.sessions_completed,
       streak = excluded.streak,
       generated_at = excluded.generated_at $$,
  'a rerun for an already-generated week upserts instead of failing');
select results_eq(
  $$ select count(*)::int, max(sessions_completed), max(streak) from public.weekly_recaps
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values (1, 5, 4) $$,
  'the rerun updated in place: still exactly one row, carrying the new figures');

-- --- week_start must be the Monday of an ISO week -------------------
select throws_ok(
  $$ insert into public.weekly_recaps (user_id, week_start)
     values ('aaaaaaaa-0000-4000-8000-000000000003', date '2026-08-23') $$,
  '23514',
  null,
  'a Sunday week_start is refused - the idempotency key is only meaningful if every run agrees where the week starts');
select lives_ok(
  $$ insert into public.weekly_recaps (user_id, week_start)
     values ('aaaaaaaa-0000-4000-8000-000000000003', date '2026-08-17') $$,
  'an earlier Monday is accepted, so past weeks are browsable');

-- =====================================================================
-- weekly_recaps: the client boundary
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select count(*)::int from public.weekly_recaps $$,
  $$ values (1) $$,
  'member A sees exactly their own one recap and nothing else in the table');
select isnt_empty(
  $$ select 1 from public.weekly_recaps
     where user_id = tests.uid('m1') and week_start = date '2026-08-24' $$,
  'member A reads their own recap');
select is_empty(
  $$ select 1 from public.weekly_recaps where user_id = tests.uid('m2') $$,
  'member A cannot read member B''s recap - refused by RLS, not by client logic');

select throws_ok(
  $$ insert into public.weekly_recaps (user_id, week_start, sessions_completed)
     values (tests.uid('m1'), date '2026-08-10', 40) $$,
  '42501',
  null,
  'a member cannot insert a recap for themselves - a generated summary is not a self-reported claim');
select throws_ok(
  $$ update public.weekly_recaps set sessions_completed = 40 where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'a member cannot inflate their own recap before sharing it to the feed');
select throws_ok(
  $$ delete from public.weekly_recaps where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'a member cannot delete their own recap row');

-- anon does not get an empty result, it gets a permission error: the
-- revoke means the table is not reachable at all rather than reachable and
-- filtered.
select pg_catalog.set_config('role', 'anon', true);
select throws_ok(
  $$ select 1 from public.weekly_recaps $$,
  '42501',
  null,
  'anon cannot reach weekly_recaps at all');
select throws_ok(
  $$ select 1 from public.onboarding_progress $$,
  '42501',
  null,
  'anon cannot reach onboarding_progress at all');

-- =====================================================================
-- onboarding_progress: seeded at MEMBER_JOINED, never by a client
-- =====================================================================
select tests.clear_auth();

-- The fixture redemptions in rls_helpers.sql each fired the trigger.
select results_eq(
  $$ select count(*)::int from public.onboarding_progress op
     join public.invite_redemptions ir on ir.user_id = op.user_id $$,
  $$ select count(*)::int from public.invite_redemptions $$,
  'every redeemed member already has an onboarding row - the trigger seeded it, nobody had to ask');
select results_eq(
  $$ select welcomed_at, first_week_shown_at, first_month_shown_at
     from public.onboarding_progress where user_id = tests.uid('m1') $$,
  $$ values (null::timestamptz, null::timestamptz, null::timestamptz) $$,
  'a seeded row starts with every step unshown');

-- A brand-new member redeeming right now gets a row on the spot.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-0000000000f1',
        'authenticated', 'authenticated', 'newjoiner@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now());
select is_empty(
  $$ select 1 from public.onboarding_progress where user_id = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  'an auth user who has not redeemed yet has no onboarding row - signing up is not joining');
insert into public.invite_redemptions (user_id, invite_id, role)
values ('aaaaaaaa-0000-4000-8000-0000000000f1', '11111111-2222-4333-8444-555555555555', 'member');
select isnt_empty(
  $$ select 1 from public.onboarding_progress where user_id = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  'the redemption itself seeded the row, before the profile even exists');

-- =====================================================================
-- onboarding_progress: the client boundary
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select isnt_empty(
  $$ select 1 from public.onboarding_progress where user_id = tests.uid('m1') $$,
  'member A reads their own onboarding row');
select results_eq(
  $$ select count(*)::int from public.onboarding_progress $$,
  $$ values (1) $$,
  'member A sees only their own onboarding row');
select is_empty(
  $$ select 1 from public.onboarding_progress where user_id = tests.uid('m2') $$,
  'member A cannot read member B''s onboarding row');

select throws_ok(
  $$ insert into public.onboarding_progress (user_id) values (tests.uid('m1')) $$,
  '42501',
  null,
  'a member cannot insert an onboarding row for themselves - that is how a step gets re-seen');
select throws_ok(
  $$ delete from public.onboarding_progress where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'a member cannot delete their own onboarding row either - delete-then-reinsert is the same hole');

-- --- marking a step seen ---------------------------------------------
select lives_ok(
  $$ update public.onboarding_progress set welcomed_at = now() where user_id = tests.uid('m1') $$,
  'member A marks the welcome step seen on their own row');
select isnt_empty(
  $$ select 1 from public.onboarding_progress where user_id = tests.uid('m1') and welcomed_at is not null $$,
  'the welcome stamp stuck');

-- capture it, to prove the next two writes cannot move it
select welcomed_at as welcomed_first from public.onboarding_progress where user_id = tests.uid('m1') \gset

select lives_ok(
  $$ update public.onboarding_progress set welcomed_at = null where user_id = tests.uid('m1') $$,
  'clearing a stamp is not an error - a benign repeat write retries silently rather than shouting at a new member');
select results_eq(
  format($$ select (welcomed_at = %L::timestamptz) from public.onboarding_progress
            where user_id = tests.uid('m1') $$, :'welcomed_first'),
  $$ values (true) $$,
  'but the stamp did not actually clear - a step shown once cannot be re-shown');

select lives_ok(
  $$ update public.onboarding_progress set welcomed_at = now() + interval '1 day' where user_id = tests.uid('m1') $$,
  'a second mark-seen write is accepted');
select results_eq(
  format($$ select (welcomed_at = %L::timestamptz) from public.onboarding_progress
            where user_id = tests.uid('m1') $$, :'welcomed_first'),
  $$ values (true) $$,
  'and it did not move the stamp - two tabs marking the same step seen is one stamp, not a race');

-- --- a later step is still settable ----------------------------------
select lives_ok(
  $$ update public.onboarding_progress set first_week_shown_at = now() where user_id = tests.uid('m1') $$,
  'dismissing the welcome step early does not block the first-week step from being marked later');
select isnt_empty(
  $$ select 1 from public.onboarding_progress
     where user_id = tests.uid('m1') and first_week_shown_at is not null and first_month_shown_at is null $$,
  'the first-week stamp is set and the first-month one is untouched');

-- --- another member's row is out of reach -----------------------------
select lives_ok(
  $$ update public.onboarding_progress set first_month_shown_at = now() where user_id = tests.uid('m2') $$,
  'a write aimed at member B''s row is not an error, it simply matches nothing');
select tests.clear_auth();
select results_eq(
  $$ select first_month_shown_at from public.onboarding_progress where user_id = tests.uid('m2') $$,
  $$ values (null::timestamptz) $$,
  'member B''s row was not touched - member A cannot burn another member''s onboarding');

-- --- and the row cannot be moved onto another member ------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.onboarding_progress set user_id = tests.uid('m2') where user_id = tests.uid('m1') $$,
  'an attempt to re-key the row onto member B is accepted and pinned back');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.onboarding_progress where user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'member A''s row is still member A''s');
select results_eq(
  $$ select welcomed_at is null from public.onboarding_progress where user_id = tests.uid('m2') $$,
  $$ values (true) $$,
  'and member B''s row was not overwritten by it');

-- =====================================================================
-- a redemption UPDATE does not re-seed or reset
-- =====================================================================
-- grant_coach_role() and grant_coach_role_by_handle() both UPDATE
-- invite_redemptions and move redeemed_at. The trigger is INSERT-only, so
-- neither hands a member their onboarding back.
update public.invite_redemptions set role = 'coach', redeemed_at = now() where user_id = tests.uid('m1');
select results_eq(
  $$ select count(*)::int from public.onboarding_progress where user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'promoting a member to coach did not create a second onboarding row');
select results_eq(
  format($$ select (welcomed_at = %L::timestamptz) from public.onboarding_progress
            where user_id = tests.uid('m1') $$, :'welcomed_first'),
  $$ values (true) $$,
  'and it did not reset the steps they have already seen');

-- =====================================================================
-- the seeding function is not client-callable
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.seed_onboarding_progress() $$,
  '42501',
  null,
  'seed_onboarding_progress is not executable by authenticated - the only caller is the trigger');

select * from finish();
rollback;
