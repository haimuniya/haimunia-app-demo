-- COMM-020 run C: real enforcement for 202608280026 (the notif_create
-- insert path and its helpers).
-- Boundaries: notif_create is unreachable by any client role at all - a
-- member, a coach, and an admin each get a permission error on a direct
-- RPC. notification_batches, comment_mentions et al. are covered
-- elsewhere; here notif_create is exercised directly as the bootstrap
-- superuser (the same "definer-equivalent path" a trigger uses), because
-- that is the only way to reach a function with no grant to anyone. Every
-- suppression rule fires: recipient == actor (except the self-directed
-- types), a block edge either direction, an off preference on the mapped
-- key unless the row is operational, and the (user, type, source_id)
-- dedupe window. title/body are truncated, not rejected. The
-- notifications_deep_link_check {0,255} bound (this migration's step 0)
-- actually accepts a real deep link and still rejects one with no leading
-- slash.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- notif_create is unreachable by any client role
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.notif_create(tests.uid('m2'), 'comment_reply', 'community',
       'title', 'body', 'comment', gen_random_uuid(), '/community/feed') $$,
  '42501',
  null,
  'a plain member cannot call notif_create directly');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.notif_create(tests.uid('m2'), 'comment_reply', 'community',
       'title', 'body', 'comment', gen_random_uuid(), '/community/feed') $$,
  '42501',
  null,
  'a coach cannot call notif_create directly either');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.notif_create(tests.uid('m2'), 'comment_reply', 'community',
       'title', 'body', 'comment', gen_random_uuid(), '/community/feed') $$,
  '42501',
  null,
  'an admin cannot call notif_create directly either - the boundary is the missing grant, not a role check');

-- =====================================================================
-- notifications_deep_link_check: the {0,255} bound actually works, and the
-- leading-slash rule still holds
-- =====================================================================
select tests.clear_auth();
select lives_ok(
  $$ insert into public.notifications (user_id, type, category, deep_link)
     values (tests.uid('m1'), 'comment_reply', 'community',
             '/community/feed?post=' || gen_random_uuid()::text || '&comment=' || gen_random_uuid()::text) $$,
  'a real ~90-character deep link inserts without the old "invalid repetition count(s)" error');
select throws_ok(
  $$ insert into public.notifications (user_id, type, category, deep_link)
     values (tests.uid('m1'), 'comment_reply', 'community', 'https://evil.example/redirect') $$,
  '23514',
  null,
  'a deep_link with no leading slash still fails the CHECK, so it cannot become an open redirect');

-- =====================================================================
-- fixtures for the behavioural suite: a mapped-key off preference, an
-- announcement to exercise the operational override, and a block edge.
-- Built as the bootstrap superuser, same as every other file in this
-- suite.
-- =====================================================================
select tests.clear_auth();
insert into public.notification_preferences (user_id, type, channel)
values (tests.uid('m2'), 'mentions', 'off');
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m3'));
insert into public.notification_preferences (user_id, type, channel)
values (tests.uid('m3'), 'announcements', 'off');

-- The 202608280027 fan-out trigger is not what this file tests, and it
-- would otherwise fire on this INSERT and pre-write the exact rows the
-- behavioural section below means to create itself, tripping notif_create's
-- own dedupe window before this file ever calls it directly. Disabled only
-- for these two rows, re-enabled immediately after.
alter table public.announcements disable trigger announcements_notify_insert;
insert into public.announcements (id, author_id, title, body, important) values
  ('c0260000-0000-4000-8000-000000000001', tests.uid('admin'), 'Not important', 'body', false),
  ('c0260000-0000-4000-8000-000000000002', tests.uid('admin'), 'Important', 'body', true);
alter table public.announcements enable trigger announcements_notify_insert;

-- =====================================================================
-- unknown type / unknown category raise
-- =====================================================================
select throws_ok(
  $$ select public.notif_create(tests.uid('m1'), 'not a valid type', 'community',
       't', 'b', null, null, null) $$,
  'P0001',
  null,
  'a type that fails the ^[a-z][a-z0-9_.]{2,63}$ shape raises');
select throws_ok(
  $$ select public.notif_create(tests.uid('m1'), 'comment_reply', 'not_a_category',
       't', 'b', null, null, null) $$,
  'P0001',
  'unknown notification category not_a_category',
  'an unknown category raises');

-- =====================================================================
-- a plain, unsuppressed call actually writes a row and returns its id
-- =====================================================================
select lives_ok(
  $$ select public.notif_create(tests.uid('m1'), 'comment_reply', 'community',
       'hi', 'body', 'comment', 'c0260000-0000-4000-8000-0000000000a1'::uuid,
       '/community/feed?post=x') $$,
  'a normal call with no suppression rule in play lives');
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m1') and type = 'comment_reply'
       and source_id = 'c0260000-0000-4000-8000-0000000000a1' $$,
  'the row actually landed');

-- =====================================================================
-- title/body are truncated, not rejected
-- =====================================================================
select public.notif_create(tests.uid('m1'), 'comment_reply', 'community',
  repeat('t', 200), repeat('b', 600), 'comment',
  'c0260000-0000-4000-8000-0000000000a2'::uuid, null);
