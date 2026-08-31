-- COMM-234 QA sweep: real two-user pgTAP coverage for
-- 202608290007_realtime_publication.sql and 202608290008_community_search.sql,
-- the runtime half test/community-realtime-search-rls.test.mjs's own header
-- comment explicitly says still belongs in a pgTAP suite ("the runtime half
-- ... was run once by hand ... and is recorded in docs/community/backlog.md's
-- Phase 2 schema handoff for qa, which is where a pgTAP suite covering the
-- runtime half belongs next"). That static file keeps pinning the SQL text
-- (grant list, security definer shape, exact predicate mirrored from each
-- source policy); this file is the real two-role runtime enforcement half.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- supabase_realtime publication membership
-- =====================================================================
select results_eq(
  $$ select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' $$,
  $$ values (5) $$,
  '202608290007: exactly five tables are in supabase_realtime, nothing else added by this migration');
select is_empty(
  $$ select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename::text not in ('challenge_participants', 'challenge_progress', 'notifications', 'post_comments', 'reactions') $$,
  'and they are exactly the five named tables, nothing else');

-- =====================================================================
-- community_search fixtures
-- =====================================================================
select tests.clear_auth();
update public.profiles set handle = 'zzrunner1', display_name = 'Zzz Runner One' where id = tests.uid('owner');
update public.profiles set visible_to_club = false, handle = 'zzhidden', display_name = 'Zzz Hidden Member' where id = tests.uid('m3');
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('coach'), tests.uid('m1'));
update public.profiles set handle = 'zzblocked', display_name = 'Zzz Blocked Runner' where id = tests.uid('m1');

insert into public.events (id, title, event_type, status, start_at, created_by)
values
  ('e0360000-0000-4000-8000-000000000001', 'Zzz Published Run', 'social_night', 'published', now() + interval '2 days', tests.uid('coach')),
  ('e0360000-0000-4000-8000-000000000002', 'Zzz Draft Run', 'social_night', 'draft', now() + interval '3 days', tests.uid('m1'));

insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, status, created_by)
values
  ('c0360000-0000-4000-8000-000000000001', 'Zzz Published Challenge', 'individual_target', 'session_count', now() - interval '1 day', now() + interval '10 days', 'active', tests.uid('coach')),
  ('c0360000-0000-4000-8000-000000000002', 'Zzz Draft Challenge', 'individual_target', 'session_count', now() - interval '1 day', now() + interval '10 days', 'draft', tests.uid('m1'));

-- =====================================================================
-- authorization and the sub-2-char / sanitization short-circuit
-- =====================================================================
select pg_catalog.set_config('role', 'anon', true);
select throws_ok(
  $$ select public.community_search('Zzz', 10) $$,
  '42501',
  null,
  'anon cannot call community_search at all');

select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select public.community_search('Z', 10) $$,
  $$ values ('{"events": [], "members": [], "challenges": []}'::jsonb) $$,
  'a 1-character query short-circuits to three empty arrays, no table read, not an error');
select results_eq(
  $$ select public.community_search('%_,()', 10) $$,
  $$ values ('{"events": [], "members": [], "challenges": []}'::jsonb) $$,
  'a query built only from stripped characters also short-circuits rather than wildcard-matching every row');

-- =====================================================================
-- members group
-- =====================================================================
select results_eq(
  $$ select jsonb_agg(m ->> 'handle' order by m ->> 'handle') from jsonb_array_elements(public.community_search('Zzz', 10) -> 'members') m $$,
  $$ values (jsonb_build_array('zzblocked', 'zzrunner1')) $$,
  'm2 searching "Zzz" sees the two matching members with no block edge or visibility toggle against m2 (zzhidden, visible_to_club off, is excluded by the next assertion)');
select is_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'members') m where m ->> 'handle' = 'zzhidden' $$,
  'a member with visible_to_club off never appears in another member''s search results');
select is_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'members') m where m ->> 'id' = tests.uid('m2')::text $$,
  'the caller never sees their own row in their own search results');

select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'members') m where m ->> 'handle' = 'zzblocked' $$,
  'a block edge (coach blocked m1/zzblocked) hides that member from the blocker''s search, either direction of who blocked whom');

-- =====================================================================
-- events group: draft visibility mirrors events_read exactly
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'events') e where e ->> 'id' = 'e0360000-0000-4000-8000-000000000002' $$,
  'a draft event is invisible to a caller who is neither its creator nor a manage-permission holder');
select isnt_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'events') e where e ->> 'id' = 'e0360000-0000-4000-8000-000000000001' $$,
  'a published event is visible to any member');

select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'events') e where e ->> 'id' = 'e0360000-0000-4000-8000-000000000002' $$,
  'the creator sees their own draft event');

select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'events') e where e ->> 'id' = 'e0360000-0000-4000-8000-000000000002' $$,
  'a community.event.manage holder sees a draft event they did not create');

-- =====================================================================
-- challenges group: same draft-visibility shape as events
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'challenges') c where c ->> 'id' = 'c0360000-0000-4000-8000-000000000002' $$,
  'a draft challenge is invisible to a non-creator without community.challenge.create');
select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'challenges') c where c ->> 'id' = 'c0360000-0000-4000-8000-000000000002' $$,
  'the creator sees their own draft challenge');
select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select 1 from jsonb_array_elements(public.community_search('Zzz', 10) -> 'challenges') c where c ->> 'id' = 'c0360000-0000-4000-8000-000000000002' $$,
  'a community.challenge.create holder sees a draft challenge they did not create');

-- =====================================================================
-- p_limit clamps each group independently
-- =====================================================================
select tests.clear_auth();
insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, status, created_by)
values ('c0360000-0000-4000-8000-000000000003', 'Zzz Second Challenge', 'individual_target', 'session_count', now() - interval '1 day', now() + interval '10 days', 'active', tests.uid('coach'));

select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select jsonb_array_length(public.community_search('Zzz', 1) -> 'challenges') $$,
  $$ values (1) $$,
  'p_limit=1 against two matching published challenges returns exactly one');

select * from finish();
rollback;
