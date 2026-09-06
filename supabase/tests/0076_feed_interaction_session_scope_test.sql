-- Launch-readiness fix pass (202609060010). feed_record_interaction() is
-- scoped to ONE feed session.
--
-- THE BUG THIS PINS. The 202608280006 body ended with
--
--     update public.feed_impressions set opened = ..., engaged = ...
--     where user_id = v_uid and post_id = p_post_id;
--
-- two predicates where the table's own unique key has three. Every impression
-- the member had ever recorded for that post - Monday's, Wednesday's, and
-- every future session's the first time it was touched - got the flag, so
-- "shown and ignored" (the negative signal 202608310006 ranks on) was erased
-- and the open/engagement rates 202609010006 divides were inflated by however
-- many sessions a post had accumulated.
--
-- Section 1 is the regression proper: an interaction in session A must not
-- move session B's row, and must move A's. Sections 2-5 pin the parts of the
-- fix that are not the UPDATE itself - that there is exactly ONE function by
-- this name (the drop, not a fourth add_post_comment-style overload), that
-- p_feed_session_id is required, and that nothing else about the function
-- moved.
--
-- 0006_feed_telemetry_test.sql still owns the RLS boundaries of the two
-- tables and the batch limits of feed_record_impressions; nothing here
-- duplicates it.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- The post every impression below points at. Authored by m2 and club-visible,
-- so m1 reaches it through post_visible_to_viewer's ordinary branch rather
-- than the author exemption - the same way a real feed post is reached.
insert into public.workout_posts (id, author_id, visibility, body)
values ('b0760000-0000-4000-8000-000000000001', tests.uid('m2'), 'club', 'session scope target');

-- A post m1 cannot see, for the refusal assertion in section 5. Soft-deleted,
-- which post_visible_to_viewer refuses for everyone including the author.
insert into public.workout_posts (id, author_id, visibility, body, deleted_at)
values ('b0760000-0000-4000-8000-000000000002', tests.uid('m3'), 'club', 'gone', now());

-- =====================================================================
-- 1. THE REGRESSION: two sessions, one post, one member
-- =====================================================================
-- m1 was shown the same post in two different feed sessions, so
-- feed_impressions holds two rows for it. That is the whole point of
-- feed_session_id being in the unique key.
select tests.set_auth(tests.uid('m1'));
select public.feed_record_impressions(jsonb_build_array(
  jsonb_build_object('post_id', 'b0760000-0000-4000-8000-000000000001',
                     'feed_session_id', '00000000-0076-4000-8000-0000000000a1')));
select public.feed_record_impressions(jsonb_build_array(
  jsonb_build_object('post_id', 'b0760000-0000-4000-8000-000000000001',
                     'feed_session_id', '00000000-0076-4000-8000-0000000000b1')));

-- m2 was shown it in a session that happens to carry the SAME id as m1's
-- session A. The user_id predicate has always been there, but a session-scoped
-- UPDATE must not start matching across members either.
select tests.set_auth(tests.uid('m2'));
select public.feed_record_impressions(jsonb_build_array(
  jsonb_build_object('post_id', 'b0760000-0000-4000-8000-000000000001',
                     'feed_session_id', '00000000-0076-4000-8000-0000000000a1')));

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.feed_impressions
     where user_id = tests.uid('m1')
       and post_id = 'b0760000-0000-4000-8000-000000000001' $$,
  $$ values (2) $$,
  'baseline: one member, one post, two sessions, two impression rows');
select is_empty(
  $$ select 1 from public.feed_impressions
     where user_id = tests.uid('m1') and (opened or engaged) $$,
  'and nothing is flagged yet');

-- The interaction happens in session A.
select lives_ok(
  $$ select public.feed_record_interaction(
       'b0760000-0000-4000-8000-000000000001', 'open',
       '00000000-0076-4000-8000-0000000000a1') $$,
  'm1 opens the post while looking at feed session A');

select is(
  (select opened from public.feed_impressions
   where user_id = tests.uid('m1')
     and feed_session_id = '00000000-0076-4000-8000-0000000000a1'),
  true,
  'THE FIX, allow half: session A''s impression - the one the member was actually looking at - is marked opened');
select is(
  (select opened from public.feed_impressions
   where user_id = tests.uid('m1')
     and feed_session_id = '00000000-0076-4000-8000-0000000000b1'),
  false,
  'THE FIX, deny half: session B''s impression of the SAME post by the SAME member is NOT back-stamped. Before 202609060010 this was true, and every past session''s "shown and ignored" turned retroactively into "opened"');

