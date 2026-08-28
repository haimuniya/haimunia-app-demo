-- COMM-020: real two-user RLS enforcement for 202608280013 (invite actor
-- throttle).
-- Boundaries: invite_attempts stays unreachable by any client, and
-- bump_invite_attempt is not client-callable. The behaviour that matters:
-- five wrong codes as one anonymous session, then a fresh session with the
-- same actor_key, and the sixth attempt still returns rate_limited. A wrong
-- code returns the same answer and increments the same way whether the
-- actor is new or has been guessing. An already-redeemed caller gets their
-- role back, never a throttle signal, and the function never raises.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- three sessions with no redemption yet, so redeem_invite_code() actually
-- reaches the throttle instead of returning an existing role.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'authenticated', 'authenticated', 'd1@members.haimuniya.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-0000000000d2', 'authenticated', 'authenticated', 'd2@members.haimuniya.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-0000000000d3', 'authenticated', 'authenticated', 'd3@members.haimuniya.invalid', now(), now());

-- --- the store and the bump helper are unreachable -----------
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select 1 from public.invite_attempts $$,
  '42501',
  null,
  'no client can read invite_attempts');
select throws_ok(
  $$ select public.bump_invite_attempt('x', tests.uid('m1')) $$,
  '42501',
  null,
  'bump_invite_attempt is not client-callable');

-- --- five wrong codes as session d1, sixth as session d2, same key --
select tests.set_auth('aaaaaaaa-0000-4000-8000-0000000000d1');
select is( public.redeem_invite_code('wrongcode', 'device-key-A'), 'invalid',
  'first wrong attempt on a new actor returns invalid' );
select public.redeem_invite_code('wrongcode', 'device-key-A');
select public.redeem_invite_code('wrongcode', 'device-key-A');
select public.redeem_invite_code('wrongcode', 'device-key-A');
select is( public.redeem_invite_code('wrongcode', 'device-key-A'), 'invalid',
  'fifth wrong attempt still returns invalid' );

select tests.set_auth('aaaaaaaa-0000-4000-8000-0000000000d2');
select is(
  public.redeem_invite_code('wrongcode', 'device-key-A'),
  'rate_limited',
  'the sixth attempt from a brand-new session with the same actor_key is rate_limited' );
select is(
  public.redeem_invite_code('wrongcode', 'device-key-B'),
  'invalid',
  'a fresh actor_key on that same session is not pre-limited' );

-- --- same answer and same increment for a new vs guessing actor --
select tests.set_auth('aaaaaaaa-0000-4000-8000-0000000000d3');
select is( public.redeem_invite_code('wrongcode', 'device-key-C'), 'invalid',
  'a new actor gets invalid' );
select public.redeem_invite_code('wrongcode', 'device-key-C');
select public.redeem_invite_code('wrongcode', 'device-key-C');
select public.redeem_invite_code('wrongcode', 'device-key-C');
select is( public.redeem_invite_code('wrongcode', 'device-key-C'), 'invalid',
  'the fifth guess on that key still returns invalid, no different from the first' );
select is( public.redeem_invite_code('wrongcode', 'device-key-C'), 'rate_limited',
  'the sixth guess crosses the same threshold, nothing branches on recognition' );

-- --- an already-redeemed caller gets their role back, never a signal --
select tests.set_auth(tests.uid('m1'));
select is( public.redeem_invite_code('wrongcode'), 'member',
  'the one-arg wrapper returns the existing role for a redeemed caller' );
select is( public.redeem_invite_code('wrongcode', 'device-key-A'), 'member',
  'the two-arg form does the same and never raises' );

select * from finish();
rollback;
