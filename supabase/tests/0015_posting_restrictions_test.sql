-- COMM-020: real two-user RLS enforcement for 202608280015 (posting
-- restrictions).
-- Boundaries: posting_restrictions has no insert, update, or delete policy
-- and no grant for any of the three, a community.member.restrict holder
-- included - the only write path is mod_restrict_member() / mod_lift_
-- restriction(). A member reads their own restrictions and nobody else's
-- unless they hold community.member.restrict or community.comment.moderate.
-- The expiry/type CHECK holds. mod_restrict_member and mod_lift_restriction
-- both gate on community.member.restrict specifically (comment.moderate is
-- not enough) and both write an admin_actions row. is_posting_restricted
-- raises for a plain member asking about someone else, and answers for a
-- moderator. The behavioural point: a restricted member's workout_posts
-- insert is refused by posts_insert_self, add_post_comment and comment_edit
-- both raise posting_restricted, and an expired restriction stops applying
-- with no cron run, because expiry is evaluated at read time.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- no client can write the table directly, a permission holder ----
-- --- (admin, real is_admin, resolves role_code 'admin') included ----
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ insert into public.posting_restrictions (user_id, restriction_type, reason, moderator_id)
     values (tests.uid('m1'), 'permanent', 'x', tests.uid('admin')) $$,
  '42501',
  null,
  'a community.member.restrict holder cannot insert a restriction row directly');
select throws_ok(
  $$ update public.posting_restrictions set reason = 'y' $$,
  '42501',
  null,
  'a community.member.restrict holder cannot update a restriction row directly');
select throws_ok(
  $$ delete from public.posting_restrictions $$,
  '42501',
  null,
  'a community.member.restrict holder cannot delete a restriction row directly');

-- --- the expiry/type CHECK, built as the bootstrap superuser --------
select tests.clear_auth();
select throws_ok(
  $$ insert into public.posting_restrictions (user_id, restriction_type, expires_at, reason, moderator_id)
     values (tests.uid('m3'), 'temporary', null, 'x', tests.uid('admin')) $$,
  '23514',
  null,
  'a temporary restriction with a null expires_at fails the CHECK');
select throws_ok(
  $$ insert into public.posting_restrictions (user_id, restriction_type, expires_at, reason, moderator_id)
     values (tests.uid('m3'), 'permanent', now() + interval '1 day', 'x', tests.uid('admin')) $$,
  '23514',
  null,
  'a permanent restriction with a non-null expires_at fails the CHECK');

-- =====================================================================
-- mod_restrict_member: the permission gate
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.mod_restrict_member(tests.uid('m2'), 'permanent') $$,
  'P0001',
  'not authorized',
  'a plain member cannot call mod_restrict_member');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.mod_restrict_member(tests.uid('m2'), 'permanent') $$,
  'P0001',
  'not authorized',
  'community.comment.moderate alone does not authorize mod_restrict_member');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.mod_restrict_member(tests.uid('admin'), 'permanent') $$,
  'P0001',
  'cannot restrict yourself',
  'a moderator cannot restrict themselves');
select throws_ok(
  $$ select public.mod_restrict_member('00000000-4000-4000-8000-0000000000ff'::uuid, 'permanent') $$,
  'P0001',
  'member not found',
  'mod_restrict_member refuses an unknown member id');
select throws_ok(
  $$ select public.mod_restrict_member(tests.uid('m1'), 'bogus') $$,
  'P0001',
  'unknown restriction type bogus',
  'mod_restrict_member refuses an unknown restriction type');
select throws_ok(
  $$ select public.mod_restrict_member(tests.uid('m1'), 'temporary', now() - interval '1 hour') $$,
  'P0001',
  'a temporary restriction needs an end time in the future',
  'a temporary restriction needs a future expiry');

-- --- a real restriction, and the admin_actions row it must leave -----
select isnt_empty(
  $$ select public.mod_restrict_member(tests.uid('m1'), 'permanent', null, 'spam', null) $$,
  'the permission holder restricts member A');
select isnt_empty(
  $$ select 1 from public.admin_actions
     where action_type = 'member_restrict' and target_id = tests.uid('m1') $$,
  'mod_restrict_member left a member_restrict admin_actions row');

-- =====================================================================
-- read boundary
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.posting_restrictions where user_id = tests.uid('m1') $$,
  'a plain member cannot read another member''s restriction');

select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.posting_restrictions where user_id = tests.uid('m1') $$,
  'the restricted member reads their own restriction');

