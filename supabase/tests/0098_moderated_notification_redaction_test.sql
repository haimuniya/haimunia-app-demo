-- Security hunt round 4 (202609110005): a removed comment's exact text used
-- to survive, fully readable, in the recipient's own notifications row -
-- confirmed live before this fix by commenting, moderating the comment
-- away, and re-reading notifications as the recipient. This file proves
-- comment_moderate('remove') and post_delete() now blank that snapshot,
-- that 'restore' does not bring it back, and that an untouched notification
-- (no moderation action on its source) is completely unaffected.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into public.workout_posts (id, author_id, post_type, visibility, status, body, created_at, published_at)
values ('ff000000-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_TEXT', 'club', 'active', 'הפוסט של m1', now(), now());

-- =====================================================================
-- comment_moderate('remove') redacts the notification it created.
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select public.add_post_comment('ff000000-0000-4000-8000-000000000001', 'AGENTJ-SECRET-ABUSE-TEXT-77219', null) as comment_id \gset
select tests.clear_auth();

select results_eq(
  format($$ select body from public.notifications
            where user_id = tests.uid('m1') and source_type = 'comment' and source_id = %L::uuid $$, :'comment_id'),
  $$ values ('AGENTJ-SECRET-ABUSE-TEXT-77219') $$,
  'before moderation: the notification really does carry the comment''s exact text - the baseline the fix regresses against');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  format($$ select public.comment_moderate(%L, 'remove') $$, :'comment_id'),
  'admin removes the comment');
select tests.clear_auth();

select results_eq(
  format($$ select title, body from public.notifications
            where user_id = tests.uid('m1') and source_type = 'comment' and source_id = %L::uuid $$, :'comment_id'),
  $$ values ('', '') $$,
  'after removal: the notification title/body are blanked - the exact text is no longer readable by the recipient');

select is_empty(
  format($$ select 1 from public.post_comments where id = %L::uuid and status = 'active' $$, :'comment_id'),
  'sanity check: the comment itself is really removed');

-- Restoring the comment must NOT bring the notification text back.
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  format($$ select public.comment_moderate(%L, 'restore') $$, :'comment_id'),
  'admin restores the comment');
select tests.clear_auth();

select results_eq(
  format($$ select body from public.notifications
            where user_id = tests.uid('m1') and source_type = 'comment' and source_id = %L::uuid $$, :'comment_id'),
  $$ values ('') $$,
  'restoring the comment does not un-redact the notification - once blanked, stays blanked');
select results_eq(
  format($$ select status::text from public.post_comments where id = %L::uuid $$, :'comment_id'),
  $$ values ('active') $$,
  'but the comment itself really is active again - redaction is one-directional and does not fight restore');

-- =====================================================================
-- An untouched notification (no moderation action ever taken) is not
-- collaterally redacted - this is a targeted fix, not a blanket wipe.
-- =====================================================================
-- m3, not m2: a SECOND comment from the same commenter on the same post
-- routes through notif_on_comment's batched 'comment_also' path instead of
-- an immediate notif_create() row, which would make this its own separate
-- (and irrelevant) thing to prove rather than testing what this assertion
-- is actually about.
select tests.set_auth(tests.uid('m3'));
select public.add_post_comment('ff000000-0000-4000-8000-000000000001', 'a perfectly ordinary comment', null) as comment_id2 \gset
select tests.clear_auth();

select results_eq(
  format($$ select body from public.notifications
            where user_id = tests.uid('m1') and source_type = 'comment' and source_id = %L::uuid $$, :'comment_id2'),
  $$ values ('a perfectly ordinary comment') $$,
  'a comment nobody ever moderated keeps its real notification text');

-- =====================================================================
-- post_delete() redacts a notification pointing directly at the post
-- (source_type = 'post'), e.g. a report alert - seeded directly via
-- notif_create() rather than wiring up the full report() flow.
-- =====================================================================
select public.notif_create(
  tests.uid('admin'), 'new_report', 'community', 'New report', 'תלונה על פוסט חשוד',
  'post', 'ff000000-0000-4000-8000-000000000001'::uuid, '/community/feed?post=ff000000-0000-4000-8000-000000000001'
);

select results_eq(
  $$ select body from public.notifications
     where user_id = tests.uid('admin') and source_type = 'post' and source_id = 'ff000000-0000-4000-8000-000000000001'::uuid $$,
  $$ values ('תלונה על פוסט חשוד') $$,
  'the seeded post-level notification carries its real text before any moderation action');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.post_delete('ff000000-0000-4000-8000-000000000001'::uuid) $$,
  'the post is removed (by the admin acting on their own alert, for test simplicity)');
select tests.clear_auth();

select results_eq(
  $$ select title, body from public.notifications
     where user_id = tests.uid('admin') and source_type = 'post' and source_id = 'ff000000-0000-4000-8000-000000000001'::uuid $$,
  $$ values ('', '') $$,
  'post_delete() blanks the post-level notification the same way comment_moderate() blanks a comment-level one');

select * from finish();
rollback;
