-- COMM-303: behavioural coverage for 202608310006 (member_feed_weights,
-- feed_weights_resolve, the recompute_feed_weights stub, and feed_page
-- re-created to read per-user weights).
--
-- THE LOAD-BEARING ASSERTION IN THIS FILE IS THE ONE THAT PROVES NOTHING
-- HAPPENED. COMM-303's most important acceptance criterion is that a member
-- with no stored weights gets exactly today's feed order, so this ticket
-- changes no existing feed order until a weight is actually personalized.
-- Section D asserts that directly, against the SAME three fixture posts and
-- the SAME three six-decimal-place literals 0038 captured from feed_page as
-- it stood BEFORE COMM-301 - so those numbers have now survived three
-- re-creations of this function unchanged. It asserts it five times over: no
-- row at all, a row holding the empty object, a row of explicit all-1.0
-- multipliers, a row where every multiplier is at the 2.5 ceiling (a uniform
-- boost is not a boost - it cancels in the rescale), and a row of pure junk.
--
-- The rest:
--   A. member_feed_weights' boundary. Own-row read and NOTHING else: no
--      insert, update or delete grant and no policy for any of the three,
--      counted from pg_policies so a later addition fails here rather than
--      slipping in. service_role writes it; anon cannot reach it at all.
--   B/C. The two new functions' reachability. feed_weights_resolve is
--      internal with no grant to any role; recompute_feed_weights is
--      service_role only AND IS A NO-OP - asserted as such, because a stub
--      that quietly started writing rows would personalize every member's
--      feed from a heuristic nobody reviewed.
--   E. A stored row really does move the score, in the expected direction
--      and by the expected amount, and the components nobody boosted really
--      do go down - emphasis moved, not added.
--   F. THE SUM INVARIANT. Over seven pathological stored rows: the resolved
--      set sums to the defaults' own total, and every component stays inside
--      0.40..2.50 of its own default. One of the seven is exactly the case a
--      naive clamp-then-rescale gets wrong.
--   G. v_w_class moves like any other weight - at the resolver and in a real
--      ranked feed against a real attendance overlap.
--   H. COMM-112 diversity still runs after personalized scoring, unchanged,
--      structurally and behaviourally.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- rls_helpers' invite_redemptions rows fire the POST_NEW_MEMBER trigger
-- (202608290014). Those posts are authorless, published at now() and carry
-- gen_random_uuid() ids, so leaving them in would make a pinned feed order
-- non-deterministic for reasons that have nothing to do with this ticket.
-- Same removal 0038 makes, for the same reason.
delete from public.workout_posts where post_type = 'POST_NEW_MEMBER';

-- feed_page's default weight block, in one place, so the queries below hold
-- exactly one copy of those eight numbers. Section F pins this copy to the
-- one inside feed_page, so it cannot go stale without this file failing.
create temporary table w_defaults (d jsonb) on commit drop;
insert into w_defaults values (
  '{"recency":40,"relationship":18,"coach":10,"achievement":8,
    "challenge":6,"engagement":10,"personal":12,"class":6}'::jsonb);

-- =====================================================================
-- A. member_feed_weights: own-row read, and no write path at all
-- =====================================================================
select has_table('public', 'member_feed_weights', 'member_feed_weights exists');

select is(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'public.member_feed_weights'::regclass),
  true,
  'row level security is enabled on member_feed_weights');

select is(
  (select count(*)::int from pg_catalog.pg_policies
   where schemaname = 'public' and tablename = 'member_feed_weights'),
  1,
  'exactly one policy on member_feed_weights');

select is(
  (select count(*)::int from pg_catalog.pg_policies
   where schemaname = 'public' and tablename = 'member_feed_weights' and cmd <> 'SELECT'),
  0,
  'not one INSERT, UPDATE or DELETE policy on member_feed_weights - counted, so a later addition fails here rather than slipping in');

select ok(
  pg_catalog.has_table_privilege('authenticated', 'public.member_feed_weights', 'select'),
  'authenticated may select member_feed_weights');
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.member_feed_weights', 'insert'),
  'authenticated has no insert grant - a member cannot hand themselves a ranking input');
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.member_feed_weights', 'update'),
  'authenticated has no update grant');
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.member_feed_weights', 'delete'),
  'authenticated has no delete grant');
select ok(
  not pg_catalog.has_table_privilege('anon', 'public.member_feed_weights', 'select'),
  'anon has no select grant either');

select is(
  (select confdeltype from pg_catalog.pg_constraint
   where conrelid = 'public.member_feed_weights'::regclass and contype = 'f'),
  'c'::"char",
  'user_id cascades from profiles on delete - a purged member leaves no orphan weight row behind');

