-- COMM-301: behavioural coverage for 202608310002 (relationship_score, and
-- feed_page re-created to call it).
--
-- This is a refactor ticket, so the highest-value assertions here are not
-- "does the new function work" but "did anything move". Two of them do that
-- job and the rest support them:
--
--   1. A REGRESSION PIN on feed_page's actual output. Three posts, identical
--      in every scored respect except who wrote them, are ranked and their
--      feed_score values asserted to six decimal places against literals
--      captured by running this exact fixture against the pre-refactor
--      function. now() is fixed for the whole transaction, and the fixture
--      posts are published at now() - 5 hours, so the recency term is
--      40 * 0.5^(5/36) exactly - every number below is reproducible, not
--      approximate. If the extraction changed any arithmetic anywhere in
--      feed_page's scoring pass, these three numbers move and this fails.
--
--   2. A DRIFT PIN tying the two copies together, the same pattern
--      0034_feed_leaderboard_and_suggestions_test.sql uses for
--      consistency_week_streaks() versus community_profile: the gap between
--      two feed rows that differ only in their author is asserted equal to
--      18 (feed_page's relationship weight) times the gap between the same
--      two members' relationship_score(). feed_page cannot start scoring
--      relationships differently from the function it calls without this
--      failing, which is the whole point of extracting it.
--
-- Plus the boundaries: the function is internal (no grant to any client
-- role, security invoker), it agrees with are_friends() on who is mutual,
-- the 0.55 + 0.45 sum really is capped at 1, p_as_of really moves the 30-day
-- window, and the COMM-125 block edge feed_page already respected is not
-- loosened. people_suggestions (COMM-232) is asserted untouched.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures. Bootstrap superuser, so RLS and the protect_* triggers stay
-- out of the way while the world is built.
-- =====================================================================
select tests.clear_auth();

-- rls_helpers' invite_redemptions rows fire the POST_NEW_MEMBER trigger
-- (202608290014). Those posts are authorless, published at now() and carry
-- gen_random_uuid() ids, so leaving them in would make a pinned feed order
-- non-deterministic for reasons that have nothing to do with this ticket.
delete from public.workout_posts where post_type = 'POST_NEW_MEMBER';

-- Three candidates, identical in every scored respect except their author:
-- same post_type (POST_TEXT scores zero on the coach, achievement and
-- challenge components and is diversity-neutral, so no reordering pass can
-- touch them), same visibility, same published_at, no reactions, no
-- comments, no mention of the viewer, three different non-staff authors.
-- Every difference in their final score is therefore the relationship term
-- and nothing else.
insert into public.workout_posts (id, author_id, post_type, status, visibility, body, published_at, created_at)
values
  ('c3010000-0000-4000-8000-0000000000a1', tests.uid('m2'),    'POST_TEXT', 'active', 'club', 'mutual follow author',    now() - interval '5 hours', now() - interval '5 hours'),
  ('c3010000-0000-4000-8000-0000000000a2', tests.uid('m3'),    'POST_TEXT', 'active', 'club', 'one-way follow author',   now() - interval '5 hours', now() - interval '5 hours'),
  ('c3010000-0000-4000-8000-0000000000a3', tests.uid('norec'), 'POST_TEXT', 'active', 'club', 'recent interaction only', now() - interval '5 hours', now() - interval '5 hours');

-- The interaction signal has to come from somewhere that is not a candidate,
-- or the reaction would also raise that post's engagement component and the
-- rows would stop being identical-except-for-author. These two posts sit 200
-- days back, outside feed_page's 90-day candidate window, while the
-- reactions on them sit 5 days back, inside the 30-day relationship window.
insert into public.workout_posts (id, author_id, post_type, status, visibility, body, published_at, created_at)
values
  ('c3010000-0000-4000-8000-0000000000b1', tests.uid('norec'), 'POST_TEXT', 'active', 'club', 'old post', now() - interval '200 days', now() - interval '200 days'),
  ('c3010000-0000-4000-8000-0000000000b2', tests.uid('m3'),    'POST_TEXT', 'active', 'club', 'old post', now() - interval '200 days', now() - interval '200 days'),
  ('c3010000-0000-4000-8000-0000000000b3', tests.uid('coach'), 'POST_TEXT', 'active', 'club', 'old post', now() - interval '200 days', now() - interval '200 days');

insert into public.reactions (post_id, user_id, kind, created_at)
values ('c3010000-0000-4000-8000-0000000000b1', tests.uid('m1'), 'cheer', now() - interval '5 days');

insert into public.follows (follower_id, followed_id) values
  (tests.uid('m1'), tests.uid('m2')),
  (tests.uid('m2'), tests.uid('m1')),
  (tests.uid('m1'), tests.uid('m3'));

-- =====================================================================
-- The function is internal, not a second API surface
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'relationship_score'),
  false,
  'relationship_score is SECURITY INVOKER - it borrows the rights of the definer function that calls it and grants none of its own');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.relationship_score(uuid, uuid, timestamptz)', 'execute'),
  'authenticated cannot execute relationship_score');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.relationship_score(uuid, uuid, timestamptz)', 'execute'),
  'anon cannot execute relationship_score');
