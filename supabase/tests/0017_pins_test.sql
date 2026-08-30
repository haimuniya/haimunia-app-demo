-- COMM-020: real two-user RLS enforcement for 202608280017 (pins).
-- Boundaries: select is the only policy and the only grant, open to any
-- signed-in member; a community.content.pin holder still cannot write
-- directly. The (club_id, slot) unique constraint really does reject a
-- fourth pin at the row level, not just in the constraint text. pin_set and
-- pin_clear both gate on community.content.pin, both write an admin_actions
-- row, and pin_set on a dead target (removed post, cancelled event,
-- archived challenge) raises. Soft-deleting/removing a pinned target
-- auto-unpins it and frees the slot with no audit row.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- fixture targets ---------------------------------------------------
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body) values
  ('c0170000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'pinnable post'),
  ('c0170000-0000-4000-8000-000000000002', tests.uid('m1'), 'club', 'a second post');
insert into public.announcements (id, author_id, title, body) values
  ('c0170000-0000-4000-8000-000000000003', tests.uid('admin'), 'Ann.', 'body text here');
insert into public.events (id, title, event_type, start_at, status) values
  ('c0170000-0000-4000-8000-000000000004', 'An event', 'social_night', now() + interval '1 day', 'published');
insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, status, created_by) values
  ('c0170000-0000-4000-8000-000000000005', 'A challenge', 'individual_target', 'reps',
    now(), now() + interval '7 days', 'active', tests.uid('coach'));

-- =====================================================================
-- pin_set / pin_clear: the permission gate
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.pin_set('post', 'c0170000-0000-4000-8000-000000000001') $$,
  'P0001',
  'not authorized',
  'a plain member cannot call pin_set');
select throws_ok(
  $$ select public.pin_clear('post', 'c0170000-0000-4000-8000-000000000001') $$,
  'P0001',
  'not authorized',
  'a plain member cannot call pin_clear');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.pin_set('bogus', 'c0170000-0000-4000-8000-000000000001') $$,
  'P0001',
  'unknown pin target type bogus',
  'pin_set refuses an unknown target type');
select lives_ok(
  $$ select public.pin_set('post', 'c0170000-0000-4000-8000-000000000002', 'temp') $$,
  'a permission holder pins a live, valid post');
select lives_ok(
  $$ select public.pin_clear('post', 'c0170000-0000-4000-8000-000000000002') $$,
  'the permission holder clears it again, freeing the slot');
select lives_ok(
  $$ select public.pin_clear('post', 'c0170000-0000-4000-8000-000000000002') $$,
  'clearing a pin that is already gone is a silent no-op');

-- --- pinning a dead target raises --------------------------------------
select tests.clear_auth();
update public.workout_posts set status = 'removed' where id = 'c0170000-0000-4000-8000-000000000002';
update public.events set status = 'cancelled' where id = 'c0170000-0000-4000-8000-000000000004';
update public.challenges set status = 'archived' where id = 'c0170000-0000-4000-8000-000000000005';

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.pin_set('post', 'c0170000-0000-4000-8000-000000000002') $$,
  'P0001',
  'pin target not found or not pinnable',
  'pinning a removed post raises');
select throws_ok(
  $$ select public.pin_set('event', 'c0170000-0000-4000-8000-000000000004') $$,
  'P0001',
  'pin target not found or not pinnable',
  'pinning a cancelled event raises');
select throws_ok(
  $$ select public.pin_set('challenge', 'c0170000-0000-4000-8000-000000000005') $$,
  'P0001',
  'pin target not found or not pinnable',
  'pinning an archived challenge raises');

-- restore the challenge and event to pinnable state for the slot-cap test
select tests.clear_auth();
update public.events set status = 'published' where id = 'c0170000-0000-4000-8000-000000000004';
update public.challenges set status = 'active' where id = 'c0170000-0000-4000-8000-000000000005';

-- =====================================================================
-- the 3-slot cap
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.pin_set('post', 'c0170000-0000-4000-8000-000000000001', 'slot 1') $$,
  'the first pin is set');
select lives_ok(
  $$ select public.pin_set('announcement', 'c0170000-0000-4000-8000-000000000003', 'slot 2') $$,
  'the second pin is set');
