-- COMM-020 run C: real enforcement for 202608280028 (the notification batch
-- flusher).
-- Boundaries: notif_batch_flush_due is granted to service_role only, not
-- authenticated - a member gets a permission error, service_role does not.
-- It processes only notification_batches rows with next_flush_at <= now()
-- and pending_count > 0, ignoring a future window and an empty batch even
-- when overdue. It writes one notifications row per key in pending, using
-- the batched type key as notifications.type, then zeroes pending_count and
-- pending for that user+category and rearms next_flush_at. A single-type
-- batch whose type is reaction or comment_also deep-links to the last
-- source post; the same single-type shape for any other type, and a
-- multi-type batch of any kind, deep-links to the category surface
-- instead. Returns the count of rows written; a second call with nothing
-- due writes nothing and returns 0. A malformed last_source_id in the
-- pending jsonb does not blow up the whole flush.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- granted to service_role only
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.notif_batch_flush_due() $$, '42501', null,
  'a plain member cannot call notif_batch_flush_due directly');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.notif_batch_flush_due() $$, '42501', null,
  'not even an admin - the boundary is the missing grant, not a role check');

select tests.clear_auth();
select pg_catalog.set_config('role', 'service_role', true);
select lives_ok(
  $$ select public.notif_batch_flush_due() $$,
  'service_role can call notif_batch_flush_due - the sole grant this function has');
select tests.clear_auth();

-- =====================================================================
-- fixtures: seven notification_batches rows covering every branch -
-- built directly (not through notif_queue_batched) so next_flush_at and
-- pending are fully under this file's control. Built as the bootstrap
-- superuser.
-- =====================================================================
insert into public.notification_batches
  (user_id, category, pending_count, pending, next_flush_at) values
  -- A: single type (reaction), dominates, due -> post-link, plural wording
  (tests.uid('m1'), 'community', 3,
   jsonb_build_object('reaction', jsonb_build_object('count', 3, 'last_source_id', 'c0280000-0000-4000-8000-0000000000a1')),
   now() - interval '1 minute'),
  -- B: single type (friend_achievement), dominates, due, but the type is
  -- not in the reaction/comment_also special-case list -> surface link
  -- even though it dominates
  (tests.uid('m2'), 'training', 4,
   jsonb_build_object('friend_achievement', jsonb_build_object('count', 4, 'last_source_id', 'c0280000-0000-4000-8000-0000000000b1')),
   now() - interval '1 minute'),
  -- C: two types in one batch, due -> neither dominates, both get the
  -- category surface link even though one of them is reaction
  (tests.uid('m3'), 'challenges', 5,
   jsonb_build_object(
     'reaction', jsonb_build_object('count', 2, 'last_source_id', 'c0280000-0000-4000-8000-0000000000c1'),
     'comment_also', jsonb_build_object('count', 3, 'last_source_id', 'c0280000-0000-4000-8000-0000000000c2')),
   now() - interval '1 minute'),
  -- D: due, but pending_count is 0 - nothing to flush even though overdue
  (tests.uid('norec'), 'community', 0, '{}'::jsonb, now() - interval '1 minute'),
  -- E: not due yet, has real pending content - left entirely alone
  (tests.uid('coach'), 'community', 1,
   jsonb_build_object('reaction', jsonb_build_object('count', 1, 'last_source_id', 'c0280000-0000-4000-8000-0000000000e1')),
   now() + interval '1 hour'),
  -- F: single type with an unrecognised key and a null last_source_id ->
  -- the "else" wording branch and the category surface
  (tests.uid('admin'), 'events', 2,
   jsonb_build_object('custom_x', jsonb_build_object('count', 2, 'last_source_id', null)),
   now() - interval '1 minute'),
  -- G: single type, dominates, type is reaction, but last_source_id is not
  -- a valid uuid - the cast has to fail closed, not blow up the flush
  (tests.uid('owner'), 'club', 1,
   jsonb_build_object('reaction', jsonb_build_object('count', 1, 'last_source_id', 'not-a-uuid')),
   now() - interval '1 minute');

select pg_catalog.set_config('role', 'service_role', true);

-- =====================================================================
-- one call processes A, B, C (x2), F, G - six rows - and returns 6
-- =====================================================================
select results_eq(
  $$ select public.notif_batch_flush_due() $$,
  $$ values (6) $$,
  'the call returns the exact count of notifications rows it wrote: A + B + C(2) + F + G = 6');

select tests.clear_auth();

-- --- A: reaction, dominates, real last_source_id -> post-link, plural --
select results_eq(
  $$ select type, category, title, body, source_id, deep_link from public.notifications
     where user_id = tests.uid('m1') $$,
  $$ values (
       'reaction'::text, 'community'::text, 'New reactions'::text, '3 reactions on your posts'::text,
       'c0280000-0000-4000-8000-0000000000a1'::uuid,
       '/community/feed?post=c0280000-0000-4000-8000-0000000000a1'::text
     ) $$,
  'A: a dominating single-type reaction batch rolls up to one row that deep-links straight to the source post');