-- The service-role writer is the only writer, and it is exercised as a real
-- service_role: not the bootstrap superuser, which would sail past a missing
-- grant and tell us nothing about whether the scheduled job can write.
select pg_catalog.set_config('role', 'service_role', true);

select lives_ok(
  $$ insert into public.member_feed_weights (user_id, weights)
     values ('aaaaaaaa-0000-4000-8000-000000000002', '{"coach": 1.5}') $$,
  'service_role writes a weights row directly, the same shape weekly_recaps uses for its own service-role-only writer');

select results_eq(
  $$ select weights, (computed_at is not null) from public.member_feed_weights
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000002' $$,
  $$ values ('{"coach": 1.5}'::jsonb, true) $$,
  'and computed_at defaults on its own, so a writer that only knows the multipliers still produces a complete row');

select throws_ok(
  $$ insert into public.member_feed_weights (user_id, weights)
     values ('aaaaaaaa-0000-4000-8000-000000000003', '[1,2,3]') $$,
  '23514',
  null,
  'a weights value that is not a json object is refused by the check constraint - every reader treats it as an object, so the table may not hold anything else');

select throws_ok(
  $$ insert into public.member_feed_weights (user_id, weights)
     values ('aaaaaaaa-0000-4000-8000-000000000003', '"hello"') $$,
  '23514',
  null,
  'and neither may it hold a bare json string');

select tests.clear_auth();
delete from public.member_feed_weights;

-- The client boundary.
insert into public.member_feed_weights (user_id, weights) values
  (tests.uid('m1'), '{"coach": 1.4}'),
  (tests.uid('m2'), '{"coach": 0.6}');

select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select count(*)::int from public.member_feed_weights $$,
  $$ values (1) $$,
  'member A sees exactly their own weight row and nothing else in the table');
select isnt_empty(
  $$ select 1 from public.member_feed_weights where user_id = tests.uid('m1') $$,
  'member A reads their own weights - there is nothing private in them and a support answer is easier when they are inspectable');
select is_empty(
  $$ select 1 from public.member_feed_weights where user_id = tests.uid('m2') $$,
  'member A cannot read member B''s weights - refused by RLS, not by client logic');

select throws_ok(
  $$ insert into public.member_feed_weights (user_id, weights)
     values (tests.uid('m1'), '{"recency": 2.5}') $$,
  '42501',
  null,
  'a member cannot insert their own weight row - a client-supplied weight is exactly the client-trusted ranking input COMM-303''s contract section refuses');
select throws_ok(
  $$ update public.member_feed_weights set weights = '{"recency": 2.5}'
     where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'a member cannot update their own weight row');
select throws_ok(
  $$ delete from public.member_feed_weights where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'a member cannot delete their own weight row');

-- An admin is a member here too: is_admin() buys nothing on this table,
-- because there is no write policy for it to be evaluated against.
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ insert into public.member_feed_weights (user_id, weights)
     values (tests.uid('admin'), '{"recency": 2.5}') $$,
  '42501',
  null,
  'an admin cannot write a weight row either - there is no write policy for anyone to match');

select pg_catalog.set_config('role', 'anon', true);
select throws_ok(
  $$ select 1 from public.member_feed_weights $$,
  '42501',
  null,
  'anon cannot reach member_feed_weights at all - the revoke means it is not reachable rather than reachable and filtered');

select tests.clear_auth();
delete from public.member_feed_weights;

-- =====================================================================
-- B. feed_weights_resolve is internal plumbing, not a second API surface
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'feed_weights_resolve'),
  false,
  'feed_weights_resolve is SECURITY INVOKER - it borrows the rights of the definer function that calls it and grants none of its own, the shape relationship_score() and classmate_day_counts() both use');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.feed_weights_resolve(uuid, jsonb)', 'execute'),
  'authenticated cannot execute feed_weights_resolve');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.feed_weights_resolve(uuid, jsonb)', 'execute'),
  'anon cannot execute feed_weights_resolve');
select ok(
  not pg_catalog.has_function_privilege('public', 'public.feed_weights_resolve(uuid, jsonb)', 'execute'),
  'and neither can PUBLIC, so the default grant every new function starts with really was revoked');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.feed_weights_resolve(tests.uid('m1'), '{"recency":40}'::jsonb) $$,
  '42501',
  null,
  'a real authenticated caller reaching for it directly is refused by the grant, not by a check inside the body');
select tests.clear_auth();

-- =====================================================================
-- C. recompute_feed_weights: service_role only, and a NO-OP
-- =====================================================================
select ok(
  pg_catalog.has_function_privilege('service_role', 'public.recompute_feed_weights(integer)', 'execute'),
  'service_role may execute recompute_feed_weights - the weekly scheduled job''s entry point');
