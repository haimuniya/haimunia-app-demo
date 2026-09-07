-- Five-persona UX audit, defect 2 (202609060022). The audit log can answer
-- "who did what" now.
--
-- WHAT WAS BROKEN. A real moderation decision logged as
--
--     מנהל/ת f70f95f5 · לפני 3 דקות
--
-- - eight characters of a uuid and a relative time. No admin name, no target
-- member, no record of WHICH decision was taken, no note. Reviewing,
-- defending or reversing that decision was impossible from the log, which is
-- the only reason a log exists.
--
-- Every assertion below is one of those five missing facts, on a real write
-- through the real function, not on a hand-inserted row: admin_actions has
-- no INSERT grant and no INSERT policy at all, so log_admin_action() is the
-- only way a row can exist.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 0. The table is still append-only for every client
-- =====================================================================
select is(
  (select has_table_privilege('authenticated', 'public.admin_actions', 'INSERT')), false,
  'no client role can insert an audit row directly...');
select is(
  (select has_table_privilege('authenticated', 'public.admin_actions', 'UPDATE')), false,
  '...or amend one...');
select is(
  (select has_table_privilege('authenticated', 'public.admin_actions', 'DELETE')), false,
  '...or delete one - the log stays append-only, admins included');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_admin_action'), 1,
  'there is exactly ONE log_admin_action - the 5-argument form that recorded no identity is gone, not left alive beside the new one');
select is(
  (select has_function_privilege('authenticated',
     'public.log_admin_action(text, text, uuid, jsonb, jsonb, text, text, uuid)', 'execute')), false,
  'and it is still callable by no client role, so a member cannot forge a row for someone else');
select is(
  (select has_function_privilege('authenticated', 'public.audit_identity_label(uuid)', 'execute')), false,
  'the identity resolver is not client-callable either - granted, it would be a uuid-to-display-name oracle over the whole club');

-- =====================================================================
-- 1. A real moderation decision, end to end
-- =====================================================================
insert into public.workout_posts (id, author_id, post_type, visibility, body, status, published_at, occurred_on)
values ('40840000-0000-4000-8000-000000000001', tests.uid('m2'), 'POST_TEXT', 'club',
        'תוכן שדווח', 'active', now(), current_date);
insert into public.reports (id, reporter_id, post_id, target_type, target_id, reason, details)
values ('40840000-0000-4000-8000-000000000002', tests.uid('m1'),
        '40840000-0000-4000-8000-000000000001', 'post',
        '40840000-0000-4000-8000-000000000001', 'spam', 'ספאם חוזר');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.mod_review('40840000-0000-4000-8000-000000000002', 'remove',
                              'הוסר לאחר אזהרה שנייה') $$,
  'an admin removes reported content');

select is(
  (select admin_display from public.admin_actions
    where action_type = 'report_review' order by created_at desc limit 1),
  'Admin X',
  'THE FIX, 1 of 4: the row names the acting admin instead of eight characters of a uuid');
select is(
  (select target_user_id from public.admin_actions
    where action_type = 'report_review' order by created_at desc limit 1),
  tests.uid('m2'),
  'THE FIX, 2 of 4: it records the member the decision landed on - resolved through the REPORT to the reported post''s author, two hops the reader used to have to make by hand');
select is(
  (select target_display from public.admin_actions
    where action_type = 'report_review' order by created_at desc limit 1),
  'Member B',
  'and names them too');
select is(
  (select action_detail from public.admin_actions
    where action_type = 'report_review' order by created_at desc limit 1),
  'remove',
  'THE FIX, 3 of 4: WHICH decision was taken, in a column, not buried in after_data');
select is(
  (select note from public.admin_actions
    where action_type = 'report_review' order by created_at desc limit 1),
  'הוסר לאחר אזהרה שנייה',
  'THE FIX, 4 of 4: the moderator''s justification, which mod_review has always collected and never stored here');
select ok(
  (select created_at is not null from public.admin_actions
    where action_type = 'report_review' order by created_at desc limit 1),
  'and the timestamp it always had');

-- The delegated removal writes its own row, and it too names the author.
select is(
  (select target_display from public.admin_actions
    where action_type = 'content_delete' and target_id = '40840000-0000-4000-8000-000000000001'),
  'Member B',
  'the content_delete row mod_review delegates to post_delete() names the author as well - passed explicitly, because by the time it is logged the post is already soft-deleted');

-- =====================================================================
-- 2. The one action_type that could not tell its own two decisions apart
-- =====================================================================
select tests.clear_auth();
insert into public.post_comments (id, post_id, author_id, body, status)
values ('40840000-0000-4000-8000-000000000003', '40840000-0000-4000-8000-000000000001',
        tests.uid('m3'), 'תגובה', 'active');
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.comment_moderate('40840000-0000-4000-8000-000000000003', 'remove') $$,
  'a comment is removed');