-- --- B: friend_achievement, dominates, but not in the post-link set ----
select results_eq(
  $$ select type, title, body, deep_link from public.notifications where user_id = tests.uid('m2') $$,
  $$ values (
       'friend_achievement'::text, 'Friends unlocked achievements'::text,
       '4 friends unlocked achievements'::text,
       '/community/account/achievements'::text
     ) $$,
  'B: even a dominating single-type batch links to the category surface when the type is not reaction or comment_also');

-- --- C: two types in one batch, neither dominates -----------------
select results_eq(
  $$ select count(*)::int from public.notifications where user_id = tests.uid('m3') $$,
  $$ values (2) $$,
  'C: a two-key batch writes exactly two rows, one per pending type');
select results_eq(
  $$ select type, body, deep_link from public.notifications
     where user_id = tests.uid('m3') and type = 'reaction' $$,
  $$ values ('reaction'::text, '2 reactions on your posts'::text, '/community/boards'::text) $$,
  'C: the reaction row does not dominate this batch, so it links to the category surface, not the source post');
select results_eq(
  $$ select type, body, deep_link from public.notifications
     where user_id = tests.uid('m3') and type = 'comment_also' $$,
  $$ values ('comment_also'::text, '3 new comments on your posts'::text, '/community/boards'::text) $$,
  'C: same for the comment_also row in the same batch');

-- --- D: pending_count 0 - overdue but nothing to write --------------
select is_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('norec') $$,
  'D: an overdue batch with pending_count 0 writes nothing');
select results_eq(
  $$ select pending_count from public.notification_batches
     where user_id = tests.uid('norec') and category = 'community' $$,
  $$ values (0) $$,
  'D: and is left otherwise untouched - still 0, not touched by notif_batch_flushed either');

-- --- E: not due yet - left alone entirely ----------------------------
select is_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('coach') $$,
  'E: a batch with real content but a future next_flush_at is not flushed');
select results_eq(
  $$ select pending_count from public.notification_batches
     where user_id = tests.uid('coach') and category = 'community' $$,
  $$ values (1) $$,
  'E: its pending_count is untouched, still 1');

-- --- F: unrecognised key, null last_source_id -> else wording, surface -
select results_eq(
  $$ select type, title, body, source_id, deep_link from public.notifications where user_id = tests.uid('admin') $$,
  $$ values (
       'custom_x'::text, 'New activity'::text, '2 new updates'::text,
       null::uuid, '/community/feed'::text
     ) $$,
  'F: an unrecognised pending key falls back to the generic wording, a null last_source_id stays null, and events maps to /community/feed');

-- --- G: malformed last_source_id does not error the whole flush -------
select results_eq(
  $$ select type, source_id, deep_link from public.notifications where user_id = tests.uid('owner') $$,
  $$ values ('reaction'::text, null::uuid, '/community/feed'::text) $$,
  'G: a non-uuid last_source_id in the jsonb is caught, source_id lands null, and the deep link falls back to the club category surface even though the type and dominance would otherwise earn a post link');

-- =====================================================================
-- every flushed batch was zeroed and rearmed
-- =====================================================================
select results_eq(
  $$ select pending_count, pending, last_flushed_at is not null from public.notification_batches
     where user_id = tests.uid('m1') and category = 'community' $$,
  $$ values (0, '{}'::jsonb, true) $$,
  'A''s batch is zeroed and stamped after the flush');
select results_eq(
  $$ select pending_count, pending from public.notification_batches
     where user_id = tests.uid('m3') and category = 'challenges' $$,
  $$ values (0, '{}'::jsonb) $$,
  'C''s two-key batch is zeroed too, one flushed_due call cleared both keys at once');
select isnt_empty(
  $$ select 1 from public.notification_batches
     where user_id = tests.uid('m1') and category = 'community'
       and next_flush_at > now() + interval '5 hours 55 minutes' $$,
  'A''s batch was rearmed roughly notification_batch_window() out, same as a fresh notif_queue_batched call');

-- =====================================================================
-- a second call with nothing newly due writes nothing and returns 0
-- =====================================================================
select pg_catalog.set_config('role', 'service_role', true);
select results_eq(
  $$ select public.notif_batch_flush_due() $$,
  $$ values (0) $$,
  'a second call right after the first has nothing left due and returns 0');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where user_id in (tests.uid('m1'), tests.uid('m2'), tests.uid('m3'), tests.uid('admin'), tests.uid('owner')) $$,
  $$ values (6) $$,
  'and it wrote no additional rows - still exactly the six from the first call');

select * from finish();
rollback;
