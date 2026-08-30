-- COMM-020 run B: real enforcement for 202608280025 (moderation reshape).
-- Boundaries: report() requires is_community_member, rejects an unknown
-- target_type or reason, is rate limited at 10/10min, sets post_id only for
-- a post target, and a duplicate by the same reporter on the same target
-- refreshes reason/details without adding a row, moving the reporter count,
-- or reopening status; submit_report still routes here. post_delete: the
-- author always, a non-author only via post.delete_any OR comment.moderate
-- OR real is_admin, idempotent, one content_delete audit row for a
-- moderator and none for the author. comment_moderate: comment.moderate OR
-- real is_admin, remove/restore set or clear status+deleted_at+deleted_by,
-- idempotent, one content_delete audit row per real transition. mod_queue:
-- comment.moderate OR real is_admin, one row per (target_type, target_id),
-- reporter_count/reasons/status folding, p_status = 'all', p_limit clamped
-- to 1..50, reporters jsonb shape. mod_review: routes remove and restrict
-- decisions through the functions above, every decision stamps every
-- report row on the target and writes one report_review audit row,
-- p_expires_at is read only for restrict_temp, and a comment.moderate-only
-- caller can pick a restrict decision but the underlying
-- mod_restrict_member call then raises. admin_grant_coach/admin_revoke_coach:
-- real is_admin only, role constrained to coach/head_coach on the two-arg
-- form, a role_change audit row on every real transition, none on a no-op
-- revoke.
--
-- Table-state verification throughout uses tests.clear_auth() (the
-- bootstrap superuser, RLS out of the way) rather than whichever member or
-- moderator made the preceding call: reports is self-or-real-admin read
-- only (reports_read_self_or_admin), admin_actions read requires
-- community.analytics.view (nobody in this file but admin/owner holds
-- it), and workout_posts/post_comments both hide a row once it is soft-
-- removed, even from the moderator who just removed it. Every mod_review
-- call below looks up its report_id the same way: clear_auth, `\gset` the
-- id into a psql variable, then set_auth back to the caller who is meant
-- to act on it - never a raw `select id from public.reports ...` run
-- while impersonating the moderator, which reports' own RLS would answer
-- with nothing.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body) values
  ('c0250000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'P1 by m1 (report dedup + author self-delete)'),
  ('c0250000-0000-4000-8000-000000000002', tests.uid('m2'), 'club', 'P2 by m2 (moderator delete)'),
  ('c0250000-0000-4000-8000-000000000003', tests.uid('m1'), 'club', 'P3 by m1 (queue grouping)'),
  ('c0250000-0000-4000-8000-000000000004', tests.uid('m1'), 'club', 'P4 (folding: reviewing)'),
  ('c0250000-0000-4000-8000-000000000005', tests.uid('m1'), 'club', 'P5 (folding: dismissed)'),
  ('c0250000-0000-4000-8000-000000000006', tests.uid('m1'), 'club', 'P6 (folding: action_taken)'),
  ('c0250000-0000-4000-8000-000000000007', tests.uid('m2'), 'club', 'P7 (mod_review remove post)'),
  ('c0250000-0000-4000-8000-000000000008', tests.uid('m1'), 'club', 'P8 (restrict_temp, coach lacks perm)'),
  ('c0250000-0000-4000-8000-000000000009', tests.uid('m3'), 'club', 'P9 (restrict_temp, admin)'),
  ('c0250000-0000-4000-8000-00000000000a', tests.uid('m2'), 'club', 'P10 (restrict_permanent)'),
  ('c0250000-0000-4000-8000-00000000000b', tests.uid('m1'), 'club', 'P11 (dismiss)'),
  ('c0250000-0000-4000-8000-00000000000c', tests.uid('m1'), 'club', 'P12 (warn)'),
  ('c0250000-0000-4000-8000-00000000000d', tests.uid('m1'), 'club', 'P13 (group-wide stamp)'),
  ('c0250000-0000-4000-8000-00000000000e', tests.uid('m1'), 'club', 'P14, host for the comment_moderate fixtures - never deleted, so post_visible_to_viewer keeps answering for its comments');
insert into public.post_comments (id, post_id, author_id, body) values
  ('c0250000-0000-4000-8000-000000000101', 'c0250000-0000-4000-8000-00000000000e', tests.uid('m2'), 'C1 by m2'),
  ('c0250000-0000-4000-8000-000000000102', 'c0250000-0000-4000-8000-00000000000e', tests.uid('m3'), 'C2 (comment_moderate target)'),
  ('c0250000-0000-4000-8000-000000000103', 'c0250000-0000-4000-8000-00000000000e', tests.uid('m3'), 'C3 (mod_review remove comment)');

-- =====================================================================
-- report(): membership gate, unknown target_type / reason, rate limit
-- =====================================================================
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000001', 'spam', '') $$,
  'P0001',
  'recovery method required',
  'report() requires a verified community member');

