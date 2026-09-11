-- Security hunt, round 10 (202609120012): RLS is row-level only. reports'
-- and posting_restrictions' "read your own row" policies were written
-- before reviewed_by/review_note/resolution_notes and moderator_id/
-- lifted_by/source_report_id/lift_reason existed on those tables, and
-- were never revisited when those staff-internal columns were added - a
-- member reading their OWN row could also read exactly which staff
-- member acted on it, and that staff member's private notes. This proves
-- the exact live repro from the hunt: file a report, have it reviewed,
-- then read it back as the reporter - and the equivalent for a
-- restriction.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body, status)
values ('b1090000-0000-4000-8000-000000000001', tests.uid('m2'), 'club', 'reported post', 'active');

-- --- reports: the self-read branch is gone, not narrowed --------------
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.report('post', 'b1090000-0000-4000-8000-000000000001', 'spam', 'this looks like spam') $$,
  'm1 files a real report');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.mod_review(
       (select id from public.reports where reporter_id = tests.uid('m1') and target_id = 'b1090000-0000-4000-8000-000000000001'),
       'dismiss', 'reporter is wrong, this is not spam - internal note', null) $$,
  'admin reviews and dismisses the report, leaving a staff-internal note');

select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.reports where reporter_id = tests.uid('m1') $$,
  'the reporter can no longer read their own report row directly at all - reviewed_by/review_note were never meant to be reporter-facing, and there is no legitimate client path that needed self-read here');

-- --- posting_restrictions: self-read survives, but only the safe columns
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.mod_restrict_member(tests.uid('m3'), 'permanent', null, 'you can read this reason', null) $$,
  'staff restricts m3, with a reason the member is owed');

select tests.set_auth(tests.uid('m3'));
select is_empty(
  $$ select 1 from public.posting_restrictions where user_id = tests.uid('m3') $$,
  'a direct table read of one''s own restriction is refused');

select results_eq(
  $$ select restriction_type, reason from public.my_posting_restrictions() $$,
  $$ values ('permanent'::text, 'you can read this reason'::text) $$,
  'my_posting_restrictions() gives the member the type and reason they are owed');

-- The actual column-level proof: my_posting_restrictions()'s declared
-- return shape has no moderator_id column at all - not just "empty in
-- this row", structurally absent, so a future column added to the
-- underlying table does not silently leak through this function by
-- default the way `select *` would have.
select throws_ok(
  $$ select moderator_id from public.my_posting_restrictions() $$,
  '42703',
  null,
  'my_posting_restrictions()''s return shape has no moderator_id column to ever expose');

select * from finish();
rollback;
