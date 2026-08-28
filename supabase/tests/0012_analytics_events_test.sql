-- COMM-020: real two-user RLS enforcement for 202608280012 (analytics_events).
-- Boundaries: insert own-row or a null user_id. Read only by a
-- community.analytics.view holder, and specifically NOT by the member who
-- wrote the row. A props payload over 4 KB is rejected by the trigger. No
-- update or delete path.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- insert boundary ----------------------------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.analytics_events (user_id, event_name)
     values (tests.uid('m1'), 'community.feed_open') $$,
  'a member inserts an analytics row for their own user_id');
select lives_ok(
  $$ insert into public.analytics_events (user_id, event_name)
     values (null, 'community.invite_view') $$,
  'a member inserts an analytics row with a null user_id');
select throws_ok(
  $$ insert into public.analytics_events (user_id, event_name)
     values (tests.uid('m2'), 'community.spoofed') $$,
  '42501',
  null,
  'a member cannot insert an analytics row under another user_id');

-- --- read boundary ----------------------------------------
select is_empty(
  $$ select 1 from public.analytics_events $$,
  'the member who wrote the rows cannot read them back');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.analytics_events $$,
  'a coach without community.analytics.view reads nothing');
select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select count(*)::int from public.analytics_events $$,
  $$ values (2) $$,
  'a community.analytics.view holder reads the analytics rows');

-- --- 4 KB props cap --------------------------------------
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.analytics_events (user_id, event_name, props)
     values (tests.uid('m1'), 'community.big', jsonb_build_object('blob', repeat('x', 5000))) $$,
  'P0001',
  'props exceeds 4 KB',
  'the trigger rejects a props payload over 4 KB');

-- --- no update or delete path --------------------------
select throws_ok(
  $$ update public.analytics_events set event_name = 'community.rewritten' $$,
  '42501',
  null,
  'analytics_events has no update grant');
select throws_ok(
  $$ delete from public.analytics_events $$,
  '42501',
  null,
  'analytics_events has no delete grant');

select * from finish();
rollback;
