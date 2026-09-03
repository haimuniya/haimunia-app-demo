-- COMM-373. onboarding_step_content: the seed, the read audience, the
-- write boundary, the two triggers
-- (202609030004_onboarding_step_content.sql).
--
-- The write boundary needs saying carefully, because UPDATE under RLS does
-- NOT raise when the USING clause is false - the row is simply invisible to
-- the statement and zero rows change. So "a member cannot edit the welcome
-- card" is asserted as "the statement succeeds, touches nothing, and the
-- copy is byte-identical afterwards", which is the real behaviour. Asserting
-- a raise here would be asserting something that never happens.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Exactly five rows, carrying the live copy
-- =====================================================================
select results_eq(
  $$ select count(*)::int from public.onboarding_step_content $$,
  $$ values (5) $$,
  'exactly five rows are seeded, one per onboarding step');
select results_eq(
  $$ select step from public.onboarding_step_content order by step $$,
  $$ values ('first_class'::text), ('first_month'::text), ('first_week'::text),
            ('third_class'::text), ('welcome'::text) $$,
  'and they are exactly the five step names cloud.js renders');

-- Byte-for-byte against cloud.js's renderers, so a later copy edit in one
-- place and not the other is caught here rather than by a member.
select results_eq(
  $$ select title, body from public.onboarding_step_content where step = 'welcome' $$,
  $$ values ('ברוכים הבאים לקהילה!'::text,
             'כאן רואים מה קורה במועדון, ואפשר לשתף אימונים ושיאים ולהגיב לחברים אחרים. לחיצה על "כתיבת פוסט" למעלה פותחת את השיתוף הראשון שלכם.'::text) $$,
  'the welcome card is seeded with renderOnboardingWelcomeStep()''s exact live copy - first deploy changes nothing a member sees');
select results_eq(
  $$ select title, body from public.onboarding_step_content where step = 'first_class' $$,
  $$ values ('הגעתם לאימון הראשון!'::text,
             'האימון הראשון שלכם כבר נרשם במערכת. ממשיכים באותו הקצב?'::text) $$,
  'and so is first_class');
select results_eq(
  $$ select title, body from public.onboarding_step_content where step = 'third_class' $$,
  $$ values ('אימון שלישי — אתם כבר בקצב!'::text,
             'שלושה אימונים כבר מאחוריכם. ככה בונים הרגל אימונים.'::text) $$,
  'and third_class');

select results_eq(
  $$ select title, body from public.onboarding_step_content where step = 'first_week' $$,
  $$ values ('השבוע הראשון שלכם מאחוריכם'::text, ''::text) $$,
  'first_week carries its fixed TITLE and an EMPTY body - deliberately, not by omission: its whole visible body is the active-challenge sentence cloud.js computes at render time, so there is no fixed lead copy today and seeding one would change what a member sees');
select results_eq(
  $$ select title, body from public.onboarding_step_content where step = 'first_month' $$,
  $$ values ('החודש הראשון שלכם במועדון'::text, ''::text) $$,
  'same for first_month, whose body is the computed sessions/PRs/achievements summary');

select results_eq(
  $$ select count(*)::int from public.onboarding_step_content where updated_by is null $$,
  $$ values (5) $$,
  'the seed leaves updated_by null on all five - nobody has edited them, and the migration itself is not a person');

-- =====================================================================
-- Reading: every member, no privacy dimension
-- =====================================================================
select results_eq(
  $$ select relrowsecurity from pg_catalog.pg_class
     where oid = 'public.onboarding_step_content'::regclass $$,
  $$ values (true) $$,
  'row level security is enabled');
select results_eq(
  $$ select has_table_privilege('authenticated', 'public.onboarding_step_content', 'select'),
            has_table_privilege('authenticated', 'public.onboarding_step_content', 'update'),
            has_table_privilege('authenticated', 'public.onboarding_step_content', 'insert'),
            has_table_privilege('authenticated', 'public.onboarding_step_content', 'delete') $$,
  $$ values (true, true, false, false) $$,
  'authenticated is granted select and update only - insert and delete are not granted to any client role, which is what makes "the five rows always exist" a grant rather than a convention');
