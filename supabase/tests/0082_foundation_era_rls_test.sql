-- Production-readiness audit, DATABASE_AUDIT.md DB-M4.
--
-- The foundation migration (202608260001) created the tables the whole
-- module rests on, and it predates the pgTAP suite - so while later tests
-- reference these tables incidentally, nothing asserted their OWN RLS
-- boundaries directly. private_records is the sharpest gap: it is the
-- offline-sync channel, it holds the member's entire training log, and it
-- was referenced by exactly two test files, neither of which checked
-- whether one member can read another's.
--
-- This file covers the four foundation tables' self-only boundaries plus
-- the constraints 202609060012 added to private_records.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures: two members with their own private records
-- =====================================================================
select tests.clear_auth();
insert into public.private_records (user_id, record_type, record_id, payload) values
  (tests.uid('m1'), 'strength_entry', 'm1-squat-1', '{"kg": 100}'::jsonb),
  (tests.uid('m1'), 'bodyweight',     'm1-bw-1',    '{"kg": 80}'::jsonb),
  (tests.uid('m2'), 'strength_entry', 'm2-squat-1', '{"kg": 90}'::jsonb);

insert into public.follows (follower_id, followed_id) values (tests.uid('m1'), tests.uid('m2'));
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m1'));

-- =====================================================================
-- 1. private_records - the training log. Self-only, both directions.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.private_records), 2,
  'a member reads exactly their own private records...');
select is_empty(
  $$ select 1 from public.private_records where user_id = tests.uid('m2') $$,
  '...and cannot read another member''s training log at all - the single most sensitive read boundary in the schema, and it had no direct test before this file');

-- Writing into somebody else's log is refused by the WITH CHECK.
select throws_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m2'), 'strength_entry', 'forged-1', '{"kg": 999}'::jsonb) $$,
  '42501', null,
  'and cannot write into another member''s log either');

-- Updating and deleting are equally scoped: RLS filters rather than
-- raising, so the assertion is that nothing changed.
select lives_ok(
  $$ update public.private_records set payload = '{"kg": 1}'::jsonb where user_id = tests.uid('m2') $$,
  'an UPDATE aimed at another member raises nothing...');
select tests.clear_auth();
select is(
  (select payload ->> 'kg' from public.private_records where user_id = tests.uid('m2') and record_id = 'm2-squat-1'), '90',
  '...and changed nothing');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ delete from public.private_records where user_id = tests.uid('m2') $$,
  'a DELETE aimed at another member raises nothing...');
select tests.clear_auth();
select is(
  (select count(*)::int from public.private_records where user_id = tests.uid('m2')), 1,
  '...and removed nothing');

-- =====================================================================
-- 2. private_records constraints added by 202609060012 (SEC-007)
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'session_note', 'huge', jsonb_build_object('n', repeat('x', 100000))) $$,
  '23514', null,
  'the 64 KB payload ceiling holds on the real table, not just in the migration text');
select throws_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'not_a_real_type', 'x', '{}'::jsonb) $$,
  '23514', null,
  'and record_type is still constrained to the known set');

-- =====================================================================
-- 3. follows - a member may only create edges FROM themselves
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ insert into public.follows (follower_id, followed_id)
     values (tests.uid('m1'), tests.uid('m3')) $$,
  '42501', null,
  'a member cannot make somebody else follow a third member');
select lives_ok(
  $$ insert into public.follows (follower_id, followed_id)
     values (tests.uid('m2'), tests.uid('m3')) $$,
  'but can follow on their own behalf');

-- =====================================================================
-- 4. blocks - self-only, and invisible to the blocked member
-- =====================================================================
-- BOTH SIDES of a block edge can read it, and that is deliberate rather
-- than an oversight: blocks_self_select is
-- `blocker_id = auth.uid() OR blocked_id = auth.uid()`, with both branches
-- written explicitly, and cloud.js:3568-3570 reads the table in BOTH
-- directions to compute the edge set it uses to hide content. A block has
-- to be mutual in effect - neither party sees the other - so the blocked
-- member's client needs to know the edge exists.
--
-- Recorded here as an assertion rather than left implicit, because the
-- naive expectation ("the blocked member should not be able to tell") is
-- the one a future reader will bring, and it would break the feature.
-- What a blocked member CANNOT do is enumerate blocks they are not part
-- of, which the next assertion covers.
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.blocks where blocked_id = tests.uid('m1')), 1,
  'the blocked member CAN see the edge that names them - both clients need it to hide each other''s content');
select is_empty(
  $$ select 1 from public.blocks
      where blocker_id <> tests.uid('m1') and blocked_id <> tests.uid('m1') $$,
  'but sees no block edge they are not a party to');
select throws_ok(
  $$ insert into public.blocks (blocker_id, blocked_id)
     values (tests.uid('m2'), tests.uid('m3')) $$,
  '42501', null,
  'and a member cannot create a block on somebody else''s behalf');

select tests.set_auth(tests.uid('m3'));
select is(
  (select count(*)::int from public.blocks where blocker_id = tests.uid('m3')), 1,
  'while the blocker reads their own block list');

-- =====================================================================
-- 5. reactions - insert is own-row only
-- =====================================================================
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body, status)
values ('40820000-0000-4000-8000-000000000001', tests.uid('m2'), 'club', 'post', 'active');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.reactions (post_id, user_id, kind)
     values ('40820000-0000-4000-8000-000000000001', tests.uid('m2'), 'cheer') $$,
  '42501', null,
  'a member cannot forge a reaction attributed to somebody else');

-- =====================================================================
-- 6. account_deletion_requests - self-read only
-- =====================================================================
select tests.clear_auth();
insert into public.account_deletion_requests (user_id) values (tests.uid('m2'))
on conflict (user_id) do nothing;
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.account_deletion_requests where user_id = tests.uid('m2') $$,
  'one member cannot see that another has requested deletion');

select * from finish();
rollback;
