-- COMM-020: real two-user RLS enforcement for 202608280018 (notification
-- batches).
-- Boundaries: own-row read only, no insert/update/delete grant or policy
-- for any client, a member who owns the row included - a batch is written
-- only by notif_queue_batched() / notif_batch_flushed(), and those two are
-- revoked from authenticated as well as anon, so they are server-only.
-- Behaviour: a second notif_queue_batched call for the same member,
-- category, and type increments pending_count and the per-type counter in
-- place rather than creating a second row, and does not move next_flush_at
-- once a window is already open; a queue call on an empty batch does start
-- a fresh window. notification_batch_window() is 6 hours and matches the
-- column default. notif_batch_flushed resets the counters and arms the
-- next window.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- notification_batch_window()
-- =====================================================================
select results_eq(
  $$ select public.notification_batch_window() $$,
  $$ values ('6 hours'::interval) $$,
  'notification_batch_window() is 6 hours');

-- =====================================================================
-- notif_queue_batched / notif_batch_flushed are not client-callable at all
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.notif_queue_batched(tests.uid('m1'), 'community', 'reaction', null) $$,
  '42501',
  null,
  'notif_queue_batched is not executable by authenticated');
select throws_ok(
  $$ select public.notif_batch_flushed(tests.uid('m1'), 'community') $$,
  '42501',
  null,
  'notif_batch_flushed is not executable by authenticated');

-- =====================================================================
-- the actual batching behaviour, run as the bootstrap superuser, which is
-- what a server-side consumer or the flusher looks like from here.
-- =====================================================================
select tests.clear_auth();

-- --- an empty batch starts a fresh window ---------------------------
select public.notif_queue_batched(tests.uid('m1'), 'community', 'reaction', null);
select results_eq(
  $$ select pending_count from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$,
  $$ values (1) $$,
  'the first queue call on an empty batch sets pending_count to 1');
select results_eq(
  $$ select (pending #>> array['reaction', 'count'])::int from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$,
  $$ values (1) $$,
  'the per-type reaction counter starts at 1');
select isnt_empty(
  $$ select 1 from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community'
       and next_flush_at > now() + interval '5 hours 55 minutes'
       and next_flush_at < now() + interval '6 hours 5 minutes' $$,
  'a fresh window arms next_flush_at about 6 hours out');

-- capture the window's next_flush_at before a repeat call, to prove it
-- does not move once a window is already open
select next_flush_at as before_flush from public.notification_batches
  where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' \gset

-- --- a second call for the same member/category/type increments in place,
-- not a second row --------------------------------------------------
select public.notif_queue_batched(tests.uid('m1'), 'community', 'reaction', null);
select results_eq(
  $$ select count(*)::int from public.notification_batches where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values (1) $$,
  'a repeat queue call for the same user/category is still exactly one row');
select results_eq(
  $$ select pending_count from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$,
  $$ values (2) $$,
  'the second call incremented pending_count to 2');
select results_eq(
  $$ select (pending #>> array['reaction', 'count'])::int from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$,
  $$ values (2) $$,
  'the per-type reaction counter incremented to 2');
select results_eq(
  format($$ select (next_flush_at = %L::timestamptz) from public.notification_batches
            where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$, :'before_flush'),
  $$ values (true) $$,
  'next_flush_at did not move on the second call, the window is already open');

-- --- a second, distinct type in the same category adds to pending_count
-- and gets its own per-type counter, not shared with the first ------
select public.notif_queue_batched(tests.uid('m1'), 'community', 'comment_reply', 'c0180000-0000-4000-8000-000000000001'::uuid);
select results_eq(
  $$ select pending_count from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$,
  $$ values (3) $$,
  'a distinct type in the same category adds to the shared pending_count');
select results_eq(
  $$ select (pending #>> array['comment_reply', 'count'])::int from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$,
  $$ values (1) $$,
  'the comment_reply counter starts at 1, independent of the reaction counter');
select results_eq(
  $$ select (pending #>> array['reaction', 'count'])::int from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$,
  $$ values (2) $$,
  'the reaction counter is untouched by the comment_reply call');

-- =====================================================================
-- notif_batch_flushed resets and re-arms
-- =====================================================================
select public.notif_batch_flushed(tests.uid('m1'), 'community');
select results_eq(
  $$ select pending_count, pending, last_flushed_at is not null
     from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$,
  $$ values (0, '{}'::jsonb, true) $$,
  'notif_batch_flushed resets pending_count and pending and stamps last_flushed_at');

-- a queue call right after a flush starts a fresh window again, same as a
-- brand-new batch
select public.notif_queue_batched(tests.uid('m1'), 'community', 'reaction', null);
select results_eq(
  $$ select pending_count from public.notification_batches
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and category = 'community' $$,
  $$ values (1) $$,
  'a queue call right after a flush starts a fresh count at 1');

-- flushing an already-empty batch is idempotent, only last_flushed_at moves
select public.notif_batch_flushed(tests.uid('m2'), 'community');
select lives_ok(
  $$ select public.notif_batch_flushed(tests.uid('m2'), 'community') $$,
  'flushing a batch that does not exist yet is not an error');

-- =====================================================================
-- read boundary: own-row only, no write of any kind
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m1') and category = 'community' $$,
  'member A reads their own batch');
select is_empty(
  $$ select 1 from public.notification_batches where user_id <> tests.uid('m1') $$,
  'member A reads nothing belonging to another member');

select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m1') $$,
  'member B cannot read member A''s batch');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.notification_batches (user_id, category)
     values (tests.uid('m1'), 'training') $$,
  '42501',
  null,
  'a member cannot insert their own notification_batches row directly');
select throws_ok(
  $$ update public.notification_batches set next_flush_at = now()
     where user_id = tests.uid('m1') and category = 'community' $$,
  '42501',
  null,
  'a member cannot fast-forward their own next_flush_at directly');
select throws_ok(
  $$ delete from public.notification_batches where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'a member cannot delete their own batch row directly');

select * from finish();
rollback;