select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.recompute_feed_weights(integer)', 'execute'),
  'authenticated cannot execute recompute_feed_weights - a member may not ask for their own weights to be recomputed');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.recompute_feed_weights(integer)', 'execute'),
  'anon cannot execute recompute_feed_weights');
select ok(
  not pg_catalog.has_function_privilege('public', 'public.recompute_feed_weights(integer)', 'execute'),
  'and neither can PUBLIC');
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'recompute_feed_weights'),
  true,
  'recompute_feed_weights is SECURITY DEFINER with the grant as its only gate - notif_batch_flush_due''s auth shape, and the same documented no-auth.uid() exception, since service_role has no uid to check');

-- IT IS A STUB AND MUST STAY ONE UNTIL A LATER TICKET WRITES A BODY.
select pg_catalog.set_config('role', 'service_role', true);
select is(
  (select public.recompute_feed_weights()),
  0,
  'recompute_feed_weights() returns 0 rows written - the zero-argument call form resolves, and the answer is the "rows written" integer notif_batch_flush_due() also returns');
select is(
  (select public.recompute_feed_weights(50)),
  0,
  'and so does the p_limit form, whose argument is accepted and unused today on purpose, so a scheduler''s call site does not change when the body lands');
select is(
  (select count(*)::int from public.member_feed_weights),
  0,
  'and it wrote NOTHING. COMM-303 ships the storage and the reader, not the derivation: a stub that quietly wrote a row would personalize every member''s feed from a heuristic nobody reviewed');
select tests.clear_auth();

-- =====================================================================
-- The fixture. 0038's, verbatim, and for the same reason.
--
-- Three candidates, identical in every scored respect except their author:
-- same post_type (POST_TEXT scores zero on the coach, achievement and
-- challenge components and is diversity-neutral, so no reordering pass can
-- touch them), same visibility, same published_at, no reactions, no
-- comments, no mention of the viewer, three different non-staff authors.
-- Every difference in their final score is therefore the relationship term
-- and nothing else - which is what makes the gaps in section E readable as a
-- weight.
--
-- A FOURTH post is added beyond 0038's fixture, by a member the viewer has
-- no edge with of any kind. It scores on recency ALONE, so its total is the
-- recency weight times the half-life factor and nothing else - which makes
-- it the one row in this file that reads a single weight directly, and the
-- row section E uses to show the un-boosted components really do go down.
-- =====================================================================
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-0000000000a9', 'authenticated', 'authenticated', 'a9@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now());
insert into public.profiles (id, handle, display_name, recovery_verified_at)
values ('bbbbbbbb-0000-4000-8000-0000000000a9', 'no_edges', 'No Edges At All', now());

insert into public.workout_posts (id, author_id, post_type, status, visibility, body, published_at, created_at)
values
  ('c3030000-0000-4000-8000-0000000000a1', tests.uid('m2'),    'POST_TEXT', 'active', 'club', 'mutual follow author',    now() - interval '5 hours', now() - interval '5 hours'),
  ('c3030000-0000-4000-8000-0000000000a2', tests.uid('m3'),    'POST_TEXT', 'active', 'club', 'one-way follow author',   now() - interval '5 hours', now() - interval '5 hours'),
  ('c3030000-0000-4000-8000-0000000000a3', tests.uid('norec'), 'POST_TEXT', 'active', 'club', 'recent interaction only', now() - interval '5 hours', now() - interval '5 hours'),
  ('c3030000-0000-4000-8000-0000000000a4', 'bbbbbbbb-0000-4000-8000-0000000000a9', 'POST_TEXT', 'active', 'club', 'no signal at all', now() - interval '5 hours', now() - interval '5 hours');

-- The interaction signal comes from a post 200 days back - outside
-- feed_page's 90-day candidate window - so the reaction that creates it
-- cannot also raise a candidate's engagement component.
insert into public.workout_posts (id, author_id, post_type, status, visibility, body, published_at, created_at)
values
  ('c3030000-0000-4000-8000-0000000000b1', tests.uid('norec'), 'POST_TEXT', 'active', 'club', 'old post', now() - interval '200 days', now() - interval '200 days');

insert into public.reactions (post_id, user_id, kind, created_at)
values ('c3030000-0000-4000-8000-0000000000b1', tests.uid('m1'), 'cheer', now() - interval '5 days');

insert into public.follows (follower_id, followed_id) values
  (tests.uid('m1'), tests.uid('m2')),
  (tests.uid('m2'), tests.uid('m1')),
  (tests.uid('m1'), tests.uid('m3'));