select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.report('profile', 'c0250000-0000-4000-8000-000000000001', 'spam', '') $$,
  'P0001',
  null,
  'an unknown target_type raises');
select throws_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000001', 'made_up_reason', '') $$,
  'P0001',
  null,
  'an unknown reason raises');

select tests.clear_auth();
insert into public.rate_limits (user_id, action, window_started_at, attempt_count)
values (tests.uid('m3'), 'report', now(), 10)
on conflict (user_id, action) do update set window_started_at = now(), attempt_count = 10;
select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000001', 'spam', '') $$,
  'P0001',
  'rate_limited',
  'the 11th report in the window is rate limited');
select tests.clear_auth();
delete from public.rate_limits where user_id = tests.uid('m3') and action = 'report';

-- =====================================================================
-- report(): post target sets post_id, comment target leaves it null
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000001', 'spam', 'first note') $$,
  'm3 reports P1 as a post target');
select tests.clear_auth();
select results_eq(
  $$ select post_id from public.reports where reporter_id = tests.uid('m3')
       and target_type = 'post' and target_id = 'c0250000-0000-4000-8000-000000000001' $$,
  $$ values ('c0250000-0000-4000-8000-000000000001'::uuid) $$,
  'a post-target report() call sets post_id = target_id');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.report('comment', 'c0250000-0000-4000-8000-000000000101', 'harassment', '') $$,
  'm1 reports C1 as a comment target');
select tests.clear_auth();
select results_eq(
  $$ select post_id from public.reports where reporter_id = tests.uid('m1')
       and target_type = 'comment' and target_id = 'c0250000-0000-4000-8000-000000000101' $$,
  $$ values (null::uuid) $$,
  'a comment-target report() call leaves post_id null');

-- =====================================================================
-- report(): a duplicate by the same reporter on the same target refreshes
-- reason/details, does not add a row, does not move the distinct-reporter
-- count, and does not reopen a status that already moved on
-- =====================================================================
update public.reports set status = 'dismissed'
  where reporter_id = tests.uid('m3') and target_type = 'post' and target_id = 'c0250000-0000-4000-8000-000000000001';

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000001', 'harassment', 'updated note') $$,
  'm3 reports the same post target a second time with a different reason');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.reports where reporter_id = tests.uid('m3')
       and target_type = 'post' and target_id = 'c0250000-0000-4000-8000-000000000001' $$,
  $$ values (1) $$,
  'the duplicate did not add a second row');
select results_eq(
  $$ select reason, details, status::text from public.reports where reporter_id = tests.uid('m3')
       and target_type = 'post' and target_id = 'c0250000-0000-4000-8000-000000000001' $$,
  $$ values ('harassment'::text, 'updated note'::text, 'dismissed'::text) $$,
  'reason and details refreshed in place; status was not reopened back to open');
select results_eq(
  $$ select count(distinct reporter_id)::int from public.reports
       where target_type = 'post' and target_id = 'c0250000-0000-4000-8000-000000000001' $$,
  $$ values (1) $$,
  'the distinct-reporter count for this target is still exactly 1');

-- =====================================================================
-- submit_report() still resolves and routes through report()
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.submit_report('c0250000-0000-4000-8000-000000000002', 'other') $$,
  'the legacy two-argument submit_report still resolves');
select tests.clear_auth();
select results_eq(
  $$ select target_type, reason, post_id from public.reports
     where reporter_id = tests.uid('m2') and target_id = 'c0250000-0000-4000-8000-000000000002' $$,
  $$ values ('post'::text, 'other'::text, 'c0250000-0000-4000-8000-000000000002'::uuid) $$,
  'submit_report wrote a proper target_type=post row through report()');

-- =====================================================================
-- post_delete(): author always
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_delete('c0250000-0000-4000-8000-000000000001') $$,
  'the author deletes their own post');