select lives_ok(
  $$ select public.pin_set('event', 'c0170000-0000-4000-8000-000000000004', 'slot 3') $$,
  'the third pin is set, filling all 3 slots');
select throws_ok(
  $$ select public.pin_set('challenge', 'c0170000-0000-4000-8000-000000000005') $$,
  'P0001',
  'pin_limit_reached',
  'a fourth pin_set call raises pin_limit_reached');
select results_eq(
  $$ select count(*)::int from public.pins $$,
  $$ values (3) $$,
  'exactly 3 pin rows exist, the fourth call left nothing behind');

-- --- the unique-constraint cap actually rejects a row at the row level,
-- not only in the constraint text: two rows forced into the same slot by a
-- direct superuser insert (bypassing pin_set's own free-slot arithmetic and
-- advisory lock, which is what a genuine race would also bypass) collide on
-- (club_id, slot). This is the guarantee pin_set's advisory lock only makes
-- a single client-observable failure out of; the constraint itself is what
-- actually prevents two rows landing in one slot under a real race between
-- two backends, which a single-transaction pgTAP file cannot simulate.
select tests.clear_auth();
select throws_ok(
  $$ insert into public.pins (club_id, target_type, target_id, slot, pinned_by)
     values (public.default_club_id(), 'challenge', 'c0170000-0000-4000-8000-000000000005', 0, tests.uid('admin')) $$,
  '23505',
  null,
  'a direct insert forcing a second row into an occupied slot collides on (club_id, slot)');

-- =====================================================================
-- read boundary: select only, open to any signed-in member; no write
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select count(*)::int from public.pins $$,
  $$ values (3) $$,
  'a plain member reads all 3 pins');
select throws_ok(
  $$ insert into public.pins (club_id, target_type, target_id, slot, pinned_by)
     values (public.default_club_id(), 'post', 'c0170000-0000-4000-8000-000000000001', 0, tests.uid('m2')) $$,
  '42501',
  null,
  'a plain member cannot insert a pins row directly');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ insert into public.pins (club_id, target_type, target_id, slot, pinned_by)
     values (public.default_club_id(), 'post', 'c0170000-0000-4000-8000-000000000001', 1, tests.uid('admin')) $$,
  '42501',
  null,
  'a community.content.pin holder still cannot insert a pins row directly');
select throws_ok(
  $$ update public.pins set note = 'x' $$,
  '42501',
  null,
  'a community.content.pin holder cannot update a pins row directly');
select throws_ok(
  $$ delete from public.pins $$,
  '42501',
  null,
  'a community.content.pin holder cannot delete a pins row directly');

-- =====================================================================
-- admin_actions audit rows and auto-unpin
-- =====================================================================
select isnt_empty(
  $$ select 1 from public.admin_actions
     where action_type = 'content_pin' and target_id = 'c0170000-0000-4000-8000-000000000001' $$,
  'pin_set left a content_pin admin_actions row');

select tests.clear_auth();
update public.workout_posts set status = 'removed' where id = 'c0170000-0000-4000-8000-000000000001';

select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select 1 from public.pins where target_id = 'c0170000-0000-4000-8000-000000000001' $$,
  'removing the pinned post auto-unpins it and frees the slot');
select results_eq(
  $$ select count(*)::int from public.pins $$,
  $$ values (2) $$,
  'only 2 pins remain after the auto-unpin');
select is_empty(
  $$ select 1 from public.admin_actions
     where action_type = 'content_unpin' and target_id = 'c0170000-0000-4000-8000-000000000001' $$,
  'the auto-unpin wrote no content_unpin admin_actions row');

select lives_ok(
  $$ select public.pin_set('challenge', 'c0170000-0000-4000-8000-000000000005', 'now fits') $$,
  'the freed slot can be reused, filling the 3 slots again');
select lives_ok(
  $$ select public.pin_clear('announcement', 'c0170000-0000-4000-8000-000000000003') $$,
  'pin_clear removes a pin explicitly');
select isnt_empty(
  $$ select 1 from public.admin_actions
     where action_type = 'content_unpin' and target_id = 'c0170000-0000-4000-8000-000000000003' $$,
  'the explicit pin_clear left a content_unpin admin_actions row');

select * from finish();
rollback;