-- =====================================================================
-- D. THE BYTE-IDENTICAL PIN. The whole ticket rests on this.
--
-- These are 0038's literals, captured by running this fixture against
-- feed_page as it stood BEFORE 202608310002 - two re-creations of this
-- function ago. They have not moved since, and they must not move now:
--
--   recency      40 * 0.5^(5/36)              = 36.328735
--   m2  mutual   36.328735 + 18 * 1.00        = 54.328735
--   m3  follow   36.328735 + 18 * 0.55        = 46.228735
--   norec top-up 36.328735 + 18 * 0.45        = 44.428735
--
-- Five times over: with no member_feed_weights row (which is every member
-- today, since nothing writes that table), with the empty object the
-- recomputation job writes for a member who produced no signal, with an
-- explicit all-1.0 object, with every multiplier at the 2.5 ceiling, and
-- with a row of junk.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select id, feed_score from public.feed_page(null, 40) $$,
  $$ values ('c3030000-0000-4000-8000-0000000000a1'::uuid, 54.328735::numeric),
            ('c3030000-0000-4000-8000-0000000000a2'::uuid, 46.228735::numeric),
            ('c3030000-0000-4000-8000-0000000000a3'::uuid, 44.428735::numeric),
            ('c3030000-0000-4000-8000-0000000000a4'::uuid, 36.328735::numeric) $$,
  'NO STORED WEIGHTS ROW: feed_page returns the same rows in the same order with the same scores as before COMM-303, to six decimal places, against literals captured from the pre-COMM-301 function');

select tests.clear_auth();
insert into public.member_feed_weights (user_id, weights) values (tests.uid('m1'), '{}');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select id, feed_score from public.feed_page(null, 40) $$,
  $$ values ('c3030000-0000-4000-8000-0000000000a1'::uuid, 54.328735::numeric),
            ('c3030000-0000-4000-8000-0000000000a2'::uuid, 46.228735::numeric),
            ('c3030000-0000-4000-8000-0000000000a3'::uuid, 44.428735::numeric),
            ('c3030000-0000-4000-8000-0000000000a4'::uuid, 36.328735::numeric) $$,
  'AN EMPTY WEIGHTS OBJECT scores identically - COMM-303 never produces a personalized set from zero data, and "we looked on Monday and found nothing" must cost a member nothing');

select tests.clear_auth();
update public.member_feed_weights
   set weights = '{"recency":1,"relationship":1,"coach":1,"achievement":1,"challenge":1,"engagement":1,"personal":1,"class":1}'
 where user_id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select id, feed_score from public.feed_page(null, 40) $$,
  $$ values ('c3030000-0000-4000-8000-0000000000a1'::uuid, 54.328735::numeric),
            ('c3030000-0000-4000-8000-0000000000a2'::uuid, 46.228735::numeric),
            ('c3030000-0000-4000-8000-0000000000a3'::uuid, 44.428735::numeric),
            ('c3030000-0000-4000-8000-0000000000a4'::uuid, 36.328735::numeric) $$,
  'AN EXPLICIT ALL-1.0 OBJECT scores identically too - 1.0 means the default, so the identity multiplier really is the identity');

select tests.clear_auth();
update public.member_feed_weights
   set weights = '{"recency":2.5,"relationship":2.5,"coach":2.5,"achievement":2.5,"challenge":2.5,"engagement":2.5,"personal":2.5,"class":2.5}'
 where user_id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select id, feed_score from public.feed_page(null, 40) $$,
  $$ values ('c3030000-0000-4000-8000-0000000000a1'::uuid, 54.328735::numeric),
            ('c3030000-0000-4000-8000-0000000000a2'::uuid, 46.228735::numeric),
            ('c3030000-0000-4000-8000-0000000000a3'::uuid, 44.428735::numeric),
            ('c3030000-0000-4000-8000-0000000000a4'::uuid, 36.328735::numeric) $$,
  'EVERY MULTIPLIER AT THE 2.5 CEILING scores identically as well - a uniform boost is not a boost, it cancels in the rescale, which is what "redistributes rather than inflates" means at its limit');

select tests.clear_auth();
update public.member_feed_weights
   set weights = '{"recency":"banana","relationship":null,"nonsense":3,"coach":{"a":1}}'
 where user_id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select id, feed_score from public.feed_page(null, 40) $$,
  $$ values ('c3030000-0000-4000-8000-0000000000a1'::uuid, 54.328735::numeric),
            ('c3030000-0000-4000-8000-0000000000a2'::uuid, 46.228735::numeric),
            ('c3030000-0000-4000-8000-0000000000a3'::uuid, 44.428735::numeric),
            ('c3030000-0000-4000-8000-0000000000a4'::uuid, 36.328735::numeric) $$,
  'A ROW OF JUNK - a string, a json null, an unknown key, a nested object - scores identically and raises nothing: a malformed row costs a member their personalization, never their feed');