select tests.clear_auth();
select results_eq(
  $$ select status::text, deleted_at is not null from public.workout_posts
     where id = 'c0250000-0000-4000-8000-000000000001' $$,
  $$ values ('removed'::text, true) $$,
  'the post is soft-removed');
select is_empty(
  $$ select 1 from public.admin_actions
     where action_type = 'content_delete' and target_type = 'post'
       and target_id = 'c0250000-0000-4000-8000-000000000001' $$,
  'an author removing their own post writes no content_delete audit row');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_delete('c0250000-0000-4000-8000-000000000001') $$,
  'a second author delete call is idempotent');

-- =====================================================================
-- post_delete(): a non-author with no qualifying permission raises
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.post_delete('c0250000-0000-4000-8000-000000000002') $$,
  'P0001',
  'not authorized',
  'a plain member cannot delete someone else''s post');

-- =====================================================================
-- post_delete(): a community.comment.moderate holder (coach) can remove a
-- post they did not author, writes exactly one content_delete audit row,
-- and a second call does not write a second one
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.post_delete('c0250000-0000-4000-8000-000000000002') $$,
  'a comment.moderate holder removes a post authored by someone else');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'content_delete' and target_type = 'post'
       and target_id = 'c0250000-0000-4000-8000-000000000002' $$,
  $$ values (1) $$,
  'the moderator removal wrote exactly one content_delete audit row');
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.post_delete('c0250000-0000-4000-8000-000000000002') $$,
  'a second moderator delete call on the same post is idempotent');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'content_delete' and target_type = 'post'
       and target_id = 'c0250000-0000-4000-8000-000000000002' $$,
  $$ values (1) $$,
  'the idempotent second call did not write a second audit row');

-- =====================================================================
-- comment_moderate(): auth gate, remove/restore, idempotency, one audit
-- row per real transition
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.comment_moderate('c0250000-0000-4000-8000-000000000102', 'remove') $$,
  'P0001',
  'not authorized',
  'a plain member cannot call comment_moderate');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.comment_moderate('c0250000-0000-4000-8000-000000000102', 'made_up') $$,
  'P0001',
  null,
  'an unknown action raises');
select lives_ok(
  $$ select public.comment_moderate('c0250000-0000-4000-8000-000000000102', 'remove') $$,
  'a comment.moderate holder removes C2');
select tests.clear_auth();
select results_eq(
  $$ select status::text, deleted_at is not null, deleted_by from public.post_comments
     where id = 'c0250000-0000-4000-8000-000000000102' $$,
  $$ values ('removed'::text, true, tests.uid('coach')) $$,
  'status, deleted_at, and deleted_by are all set together, stamped with the moderator');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'content_delete' and target_type = 'comment'
       and target_id = 'c0250000-0000-4000-8000-000000000102' $$,
  $$ values (1) $$,
  'the remove wrote exactly one content_delete audit row');
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.comment_moderate('c0250000-0000-4000-8000-000000000102', 'remove') $$,
  'a second remove call is idempotent and does not overwrite deleted_by');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'content_delete' and target_type = 'comment'
       and target_id = 'c0250000-0000-4000-8000-000000000102' $$,
  $$ values (1) $$,
  'the idempotent second remove did not write a second audit row');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.comment_moderate('c0250000-0000-4000-8000-000000000102', 'restore') $$,
  'a comment.moderate holder restores C2');
select tests.clear_auth();
select results_eq(
  $$ select status::text, deleted_at, deleted_by from public.post_comments
     where id = 'c0250000-0000-4000-8000-000000000102' $$,
  $$ values ('active'::text, null::timestamptz, null::uuid) $$,
  'restore clears status, deleted_at, and deleted_by together');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'content_delete' and target_type = 'comment'
       and target_id = 'c0250000-0000-4000-8000-000000000102' $$,
  $$ values (2) $$,
  'the restore wrote its own, second content_delete audit row');
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.comment_moderate('c0250000-0000-4000-8000-000000000102', 'restore') $$,
  'a second restore call is idempotent');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'content_delete' and target_type = 'comment'
       and target_id = 'c0250000-0000-4000-8000-000000000102' $$,
  $$ values (2) $$,
  'the idempotent second restore did not write a third audit row');

-- =====================================================================
-- mod_queue(): auth gate, grouping, reporter_count/reasons, status folding,
-- p_status = 'all', p_limit clamp, reporters shape
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.mod_queue('open', null, 50) $$,
  'P0001',
  'not authorized',
  'a plain member cannot call mod_queue');