select results_eq(
  $$ select has_table_privilege('anon', 'public.onboarding_step_content', 'select') $$,
  $$ values (false) $$,
  'anon cannot read the cards at all');

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.onboarding_step_content $$,
  $$ values (5) $$,
  'a plain member reads all five rows - the same audience the cards already have, and the reason the read policy is `using (true)`');
select tests.set_auth(tests.uid('norec'));
select results_eq(
  $$ select count(*)::int from public.onboarding_step_content $$,
  $$ values (5) $$,
  'and so does a member with no verified recovery method - this is club copy, not member data');

-- =====================================================================
-- Writing: a member cannot, a coach can
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.onboarding_step_content set title = 'hijacked' where step = 'welcome' $$,
  'a member''s UPDATE does not raise - under RLS a failing USING clause makes the row invisible to the statement, it does not error');
select results_eq(
  $$ select title from public.onboarding_step_content where step = 'welcome' $$,
  $$ values ('ברוכים הבאים לקהילה!'::text) $$,
  'but it changed NOTHING - the member has the grant and not the permission, so zero rows matched');
select results_eq(
  $$ select count(*)::int from public.onboarding_step_content where title = 'hijacked' $$,
  $$ values (0) $$,
  'no row anywhere carries the member''s text');

select throws_ok(
  $$ insert into public.onboarding_step_content (step, title, body)
     values ('welcome', 'x', 'y') $$,
  '42501', null,
  'a member cannot insert a sixth row - refused by the missing grant, before any policy is consulted');
select throws_ok(
  $$ delete from public.onboarding_step_content where step = 'welcome' $$,
  '42501', null,
  'nor delete one');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ insert into public.onboarding_step_content (step, title, body)
     values ('sixth_step', 'x', 'y') $$,
  '42501', null,
  'and NEITHER CAN AN ADMIN - changing the step set is a migration, not an app action, so the grant names no exception');
select throws_ok(
  $$ delete from public.onboarding_step_content $$,
  '42501', null,
  'an admin cannot delete a card either, which is what guarantees a reader expecting five never finds four');

-- The coach holds community.content.manage_onboarding (seeded to the same
-- list community.announcement.publish has).
select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select public.has_perm('community.content.manage_onboarding'), public.is_admin() $$,
  $$ values (true, false) $$,
  'a coach holds the onboarding permission and is not an admin - so the ALLOW below is the permission working, not the admin bypass');
select lives_ok(
  $$ update public.onboarding_step_content
     set title = 'ברוכים הבאים!', body = 'טקסט חדש מהמאמן.'
     where step = 'welcome' $$,
  'a coach edits the welcome card');
select results_eq(
  $$ select title, body from public.onboarding_step_content where step = 'welcome' $$,
  $$ values ('ברוכים הבאים!'::text, 'טקסט חדש מהמאמן.'::text) $$,
  'and the edit really landed');

-- =====================================================================
-- The pin trigger
-- =====================================================================
select results_eq(
  $$ select updated_by = tests.uid('coach') from public.onboarding_step_content where step = 'welcome' $$,
  $$ values (true) $$,
  'updated_by is pinned to auth.uid() - the coach who edited it');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ update public.onboarding_step_content
     set title = 'מאת המנהל',
         updated_by = tests.uid('m1'),
         updated_at = '2001-01-01'::timestamptz
     where step = 'welcome' $$,
  'an admin edits it and also tries to author the edit as m1, backdated to 2001');
select results_eq(
  $$ select updated_by = tests.uid('admin'), updated_at > '2020-01-01'::timestamptz
     from public.onboarding_step_content where step = 'welcome' $$,
  $$ values (true, true) $$,
  'both forgeries are overwritten by the trigger: updated_by is the real caller and updated_at is now(), regardless of what the client sent - the same "trigger pins the column" shape protect_is_admin() uses');

-- step is pinned too, which the ticket's outline did not name.
select lives_ok(
  $$ update public.onboarding_step_content set step = 'first_class' where step = 'welcome' $$,
  'an admin tries to RENAME the welcome step to first_class - which, unchecked, would collide with a real primary key and leave the table with four distinct steps');
