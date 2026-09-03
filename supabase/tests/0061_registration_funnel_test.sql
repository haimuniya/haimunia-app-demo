-- COMM-375. registration_funnel (202609030006_registration_funnel.sql).
--
-- Gated like analytics_dashboard, NOT like the roster: a COACH is refused
-- here and allowed there, and both halves are asserted so the two Phase 4
-- read surfaces cannot quietly converge on one tier.
--
-- The two claims most worth pinning down, because both look like bugs when
-- first seen on a screen:
--   * redeemed CAN exceed invites_issued, and redeemed_rate CAN exceed 1,
--     in a club that mostly uses the shared code;
--   * a rate over a zero denominator is null, never 0.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

create table tests.stash (k text primary key, j jsonb, id uuid);
grant select, insert, update, delete on tests.stash to authenticated;

-- =====================================================================
-- Who may read
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.registration_funnel(current_date - 30, current_date) $$,
  'P0001', 'not authorized',
  'a plain member cannot read the funnel');
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.registration_funnel(current_date - 30, current_date) $$,
  'P0001', 'not authorized',
  'and NEITHER CAN A COACH - this is community.analytics.view or is_admin(), the same pair as analytics_dashboard, NOT the is_staff() that lets the same coach browse the roster in COMM-374');
select results_eq(
  $$ select public.has_perm('community.analytics.view'), public.is_staff() $$,
  $$ values (false, true) $$,
  'that coach really is staff and really lacks the analytics permission, so the refusal above is the gate working rather than a broken fixture');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.registration_funnel(current_date - 30, current_date) $$,
  'an admin can');
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.registration_funnel(current_date - 30, current_date) $$,
  'and an owner can');

-- =====================================================================
-- Period validation: refused, never clamped
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.registration_funnel(null, current_date) $$,
  'P0001', 'period required',
  'a null start is refused');
select throws_ok(
  $$ select public.registration_funnel(current_date, null) $$,
  'P0001', 'period required',
  'and a null end');
select throws_ok(
  $$ select public.registration_funnel(current_date, current_date - 1) $$,
  'P0001', 'period end before start',
  'an inverted period is refused rather than silently swapped');
select throws_ok(
  $$ select public.registration_funnel(current_date - 400, current_date) $$,
  'P0001', 'period exceeds 366 days',
  'and an over-long one is refused rather than clamped - a number must never be labelled with a range it was not computed over');
select lives_ok(
  $$ select public.registration_funnel(current_date - 365, current_date) $$,
  'exactly 366 days is accepted - the boundary is inclusive, matching analytics_dashboard');
select lives_ok(
  $$ select public.registration_funnel(current_date, current_date) $$,
  'and a single-day period is fine');

-- =====================================================================
-- The period block
-- =====================================================================
select results_eq(
  $$ select (public.registration_funnel('2026-01-01', '2026-01-31') -> 'period') ->> 'start',
            (public.registration_funnel('2026-01-01', '2026-01-31') -> 'period') ->> 'end',
            (public.registration_funnel('2026-01-01', '2026-01-31') -> 'period') ->> 'end_exclusive',
            (public.registration_funnel('2026-01-01', '2026-01-31') -> 'period') ->> 'days' $$,
  $$ values ('2026-01-01'::text, '2026-01-31'::text, '2026-02-01'::text, '31'::text) $$,
  'p_period_end is INCLUSIVE and the resolved half-open bound is published as end_exclusive, so a reader can see which convention produced the numbers');

-- =====================================================================
-- The response shape
-- =====================================================================
select results_eq(
  $$ select public.registration_funnel(current_date - 30, current_date)
       ?& array['period', 'shared_codes', 'per_person_invites', 'funnel'] $$,
  $$ values (true) $$,
  'the four top-level keys are present');
select results_eq(
  $$ select (public.registration_funnel(current_date - 30, current_date) -> 'shared_codes')
       ?& array['active_count', 'redemptions_in_period'] $$,
  $$ values (true) $$,
  'shared_codes carries its two keys');
select results_eq(
  $$ select (public.registration_funnel(current_date - 30, current_date) -> 'per_person_invites')
       ?& array['created_in_period', 'redeemed_in_period', 'revoked_in_period',
                'pending_now', 'expired_unredeemed_now'] $$,
  $$ values (true) $$,
  'per_person_invites carries its five');