select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000003', 'spam', '') $$,
  'm2 reports P3');
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000003', 'harassment', '') $$,
  'm3 also reports P3, a second reporter on the same target');

select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select count(*)::int from public.mod_queue('open', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000003' $$,
  $$ values (1) $$,
  'two reports on the same target fold into exactly one mod_queue row');
select results_eq(
  $$ select reporter_count from public.mod_queue('open', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000003' $$,
  $$ values (2) $$,
  'reporter_count is the distinct reporter count for the group');
select results_eq(
  $$ select array(select unnest(reasons) order by 1) from public.mod_queue('open', null, 50)
       where target_id = 'c0250000-0000-4000-8000-000000000003' $$,
  $$ values (array['harassment','spam']::text[]) $$,
  'reasons is the distinct set of reasons across the group');
select results_eq(
  $$ select jsonb_array_length(
       (select reporters from public.mod_queue('open', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000003')) $$,
  $$ values (2) $$,
  'reporters carries one jsonb entry per distinct reporter');
select isnt_empty(
  $$ select 1 from public.mod_queue('open', null, 50) r, jsonb_array_elements(r.reporters) e
     where r.target_id = 'c0250000-0000-4000-8000-000000000003'
       and e ->> 'id' = tests.uid('m2')::text and e ->> 'name' is not null $$,
  'each reporters entry carries id and a non-null name');

-- --- status folding: open > reviewing > dismissed > action_taken -------
select tests.clear_auth();
insert into public.reports (reporter_id, target_type, target_id, post_id, reason, status) values
  (tests.uid('m1'), 'post', 'c0250000-0000-4000-8000-000000000004', 'c0250000-0000-4000-8000-000000000004', 'spam', 'reviewing'),
  (tests.uid('m2'), 'post', 'c0250000-0000-4000-8000-000000000004', 'c0250000-0000-4000-8000-000000000004', 'spam', 'dismissed'),
  (tests.uid('m3'), 'post', 'c0250000-0000-4000-8000-000000000004', 'c0250000-0000-4000-8000-000000000004', 'spam', 'action_taken');
insert into public.reports (reporter_id, target_type, target_id, post_id, reason, status) values
  (tests.uid('m1'), 'post', 'c0250000-0000-4000-8000-000000000005', 'c0250000-0000-4000-8000-000000000005', 'spam', 'dismissed'),
  (tests.uid('m2'), 'post', 'c0250000-0000-4000-8000-000000000005', 'c0250000-0000-4000-8000-000000000005', 'spam', 'action_taken');
insert into public.reports (reporter_id, target_type, target_id, post_id, reason, status) values
  (tests.uid('m1'), 'post', 'c0250000-0000-4000-8000-000000000006', 'c0250000-0000-4000-8000-000000000006', 'spam', 'action_taken');

select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select status from public.mod_queue('all', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000004' $$,
  $$ values ('reviewing'::text) $$,
  'a group with reviewing, dismissed, and action_taken (no open) folds to reviewing');
select results_eq(
  $$ select status from public.mod_queue('all', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000005' $$,
  $$ values ('dismissed'::text) $$,
  'a group with dismissed and action_taken only folds to dismissed');
select results_eq(
  $$ select status from public.mod_queue('all', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000006' $$,
  $$ values ('action_taken'::text) $$,
  'a group with only action_taken folds to action_taken');

-- --- p_status = 'all' returns every group regardless of folded status --
select isnt_empty(
  $$ select 1 from public.mod_queue('all', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000004' $$,
  'p_status = all surfaces a reviewing-folded group');
select isnt_empty(
  $$ select 1 from public.mod_queue('all', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000006' $$,
  'p_status = all surfaces an action_taken-folded group too');
select is_empty(
  $$ select 1 from public.mod_queue('open', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000006' $$,
  'p_status = open does not surface the action_taken-only group');

-- --- p_limit clamps to 1..50 --------------------------------------------
select results_eq(
  $$ select count(*)::int from public.mod_queue('all', null, 0) $$,
  $$ values (1) $$,
  'p_limit = 0 clamps up to 1 row');
select ok(
  (select count(*)::int from public.mod_queue('all', null, 999)) <= 50,
  'p_limit = 999 clamps down to at most 50 rows');

-- =====================================================================
-- mod_review(): auth gate, unknown decision
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.mod_review('00000000-0000-4000-8000-000000000000'::uuid, 'dismiss', '', null) $$,
  'P0001',
  'not authorized',
  'a plain member cannot call mod_review, checked before any report lookup');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.mod_review(
       (select report_id from public.mod_queue('all', null, 50) where target_id = 'c0250000-0000-4000-8000-000000000004'),
       'made_up', '', null) $$,
  'P0001',
  null,
  'an unknown decision raises');

-- =====================================================================
-- mod_review(): remove on a post routes through post_delete - two audit
-- rows (content_delete + report_review)
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000007', 'spam', '') $$,
  'm3 reports P7');

select tests.set_auth(tests.uid('coach'));
select report_id as p7_report_id from public.mod_queue('all', null, 50)
  where target_id = 'c0250000-0000-4000-8000-000000000007' \gset
select lives_ok(
  format($$ select public.mod_review(%L::uuid, 'remove', 'removed via queue', null) $$, :'p7_report_id'),
  'a moderator removes P7 through mod_review');
select tests.clear_auth();
select results_eq(
  $$ select status::text from public.workout_posts where id = 'c0250000-0000-4000-8000-000000000007' $$,
  $$ values ('removed'::text) $$,
  'mod_review remove actually removed the post via post_delete');
select results_eq(
  $$ select status::text, reviewed_by, review_note from public.reports
     where target_id = 'c0250000-0000-4000-8000-000000000007' $$,
  $$ values ('action_taken'::text, tests.uid('coach'), 'removed via queue'::text) $$,
  'the report row is stamped action_taken, reviewed_by, and review_note');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where target_type = 'post' and target_id = 'c0250000-0000-4000-8000-000000000007' and action_type = 'content_delete' $$,
  $$ values (1) $$,
  'one content_delete audit row from the post_delete delegation');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where target_type = 'report' and action_type = 'report_review'
       and target_id = (select id from public.reports where target_id = 'c0250000-0000-4000-8000-000000000007') $$,
  $$ values (1) $$,
  'one report_review audit row from mod_review itself');

-- =====================================================================
-- mod_review(): remove on a comment routes through comment_moderate
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.report('comment', 'c0250000-0000-4000-8000-000000000103', 'harassment', '') $$,
  'm2 reports C3');

select tests.set_auth(tests.uid('admin'));
select report_id as c3_report_id from public.mod_queue('all', null, 50)
  where target_id = 'c0250000-0000-4000-8000-000000000103' \gset
select lives_ok(
  format($$ select public.mod_review(%L::uuid, 'remove', 'removed comment via queue', null) $$, :'c3_report_id'),
  'a real admin removes C3 through mod_review');
select tests.clear_auth();
select results_eq(
  $$ select status::text, deleted_by from public.post_comments where id = 'c0250000-0000-4000-8000-000000000103' $$,
  $$ values ('removed'::text, tests.uid('admin')) $$,
  'mod_review remove actually removed the comment via comment_moderate, stamped with the admin');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where target_type = 'comment' and target_id = 'c0250000-0000-4000-8000-000000000103' and action_type = 'content_delete' $$,
  $$ values (1) $$,
  'one content_delete audit row from the comment_moderate delegation');

-- =====================================================================
-- mod_review(): restrict_temp / restrict_permanent route through
-- mod_restrict_member, which itself needs community.member.restrict - a
-- comment.moderate-only caller can pick the decision but the call raises
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000008', 'spam', '') $$,
  'm2 reports P8, authored by m1');

select tests.set_auth(tests.uid('coach'));
select report_id as p8_report_id from public.mod_queue('all', null, 50)
  where target_id = 'c0250000-0000-4000-8000-000000000008' \gset
select throws_ok(
  format($$ select public.mod_review(%L::uuid, 'restrict_temp', 'x', now() + interval '1 day') $$, :'p8_report_id'),
  'P0001',
  'not authorized',
  'a comment.moderate-only caller picking restrict_temp is refused by the underlying mod_restrict_member call');

-- =====================================================================
-- mod_review(): restrict_temp with a real moderator (admin, who does hold
-- community.member.restrict) actually restricts the content author
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-000000000009', 'spam', '') $$,
  'm2 reports P9, authored by m3');