select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select 1 from public.posting_restrictions where user_id = tests.uid('m1') $$,
  'a community.comment.moderate holder reads someone else''s restriction');

-- =====================================================================
-- is_posting_restricted
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.is_posting_restricted(tests.uid('m1')) $$,
  'P0001',
  'not authorized',
  'a plain member cannot ask about someone else''s restriction status');
select is(
  public.is_posting_restricted(),
  false,
  'a plain member can ask about their own status');

select tests.set_auth(tests.uid('coach'));
select is(
  public.is_posting_restricted(tests.uid('m1')),
  true,
  'a moderator can ask about someone else''s status and gets the real answer');

select tests.set_auth(tests.uid('m1'));
select is(
  public.is_posting_restricted(),
  true,
  'the restricted member sees their own status as true');

-- =====================================================================
-- behavioural enforcement point 1: workout_posts insert
-- =====================================================================
select throws_ok(
  $$ insert into public.workout_posts (author_id, visibility, body)
     values (tests.uid('m1'), 'club', 'should be blocked') $$,
  '42501',
  null,
  'a restricted member''s workout_posts insert is refused by posts_insert_self');

-- =====================================================================
-- behavioural enforcement point 2: add_post_comment / comment_edit
-- =====================================================================
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body) values
  ('c0150000-0000-4000-8000-000000000001', tests.uid('m2'), 'club', 'host post');
-- m1's own comment, written before the restriction landed, so comment_edit
-- has an authored row to attempt and the restriction can be shown to catch
-- an edit on old content too.
insert into public.post_comments (id, post_id, author_id, body) values
  ('c0150000-0000-4000-8000-000000000011', 'c0150000-0000-4000-8000-000000000001', tests.uid('m1'), 'before the restriction');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.add_post_comment('c0150000-0000-4000-8000-000000000001', 'trying to comment', null) $$,
  'P0001',
  'posting_restricted',
  'add_post_comment raises posting_restricted for a restricted member');
select throws_ok(
  $$ select public.comment_edit('c0150000-0000-4000-8000-000000000011', 'rewritten') $$,
  'P0001',
  'posting_restricted',
  'comment_edit refuses to let a restricted member rewrite an old comment');

-- =====================================================================
-- mod_lift_restriction
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.mod_lift_restriction('00000000-4000-4000-8000-0000000000ff'::uuid) $$,
  'P0001',
  'not authorized',
  'a plain member cannot call mod_lift_restriction');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.mod_lift_restriction('00000000-4000-4000-8000-0000000000ff'::uuid) $$,
  'P0001',
  'restriction not found',
  'mod_lift_restriction refuses an unknown restriction id');

select lives_ok(
  $$ select public.mod_lift_restriction(
       (select id from public.posting_restrictions where user_id = tests.uid('m1')), 'appeal accepted') $$,
  'the permission holder lifts member A''s restriction');
select isnt_empty(
  $$ select 1 from public.admin_actions
     where action_type = 'member_unrestrict' and target_id = tests.uid('m1') $$,
  'mod_lift_restriction left a member_unrestrict admin_actions row');

select lives_ok(
  $$ select public.mod_lift_restriction(
       (select id from public.posting_restrictions where user_id = tests.uid('m1')), 'second call') $$,
  'lifting an already-lifted restriction a second time is a silent no-op');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'member_unrestrict' and target_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'the no-op second lift did not write a second admin_actions row');

select tests.set_auth(tests.uid('m1'));
select is(
  public.is_posting_restricted(),
  false,
  'member A is no longer restricted after the lift');
select lives_ok(
  $$ insert into public.workout_posts (author_id, visibility, body)
     values (tests.uid('m1'), 'club', 'allowed again') $$,
  'member A can post again once the restriction is lifted');

-- =====================================================================
-- expiry is evaluated at read time, no cron, no backfill
-- =====================================================================
select tests.clear_auth();
insert into public.posting_restrictions
  (user_id, restriction_type, expires_at, reason, moderator_id, created_at)
values
  (tests.uid('m3'), 'temporary', now() - interval '1 hour', 'already over', tests.uid('admin'), now() - interval '2 hours');

select tests.set_auth(tests.uid('m3'));
select is(
  public.is_posting_restricted(),
  false,
  'a restriction whose expires_at has already passed no longer applies');
select lives_ok(
  $$ insert into public.workout_posts (author_id, visibility, body)
     values (tests.uid('m3'), 'club', 'expired restriction does not block this') $$,
  'a member with only an expired restriction can post');

select * from finish();
rollback;
