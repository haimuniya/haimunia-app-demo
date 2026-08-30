-- COMM-020 run B: real enforcement for 202608280021 (comment mentions and
-- self-delete).
-- Boundaries: comment_mentions is select-only for everyone, an author and a
-- moderator included - no client can insert, update, or delete it directly.
-- A member reads a mention row only when they are the mentioned user or the
-- comment author; a third member who can read the comment reads no mention
-- rows for it. The four-argument add_post_comment: a target with
-- allow_mentions off gets no row while the comment itself still lands; a
-- target behind a block edge in either direction gets no row either; self-
-- mention and duplicate ids write nothing extra; eleven mentions raises; the
-- two- and three-argument forms still resolve and behave as before.
-- comment_delete: a non-author is refused, the author's call sets status,
-- deleted_at, and deleted_by together, a second call on an already-removed
-- comment is a silent no-op that does not overwrite a moderator's
-- deleted_by, and the soft-deleted comment drops out of the visible set for
-- everyone but its author and a community.comment.moderate holder while its
-- replies keep parent_comment_id intact.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- fixture post and comment, one mentioned member with allow_mentions
-- switched off, a block edge between m1 and m3 -------------------------
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body) values
  ('c0210000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'host post');
update public.profiles set allow_mentions = false where id = tests.uid('norec');
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m3'));

-- =====================================================================
-- comment_mentions: select is the only grant/policy, everyone included
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.comment_mentions (comment_id, mentioned_user_id)
     values ('00000000-0000-4000-8000-000000000000', tests.uid('m2')) $$,
  '42501',
  null,
  'an author cannot insert a comment_mentions row directly');
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ update public.comment_mentions set created_at = now() $$,
  '42501',
  null,
  'a moderator cannot update comment_mentions directly');
select throws_ok(
  $$ delete from public.comment_mentions $$,
  '42501',
  null,
  'a moderator cannot delete comment_mentions directly');

-- =====================================================================
-- add_post_comment(4-arg): mention acceptance, block edge, allow_mentions
-- off, self-mention, duplicate, cap
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.add_post_comment('c0210000-0000-4000-8000-000000000001', 'hey @m2',
       null, array[tests.uid('m2')]) $$,
  'a comment with one valid mention target is created');
select isnt_empty(
  $$ select 1 from public.comment_mentions cm
     join public.post_comments c on c.id = cm.comment_id
     where c.post_id = 'c0210000-0000-4000-8000-000000000001' and c.body = 'hey @m2'
       and cm.mentioned_user_id = tests.uid('m2') $$,
  'the accepted mention wrote a comment_mentions row');

-- allow_mentions off: the comment lands, no mention row for that target
select lives_ok(
  $$ select public.add_post_comment('c0210000-0000-4000-8000-000000000001', 'hey @norec',
       null, array[tests.uid('norec')]) $$,
  'a comment mentioning a target with allow_mentions off still lands');
select is_empty(
  $$ select 1 from public.comment_mentions cm
     join public.post_comments c on c.id = cm.comment_id
     where c.post_id = 'c0210000-0000-4000-8000-000000000001' and c.body = 'hey @norec' $$,
  'no comment_mentions row was written for the allow_mentions-off target');

-- block edge either direction: comment lands, mention is dropped, not raised
select lives_ok(
  $$ select public.add_post_comment('c0210000-0000-4000-8000-000000000001', 'hey @m3 blocked',
       null, array[tests.uid('m3')]) $$,
  'a comment mentioning a target behind a block edge still lands rather than erroring the whole comment');
select is_empty(
  $$ select 1 from public.comment_mentions cm
     join public.post_comments c on c.id = cm.comment_id
     where c.post_id = 'c0210000-0000-4000-8000-000000000001' and c.body = 'hey @m3 blocked' $$,
  'no comment_mentions row was written across the block edge');

select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m1') and blocked_id = tests.uid('m3');
select tests.set_auth(tests.uid('m1'));

-- self-mention and duplicate ids write nothing extra
select lives_ok(
  $$ select public.add_post_comment('c0210000-0000-4000-8000-000000000001', 'talking to myself',
       null, array[tests.uid('m1'), tests.uid('m2'), tests.uid('m2')]) $$,
  'a comment with a self-mention and a duplicate target is created');
select results_eq(
  $$ select count(*)::int from public.comment_mentions cm
     join public.post_comments c on c.id = cm.comment_id
     where c.post_id = 'c0210000-0000-4000-8000-000000000001' and c.body = 'talking to myself' $$,
  $$ values (1) $$,
  'the self-mention wrote nothing and the duplicate target collapsed to exactly one row');
select is_empty(
  $$ select 1 from public.comment_mentions cm
     join public.post_comments c on c.id = cm.comment_id
     where c.post_id = 'c0210000-0000-4000-8000-000000000001' and c.body = 'talking to myself'
       and cm.mentioned_user_id = tests.uid('m1') $$,
  'specifically, the caller mentioning themselves wrote no row');