select tests.set_auth(tests.uid('admin'));
select report_id as p9_report_id from public.mod_queue('all', null, 50)
  where target_id = 'c0250000-0000-4000-8000-000000000009' \gset
select lives_ok(
  format($$ select public.mod_review(%L::uuid, 'restrict_temp', 'restrict note', now() + interval '2 days') $$, :'p9_report_id'),
  'an admin restrict_temps the author of P9 through mod_review');
select tests.clear_auth();
select isnt_empty(
  format($$ select 1 from public.posting_restrictions
     where user_id = tests.uid('m3') and restriction_type = 'temporary'
       and source_report_id = %L::uuid $$, :'p9_report_id'),
  'a temporary posting_restrictions row was created for the content author, linked back to the report');
select results_eq(
  $$ select status::text, review_note from public.reports where target_id = 'c0250000-0000-4000-8000-000000000009' $$,
  $$ values ('action_taken'::text, 'restrict note'::text) $$,
  'the report row is stamped action_taken with the review note');

-- =====================================================================
-- mod_review(): restrict_permanent, and p_expires_at is read only for
-- restrict_temp - passed here anyway, and ignored
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-00000000000a', 'spam', '') $$,
  'm3 reports P10, authored by m2');

select tests.set_auth(tests.uid('admin'));
select report_id as p10_report_id from public.mod_queue('all', null, 50)
  where target_id = 'c0250000-0000-4000-8000-00000000000a' \gset
