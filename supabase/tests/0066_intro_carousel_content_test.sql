-- Redesign, Phase 3. intro_carousel_content: byte-identical shape to
-- 0059_onboarding_step_content_test.sql's own coverage, renamed - a
-- deliberate three-row sibling, not a widening, of onboarding_step_content
-- (see 202609050007's own comment for why). The write-boundary note there
-- applies unchanged: UPDATE under RLS does not raise when USING is false,
-- so "a member cannot edit a screen" is asserted as "succeeds, changes
-- nothing", the real behaviour.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Exactly three rows, carrying the seeded copy
-- =====================================================================
select results_eq(
  $$ select count(*)::int from public.intro_carousel_content $$,
  $$ values (3) $$,
  'exactly three rows are seeded, one per intro-carousel screen');
select results_eq(
  $$ select step from public.intro_carousel_content order by step $$,
  $$ values ('club_rules'::text), ('getting_started'::text), ('welcome_intro'::text) $$,
  'and they are exactly the three step names cloud.js renders');
select results_eq(
  $$ select count(*)::int from public.intro_carousel_content where updated_by is null $$,
  $$ values (3) $$,
  'the seed leaves updated_by null on all three - the migration itself is not a person');

-- =====================================================================
-- Reading: every member, no privacy dimension
-- =====================================================================
select results_eq(
  $$ select relrowsecurity from pg_catalog.pg_class
     where oid = 'public.intro_carousel_content'::regclass $$,
  $$ values (true) $$,
  'row level security is enabled');
select results_eq(
  $$ select has_table_privilege('authenticated', 'public.intro_carousel_content', 'select'),
            has_table_privilege('authenticated', 'public.intro_carousel_content', 'update'),
            has_table_privilege('authenticated', 'public.intro_carousel_content', 'insert'),
            has_table_privilege('authenticated', 'public.intro_carousel_content', 'delete') $$,
  $$ values (true, true, false, false) $$,
  'authenticated is granted select and update only - insert and delete are not granted to any client role');
select results_eq(
  $$ select has_table_privilege('anon', 'public.intro_carousel_content', 'select') $$,
  $$ values (false) $$,
  'anon cannot read the screens at all');

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.intro_carousel_content $$,
  $$ values (3) $$,
  'a plain member reads all three rows');
select tests.set_auth(tests.uid('norec'));
select results_eq(
  $$ select count(*)::int from public.intro_carousel_content $$,
  $$ values (3) $$,
  'and so does a member with no verified recovery method yet - this is exactly who the carousel is FOR, so it cannot be gated behind the very thing it precedes');

-- =====================================================================
-- Writing: a member cannot, a coach can (same permission as
-- onboarding_step_content - reused, not re-granted)
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.intro_carousel_content set title = 'hijacked' where step = 'welcome_intro' $$,
  'a member''s UPDATE does not raise - the row is invisible to the statement, not refused');
select results_eq(
  $$ select title from public.intro_carousel_content where step = 'welcome_intro' $$,
  $$ values ('ברוכים הבאים'::text) $$,
  'but it changed NOTHING');
select throws_ok(
  $$ insert into public.intro_carousel_content (step, title, body)
     values ('welcome_intro', 'x', 'y') $$,
  '42501', null,
  'a member cannot insert a fourth row - refused by the missing grant');
select throws_ok(
  $$ delete from public.intro_carousel_content where step = 'welcome_intro' $$,
  '42501', null,
  'nor delete one');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ insert into public.intro_carousel_content (step, title, body)
     values ('fourth_step', 'x', 'y') $$,
  '42501', null,
  'and neither can an admin - changing the step set is a migration, not an app action');
select throws_ok(
  $$ delete from public.intro_carousel_content $$,
  '42501', null,
  'an admin cannot delete a screen either');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.intro_carousel_content
     set title = 'ברוכים הבאים למועדון!', body = 'טקסט חדש מהמאמן.'
     where step = 'welcome_intro' $$,
  'a coach edits the welcome screen - same community.content.manage_onboarding permission onboarding_step_content already uses');
select results_eq(
  $$ select title, body from public.intro_carousel_content where step = 'welcome_intro' $$,
  $$ values ('ברוכים הבאים למועדון!'::text, 'טקסט חדש מהמאמן.'::text) $$,
  'and the edit really landed');

