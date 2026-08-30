-- COMM-020: real two-user RLS enforcement for 202608280019 (feed ranking).
-- feed_page and club_summary carry no table or RLS policy of their own -
-- everything here is behavioural. Boundary: both raise 'not authorized' for
-- a null caller. The behaviour that matters most: a member's own report of
-- a post hides that post from their own feed immediately, with no
-- moderator action required, while the same post stays visible to everyone
-- else.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- fixture posts, both authored by member A, both club-visible -------
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body, published_at) values
  ('c0190000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'reported post', now()),
  ('c0190000-0000-4000-8000-000000000002', tests.uid('m1'), 'club', 'ordinary post', now());

-- =====================================================================
-- auth gate
-- =====================================================================
select throws_ok(
  $$ select * from public.feed_page() $$,
  'P0001',
  'not authorized',
  'feed_page raises for a null caller');
select throws_ok(
  $$ select public.club_summary() $$,
  'P0001',
  'not authorized',
  'club_summary raises for a null caller');

-- =====================================================================
-- baseline: both posts show up for a member with no report on file
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.feed_page() where id = 'c0190000-0000-4000-8000-000000000001' $$,
  'member B, who has filed no report, sees the post in their feed');
select isnt_empty(
  $$ select 1 from public.feed_page() where id = 'c0190000-0000-4000-8000-000000000002' $$,
  'member B also sees the ordinary post in their feed');

-- =====================================================================
-- a caller's own report hides the post from their own feed immediately
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.report('post', 'c0190000-0000-4000-8000-000000000001', 'spam', '') $$,
  'member C files a report on the post');

select is_empty(
  $$ select 1 from public.feed_page() where id = 'c0190000-0000-4000-8000-000000000001' $$,
  'the reported post is gone from the reporter''s own feed, with no moderator action taken');
select isnt_empty(
  $$ select 1 from public.feed_page() where id = 'c0190000-0000-4000-8000-000000000002' $$,
  'the reporter still sees the other, unreported post');

-- --- the report does not affect anyone else's feed ---------------------
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.feed_page() where id = 'c0190000-0000-4000-8000-000000000001' $$,
  'member B, who did not report it, still sees the post');

-- =====================================================================
-- club_summary answers for a real caller
-- =====================================================================
select isnt_empty(
  $$ select 1 from (select public.club_summary()) s $$,
  'club_summary answers for a signed-in member');

select * from finish();
rollback;