select results_eq(
  $$ select (public.registration_funnel(current_date - 30, current_date) -> 'funnel')
       ?& array['invites_issued', 'redeemed', 'profile_completed', 'verified',
                'redeemed_rate', 'profile_completed_rate', 'verified_rate'] $$,
  $$ values (true) $$,
  'and funnel carries its seven');

-- =====================================================================
-- AGGREGATE ONLY: no uuid, no handle, no display name, anywhere
-- =====================================================================
-- Structural, the same posture 0050 holds for analytics_dashboard: the
-- whole serialised response is searched, so a future key that leaks an id
-- fails here without anyone having to think of it.
select results_eq(
  $$ select public.registration_funnel(current_date - 30, current_date)::text
       ~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' $$,
  $$ values (false) $$,
  'the entire response contains no uuid anywhere - not a member id, not an invite id, not a code id');
select results_eq(
  $$ select public.registration_funnel(current_date - 30, current_date)::text
       ~* '(member_a|coach_x|admin_x|owner_x|Member A|Coach X)' $$,
  $$ values (false) $$,
  'and no handle or display name - every value is a count, a ratio or a date');

-- =====================================================================
-- Zero denominators give null, not zero
-- =====================================================================
-- A period long before the club existed: nothing was issued, redeemed,
-- completed or verified in it.
select results_eq(
  $$ select (public.registration_funnel('2001-01-01', '2001-01-31') -> 'funnel') ->> 'invites_issued',
            (public.registration_funnel('2001-01-01', '2001-01-31') -> 'funnel') ->> 'redeemed',
            (public.registration_funnel('2001-01-01', '2001-01-31') -> 'funnel') ->> 'profile_completed',
            (public.registration_funnel('2001-01-01', '2001-01-31') -> 'funnel') ->> 'verified' $$,
  $$ values ('0'::text, '0'::text, '0'::text, '0'::text) $$,
  'an empty period reports four honest zero COUNTS');
select results_eq(
  $$ select ((public.registration_funnel('2001-01-01', '2001-01-31') -> 'funnel') -> 'redeemed_rate') = 'null'::jsonb,
            ((public.registration_funnel('2001-01-01', '2001-01-31') -> 'funnel') -> 'profile_completed_rate') = 'null'::jsonb,
            ((public.registration_funnel('2001-01-01', '2001-01-31') -> 'funnel') -> 'verified_rate') = 'null'::jsonb $$,
  $$ values (true, true, true) $$,
  'but three NULL rates, never 0 - an honest zero and an undefined rate are different claims, and the client renders the second as an em dash');

-- =====================================================================
-- Real counts against real data
-- =====================================================================
-- The fixture: one shared code, seven redemptions, seven profiles, all
-- created inside this transaction so all of them land in "today".
select tests.set_auth(tests.uid('admin'));
insert into tests.stash (k, j)
  select 'i1', public.admin_invite_create('member', 'created today', null);
insert into tests.stash (k, j)
  select 'i2', public.admin_invite_create('member', 'to be revoked', null);
insert into tests.stash (k, j)
  select 'i3', public.admin_invite_create('coach', 'still pending', null);
select public.admin_invite_revoke((select (j ->> 'id')::uuid from tests.stash where k = 'i2'));

select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'per_person_invites') ->> 'created_in_period')::int,
            ((public.registration_funnel(current_date, current_date) -> 'per_person_invites') ->> 'revoked_in_period')::int,
            ((public.registration_funnel(current_date, current_date) -> 'per_person_invites') ->> 'redeemed_in_period')::int $$,
  $$ values (3, 1, 0) $$,
  'three invites created today, one of them revoked today, none redeemed');
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'per_person_invites') ->> 'pending_now')::int,
            ((public.registration_funnel(current_date, current_date) -> 'per_person_invites') ->> 'expired_unredeemed_now')::int $$,
  $$ values (2, 0) $$,
  'two are pending now and none has expired - and these two go through the same invite_status() admin_invite_list filters on, so the dashboard and the invite screen cannot disagree');

-- Expiry moves one bucket to the other, as of now rather than as of period.
select tests.clear_auth();
update public.invites set expires_at = now() - interval '1 hour'
 where id = (select (j ->> 'id')::uuid from tests.stash where k = 'i3');
select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'per_person_invites') ->> 'pending_now')::int,
            ((public.registration_funnel(current_date, current_date) -> 'per_person_invites') ->> 'expired_unredeemed_now')::int $$,
  $$ values (1, 1) $$,
  'an expired invite moves from pending_now to expired_unredeemed_now');