-- =====================================================================
-- E. A stored row moves the score, in the right direction, by the right
--    amount.
--
-- {"relationship": 2.5} with the other seven keys absent (so 1.0):
--   sum of clamped targets = 110 - 18 + 45      = 137
--   scale                  = 110 / 137          = 0.802919708...
--   relationship           = 18 * 2.5 * 110/137 = 36.131386861...
--   every other weight     = its default * 110/137
-- Nothing is pinned, so one pass settles it.
--
-- The three rows differ only in their author, so the gap between any two IS
-- the resolved relationship weight times the gap between the two authors'
-- relationship_score - the recency, engagement, personal and repetition
-- terms are equal on both sides and cancel exactly. That makes both gaps
-- below closed-form and independent of when the suite runs.
-- =====================================================================
select tests.clear_auth();
update public.member_feed_weights set weights = '{"relationship": 2.5}'
 where user_id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ with f as (select id, feed_score from public.feed_page(null, 40))
     select (select feed_score from f where id = 'c3030000-0000-4000-8000-0000000000a1')
          - (select feed_score from f where id = 'c3030000-0000-4000-8000-0000000000a2') $$,
  $$ select round((18 * 2.5 * 110 / 137) * (1.00 - 0.55), 6) $$,
  'boosting relationship widens the gap between the mutual-follow row and the one-way-follow row to exactly the RESOLVED weight times the relationship_score gap - the redistribution is applied, not approximated');

select results_eq(
  $$ with f as (select id, feed_score from public.feed_page(null, 40))
     select (select feed_score from f where id = 'c3030000-0000-4000-8000-0000000000a2')
          - (select feed_score from f where id = 'c3030000-0000-4000-8000-0000000000a3') $$,
  $$ select round((18 * 2.5 * 110 / 137) * (0.55 - 0.45), 6) $$,
  'and the follow row and the interaction-only row separate on the same rule');

select ok(
  (select (select f.feed_score from public.feed_page(null, 40) f where f.id = 'c3030000-0000-4000-8000-0000000000a1')
        - (select f.feed_score from public.feed_page(null, 40) f where f.id = 'c3030000-0000-4000-8000-0000000000a2')) > 8.1,
  'the direction is up: that gap was 18 * 0.45 = 8.1 on the defaults and is strictly larger now - who wrote it matters more to this member than it does to the club');

-- The other side of a redistribution, and the reason the fourth fixture post
-- exists: the components nobody boosted go DOWN. That row scores on recency
-- alone, so its whole total is one weight and the drop is unmixed with any
-- gain. Rows that DO carry relationship go up in absolute terms - which is
-- the point, and is why "everything goes down" would have been the wrong
-- claim to make here.
select results_eq(
  $$ select f.feed_score from public.feed_page(null, 40) f
      where f.id = 'c3030000-0000-4000-8000-0000000000a4' $$,
  $$ select round(36.328735 * 110 / 137, 6) $$,
  'and the row with no signal but freshness scores LOWER, at exactly its old score times the 110/137 rescale - the budget relationship gained came out of the other seven components, it was not added to the total');

select ok(
  (select f.feed_score from public.feed_page(null, 40) f
    where f.id = 'c3030000-0000-4000-8000-0000000000a4') < 36.328735,
  'stated as a direction too, so the exact-value assertion above cannot pass with the rescale inverted');

-- =====================================================================
-- F. THE SUM INVARIANT, and the bounds, over pathological stored rows.
--
-- Asserted at the resolver rather than through a feed, because no fixture
-- feed can exercise a weight set whose naive rescale would breach the floor.
-- The second case below is exactly that: {recency 2.5, everything else 0.4}
-- gives clamped targets summing to 128 and a naive scale of 110/128 = 0.859,
-- which would push the seven un-boosted components to 0.344x their default -
-- under the 0.40 floor the clamp exists to hold. The bounded rescale pins
-- those seven AT the floor and hands the remaining budget to recency.
-- =====================================================================
select tests.clear_auth();