select results_eq(
  $$ select char_length(title), char_length(body) from public.notifications
     where user_id = tests.uid('m1') and type = 'comment_reply'
       and source_id = 'c0260000-0000-4000-8000-0000000000a2' $$,
  $$ values (160, 500) $$,
  'a 200-character title and a 600-character body are truncated to 160 and 500, not rejected');

-- =====================================================================
-- recipient == actor is suppressed, except the self-directed types. The
-- actor is simulated by setting the jwt sub claim directly (not through
-- tests.set_auth, which would also switch role and hit the missing grant
-- above) - the same "definer-equivalent" path a trigger's auth.uid() read
-- takes, since notif_create itself only ever reads auth.uid() to find the
-- actor, never to gate the call.
-- =====================================================================
select pg_catalog.set_config('request.jwt.claim.sub', tests.uid('m2')::text, true);
select public.notif_create(tests.uid('m2'), 'comment_reply', 'community',
  't', 'b', 'comment', 'c0260000-0000-4000-8000-0000000000a3'::uuid, null);
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m2') and source_id = 'c0260000-0000-4000-8000-0000000000a3' $$,
  'recipient == actor writes nothing for an ordinary type');

select public.notif_create(tests.uid('m2'), 'achievement_unlocked', 'training',
  't', 'b', 'achievement', 'c0260000-0000-4000-8000-0000000000a4'::uuid, null);
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m2') and type = 'achievement_unlocked'
       and source_id = 'c0260000-0000-4000-8000-0000000000a4' $$,
  'recipient == actor is explicitly allowed for the self-directed achievement_unlocked type');

select tests.clear_auth();

-- =====================================================================
-- a block edge in either direction suppresses the write
-- =====================================================================
select pg_catalog.set_config('request.jwt.claim.sub', tests.uid('m3')::text, true);
select public.notif_create(tests.uid('m1'), 'comment_reply', 'community',
  't', 'b', 'comment', 'c0260000-0000-4000-8000-0000000000a5'::uuid, null);
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m1') and source_id = 'c0260000-0000-4000-8000-0000000000a5' $$,
  'a block edge between recipient and actor (blocker m1, blocked m3) suppresses the write, actor on the blocked side');

select pg_catalog.set_config('request.jwt.claim.sub', tests.uid('m1')::text, true);
select public.notif_create(tests.uid('m3'), 'comment_reply', 'community',
  't', 'b', 'comment', 'c0260000-0000-4000-8000-0000000000a6'::uuid, null);
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m3') and source_id = 'c0260000-0000-4000-8000-0000000000a6' $$,
  'the same block edge suppresses the write in the other direction too, actor on the blocker side');

select tests.clear_auth();

-- =====================================================================
-- an off preference on the mapped key suppresses a non-operational row;
-- an important announcement overrides it
-- =====================================================================
select public.notif_create(tests.uid('m2'), 'mention', 'community',
  't', 'b', 'comment', 'c0260000-0000-4000-8000-0000000000a7'::uuid, null);
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m2') and source_id = 'c0260000-0000-4000-8000-0000000000a7' $$,
  'mention is suppressed for a recipient with the mapped mentions preference off');

select public.notif_create(tests.uid('m3'), 'announcement', 'club',
  't', 'b', 'announcement', 'c0260000-0000-4000-8000-000000000001'::uuid, null);
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m3') and source_id = 'c0260000-0000-4000-8000-000000000001' $$,
  'a non-important announcement is suppressed for a recipient with announcements off');

select public.notif_create(tests.uid('m3'), 'announcement', 'club',
  't', 'b', 'announcement', 'c0260000-0000-4000-8000-000000000002'::uuid, null);
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m3') and source_id = 'c0260000-0000-4000-8000-000000000002' $$,
  'an important announcement reaches the same recipient anyway - it is operational');

-- =====================================================================
-- dedupe: an identical (user_id, type, source_id) within the window is not
-- written twice; a different source_id is a different event and is not
-- deduped
-- =====================================================================
select public.notif_create(tests.uid('owner'), 'comment_reply', 'community',
  't', 'b', 'comment', 'c0260000-0000-4000-8000-0000000000a8'::uuid, null);
select public.notif_create(tests.uid('owner'), 'comment_reply', 'community',
  't', 'b', 'comment', 'c0260000-0000-4000-8000-0000000000a8'::uuid, null);
select results_eq(
  $$ select count(*)::int from public.notifications
     where user_id = tests.uid('owner') and type = 'comment_reply'
       and source_id = 'c0260000-0000-4000-8000-0000000000a8' $$,
  $$ values (1) $$,
  'calling notif_create twice with the same (user, type, source_id) inside the window writes exactly one row');

select public.notif_create(tests.uid('owner'), 'comment_reply', 'community',
  't', 'b', 'comment', 'c0260000-0000-4000-8000-0000000000a9'::uuid, null);
select results_eq(
  $$ select count(*)::int from public.notifications
     where user_id = tests.uid('owner') and type = 'comment_reply' $$,
  $$ values (2) $$,
  'a distinct source_id for the same user and type is a distinct event, not deduped');

select * from finish();
rollback;