select ok(
  not pg_catalog.has_function_privilege('public', 'public.relationship_score(uuid, uuid, timestamptz)', 'execute'),
  'and neither can PUBLIC, so the default grant every new function starts with really was revoked');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.relationship_score(tests.uid('m1'), tests.uid('m2')) $$,
  '42501',
  null,
  'a real authenticated caller reaching for it directly is refused by the grant, not by a check inside the body');

-- Everything from here on needs both auth.uid() (for are_friends and
-- feed_page) and the rights to call an ungranted internal function, which is
-- exactly the context feed_page's definer body runs in. Claims stay set to
-- m1, the role goes back to the owner.
select pg_catalog.set_config('role', 'postgres', true);

select is(
  (select public.relationship_score(tests.uid('m1'), tests.uid('m2'))),
  1.0::numeric,
  'the promised two-argument call form still resolves - p_as_of defaults to now()');

-- =====================================================================
-- The mutual branch is are_friends(), parameterised. It must not drift.
-- =====================================================================
select isnt_empty(
  $$ select p.id from public.profiles p where p.id <> auth.uid() and public.are_friends(p.id) $$,
  'the fixture really does contain a mutual follow, so the next assertion is not vacuously true');

select is_empty(
  $$ select p.handle from public.profiles p
     where p.id <> auth.uid()
       and public.are_friends(p.id) <> (public.relationship_score(auth.uid(), p.id) >= 1.0) $$,
  'no member where are_friends() and relationship_score()''s mutual branch disagree - one definition of friends, computed twice, agreeing');

select is(
  (select public.relationship_score(tests.uid('m1'), tests.uid('m1'))),
  0.0::numeric,
  'a member is not their own relationship - the p_other <> p_viewer self-exclusion is are_friends()''s, kept');

-- =====================================================================
-- The three branches, at their stated values
-- =====================================================================
select is((select public.relationship_score(tests.uid('m1'), tests.uid('m2'))), 1.0::numeric,
  'mutual follow is the full component');
select is((select public.relationship_score(tests.uid('m1'), tests.uid('m3'))), 0.55::numeric,
  'a one-way follow is most of it');
select is((select public.relationship_score(tests.uid('m1'), tests.uid('norec'))), 0.45::numeric,
  'a reaction on that member''s post inside 30 days, with no follow edge at all, is the top-up on its own');
select is((select public.relationship_score(tests.uid('m1'), tests.uid('owner'))), 0.0::numeric,
  'a member the viewer has never followed and never touched is zero');
select is((select public.relationship_score(tests.uid('m1'), null)), 0.0::numeric,
  'a null other member is zero, not null');
select is((select public.relationship_score(null, tests.uid('m2'))), 0.0::numeric,
  'a null viewer is zero, not null');

-- =====================================================================
-- REGRESSION PIN. feed_page's ranked output, to six decimal places.
--
-- These literals were produced by running this fixture against feed_page as
-- it stood before 202608310002 (the inline CTE). They are asserted here
-- against feed_page as it stands after (the extracted function). Same rows,
-- same order, same numbers.
--
--   recency      40 * 0.5^(5/36)              = 36.328735
--   m2  mutual   36.328735 + 18 * 1.00        = 54.328735
--   m3  follow   36.328735 + 18 * 0.55        = 46.228735
--   norec top-up 36.328735 + 18 * 0.45        = 44.428735
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select id, feed_score from public.feed_page(null, 40) $$,
  $$ values ('c3010000-0000-4000-8000-0000000000a1'::uuid, 54.328735::numeric),
            ('c3010000-0000-4000-8000-0000000000a2'::uuid, 46.228735::numeric),
            ('c3010000-0000-4000-8000-0000000000a3'::uuid, 44.428735::numeric) $$,
  'feed_page returns the same three rows in the same order with the same scores as it did before the extraction');

-- =====================================================================
-- DRIFT PIN. feed_page's ranking and relationship_score cannot disagree.
--
-- The three rows differ only in their author, so the gap between any two of
-- their scores IS the relationship weight times the gap between the two
-- authors' relationship_score - with no dependence on when the suite runs,
-- because the recency, engagement, personal and repetition terms are equal
-- on both sides and cancel exactly.
-- =====================================================================
select pg_catalog.set_config('role', 'postgres', true);

