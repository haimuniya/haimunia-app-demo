-- COMM-020: real two-user RLS enforcement for 202608280008 (notifications).
-- Boundaries: own-row read only, no client insert, the own-row update
-- reaches read_at and nothing else. notification_preferences and
-- push_subscriptions are own-row read and write, so a member cannot read
-- another member endpoint or keys.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- one server-written notification for member A
select tests.clear_auth();
insert into public.notifications (id, user_id, type, category, title, body, deep_link)
values ('c0080000-0000-4000-8000-000000000001', tests.uid('m1'),
        'community.reaction', 'community', 'Original title', 'Original body', '/feed');

-- --- own-row read only --------------------------------------
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.notifications $$,
  $$ values (1) $$,
  'a member reads their own notification');
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('m1') $$,
  'a member cannot read another member notification');

-- --- no client insert --------------------------------------
select throws_ok(
  $$ insert into public.notifications (user_id, type, category)
     values (tests.uid('m2'), 'community.reaction', 'community') $$,
  '42501',
  null,
  'a member cannot insert a notification into their own stream');
select throws_ok(
  $$ insert into public.notifications (user_id, type, category)
     values (tests.uid('m1'), 'community.reaction', 'community') $$,
  '42501',
  null,
  'a member cannot plant a notification in another member stream');

-- --- own-row update reaches read_at only ------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.notifications
     set read_at = now(), title = 'HACKED', body = 'HACKED', deep_link = '/evil'
     where user_id = tests.uid('m1') $$,
  'a member update naming other columns is accepted');
select is(
  (select title from public.notifications where id = 'c0080000-0000-4000-8000-000000000001'),
  'Original title',
  'the content trigger kept the title');
select is(
  (select deep_link from public.notifications where id = 'c0080000-0000-4000-8000-000000000001'),
  '/feed',
  'the content trigger kept the deep_link');
select isnt(
  (select read_at from public.notifications where id = 'c0080000-0000-4000-8000-000000000001'),
  null,
  'the read_at write did land');

-- --- notification_preferences own-row --------------------
select lives_ok(
  $$ insert into public.notification_preferences (user_id, type, channel)
     values (tests.uid('m1'), 'community.reaction', 'off') $$,
  'a member writes their own preference row');
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.notification_preferences where user_id = tests.uid('m1') $$,
  'a member cannot read another member preference row');
select throws_ok(
  $$ insert into public.notification_preferences (user_id, type, channel)
     values (tests.uid('m1'), 'community.mention', 'off') $$,
  '42501',
  null,
  'a member cannot write a preference row for another member');

-- --- push_subscriptions own-row -------------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.push_subscriptions (user_id, endpoint, keys)
     values (tests.uid('m1'), 'https://push.example/aaa', '{"p256dh":"x","auth":"y"}') $$,
  'a member writes their own push subscription');
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.push_subscriptions where user_id = tests.uid('m1') $$,
  'a member cannot read another member push endpoint or keys');
select throws_ok(
  $$ insert into public.push_subscriptions (user_id, endpoint)
     values (tests.uid('m1'), 'https://push.example/bbb') $$,
  '42501',
  null,
  'a member cannot register a push subscription for another member');

select * from finish();
rollback;