-- =====================================================================
-- The pin trigger
-- =====================================================================
select results_eq(
  $$ select updated_by = tests.uid('coach') from public.intro_carousel_content where step = 'welcome_intro' $$,
  $$ values (true) $$,
  'updated_by is pinned to auth.uid()');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ update public.intro_carousel_content
     set title = 'מאת המנהל',
         updated_by = tests.uid('m1'),
         updated_at = '2001-01-01'::timestamptz
     where step = 'welcome_intro' $$,
  'an admin edits it and also tries to forge the author and the date');
select results_eq(
  $$ select updated_by = tests.uid('admin'), updated_at > '2020-01-01'::timestamptz
     from public.intro_carousel_content where step = 'welcome_intro' $$,
  $$ values (true, true) $$,
  'both forgeries are overwritten by the trigger');

select lives_ok(
  $$ update public.intro_carousel_content set step = 'club_rules' where step = 'welcome_intro' $$,
  'an admin tries to RENAME welcome_intro to club_rules, which would collide with a real primary key');
select results_eq(
  $$ select count(*)::int from public.intro_carousel_content where step = 'welcome_intro' $$,
  $$ values (1) $$,
  'the row is still called welcome_intro - step is pinned to its old value');
select results_eq(
  $$ select count(*)::int from public.intro_carousel_content $$,
  $$ values (3) $$,
  'and there are still exactly three rows');

-- =====================================================================
-- The audit trigger - SAME label onboarding_step_content's own edits use,
-- on purpose (see the migration's own comment): a shared audit vocabulary
-- for "staff edited onboarding copy", not a new one per table.
-- =====================================================================
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'onboarding_content_updated' $$,
  $$ values (2) $$,
  'two real edits so far (the coach''s and the admin''s) - and none for the member''s no-op');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'onboarding_content_updated' and target_type = 'onboarding_step'
       and target_id is null
       and before_data ? 'step' and before_data ? 'title' and before_data ? 'body'
       and after_data  ? 'step' and after_data  ? 'title' and after_data  ? 'body' $$,
  $$ values (2) $$,
  'each carries the step name and the before/after title and body');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ update public.intro_carousel_content
     set title = title, body = body where step = 'welcome_intro' $$,
  'an idempotent save from the editor screen succeeds');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'onboarding_content_updated' $$,
  $$ values (2) $$,
  'and writes no third audit row');

-- =====================================================================
-- Length limits - same bounds as onboarding_step_content
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ update public.intro_carousel_content set title = repeat('x', 121) where step = 'welcome_intro' $$,
  '23514', null,
  'a 121-character title is refused');
select lives_ok(
  $$ update public.intro_carousel_content set title = repeat('x', 120) where step = 'welcome_intro' $$,
  'exactly 120 is accepted');
select throws_ok(
  $$ update public.intro_carousel_content set body = repeat('x', 2001) where step = 'welcome_intro' $$,
  '23514', null,
  'a 2001-character body is refused');
select lives_ok(
  $$ update public.intro_carousel_content set body = repeat('x', 2000) where step = 'welcome_intro' $$,
  'exactly 2000 is accepted');

select tests.clear_auth();
select throws_ok(
  $$ insert into public.intro_carousel_content (step, title, body) values ('fourth', 'x', 'y') $$,
  '23514', null,
  'even as the superuser, a step name outside the closed three is refused by the CHECK');

-- =====================================================================
-- The trigger functions are not client-callable
-- =====================================================================
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.intro_carousel_content_pin()', 'execute'),
            has_function_privilege('authenticated', 'public.intro_carousel_content_audit()', 'execute') $$,
  $$ values (false, false) $$,
  'neither trigger function is callable by a client');
select results_eq(
  $$ select prosecdef from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'intro_carousel_content_audit' $$,
  $$ values (true) $$,
  'the audit trigger is security definer - log_admin_action is granted to no client role');
select results_eq(
  $$ select prosecdef from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'intro_carousel_content_pin' $$,
  $$ values (false) $$,
  'while the pin trigger is NOT definer');

select * from finish();
rollback;