select lives_ok(
  $$ select public.comment_moderate('40840000-0000-4000-8000-000000000003', 'restore') $$,
  'and then restored');
select results_eq(
  -- Ordered by action_detail, not created_at: both rows are written inside
  -- one pgTAP transaction, so now() is identical for them and created_at is
  -- not a total order here.
  $$ select action_detail from public.admin_actions
      where target_id = '40840000-0000-4000-8000-000000000003' order by action_detail $$,
  $$ values ('remove'), ('restore') $$,
  'both logged action_type content_delete - they always have - but action_detail now distinguishes taking a comment DOWN from putting it BACK, which the log could not express at all before');

-- =====================================================================
-- 3. The two staff actions that wrote no audit row whatsoever
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select is(
  (select count(*)::int from public.admin_actions
    where action_type = 'member_remove' and target_user_id = tests.uid('m3')), 0,
  'nothing logged yet');
select lives_ok(
  $$ select public.admin_remove_member(tests.uid('m3')) $$,
  'an admin removes a member - a soft delete of their profile AND every post they ever wrote');
select is(
  (select count(*)::int from public.admin_actions
    where action_type = 'member_remove' and target_user_id = tests.uid('m3')), 1,
  'THE MOST DESTRUCTIVE ACTION IN THE MODULE now leaves a trail; before this migration it left none at all');
select is(
  (select target_display from public.admin_actions
    where action_type = 'member_remove' and target_user_id = tests.uid('m3')),
  'Member C',
  'and it names the removed member, resolved past profiles_read_authenticated even though the profile was soft-deleted a line earlier');

select tests.clear_auth();
insert into public.reports (id, reporter_id, post_id, target_type, target_id, reason, details)
values ('40840000-0000-4000-8000-000000000004', tests.uid('m2'),
        '40840000-0000-4000-8000-000000000001', 'post',
        '40840000-0000-4000-8000-000000000001', 'other', 'שני');
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.review_report('40840000-0000-4000-8000-000000000004', 'dismissed', 'לא הפרה') $$,
  'the legacy review_report() path still resolves a report');
select is(
  (select action_detail from public.admin_actions
    where action_type = 'report_review'
      and target_id = '40840000-0000-4000-8000-000000000004'),
  'dismissed',
  'and it now writes an audit row - it wrote NONE before, so an admin could resolve a report invisibly through a still-granted legacy RPC');
select is(
  (select note from public.admin_actions
    where action_type = 'report_review'
      and target_id = '40840000-0000-4000-8000-000000000004'),
  'לא הפרה', 'with the resolution note');

-- =====================================================================
-- 4. Restrictions and role changes carry their reason and their role
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.mod_restrict_member(tests.uid('m2'), 'permanent', null, 'הטרדה חוזרת') $$,
  'a member is restricted');
select is(
  (select action_detail || ' / ' || note from public.admin_actions
    where action_type = 'member_restrict' and target_user_id = tests.uid('m2')),
  'permanent / הטרדה חוזרת',
  'the kind of restriction and the reason for it are both first-class now');

select lives_ok(
  $$ select public.admin_grant_coach(tests.uid('m1'), 'head_coach') $$,
  'a role is granted');
select is(
  (select action_detail from public.admin_actions
    where action_type = 'role_change' and target_user_id = tests.uid('m1')
    order by created_at desc limit 1),
  'head_coach',
  'and the log says WHICH role, not just that a role changed');

-- =====================================================================
-- 5. A target with no member behind it stays null rather than inventing one
-- =====================================================================
-- A live post: enforce_pin_target() refuses a soft-deleted one, and the post
-- above was removed by the moderation decision in section 1.
select tests.clear_auth();
insert into public.workout_posts (id, author_id, post_type, visibility, body, status, published_at, occurred_on)
values ('40840000-0000-4000-8000-000000000005', tests.uid('m1'), 'POST_TEXT', 'club',
        'פוסט להצמדה', 'active', now(), current_date);
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.pin_set('post', '40840000-0000-4000-8000-000000000005', 'להצמיד לשבוע') $$,
  'staff pin a post');
select is(
  (select note from public.admin_actions where action_type = 'content_pin'),
  'להצמיד לשבוע', 'the pin note reaches the log');

-- =====================================================================
-- 6. The reader: the filter a review actually starts from
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select ok(
  (select count(*) from public.admin_actions_page(null, 100,
     jsonb_build_object('target_user_id', tests.uid('m2')::text)) ) >= 2,
  'admin_actions_page can now answer "everything ever done to THIS member" - it could only filter by action_type and admin_id before');
select is(
  (select count(*)::int from public.admin_actions_page(null, 100,
     jsonb_build_object('target_user_id', tests.uid('owner')::text))), 0,
  'and the filter really filters');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.admin_actions_page(null, 25, '{}'::jsonb) $$,
  'P0001', 'not authorized',
  'reading the log still needs community.analytics.view - the new columns did not widen who may read it');

select * from finish();
rollback;