-- Shared codes.
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'shared_codes') ->> 'active_count')::int,
            ((public.registration_funnel(current_date, current_date) -> 'shared_codes') ->> 'redemptions_in_period')::int $$,
  $$ values (1, 7) $$,
  'one active shared code, and the seven fixture members who joined through it counted as shared-code redemptions - identified by invite_id being non-null');

-- Deactivating drops it out of active_count but not out of the redemptions.
select lives_ok(
  $$ select public.admin_invite_code_set_active('11111111-2222-4333-8444-555555555555', false) $$,
  'the admin deactivates the shared code');
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'shared_codes') ->> 'active_count')::int,
            ((public.registration_funnel(current_date, current_date) -> 'shared_codes') ->> 'redemptions_in_period')::int $$,
  $$ values (0, 7) $$,
  'active_count drops to zero while redemptions_in_period stays at seven - the same "no retroactive effect" rule COMM-371 holds, seen from the analytics side');
select lives_ok(
  $$ select public.admin_invite_code_set_active('11111111-2222-4333-8444-555555555555', true) $$,
  'and back on');

-- =====================================================================
-- THE SHAPE THAT LOOKS LIKE A BUG AND IS NOT
-- =====================================================================
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'invites_issued')::int,
            ((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'redeemed')::int $$,
  $$ values (3, 7) $$,
  'redeemed (7) EXCEEDS invites_issued (3): invites_issued counts per-person invites only, because a shared code has no issuance event to divide by, while redeemed counts every account regardless of invite type (backlog Phase 4 open question 7)');
select results_eq(
  $$ select (((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'redeemed_rate')::numeric > 1) $$,
  $$ values (true) $$,
  'so redeemed_rate is above 1 for this club - a real shape for anyone still mostly using the shared code, not a bug, and COMM-379 should render it as one rather than clamping it');

-- The three downstream steps.
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'profile_completed')::int,
            ((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'verified')::int $$,
  $$ values (7, 6) $$,
  'seven profiles were created today and six of them verified - the norec fixture has recovery_verified_at null, which is exactly the drop-off this funnel exists to show');
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'profile_completed_rate')::numeric,
            ((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'verified_rate')::numeric $$,
  $$ values (1.0000::numeric, (round(6::numeric / 7, 4))) $$,
  'and the two downstream rates divide by the step above them, rounded to four places by analytics_ratio');

-- A soft-deleted profile still counts as having completed that step.
select tests.clear_auth();
update public.profiles set deleted_at = now() where id = tests.uid('m3');
select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'profile_completed')::int $$,
  $$ values (7) $$,
  'a member who completed their profile today and then deleted their account STILL counts - otherwise a past period''s funnel would silently rewrite itself every time somebody leaves');
select tests.clear_auth();
update public.profiles set deleted_at = null where id = tests.uid('m3');

-- =====================================================================
-- A per-person redemption lands in the right buckets
-- =====================================================================
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000d1',
        'authenticated', 'authenticated', 'd1@members.haimuniya.invalid', now(), now());

select tests.set_auth('00000000-0000-4000-8000-0000000000d1');
select results_eq(
  $$ select public.redeem_invite_code((select j ->> 'code' from tests.stash where k = 'i1'), 'device-d1') $$,
  $$ values ('member'::text) $$,
  'a new person redeems the per-person invite');

select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'per_person_invites') ->> 'redeemed_in_period')::int,
            ((public.registration_funnel(current_date, current_date) -> 'shared_codes') ->> 'redemptions_in_period')::int,
            ((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'redeemed')::int $$,
  $$ values (1, 7, 8) $$,
  'it counts once as a per-person redemption, does NOT count as a shared-code redemption, and counts once in the funnel total - the invite_id/person_invite_id partition is total and disjoint, so nothing is double counted or lost');
select results_eq(
  $$ select ((public.registration_funnel(current_date, current_date) -> 'funnel') ->> 'profile_completed')::int $$,
  $$ values (7) $$,
  'and they have NOT completed a profile yet, so the funnel shows a real one-person drop between redeemed and profile_completed');

-- =====================================================================
-- Function shape
-- =====================================================================
select tests.clear_auth();
select results_eq(
  $$ select prosecdef, provolatile = 's' from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'registration_funnel' $$,
  $$ values (true, true) $$,
  'security definer and stable, matching analytics_dashboard');
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.registration_funnel(date, date)', 'execute'),
            has_function_privilege('anon', 'public.registration_funnel(date, date)', 'execute') $$,
  $$ values (true, false) $$,
  'granted to authenticated, revoked from anon');

select * from finish();
rollback;