create temporary table w_cases (uid uuid, label text, stored jsonb) on commit drop;
insert into w_cases values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'one component boosted',        '{"relationship": 2.5}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'one boosted, rest at floor',   '{"recency":2.5,"relationship":0.4,"coach":0.4,"achievement":0.4,"challenge":0.4,"engagement":0.4,"personal":0.4,"class":0.4}'),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'two above the ceiling, one below the floor', '{"recency":99,"class":99,"coach":-5}'),
  ('bbbbbbbb-0000-4000-8000-000000000004', 'recency crushed',              '{"recency":0.01}'),
  ('bbbbbbbb-0000-4000-8000-000000000005', 'mixed, none extreme',          '{"recency":0.7,"class":1.9,"personal":1.3}'),
  ('bbbbbbbb-0000-4000-8000-000000000006', 'unknown key beside a real one','{"class":2.2,"loudness":9}'),
  ('bbbbbbbb-0000-4000-8000-000000000007', 'every component moved',        '{"recency":0.5,"relationship":2.4,"coach":0.6,"achievement":1.7,"challenge":2.5,"engagement":0.4,"personal":1.1,"class":2.0}');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', c.uid, 'authenticated', 'authenticated',
       'w' || right(c.uid::text, 2) || '@members.haimuniya.invalid',
       '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()
from w_cases c;
insert into public.profiles (id, handle, display_name, recovery_verified_at)
select c.uid, 'wcase_' || right(c.uid::text, 2), 'Weight Case', now() from w_cases c;
insert into public.member_feed_weights (user_id, weights)
select c.uid, c.stored from w_cases c;