select results_eq(
  $$ select count(*)::int from public.onboarding_step_content where step = 'welcome' $$,
  $$ values (1) $$,
  'the welcome row is still called welcome - `step` is pinned to its old value by the same trigger, so the one grant that IS given cannot break the five-rows-always-exist rule');
select results_eq(
  $$ select count(*)::int from public.onboarding_step_content $$,
  $$ values (5) $$,
  'and there are still exactly five rows');

-- =====================================================================
-- The audit trigger
-- =====================================================================
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'onboarding_content_updated' $$,
  $$ values (2) $$,
  'two real edits so far (the coach''s and the admin''s), so two audit rows - and none for the member''s no-op, which matched no row');
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'onboarding_content_updated' and target_type = 'onboarding_step'
       and target_id is null
       and before_data ? 'step' and before_data ? 'title' and before_data ? 'body'
       and after_data  ? 'step' and after_data  ? 'title' and after_data  ? 'body' $$,
  $$ values (2) $$,
  'each carries the step name and the before/after title and body, with a null target_id (the step key is text, not a uuid)');
select results_eq(
  $$ select before_data ->> 'title' from public.admin_actions
     where action_type = 'onboarding_content_updated' and admin_id = tests.uid('coach') $$,
  $$ values ('ברוכים הבאים לקהילה!'::text) $$,
  'the coach''s audit row records the copy as it was BEFORE their edit, so the change is reconstructable');

-- An edit that changes nothing writes no audit row.
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ update public.onboarding_step_content
     set title = title, body = body where step = 'welcome' $$,
  'an idempotent save from the editor screen succeeds');
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.admin_actions
     where action_type = 'onboarding_content_updated' $$,
  $$ values (2) $$,
  'and writes NO third audit row - the pin trigger rewrites updated_at on every update, so without this guard every idempotent save would log a change that did not happen');

-- =====================================================================
-- Length limits
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ update public.onboarding_step_content set title = repeat('x', 121) where step = 'welcome' $$,
  '23514', null,
  'a 121-character title is refused by the CHECK');
select lives_ok(
  $$ update public.onboarding_step_content set title = repeat('x', 120) where step = 'welcome' $$,
  'exactly 120 is accepted');
select throws_ok(
  $$ update public.onboarding_step_content set body = repeat('x', 2001) where step = 'welcome' $$,
  '23514', null,
  'a 2001-character body is refused - tight enough that a staff typo cannot become a wall of text on a small screen');
select lives_ok(
  $$ update public.onboarding_step_content set body = repeat('x', 2000) where step = 'welcome' $$,
  'exactly 2000 is accepted');
select lives_ok(
  $$ update public.onboarding_step_content set body = '' where step = 'welcome' $$,
  'and an EMPTY body is legal - it has to be, since first_week and first_month ship with one');

select tests.clear_auth();
select throws_ok(
  $$ insert into public.onboarding_step_content (step, title, body) values ('sixth', 'x', 'y') $$,
  '23514', null,
  'even as the superuser, a step name outside the closed five is refused by the CHECK - so a migration typo cannot invent a sixth card either');

-- =====================================================================
-- The trigger functions are not client-callable
-- =====================================================================
select results_eq(
  $$ select has_function_privilege('authenticated', 'public.onboarding_step_content_pin()', 'execute'),
            has_function_privilege('authenticated', 'public.onboarding_step_content_audit()', 'execute') $$,
  $$ values (false, false) $$,
  'neither trigger function is callable by a client - they are reachable as triggers and nowhere else');
select results_eq(
  $$ select prosecdef from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'onboarding_step_content_audit' $$,
  $$ values (true) $$,
  'the audit trigger is security definer, because log_admin_action is granted to no client role at all - that is the one boundary it crosses');
select results_eq(
  $$ select prosecdef from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'onboarding_step_content_pin' $$,
  $$ values (false) $$,
  'while the pin trigger is NOT definer - it only rewrites the row already being written, so it needs no elevation');

select * from finish();
rollback;