-- Engagement travels the same path and is asserted separately, because
-- `opened` and `engaged` are two independent expressions in the SET list and a
-- fix applied to one of them only would still pass the four assertions above.
select lives_ok(
  $$ select public.feed_record_interaction(
       'b0760000-0000-4000-8000-000000000001', 'react',
       '00000000-0076-4000-8000-0000000000a1') $$,
  'm1 reacts, still in session A');
select is(
  (select engaged from public.feed_impressions
   where user_id = tests.uid('m1')
     and feed_session_id = '00000000-0076-4000-8000-0000000000a1'),
  true,
  'session A''s row is marked engaged');
select is(
  (select engaged from public.feed_impressions
   where user_id = tests.uid('m1')
     and feed_session_id = '00000000-0076-4000-8000-0000000000b1'),
  false,
  'and session B''s row is not - engaged is scoped exactly like opened');

-- Cross-member, same session id.
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.feed_impressions
     where user_id = tests.uid('m2') and (opened or engaged) $$,
  'm2''s impression is untouched even though it carries the identical feed_session_id - user_id is still a predicate');

-- Session B is not permanently frozen: an interaction that really happens
-- there does flip it, and does not disturb what session A already recorded.
select tests.set_auth(tests.uid('m1'));
select public.feed_record_interaction(
  'b0760000-0000-4000-8000-000000000001', 'open',
  '00000000-0076-4000-8000-0000000000b1');
select is(
  (select opened from public.feed_impressions
   where user_id = tests.uid('m1')
     and feed_session_id = '00000000-0076-4000-8000-0000000000b1'),
  true,
  'a later open IN session B flips session B''s row - the scope is per-session, not first-session-wins');
select is(
  (select engaged from public.feed_impressions
   where user_id = tests.uid('m1')
     and feed_session_id = '00000000-0076-4000-8000-0000000000b1'),
  false,
  'and that open did not drag session A''s `engaged` across with it');

-- The interactions ledger is unchanged: it was never session-scoped and still
-- records one row per call.
select results_eq(
  $$ select count(*)::int from public.feed_interactions where user_id = tests.uid('m1') $$,
  $$ values (3) $$,
  'three calls, three feed_interactions rows - the ledger is per-event and did not become per-session');

-- =====================================================================
-- 2. EXACTLY ONE FUNCTION BY THIS NAME
-- =====================================================================
-- `create or replace` with a different argument list ADDS an overload rather
-- than replacing, and the old two-argument body would have kept both the
-- broken UPDATE and its execute grant. add_post_comment has three coexisting
-- overloads today and a client call resolving to the wrong one was a real bug
-- in this same pass, so this is asserted rather than assumed.
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'feed_record_interaction' $$,
  $$ values (1) $$,
  'there is exactly ONE public.feed_record_interaction - the (uuid, text) version was dropped, not shadowed');
-- pg_get_function_arguments() rather than a direct comparison against
-- pg_proc.proargnames: catalog text columns carry the "C" collation, and
-- comparing one to a literal array raises 'could not determine which collation
-- to use'. The rendered form is also strictly more informative - it pins the
-- argument NAMES, their ORDER, their TYPES, and the absence of any DEFAULT
-- (which would appear here as `DEFAULT NULL::uuid`) in one string, and that
-- string is precisely what a PostgREST body has to key on.
select is(
  (select pg_catalog.pg_get_function_arguments(p.oid) from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'feed_record_interaction'),
  'p_post_id uuid, p_kind text, p_feed_session_id uuid',
  'and its signature is exactly p_post_id uuid, p_kind text, p_feed_session_id uuid - names, order, types, no defaults');
select results_eq(
  $$ select p.pronargdefaults::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'feed_record_interaction' $$,
  $$ values (0) $$,
  'p_feed_session_id has NO DEFAULT on purpose: a default null would have to mean "every session", which is the bug. A caller that omits it must fail to resolve, loudly');
select ok(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'feed_record_interaction'),
  'still SECURITY DEFINER - it has to be, because feed_impressions has no UPDATE grant for anyone');
select throws_ok(
  $$ select public.feed_record_interaction('b0760000-0000-4000-8000-000000000001', 'open') $$,
  '42883',
  null,
  'and the two-argument call does not resolve at all any more');

-- The privileges the drop cleared and the migration restated.
select ok(
  has_function_privilege('authenticated', 'public.feed_record_interaction(uuid, text, uuid)', 'EXECUTE'),
  'authenticated can execute the three-argument function');