select is_empty(
  $$ select c.label
     from w_cases c
     where round((select sum((e.value #>> '{}')::numeric)
                  from jsonb_each(public.feed_weights_resolve(c.uid, (select d from w_defaults))) e), 6)
        <> round((select sum((e.value #>> '{}')::numeric)
                  from jsonb_each((select d from w_defaults)) e), 6) $$,
  'THE SUM INVARIANT: every one of the seven personalized weight sets sums to exactly what the default block sums to. Personalization is a redistribution, never a raise');

select is(
  (select round(sum((e.value #>> '{}')::numeric), 6) from jsonb_each((select d from w_defaults)) e),
  110.000000::numeric,
  'and that total is 110 today - the eight declared weights, class included. The "104" two migrations carried was the seven live weights while v_w_class was multiplied by a hard 0, and COMM-302 left it stale; COMM-303 corrects the comment and moves no weight');

select is_empty(
  $$ select c.label, e.key
     from w_cases c
     cross join lateral jsonb_each(public.feed_weights_resolve(c.uid, (select d from w_defaults))) e
     where (e.value #>> '{}')::numeric
             < 0.40 * ((select d from w_defaults) ->> e.key)::numeric - 0.000000001
        or (e.value #>> '{}')::numeric
             > 2.50 * ((select d from w_defaults) ->> e.key)::numeric + 0.000000001 $$,
  'THE BOUNDS: not one component of any of the seven sets leaves 0.40..2.50 of its own default - personalization can shift emphasis but never zeroes a component out and never lets one dominate');

select is_empty(
  $$ select c.label from w_cases c
     where public.feed_weights_resolve(c.uid, (select d from w_defaults)) = (select d from w_defaults) $$,
  'and none of the seven resolved back to the defaults, so neither assertion above passed vacuously');

select is_empty(
  $$ select c.label, e.key
     from w_cases c
     cross join lateral jsonb_each(public.feed_weights_resolve(c.uid, (select d from w_defaults))) e
     where not (select d from w_defaults) ? e.key $$,
  'every resolved set carries exactly the keys it was handed - the resolver is component-agnostic and invents nothing, so an unknown stored key ("loudness") never reaches feed_page');

-- The pinned case, read off exactly. This is the one a naive rescale gets
-- wrong, so it is asserted value by value rather than only in aggregate.
select results_eq(
  $$ select (public.feed_weights_resolve('bbbbbbbb-0000-4000-8000-000000000002', (select d from w_defaults)) ->> 'recency')::numeric,
            (public.feed_weights_resolve('bbbbbbbb-0000-4000-8000-000000000002', (select d from w_defaults)) ->> 'relationship')::numeric,
            (public.feed_weights_resolve('bbbbbbbb-0000-4000-8000-000000000002', (select d from w_defaults)) ->> 'class')::numeric $$,
  $$ values (82.0::numeric, 7.2::numeric, 2.4::numeric) $$,
  'the seven un-boosted components sit exactly ON the 0.40 floor (18*0.4 = 7.2, 6*0.4 = 2.4) and recency absorbs the whole remaining budget at 82 - 2.05x its default, inside the ceiling. A plain rescale would have put those seven at 0.344x instead');

-- The drift pin: the copy of the defaults in this file is the copy inside
-- feed_page. Retune a weight there and this fails here.
select is_empty(
  $$ select v.line
     from (values ('v_w_recency        numeric := 40;'),
                  ('v_w_relationship   numeric := 18;'),
                  ('v_w_coach          numeric := 10;'),
                  ('v_w_achievement    numeric := 8;'),
                  ('v_w_challenge      numeric := 6;'),
                  ('v_w_engagement     numeric := 10;'),
                  ('v_w_personal       numeric := 12;'),
                  ('v_w_class          numeric := 6;')) v(line)
     where not exists (
       select 1 from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'feed_page'
         and p.prosrc like '%' || v.line || '%') $$,
  'feed_page still declares those eight weights at those eight values - so the copy of them in this file, which every assertion in section F rests on, cannot go stale silently');

select isnt_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'feed_page'
       and p.prosrc like '%feed_weights_resolve%' $$,
  'and feed_page resolves them through feed_weights_resolve rather than repeating the redistribution inline');

-- =====================================================================
-- G. v_w_class is personalizable like any other weight.
--
-- COMM-303 names it explicitly, so it is asserted explicitly rather than
-- assumed to fall out of "all eight". Two fresh members, no follow edge to
-- the viewer either way, one post each at the same instant: the only thing
-- separating their scores is the class component.
--
--   gc1: 8 shared training days with m1, show_attendance ON  -> full 1.0
--   gc2: no attendance at all                                -> 0
--
-- Default gap = 6. With {"class": 2.5}: targets sum to 110 - 6 + 15 = 119,
-- scale = 110/119, resolved class = 6 * 2.5 * 110/119 = 13.865546...
-- =====================================================================
select tests.clear_auth();

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-0000000000c1', 'authenticated', 'authenticated', 'gc1@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'authenticated', 'authenticated', 'gc2@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now());
insert into public.profiles (id, handle, display_name, recovery_verified_at, show_attendance)
values
  ('bbbbbbbb-0000-4000-8000-0000000000c1', 'classmate_on',  'Classmate On',  now(), true),
  ('bbbbbbbb-0000-4000-8000-0000000000c2', 'classmate_off', 'No Attendance', now(), true);

-- Eight shared days is exactly v_class_saturation, so the component is at
-- its 1.0 ceiling and the gap is the whole weight rather than a fraction.
insert into public.attendance_log (user_id, occurred_on)
select tests.uid('m1'), current_date - g from generate_series(1, 8) g;
insert into public.attendance_log (user_id, occurred_on)
select 'bbbbbbbb-0000-4000-8000-0000000000c1', current_date - g from generate_series(1, 8) g;

insert into public.workout_posts (id, author_id, post_type, status, visibility, body, published_at, created_at)
values
  ('c3030000-0000-4000-8000-0000000000d1', 'bbbbbbbb-0000-4000-8000-0000000000c1', 'POST_TEXT', 'active', 'club', 'trains beside the viewer', now() - interval '5 hours', now() - interval '5 hours'),
  ('c3030000-0000-4000-8000-0000000000d2', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'POST_TEXT', 'active', 'club', 'never trains beside them', now() - interval '5 hours', now() - interval '5 hours');

delete from public.member_feed_weights where user_id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ with f as (select id, feed_score from public.feed_page(null, 40))
     select (select feed_score from f where id = 'c3030000-0000-4000-8000-0000000000d1')
          - (select feed_score from f where id = 'c3030000-0000-4000-8000-0000000000d2') $$,
  $$ select 6.000000::numeric $$,
  'on the defaults the classmate author outscores the stranger by exactly v_w_class = 6, COMM-302''s number, unchanged by this ticket');

select tests.clear_auth();
insert into public.member_feed_weights (user_id, weights) values (tests.uid('m1'), '{"class": 2.5}');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ with f as (select id, feed_score from public.feed_page(null, 40))
     select (select feed_score from f where id = 'c3030000-0000-4000-8000-0000000000d1')
          - (select feed_score from f where id = 'c3030000-0000-4000-8000-0000000000d2') $$,
  $$ select round(6 * 2.5 * 110 / 119, 6) $$,
  'V_W_CLASS MOVES: boosting it widens that gap to the resolved 6 * 2.5 * 110/119 = 13.865546. COMM-302''s weight is not special-cased as immovable - who this member trains with can carry more of their ranking than the club default gives it');

select ok(
  (select (select f.feed_score from public.feed_page(null, 40) f where f.id = 'c3030000-0000-4000-8000-0000000000d1')
        - (select f.feed_score from public.feed_page(null, 40) f where f.id = 'c3030000-0000-4000-8000-0000000000d2')) > 6,
  'and the direction is up, stated on its own so the exact-value assertion above cannot pass with the sign inverted');

-- The block edge is still strictly stronger than any weight COMM-303 can
-- give the component: a blocked author never reaches the scoring pass.
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id)
values ('bbbbbbbb-0000-4000-8000-0000000000c1', tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));

select is_empty(
  $$ select 1 from public.feed_page(null, 40) f
     where f.id = 'c3030000-0000-4000-8000-0000000000d1' $$,
  'a block in either direction still removes that author entirely, however far this member has boosted the component that would have favoured them');

select tests.clear_auth();
delete from public.blocks where blocker_id = 'bbbbbbbb-0000-4000-8000-0000000000c1';

-- =====================================================================
-- H. COMM-112 diversity is evaluated AFTER personalized scoring, unchanged.
--
-- Structurally first: personalization is resolved before the scoring query,
-- and the diversity pass is still after it. Then behaviourally, on a feed
-- scored with a personalized weight set at the ceiling.
-- =====================================================================
select is(
  (select (position('per-user weights (COMM-303)' in p.prosrc) > 0
       and position('per-user weights (COMM-303)' in p.prosrc)
             < position('--- score, then cut the page on the keyset' in p.prosrc))
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'feed_page'),
  true,
  'the weights are resolved BEFORE the scoring query - once per feed request, not once per candidate row, and fixed for the whole call like v_anchor');

select is(
  (select (position('--- diversity (COMM-112)' in p.prosrc)
             > position('--- score, then cut the page on the keyset' in p.prosrc))
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'feed_page'),
  true,
  'and the COMM-112 diversity pass is still AFTER it - personalization changes the score, not where the diversity rules run');

select is_empty(
  $$ select 1 from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'feed_page'
       and (p.prosrc not like '%v_max_same_author  constant integer := 2;%'
         or p.prosrc not like '%v_max_system_run   constant integer := 2;%'
         or p.prosrc not like '%v_max_workout_run  constant integer := 3;%'
         or p.prosrc not like '%v_prefer_after_workouts constant integer := 2;%') $$,
  'the four diversity limits are untouched and still constant - COMM-303 personalizes weights, and there is no per-member diversity');

-- Behavioural. One author with three posts, another with one, all four
-- ranked by recency ALONE - which is why section G's attendance overlap is
-- torn down first: leaving it would give the fourth post a class component
-- and put it second on score, so the diversity displacement below would
-- never be the thing under test.
select tests.clear_auth();
delete from public.attendance_log
 where user_id in (tests.uid('m1'), 'bbbbbbbb-0000-4000-8000-0000000000c1');
delete from public.workout_posts
 where id in ('c3030000-0000-4000-8000-0000000000a1',
              'c3030000-0000-4000-8000-0000000000a2',
              'c3030000-0000-4000-8000-0000000000a3',
              'c3030000-0000-4000-8000-0000000000a4',
              'c3030000-0000-4000-8000-0000000000d1',
              'c3030000-0000-4000-8000-0000000000d2');

insert into public.workout_posts (id, author_id, post_type, status, visibility, body, published_at, created_at)
values
  ('c3030000-0000-4000-8000-0000000000e1', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'POST_TEXT', 'active', 'club', 'run 1', now() - interval '30 hours', now() - interval '30 hours'),
  ('c3030000-0000-4000-8000-0000000000e2', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'POST_TEXT', 'active', 'club', 'run 2', now() - interval '31 hours', now() - interval '31 hours'),
  ('c3030000-0000-4000-8000-0000000000e3', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'POST_TEXT', 'active', 'club', 'run 3', now() - interval '32 hours', now() - interval '32 hours'),
  ('c3030000-0000-4000-8000-0000000000e4', 'bbbbbbbb-0000-4000-8000-0000000000c1', 'POST_TEXT', 'active', 'club', 'someone else', now() - interval '33 hours', now() - interval '33 hours');

update public.member_feed_weights
   set weights = '{"recency":2.5,"relationship":0.4,"coach":0.4,"achievement":0.4,"challenge":0.4,"engagement":0.4,"personal":0.4,"class":0.4}'
 where user_id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));

select results_eq(
  $$ select id from public.feed_page(null, 40) $$,
  $$ values ('c3030000-0000-4000-8000-0000000000e1'::uuid),
            ('c3030000-0000-4000-8000-0000000000e2'::uuid),
            ('c3030000-0000-4000-8000-0000000000e4'::uuid),
            ('c3030000-0000-4000-8000-0000000000e3'::uuid) $$,
  'on a feed scored with a personalized weight set, v_max_same_author still breaks the run at two: the third post by that author is displaced by the other member''s lower-scoring one. Personalization changes emphasis inside the ranked set, not the diversity guarantee across it');

select * from finish();
rollback;
