-- Production-readiness audit, 2026-09-06 (202609060013).
-- The two product decisions: raw attendance is admin-only (SEC-009/PRIV-001),
-- and announcement edits are author-or-admin and audited (SEC-010).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures
-- =====================================================================
select tests.clear_auth();
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('m1'), current_date),
       (tests.uid('m1'), current_date - 1);

insert into public.announcements (id, author_id, title, body)
values ('40790000-0000-4000-8000-000000000001', tests.uid('coach'), 'Coach notice', 'Body A'),
       ('40790000-0000-4000-8000-000000000002', tests.uid('admin'), 'Admin notice', 'Body B');

-- =====================================================================
-- DECISION 1: raw attendance_log
-- =====================================================================
-- The permission split this decision rests on, read off the seed rather
-- than asserted from memory: a coach is staff but does NOT hold
-- community.analytics.view.
select is(
  (select count(*)::int from public.role_permissions
   where role_code = 'coach' and permission_code = 'community.analytics.view'), 0,
  'the coach role does not hold community.analytics.view...');
select tests.set_auth(tests.uid('coach'));
select ok(public.is_staff(), '...while still being is_staff(), which is exactly the gap SEC-009 sat in');

select is_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m1') $$,
  'THE DECISION: a plain coach now reads ZERO raw attendance rows for another member - before 202609060013 the is_staff() branch returned every row, contradicting PRIVACY.md''s "not a detailed log" promise');

select tests.set_auth(tests.uid('admin'));
select isnt_empty(
  $$ select 1 from public.attendance_log where user_id = tests.uid('m1') $$,
  'an admin (community.analytics.view) still reads raw attendance - the capability moved, it was not deleted');

-- The self-read path the shipped client actually uses (cloud.js ~1262, the
-- first_class/third_class onboarding steps) is untouched.
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.attendance_log where user_id = tests.uid('m1')), 2,
  'and a member still reads their OWN attendance rows, which is the only attendance read the shipped client makes');

-- The aggregate coach features keep working because they are SECURITY
-- DEFINER and bypass this policy entirely. Asserted structurally so a
-- future refactor to security invoker fails here rather than silently
-- blanking every coach tool.
select is(
  (select prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'coach_detect_engagement_decline'), true,
  'coach_detect_engagement_decline() is SECURITY DEFINER, which is why narrowing the policy above does not blind the coach tools');

-- =====================================================================
-- DECISION 2: announcement edits
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.announcements set body = 'Body A edited'
     where id = '40790000-0000-4000-8000-000000000001' $$,
  'a coach still edits their OWN announcement...');
select tests.clear_auth();
select is(
  (select body from public.announcements where id = '40790000-0000-4000-8000-000000000001'), 'Body A edited',
  '...and it really changed');

-- The SEC-010 vector: a coach editing somebody else's announcement.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.announcements set body = 'hijacked'
     where id = '40790000-0000-4000-8000-000000000002' $$,
  'THE FIX: a coach editing an ADMIN''s announcement raises nothing - RLS filters rather than errors...');
select tests.clear_auth();
select is(
  (select body from public.announcements where id = '40790000-0000-4000-8000-000000000002'), 'Body B',
  '...and changed nothing, because announcements_update_admin is now author-or-admin instead of any is_staff()');

-- Soft-delete is an UPDATE, so it is covered by the same boundary.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.announcements set deleted_at = now()
     where id = '40790000-0000-4000-8000-000000000002' $$,
  'the same holds for a soft-delete, which is an UPDATE and was equally open before...');
select tests.clear_auth();
select is(
  (select deleted_at is null from public.announcements where id = '40790000-0000-4000-8000-000000000002'), true,
  '...the admin''s announcement is still live');

-- The audit trail for the case that IS still allowed: an admin editing
-- somebody else's announcement.
select tests.clear_auth();
delete from public.admin_actions where action_type = 'announcement_edit';
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ update public.announcements set body = 'corrected by admin'
     where id = '40790000-0000-4000-8000-000000000001' $$,
  'an admin CAN still edit a coach''s announcement - somebody has to be able to pull a bad post...');
select tests.clear_auth();
select is(
  (select count(*)::int from public.admin_actions
   where action_type = 'announcement_edit' and target_id = '40790000-0000-4000-8000-000000000001'), 1,
  '...and that cross-author edit now leaves exactly one admin_actions row, which it never did before');
select is(
  (select after_data ->> 'body' from public.admin_actions
   where action_type = 'announcement_edit' and target_id = '40790000-0000-4000-8000-000000000001'),
  'corrected by admin',
  'and the audit row records what the announcement was changed TO');

-- An author editing their own writes no audit row - ordinary authorship is
-- not an administrative act.
select tests.clear_auth();
delete from public.admin_actions where action_type = 'announcement_edit';
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.announcements set body = 'own edit again'
     where id = '40790000-0000-4000-8000-000000000001' $$,
  'the author edits their own announcement again...');
select tests.clear_auth();
select is(
  (select count(*)::int from public.admin_actions where action_type = 'announcement_edit'), 0,
  '...and writes NO audit row - only cross-author edits are administrative acts');

select * from finish();
rollback;