select ok(
  not has_function_privilege('anon', 'public.feed_record_interaction(uuid, text, uuid)', 'EXECUTE'),
  'anon cannot');
select ok(
  not has_table_privilege('authenticated', 'public.feed_impressions', 'UPDATE'),
  'and there is still no direct UPDATE grant on feed_impressions, so this function remains the only way opened/engaged can move');

-- =====================================================================
-- 3. A NULL session id: the interaction survives, no flag moves
-- =====================================================================
-- Required argument, but a null VALUE is tolerated rather than raised on. The
-- caller is fire-and-forget, so raising would roll back the feed_interactions
-- insert as well and lose the whole interaction silently - strictly more data
-- lost than the flag alone. feed_session_id is NOT NULL, so a null argument
-- could never have matched a row.
select tests.set_auth(tests.uid('m1'));
select public.feed_record_impressions(jsonb_build_array(
  jsonb_build_object('post_id', 'b0760000-0000-4000-8000-000000000001',
                     'feed_session_id', '00000000-0076-4000-8000-0000000000c1')));
select lives_ok(
  $$ select public.feed_record_interaction(
       'b0760000-0000-4000-8000-000000000001', 'react', null) $$,
  'a null feed_session_id does not raise');
select is(
  (select engaged from public.feed_impressions
   where user_id = tests.uid('m1')
     and feed_session_id = '00000000-0076-4000-8000-0000000000c1'),
  false,
  'and flips nothing - a null session id is emphatically NOT "all of them"');
select results_eq(
  $$ select count(*)::int from public.feed_interactions where user_id = tests.uid('m1') $$,
  $$ values (4) $$,
  'but the interaction itself is still recorded, which is the reason it does not raise');

-- =====================================================================
-- 4. An interaction with no impression row at all
-- =====================================================================
-- A post opened from a notification, a permalink, a profile or a search
-- result was never shown in a feed session, so there is no row to stamp. Zero
-- rows updated is the correct outcome, not an error.
select lives_ok(
  $$ select public.feed_record_interaction(
       'b0760000-0000-4000-8000-000000000001', 'open',
       '00000000-0076-4000-8000-0000000000f1') $$,
  'an interaction naming a session with no impression row succeeds');
select results_eq(
  $$ select count(*)::int from public.feed_interactions where user_id = tests.uid('m1') $$,
  $$ values (5) $$,
  'and is recorded - the ledger does not depend on an impression existing');
select results_eq(
  $$ select count(*)::int from public.feed_impressions
     where user_id = tests.uid('m1') and feed_session_id = '00000000-0076-4000-8000-0000000000f1' $$,
  $$ values (0) $$,
  'and no impression row was conjured to hold the flag');

-- =====================================================================
-- 5. EVERYTHING ELSE, unchanged from 202608280006
-- =====================================================================
select throws_ok(
  $$ select public.feed_record_interaction(
       'b0760000-0000-4000-8000-000000000001', 'applaud',
       '00000000-0076-4000-8000-0000000000a1') $$,
  'P0001',
  'unknown interaction kind applaud',
  'the p_kind allow-list is intact');
select throws_ok(
  $$ select public.feed_record_interaction(
       'b0760000-0000-4000-8000-000000000002', 'open',
       '00000000-0076-4000-8000-0000000000a1') $$,
  'P0001',
  'not authorized',
  'and a post the caller cannot see is still refused, before anything is written');
select results_eq(
  $$ select count(*)::int from public.feed_interactions
     where user_id = tests.uid('m1') and post_id = 'b0760000-0000-4000-8000-000000000002' $$,
  $$ values (0) $$,
  'with no interaction row left behind by the refusal');

-- `hide` and `profile_open` are in the allow-list but in neither flag
-- expression. They were no-ops for both flags before and still are.
select public.feed_record_interaction(
  'b0760000-0000-4000-8000-000000000001', 'hide',
  '00000000-0076-4000-8000-0000000000c1');
select ok(
  (select not opened and not engaged from public.feed_impressions
   where user_id = tests.uid('m1')
     and feed_session_id = '00000000-0076-4000-8000-0000000000c1'),
  'a hide is recorded but flips neither flag, exactly as before');

select tests.clear_auth();
select is_empty(
  $$ select 1 from public.feed_impressions
     where user_id = tests.uid('m2') and (opened or engaged) $$,
  'final sweep: after every one of m1''s interactions above, m2''s impression of the same post is still untouched');

select * from finish();
rollback;