-- eleven mentions raises
select throws_ok(
  $$ select public.add_post_comment('c0210000-0000-4000-8000-000000000001', 'too many mentions', null,
       array[tests.uid('m2'), tests.uid('m3'), tests.uid('coach'), tests.uid('admin'), tests.uid('owner'),
             tests.uid('norec'), tests.uid('m2'), tests.uid('m3'), tests.uid('coach'), tests.uid('admin'),
             tests.uid('owner')]) $$,
  'P0001',
  'at most 10 mentions per comment',
  'eleven mention targets in one call is refused, even with duplicates among them');
select is_empty(
  $$ select 1 from public.post_comments where body = 'too many mentions' $$,
  'the over-cap call was refused before the comment itself was written');

-- =====================================================================
-- the two- and three-argument forms still resolve and behave as before
-- =====================================================================
select lives_ok(
  $$ select public.add_post_comment('c0210000-0000-4000-8000-000000000001', 'legacy two-arg') $$,
  'the two-argument add_post_comment still resolves');
select lives_ok(
  $$ select public.add_post_comment('c0210000-0000-4000-8000-000000000001', 'legacy three-arg', null) $$,
  'the three-argument add_post_comment still resolves');

-- =====================================================================
-- comment_delete: author-only self delete
-- =====================================================================
select tests.clear_auth();
insert into public.post_comments (id, post_id, author_id, body) values
  ('c0210000-0000-4000-8000-000000000011', 'c0210000-0000-4000-8000-000000000001', tests.uid('m2'), 'delete me');

select tests.set_auth(tests.uid('m3'));
select throws_ok(
  $$ select public.comment_delete('c0210000-0000-4000-8000-000000000011') $$,
  'P0001',
  'not authorized',
  'a non-author cannot delete someone else''s comment');

select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.comment_delete('c0210000-0000-4000-8000-000000000011') $$,
  'the author soft-deletes their own comment');
select results_eq(
  $$ select status::text, deleted_at is not null, deleted_by from public.post_comments
     where id = 'c0210000-0000-4000-8000-000000000011' $$,
  $$ values ('removed', true, tests.uid('m2')) $$,
  'status, deleted_at, and deleted_by are set together, deleted_by is the author');

-- --- a second call, from the author again, is a silent no-op ----------
select lives_ok(
  $$ select public.comment_delete('c0210000-0000-4000-8000-000000000011') $$,
  'a second self-delete call on an already-removed comment is a silent no-op');

-- --- a moderator-removed comment: the author's delete call afterwards
-- must NOT overwrite the moderator's deleted_by stamp ------------------
select tests.clear_auth();
insert into public.post_comments (id, post_id, author_id, body) values
  ('c0210000-0000-4000-8000-000000000012', 'c0210000-0000-4000-8000-000000000001', tests.uid('m2'), 'mod will remove me');
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.comment_moderate('c0210000-0000-4000-8000-000000000012', 'remove') $$,
  'a moderator removes the comment first');
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.comment_delete('c0210000-0000-4000-8000-000000000012') $$,
  'the author''s own delete call on an already-moderator-removed comment does not raise');
select results_eq(
  $$ select deleted_by from public.post_comments where id = 'c0210000-0000-4000-8000-000000000012' $$,
  $$ values (tests.uid('coach')) $$,
  'the moderator''s deleted_by stamp survives the author''s later delete call untouched');

-- =====================================================================
-- visibility of the soft-deleted comment and its reply
-- =====================================================================
select tests.clear_auth();
insert into public.post_comments (id, post_id, author_id, body, parent_comment_id) values
  ('c0210000-0000-4000-8000-000000000013', 'c0210000-0000-4000-8000-000000000001', tests.uid('m3'), 'a reply to the removed comment', 'c0210000-0000-4000-8000-000000000011');

select tests.set_auth(tests.uid('m3'));
select is_empty(
  $$ select 1 from public.post_comments where id = 'c0210000-0000-4000-8000-000000000011' $$,
  'a stranger member cannot see the self-removed comment');
select isnt_empty(
  $$ select 1 from public.post_comments where id = 'c0210000-0000-4000-8000-000000000013' $$,
  'the reply pointing at the removed comment is still visible to a stranger');

select tests.clear_auth();
select results_eq(
  $$ select parent_comment_id from public.post_comments where id = 'c0210000-0000-4000-8000-000000000013' $$,
  $$ values ('c0210000-0000-4000-8000-000000000011'::uuid) $$,
  'the reply keeps its parent_comment_id intact');

select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.post_comments where id = 'c0210000-0000-4000-8000-000000000011' $$,
  'the author still sees their own removed comment');

select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select 1 from public.post_comments where id = 'c0210000-0000-4000-8000-000000000011' $$,
  'a community.comment.moderate holder still sees the removed comment');

select * from finish();
rollback;