select lives_ok(
  format($$ select public.mod_review(%L::uuid, 'restrict_permanent', 'perm note', now() + interval '3 days') $$, :'p10_report_id'),
  'an admin restrict_permanents the author of P10, passing an expires_at that should be ignored');
select tests.clear_auth();
select results_eq(
  format($$ select restriction_type, expires_at from public.posting_restrictions
     where user_id = tests.uid('m2') and restriction_type = 'permanent'
       and source_report_id = %L::uuid $$, :'p10_report_id'),
  $$ values ('permanent'::text, null::timestamptz) $$,
  'the permanent restriction carries no expiry even though p_expires_at was passed');

-- =====================================================================
-- mod_review(): dismiss maps to dismissed, warn (and everything else) maps
-- to action_taken, and every decision writes one report_review audit row
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-00000000000b', 'spam', '') $$,
  'm2 reports P11');

select tests.set_auth(tests.uid('coach'));
select report_id as p11_report_id from public.mod_queue('all', null, 50)
  where target_id = 'c0250000-0000-4000-8000-00000000000b' \gset
select lives_ok(
  format($$ select public.mod_review(%L::uuid, 'dismiss', 'not a real problem', null) $$, :'p11_report_id'),
  'a moderator dismisses the report on P11');
select tests.clear_auth();
select results_eq(
  $$ select status::text from public.reports where target_id = 'c0250000-0000-4000-8000-00000000000b' $$,
  $$ values ('dismissed'::text) $$,
  'dismiss maps status to dismissed');
select results_eq(
  format($$ select before_data ->> 'status', after_data ->> 'status', after_data ->> 'decision'
     from public.admin_actions
     where target_type = 'report' and action_type = 'report_review'
       and target_id = %L::uuid $$, :'p11_report_id'),
  $$ values ('open'::text, 'dismissed'::text, 'dismiss'::text) $$,
  'the report_review audit row carries before {status: open} and after {status: dismissed, decision: dismiss}');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-00000000000c', 'spam', '') $$,
  'm3 reports P12');

select tests.set_auth(tests.uid('coach'));
select report_id as p12_report_id from public.mod_queue('all', null, 50)
  where target_id = 'c0250000-0000-4000-8000-00000000000c' \gset
select lives_ok(
  format($$ select public.mod_review(%L::uuid, 'warn', 'a warning was issued off-platform', null) $$, :'p12_report_id'),
  'a moderator issues a warn decision on P12');
select tests.clear_auth();
select results_eq(
  $$ select status::text from public.reports where target_id = 'c0250000-0000-4000-8000-00000000000c' $$,
  $$ values ('action_taken'::text) $$,
  'warn (like every non-dismiss decision) maps status to action_taken');
select is_empty(
  $$ select 1 from public.admin_actions
     where target_type = 'post' and target_id = 'c0250000-0000-4000-8000-00000000000c' and action_type = 'content_delete' $$,
  'a warn decision does not remove the post: no content_delete audit row for it');

-- =====================================================================
-- mod_review(): every decision stamps every report row for the target,
-- not just the one p_report_id passed in
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-00000000000d', 'spam', 'from m1') $$,
  'm1 reports P13');
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.report('post', 'c0250000-0000-4000-8000-00000000000d', 'harassment', 'from m2') $$,
  'm2 also reports P13');