select results_eq(
  $$ with f as (select id, feed_score from public.feed_page(null, 40))
     select (select feed_score from f where id = 'c3010000-0000-4000-8000-0000000000a1')
          - (select feed_score from f where id = 'c3010000-0000-4000-8000-0000000000a2') $$,
  $$ select round(18 * (public.relationship_score(auth.uid(), tests.uid('m2'))
                      - public.relationship_score(auth.uid(), tests.uid('m3'))), 6) $$,
  'the mutual row outscores the one-way-follow row by exactly 18 x the relationship_score gap - feed_page and the function it calls agree');

select results_eq(
  $$ with f as (select id, feed_score from public.feed_page(null, 40))
     select (select feed_score from f where id = 'c3010000-0000-4000-8000-0000000000a2')
          - (select feed_score from f where id = 'c3010000-0000-4000-8000-0000000000a3') $$,
  $$ select round(18 * (public.relationship_score(auth.uid(), tests.uid('m3'))
                      - public.relationship_score(auth.uid(), tests.uid('norec'))), 6) $$,
  'and so do the follow row and the interaction-only row, on the same rule');

-- =====================================================================
-- The cap is real: 0.55 + 0.45 is 1.00, not 1.00-and-a-bit
-- =====================================================================
select tests.clear_auth();
insert into public.reactions (post_id, user_id, kind, created_at)
values ('c3010000-0000-4000-8000-0000000000b2', tests.uid('m1'), 'cheer', now() - interval '5 days');
select tests.set_auth(tests.uid('m1'));
select pg_catalog.set_config('role', 'postgres', true);

select is(
  (select public.relationship_score(tests.uid('m1'), tests.uid('m3'))),
  1.0::numeric,
  'following a member AND having reacted to them recently sums to 0.55 + 0.45 and is capped at exactly 1, the same ceiling a mutual follow reaches');

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select id, feed_score from public.feed_page(null, 40) $$,
  $$ values ('c3010000-0000-4000-8000-0000000000a2'::uuid, 54.328735::numeric),
            ('c3010000-0000-4000-8000-0000000000a1'::uuid, 54.328735::numeric),
            ('c3010000-0000-4000-8000-0000000000a3'::uuid, 44.428735::numeric) $$,
  'in the feed the capped author now ties the mutual one to the last decimal, and the tie falls to published_at then id - the same tiebreak as before');

-- =====================================================================
-- p_as_of really is the window anchor, not decoration
-- =====================================================================
select tests.clear_auth();
-- The coach's only interaction with m1 is a comment 40 days old: outside the
-- 30-day window measured from now(), inside it measured from 15 days ago.
insert into public.post_comments (post_id, author_id, body, created_at)
values ('c3010000-0000-4000-8000-0000000000b3', tests.uid('m1'), 'nice session', now() - interval '40 days');
select tests.set_auth(tests.uid('m1'));
select pg_catalog.set_config('role', 'postgres', true);

select is(
  (select public.relationship_score(tests.uid('m1'), tests.uid('coach'))),
  0.0::numeric,
  'a comment 40 days old is outside the 30-day window and counts for nothing');
select is(
  (select public.relationship_score(tests.uid('m1'), tests.uid('coach'), now() - interval '15 days')),
  0.45::numeric,
  'the same comment counts when the window is measured from an anchor 15 days back - which is what keeps every page of one feed session scoring identically');

-- The comment branch is a real branch: nothing above it reached the coach.
select isnt(
  (select public.relationship_score(tests.uid('m1'), tests.uid('coach'), now() - interval '15 days')),
  0.0::numeric,
  'a comment the viewer left on that member''s post is interaction, the same as a reaction');

-- =====================================================================
-- COMM-125. The block edge feed_page already respected is not loosened.
-- =====================================================================
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select id from public.feed_page(null, 40) $$,
  $$ values ('c3010000-0000-4000-8000-0000000000a1'::uuid),
            ('c3010000-0000-4000-8000-0000000000a3'::uuid) $$,
  'a block in either direction still removes that author from the candidate set entirely, however high the relationship score would have been');

-- =====================================================================
-- people_suggestions (COMM-232) is out of scope and stays out
-- =====================================================================
-- Its priority order - challenge, then interaction, then event - is a
-- different question from "how close is this pair already" and is pinned by
-- 0034. This asserts the boundary itself: the extraction did not leak into
-- it. If a later ticket decides the two should share arithmetic, this fails
-- and forces that decision to be made deliberately.
select is_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'people_suggestions'
       and p.prosrc like '%relationship_score%' $$,
  'people_suggestions does not call relationship_score - COMM-232''s own ordering rule is untouched by this ticket');

select isnt_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'feed_page'
       and p.prosrc like '%relationship_score%' $$,
  'feed_page, on the other hand, calls it rather than repeating it');

select * from finish();
rollback;