select tests.clear_auth();
select id as p13_m1_report_id from public.reports
  where target_id = 'c0250000-0000-4000-8000-00000000000d' and reporter_id = tests.uid('m1') \gset
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  format($$ select public.mod_review(%L::uuid, 'dismiss', 'group dismiss', null) $$, :'p13_m1_report_id'),
  'a moderator dismisses using only one of the two report ids on this target');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.reports
     where target_id = 'c0250000-0000-4000-8000-00000000000d' and status = 'dismissed' and review_note = 'group dismiss' $$,
  $$ values (2) $$,
  'both report rows on the target were stamped, not only the one whose id was passed');

-- =====================================================================
-- admin_grant_coach / admin_revoke_coach: real is_admin only
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.admin_grant_coach(tests.uid('m2'), 'coach') $$,
  'P0001',
  'not authorized',
  'a comment.moderate holder who is not a real admin cannot grant coach');
select throws_ok(
  $$ select public.admin_revoke_coach(tests.uid('m1')) $$,
  'P0001',
  'not authorized',
  'a comment.moderate holder who is not a real admin cannot revoke coach either');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.admin_grant_coach(tests.uid('m2'), 'staff') $$,
  'P0001',
  null,
  'the two-argument form refuses a role outside coach/head_coach');

select tests.clear_auth();
select results_eq(
  $$ select role from public.invite_redemptions where user_id = tests.uid('m3') $$,
  $$ values ('member'::text) $$,
  'sanity: m3 starts as a plain member');
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_grant_coach(tests.uid('m3'), 'head_coach') $$,
  'a real admin grants head_coach through the two-argument form');
select tests.clear_auth();
select results_eq(
  $$ select role from public.invite_redemptions where user_id = tests.uid('m3') $$,
  $$ values ('head_coach'::text) $$,
  'm3''s role is now head_coach');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'role_change' and target_type = 'member' and target_id = tests.uid('m3') $$,
  $$ values (1) $$,
  'sanity: exactly one role_change audit row exists for m3 so far');
select isnt_empty(
  $$ select 1 from public.admin_actions
     where action_type = 'role_change' and target_type = 'member' and target_id = tests.uid('m3')
       and before_data ->> 'role' = 'member' and after_data ->> 'role' = 'head_coach' $$,
  'the grant wrote a role_change audit row with the prior and new role');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_grant_coach(tests.uid('m2')) $$,
  'the one-argument form still resolves and is not ambiguous');
select tests.clear_auth();
select results_eq(
  $$ select role from public.invite_redemptions where user_id = tests.uid('m2') $$,
  $$ values ('coach'::text) $$,
  'the one-argument form granted coach specifically');

-- --- revoke of someone already a plain member writes nothing -----------
select results_eq(
  $$ select role from public.invite_redemptions where user_id = tests.uid('m1') $$,
  $$ values ('member'::text) $$,
  'sanity: m1 is already a plain member');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'role_change' and target_type = 'member' and target_id = tests.uid('m1') $$,
  $$ values (0) $$,
  'sanity: no role_change audit row exists yet for m1');
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_revoke_coach(tests.uid('m1')) $$,
  'revoking coach from an already-plain-member is a no-op call, not a raise');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'role_change' and target_type = 'member' and target_id = tests.uid('m1') $$,
  $$ values (0) $$,
  'the no-op revoke wrote no role_change audit row');

-- --- a real revoke writes its audit row ---------------------------------
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_revoke_coach(tests.uid('m3')) $$,
  'the admin revokes m3''s head_coach role');
select tests.clear_auth();
select results_eq(
  $$ select role from public.invite_redemptions where user_id = tests.uid('m3') $$,
  $$ values ('member'::text) $$,
  'm3''s role reverted to member');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'role_change' and target_type = 'member' and target_id = tests.uid('m3') $$,
  $$ values (2) $$,
  'the revoke added a second role_change audit row for m3 (grant, then revoke)');
select isnt_empty(
  $$ select 1 from public.admin_actions
     where action_type = 'role_change' and target_type = 'member' and target_id = tests.uid('m3')
       and before_data ->> 'role' = 'head_coach' and after_data ->> 'role' = 'member' $$,
  'the revoke wrote a role_change audit row with the prior and new role');

select * from finish();
rollback;
