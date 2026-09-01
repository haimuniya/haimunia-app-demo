-- COMM-315, schema half: behavioural coverage for 202609010001
-- (member_of_week, member_of_week_category, member_of_week_candidates,
-- member_of_week_publish).
--
-- Five boundaries, each proved by a SCENARIO rather than by a structural
-- check, the style 0039 to 0044 established:
--
--   1. THE ROTATION IS DETERMINISTIC AND STATED. Four consecutive weeks
--      produce the four categories in the documented order, the cycle
--      closes at 28 days, and - the assertion the implementation choice
--      actually turns on - three consecutive weeks across the 2026/2027
--      ISO boundary produce three DIFFERENT categories, where the "ISO week
--      number mod 4" alternative the ticket offered as an example would
--      have repeated one. 2026 is a 53-week ISO year, so that boundary is
--      real and reachable, not hypothetical.
--   2. EACH CATEGORY RESPECTS ITS OWN PRIVACY TOGGLE. For all three
--      computed categories the fixture is built so that the member who is
--      EXCLUDED by the toggle would otherwise be the TOP candidate. A
--      filter that silently stopped working would therefore change who
--      comes first, not merely how many rows come back.
--   3. NO TWO CONSECUTIVE WEEKS - a real refusal from the function, proved
--      on a member who was in fact the published choice the week before,
--      and proved to be about ADJACENCY and not about repetition, by the
--      same member being published again two weeks later.
--   4. ONE PUBLISH PER WEEK - the second call raises and leaves nothing
--      behind: no second row, no second post, no second audit row.
--   5. THE RLS BOUNDARY - club-wide read for every signed-in member once
--      published, and NO client write path at all, asserted for a plain
--      member, a coach and an admin separately.
--
-- FIXTURE MECHANIC WORTH READING FIRST
-- Every week is an offset from tests.mow_base(), which is the Monday of a
-- `consistency_streak` week between four and seven weeks in the past -
-- chosen by solving the rotation backwards from the current week, so the
-- file means the same thing whatever day it runs on and every week it
-- touches is in the past. The four weeks are then:
--
--   base + 0   consistency_streak
--   base + 7   most_prs
--   base + 14  challenge_completion
--   base + 21  coachs_pick
--   base + 28  consistency_streak again (the cycle closing)
--
-- ONE THING THE FIXTURE CANNOT DO, stated rather than hidden: the
-- consistency category reads feed_leaderboard's consistency mode, which
-- reports the streak AS OF NOW and takes no as-of date (see the migration's
-- own note). So the attendance below is seeded relative to current_date,
-- not relative to base + 0, and this file proves the privacy behaviour of
-- that category rather than a historical streak it has no way to ask for.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- ---------------------------------------------------------------------
-- Fixture helpers
-- ---------------------------------------------------------------------

-- The Monday of a consistency_streak week, four to seven weeks back. Solved
-- from the rotation rather than hard-coded, so the file is date-independent
-- and so a change to the rotation epoch fails the self-check below rather
-- than silently shifting every scenario onto the wrong category.
create or replace function tests.mow_base() returns date
language sql stable as $fn$
  select (date_trunc('week', current_date::timestamp)::date)
       - ((((((date_trunc('week', current_date::timestamp)::date - date '2026-01-05') / 7) % 4) + 4) % 4) * 7)
       - 28;
$fn$;
grant execute on function tests.mow_base() to anon, authenticated, service_role;

-- The single envelope row member_of_week_candidates() always returns.
create or replace function tests.mow_env(p_week date) returns jsonb
language sql stable as $fn$
  select c from public.member_of_week_candidates(p_week) c;
$fn$;
grant execute on function tests.mow_env(date) to anon, authenticated, service_role;

create or replace function tests.mow_cand_ids(p_week date) returns uuid[]
language sql stable as $fn$
  select coalesce(array_agg((e ->> 'user_id')::uuid order by ord), array[]::uuid[])
  from jsonb_array_elements(tests.mow_env(p_week) -> 'candidates') with ordinality as t(e, ord);
$fn$;
grant execute on function tests.mow_cand_ids(date) to anon, authenticated, service_role;

create or replace function tests.mow_cand_detail(p_week date, p_user uuid, p_key text)
returns text language sql stable as $fn$
  select e -> 'detail' ->> p_key
  from jsonb_array_elements(tests.mow_env(p_week) -> 'candidates') e
  where (e ->> 'user_id')::uuid = p_user;
$fn$;
grant execute on function tests.mow_cand_detail(date, uuid, text) to anon, authenticated, service_role;

-- n consecutive training weeks ending in the current week, so
-- consistency_week_streaks() anchors and counts back exactly n.
create or replace function tests.mow_seed_streak(p_user uuid, p_weeks int) returns void
language sql as $fn$
  insert into public.attendance_log (user_id, occurred_on)
  select p_user, current_date - (g * 7) from generate_series(0, p_weeks - 1) g;
$fn$;
grant execute on function tests.mow_seed_streak(uuid, int) to anon, authenticated, service_role;

-- admin_actions is readable only under `community.analytics.view`
-- (202608280002), which a coach does not hold - so counting the audit rows
-- from inside the coach's session would read zero for the wrong reason.
-- This crosses that one boundary, on purpose, and checks the whole row
-- shape rather than just the count while it is there.
create or replace function tests.mow_audit_count(p_target uuid default null,
                                                 p_category text default null)
returns integer language sql stable security definer as $fn$
  select count(*)::integer from public.admin_actions a
  where a.action_type = 'member_of_week_publish'
    and a.target_type = 'member'
    and a.admin_id = tests.uid('coach')
    and (p_target is null or a.target_id = p_target)
    and (p_category is null or a.after_data ->> 'category' = p_category);
$fn$;
grant execute on function tests.mow_audit_count(uuid, text) to anon, authenticated, service_role;

create or replace function tests.mow_seed_prs(p_user uuid, p_day date, p_n int,
                                             p_vis public.post_visibility default 'club')
returns void language sql as $fn$
  insert into public.workout_posts
    (author_id, post_type, visibility, title, result_text, occurred_on, status)
  select p_user, 'POST_PR', p_vis, 'PR ' || g, '100 kg', p_day, 'active'
  from generate_series(1, p_n) g;
$fn$;
grant execute on function tests.mow_seed_prs(uuid, date, int, public.post_visibility) to anon, authenticated, service_role;

-- =====================================================================
-- 1. THE ROTATION RULE
-- =====================================================================
select is(
  (select p.provolatile from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'member_of_week_category'),
  'i'::"char",
  'member_of_week_category is IMMUTABLE - the rotation is arithmetic over a calendar and reads no table, which is what makes "auditable and repeatable" a property of the code rather than a promise about it');

select results_eq(
  $$ select public.member_of_week_category(tests.mow_base() + (g * 7))
     from generate_series(0, 4) g $$,
  $$ values ('consistency_streak'::text), ('most_prs'), ('challenge_completion'),
            ('coachs_pick'), ('consistency_streak') $$,
  'THE STATED ORDER: five consecutive Mondays produce consistency streak, most PRs, challenge completion, coach''s pick, and then consistency streak again - one category per week, in the order the migration names, with the cycle closing on the fifth');

select ok(
  (select bool_and(public.member_of_week_category(d) = public.member_of_week_category(d + 28))
   from (select date '2020-01-06' + (g * 7) as d from generate_series(0, 600) g) s),
  'and the cycle is exactly 28 days wide across eleven years of Mondays, in both directions from the epoch - 2020-01-06 is six years BEFORE it, so this also proves the negative-modulo branch really is a cycle and not a wrap-around bug');

select isnt(
  (select public.member_of_week_category(date '2020-01-06')), null,
  'a week before the 2026-01-05 epoch resolves to a real category rather than null: Postgres''s % keeps the sign of the dividend, so the rule normalises it - a fixture, a backfill or an early adopter club is a real input');

-- THE 53-WEEK YEAR. 2026-01-01 is a Thursday, so ISO year 2026 has 53
-- weeks. Under "ISO week number mod 4" the sequence there would read
-- 52 -> 0, 53 -> 1, then week 1 of 2027 -> 1: the same category two weeks
-- running. This is the concrete case the implementation choice was made
-- against, so it is asserted concretely.
select results_eq(
  $$ select extract(isoyear from d)::int, extract(week from d)::int
     from (values (date '2026-12-21'), (date '2026-12-28'), (date '2027-01-04')) v(d) $$,
  $$ values (2026, 52), (2026, 53), (2027, 1) $$,
  'the fixture dates really are ISO weeks 52, 53 and 1 - 2026 is a 53-week ISO year, so the boundary this rule was chosen against exists');

select ok(
  (select count(distinct public.member_of_week_category(d)) = 3
   from (values (date '2026-12-21'), (date '2026-12-28'), (date '2027-01-04')) v(d)),
  'THE REASON FOR THE EPOCH: three consecutive weeks across the 53-week year boundary get three DIFFERENT categories. "ISO week number mod 4" would have given weeks 53 and 1 the same index and repeated a category two weeks running, silently, every few years');

select is(
  public.member_of_week_category(tests.mow_base()),
  'consistency_streak',
  'fixture self-check: the base week this file solves for really is a consistency_streak week, so every scenario below is on the category it claims');

select is(
  public.member_of_week_category_label('coachs_pick'),
  'בחירת המאמן/ת',
  'each category has a Hebrew label in the database, so the suggestion card and the published post name it identically');

-- =====================================================================
-- 2. REACHABILITY AND THE RLS SHAPE OF THE TABLE
-- =====================================================================
select ok(
  (select c.relrowsecurity from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'member_of_week'),
  'member_of_week has RLS enabled');

select results_eq(
  $$ select polname, polcmd::text from pg_catalog.pg_policy
     where polrelid = 'public.member_of_week'::regclass order by polname $$,
  $$ values ('member_of_week_read'::name, 'r'::text) $$,
  'exactly one policy on the table and it is a SELECT policy - there is no insert, update or delete policy for anybody, which is the pins shape (202608280017) and for the same reason: the four rules publishing enforces must not depend on the client behaving');

select ok(
  pg_catalog.has_table_privilege('authenticated', 'public.member_of_week', 'select'),
  'authenticated may select');
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.member_of_week', 'insert')
  and not pg_catalog.has_table_privilege('authenticated', 'public.member_of_week', 'update')
  and not pg_catalog.has_table_privilege('authenticated', 'public.member_of_week', 'delete'),
  'and holds no insert, update or delete grant - asserted on the grant as well as on the policy, because either one alone would be enough to leave a write path open');
select ok(
  not pg_catalog.has_table_privilege('anon', 'public.member_of_week', 'select'),
  'anon reaches nothing');

select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'member_of_week_publish'),
  true,
  'member_of_week_publish is SECURITY DEFINER - it crosses into a table with no write policy at all, on purpose');

select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.member_of_week_candidates(date)', 'execute')
  and pg_catalog.has_function_privilege('authenticated', 'public.member_of_week_publish(date, uuid, text)', 'execute'),
  'both entry points are executable by authenticated - the staff test is inside the body, not in the grant, so a coach who is not an admin can still call them');

select ok(
  not pg_catalog.has_function_privilege('anon', 'public.member_of_week_candidates(date)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.member_of_week_publish(date, uuid, text)', 'execute'),
  'and neither anon nor PUBLIC can - PUBLIC asserted separately, because a new function starts with execute granted to PUBLIC and forgetting that one revoke is how a staff RPC quietly becomes an open one');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.member_of_week_candidate_set(text, date, int)', 'execute'),
  'the shared candidate-set helper is not reachable by a client at all: it applies the privacy toggles but has no staff gate of its own, because both of its callers have one');

-- =====================================================================
-- 3. FIXTURES
-- =====================================================================
-- For every computed category the member the toggle EXCLUDES is the member
-- who would otherwise come FIRST. A filter that stopped working would
-- change the head of the list, not just its length.
--
--   consistency_streak   norec has the longest streak and in_leaderboards
--                        off; m3 has a long streak and show_attendance off
--                        (the third gate feed_leaderboard adds).
--   most_prs             owner has 10 PRs and visible_to_club off; m2 has
--                        5 and show_prs off; m1 has 3 and is the answer.
--   challenge_completion norec has 2 completions and in_leaderboards off.

update public.profiles set show_prs = true,  show_attendance = true,  in_leaderboards = true
  where id = tests.uid('m1');
update public.profiles set show_prs = false, show_attendance = true,  in_leaderboards = true
  where id = tests.uid('m2');
update public.profiles set show_prs = true,  show_attendance = false, in_leaderboards = true
  where id = tests.uid('m3');
update public.profiles set show_prs = true,  show_attendance = true,  in_leaderboards = false
  where id = tests.uid('norec');
update public.profiles set show_prs = true,  show_attendance = true,  in_leaderboards = true,
                           visible_to_club = false
  where id = tests.uid('owner');

-- Streaks, anchored on the current week (see the header note).
select tests.mow_seed_streak(tests.uid('norec'), 4);
select tests.mow_seed_streak(tests.uid('m2'), 3);
select tests.mow_seed_streak(tests.uid('m1'), 2);
select tests.mow_seed_streak(tests.uid('m3'), 3);

-- PRs. Inside base+7 unless stated.
select tests.mow_seed_prs(tests.uid('owner'), tests.mow_base() + 8, 10);
select tests.mow_seed_prs(tests.uid('m2'),    tests.mow_base() + 8, 5);
select tests.mow_seed_prs(tests.uid('m1'),    tests.mow_base() + 8, 3);
select tests.mow_seed_prs(tests.uid('m3'),    tests.mow_base() + 9, 1);
-- The window proof: four more of m1's PRs, one week earlier. If the week
-- bound were wrong m1 would count 7 and the detail below would say so.
select tests.mow_seed_prs(tests.uid('m1'),    tests.mow_base() + 1, 4);
-- The post-visibility proof: an only_me PR of m3's inside the week. It is
-- m3's own business and must not be counted for a coach.
select tests.mow_seed_prs(tests.uid('m3'),    tests.mow_base() + 10, 1, 'only_me');

-- Challenges and completions, inside base+14 unless stated.
insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, status)
values
  ('c0000000-0000-4000-8000-000000000001', 'Challenge One',   'individual_target', 'reps',
   now() - interval '90 days', now() + interval '90 days', 'active'),
  ('c0000000-0000-4000-8000-000000000002', 'Challenge Two',   'individual_target', 'reps',
   now() - interval '90 days', now() + interval '90 days', 'active'),
  ('c0000000-0000-4000-8000-000000000003', 'Challenge Three', 'individual_target', 'reps',
   now() - interval '90 days', now() + interval '90 days', 'active'),
  ('c0000000-0000-4000-8000-000000000004', 'Challenge Four',  'individual_target', 'reps',
   now() - interval '90 days', now() + interval '90 days', 'draft'),
  ('c0000000-0000-4000-8000-000000000005', 'Challenge Five',  'individual_target', 'reps',
   now() - interval '90 days', now() + interval '90 days', 'active');

insert into public.challenge_participants (challenge_id, user_id, status, completed_at) values
  -- m1: one real completion in the week.
  ('c0000000-0000-4000-8000-000000000001', tests.uid('m1'), 'completed', (tests.mow_base() + 15)::timestamptz),
  -- ... plus one OUTSIDE the week, which must not count.
  ('c0000000-0000-4000-8000-000000000003', tests.uid('m1'), 'completed', (tests.mow_base() + 4)::timestamptz),
  -- ... plus one inside the week that was withdrawn, which must not count.
  ('c0000000-0000-4000-8000-000000000005', tests.uid('m1'), 'withdrawn', (tests.mow_base() + 16)::timestamptz),
  -- m3: one real completion, plus one on a DRAFT challenge. If the draft
  -- filter failed, m3 would count 2 and would displace m1 at the head.
  ('c0000000-0000-4000-8000-000000000002', tests.uid('m3'), 'completed', (tests.mow_base() + 16)::timestamptz),
  ('c0000000-0000-4000-8000-000000000004', tests.uid('m3'), 'completed', (tests.mow_base() + 17)::timestamptz),
  -- norec: two real completions, and in_leaderboards off.
  ('c0000000-0000-4000-8000-000000000001', tests.uid('norec'), 'completed', (tests.mow_base() + 15)::timestamptz),
  ('c0000000-0000-4000-8000-000000000002', tests.uid('norec'), 'completed', (tests.mow_base() + 16)::timestamptz);

-- =====================================================================
-- 4. STAFF GATE
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.member_of_week_candidates(null) $$,
  'P0001', 'not authorized',
  'a plain member cannot read the suggestions. The gate is inside the body, so it holds for a direct PostgREST call and not only for a hidden nav item');
select throws_ok(
  $$ select public.member_of_week_publish(tests.mow_base(), tests.uid('m2'), 'x') $$,
  'P0001', 'not authorized',
  'and cannot publish');

select tests.set_auth(tests.uid('coach'));

-- =====================================================================
-- 5. CANDIDATES, CATEGORY BY CATEGORY, AGAINST THE TOGGLES
-- =====================================================================
select is(
  tests.mow_env(tests.mow_base()) ->> 'category', 'consistency_streak',
  'the envelope names the week''s category, so the empty state can say WHICH category found nobody - which is why this function returns one row with a list inside it rather than one row per candidate');

select results_eq(
  $$ select tests.mow_cand_ids(tests.mow_base()) $$,
  $$ select array[tests.uid('m2'), tests.uid('m1')]::uuid[] $$,
  'CONSISTENCY, and the toggle proof: norec has the LONGEST streak (4 weeks) and is absent because in_leaderboards is off, m3 has a 3-week streak and is absent because show_attendance is off - the third gate this category inherits whole from feed_leaderboard, since the value being ranked is attendance-derived. What is left is m2 then m1, in streak order');

select is(
  tests.mow_cand_detail(tests.mow_base(), tests.uid('m2'), 'streak_weeks'), '3',
  'and the suggestion carries the number the coach is being asked to recognise, not just a name');

select is(
  tests.mow_env(tests.mow_base() + 7) ->> 'category', 'most_prs',
  'the next week is the PR week');

select results_eq(
  $$ select tests.mow_cand_ids(tests.mow_base() + 7) $$,
  $$ select array[tests.uid('m1'), tests.uid('m3')]::uuid[] $$,
  'MOST PRs, and two toggle proofs at once: the owner logged 10 PRs that week and is absent because visible_to_club is off, m2 logged 5 and is absent because show_prs is off. Both would have been ahead of m1''s 3. A coach is never handed a name they could not already see, and never handed one they could see but must not broadcast');

select is(
  tests.mow_cand_detail(tests.mow_base() + 7, tests.uid('m1'), 'pr_count'), '3',
  'm1 counts 3 and not 7: the four PRs they logged the week before are outside the window. The category is "most PRs THIS WEEK"');

select is(
  tests.mow_cand_detail(tests.mow_base() + 7, tests.uid('m3'), 'pr_count'), '1',
  'and m3 counts 1 and not 2: their second PR that week is only_me, and post_visible_to_viewer() keeps it out exactly as coach_celebrate_feed''s PR branch does. A private post is not evidence a coach may use in public');

select is(
  tests.mow_env(tests.mow_base() + 14) ->> 'category', 'challenge_completion',
  'the third week is the challenge week');

select results_eq(
  $$ select tests.mow_cand_ids(tests.mow_base() + 14) $$,
  $$ select array[tests.uid('m1'), tests.uid('m3')]::uuid[] $$,
  'CHALLENGE COMPLETION, and the toggle proof: norec completed two challenges that week - more than anyone - and is absent because in_leaderboards is off, the same toggle coach_celebrate_feed applies to a completion. A member who opted out of the leaderboard did not opt in to being announced');

select is(
  tests.mow_cand_detail(tests.mow_base() + 14, tests.uid('m3'), 'completions'), '1',
  'm3 counts 1 and not 2: their second completion that week is on a DRAFT challenge, which is not a thing the club can see. Had it counted, m3 would have displaced m1 at the head of the list');

select is(
  tests.mow_cand_detail(tests.mow_base() + 14, tests.uid('m1'), 'completions'), '1',
  'and m1 counts 1 and not 3: one completion is outside the week and one was withdrawn');

select is(
  tests.mow_env(tests.mow_base() + 21) ->> 'category', 'coachs_pick',
  'the fourth week is the coach''s pick');

select results_eq(
  $$ select (tests.mow_env(tests.mow_base() + 21) ->> 'free_selection')::boolean,
            jsonb_array_length(tests.mow_env(tests.mow_base() + 21) -> 'candidates') $$,
  $$ values (true, 0) $$,
  'COACH''S PICK: free_selection is true and the shortlist is empty - not "nobody qualified", but "this category has no computed shortlist by definition". The client branches on the flag rather than string-matching the category name');

select results_eq(
  $$ select jsonb_array_length(tests.mow_env(tests.mow_base() - 21) -> 'candidates'),
            tests.mow_env(tests.mow_base() - 21) ->> 'category' $$,
  $$ values (0, 'most_prs'::text) $$,
  'THE EMPTY STATE: a PR week nobody logged a PR in returns zero candidates and still names the category, which is what the "אין מועמדים השבוע לקטגוריה זו" state needs in order to say which category it means');

select results_eq(
  $$ select (tests.mow_env(null) ->> 'week_start')::date,
            tests.mow_env(null) ->> 'category',
            (tests.mow_env(null) ->> 'rotation_index')::int $$,
  $$ select date_trunc('week', current_date::timestamp)::date,
            public.member_of_week_category(date_trunc('week', current_date::timestamp)::date),
            ((((date_trunc('week', current_date::timestamp)::date - date '2026-01-05') / 7) % 4) + 4) % 4 $$,
  'a null p_week_start means THIS week - the Monday of the current ISO week, its rotation category, and the rotation index that produced it. That is what a publish control with no date picker calls, and the index is sent so the client can render "week N of 4" without re-deriving the rule in JavaScript');

select is(
  tests.mow_env(tests.mow_base() + 7),
  tests.mow_env(tests.mow_base() + 7),
  'and two identical calls return an identical envelope: the shortlist order is total (value, then display name, then id), so a coach refreshing the page does not get a reshuffled list');

select is_empty(
  $$ select 1 from public.member_of_week $$,
  'nothing has been published yet - reading the suggestions writes nothing, which is COMM-309''s generated-draft/staff-publishes shape and the whole reason this is two functions and not one');

-- =====================================================================
-- 6. PUBLISHING
-- =====================================================================
select throws_ok(
  $$ select public.member_of_week_publish(tests.mow_base() - 7, tests.uid('owner'), 'הכי הרבה שיאים') $$,
  'P0001', 'member is not visible to the club',
  'A MEMBER HIDDEN FROM THE CLUB IS NEVER PUBLISHED, even as a free coach''s pick and even though the calling coach can see them fine. Publishing is broadcasting, so this is asked of the visible_to_club COLUMN rather than of can_view_profile_field(), which would answer "yes, this coach may see them"');

select throws_ok(
  $$ select public.member_of_week_publish(tests.mow_base() - 7, tests.uid('m1'), '') $$,
  'P0001', 'reason required for a coach''s pick',
  'and a coach''s pick with no typed reason is refused: a free selection with no stated reason publishes a name and nothing else, where every computed category carries its reason in the category itself');

select lives_ok(
  $$ select public.member_of_week_publish(tests.mow_base(), tests.uid('m2'), '') $$,
  'the consistency week is published for m2, with no typed reason - which is legal here precisely because the category IS the reason');

select results_eq(
  $$ select category, reason, published_by = tests.uid('coach')
     from public.member_of_week where week_start = tests.mow_base() $$,
  $$ values ('consistency_streak'::text, ''::text, true) $$,
  'the row records the rotation category, an empty reason, and the coach who published it');

-- --- the celebratory post --------------------------------------------
select results_eq(
  $$ select w.post_type::text, w.author_id is null, w.visibility::text, w.status::text,
            w.source_type, w.source_id = m.id, w.occurred_on = m.week_start
     from public.member_of_week m join public.workout_posts w on w.id = m.post_id
     where m.week_start = tests.mow_base() $$,
  $$ values ('POST_ANNOUNCEMENT'::text, true, 'club'::text, 'active'::text,
             'announcement'::text, true, true) $$,
  'THE PUBLISH-POST DECISION, executed: an AUTHORLESS, club-visible POST_ANNOUNCEMENT pointing back at its member_of_week row. Not COMM-225''s comment-on-a-card pattern, which needs a source post that three of the four categories do not have, and not a coach-authored post, because member of the week is club voice and not one coach''s opinion of a member');

select results_eq(
  $$ select w.metadata ->> 'member_id' = tests.uid('m2')::text,
            w.metadata ->> 'category',
            w.metadata ->> 'week_start' = tests.mow_base()::text,
            coalesce(w.metadata ->> 'title', '') <> '',
            w.body like '%' || (select display_name from public.profiles where id = tests.uid('m2')) || '%'
     from public.member_of_week m join public.workout_posts w on w.id = m.post_id
     where m.week_start = tests.mow_base() $$,
  $$ values (true, 'consistency_streak'::text, true, true, true) $$,
  'the post carries a flat, self-describing metadata shape and names the member in its body. metadata.title is present because renderAnnouncementPostCard reads it FIRST - this is the first producer POST_ANNOUNCEMENT has ever had, and it had to fit the renderer that already shipped');

select results_eq(
  $$ select tests.mow_audit_count(tests.uid('m2'), 'consistency_streak') $$,
  $$ values (1) $$,
  'and exactly one admin_actions row, of a new action_type this migration added to the closed list rather than borrowing a label that would have made the audit log describe something else');

-- --- two consecutive weeks -------------------------------------------
select results_eq(
  $$ select (tests.mow_env(tests.mow_base() + 7) ->> 'previous_week_user_id')::uuid $$,
  $$ select tests.uid('m2') $$,
  'the next week''s envelope names last week''s member, so the free-selection form can grey them out instead of letting a coach discover the rule by hitting it');

select throws_ok(
  $$ select public.member_of_week_publish(tests.mow_base() + 7, tests.uid('m2'), 'שוב') $$,
  'P0001', 'member was recognised last week',
  'NO TWO CONSECUTIVE WEEKS, and it is a real refusal from the function rather than a suggestion-level nicety: m2 is not on the PR shortlist at all, so this call could only ever have arrived as a hand-made coach''s pick, and it is still refused');

select lives_ok(
  $$ select public.member_of_week_publish(tests.mow_base() + 7, tests.uid('m1'), '') $$,
  'the PR week is published for m1 instead');

select is(
  (select category from public.member_of_week where week_start = tests.mow_base() + 7),
  'most_prs',
  'recorded under the rotation category, because m1 was on that week''s computed shortlist');

-- --- one publish per week --------------------------------------------
select throws_ok(
  $$ select public.member_of_week_publish(tests.mow_base() + 7, tests.uid('m3'), 'שינוי דעה') $$,
  'P0001', 'week already published',
  'ONE PUBLISH PER WEEK: the second call for a week already published RAISES. Deliberately not weekly_recaps''s upsert - a recap is a regenerated summary, this is a public act of recognition that has already reached the feed, and quietly replacing it would leave the post naming one member and the row naming another');

select results_eq(
  $$ select (select user_id from public.member_of_week where week_start = tests.mow_base() + 7),
            (select count(*)::int from public.member_of_week),
            (select count(*)::int from public.workout_posts where post_type = 'POST_ANNOUNCEMENT'),
            (select tests.mow_audit_count()) $$,
  $$ select tests.uid('m1'), 2, 2, 2 $$,
  'and the refused call left NOTHING behind: same member on the row, two rows, two posts, two audit entries. Every refusal in this function is checked before the first insert, so a rejected publish is not a half-published one');

select is(
  (tests.mow_env(tests.mow_base() + 7) -> 'published' ->> 'user_id')::uuid,
  tests.uid('m1'),
  'the envelope for a published week reports who it went to, so the client can spend the publish control without a second round trip');

-- --- the normalisation ------------------------------------------------
select throws_ok(
  $$ select public.member_of_week_publish(tests.mow_base() + 11, tests.uid('m3'), 'x') $$,
  'P0001', 'week already published',
  'a mid-week date is normalised to its own ISO Monday rather than rejected: base+11 is the Friday of the PR week, and it collides with the PR week''s existing row instead of opening a second, parallel week. A coach tapping a date picker means the week a human means');

-- --- the rest of the cycle -------------------------------------------
select throws_ok(
  $$ select public.member_of_week_publish(tests.mow_base() + 14, tests.uid('m1'), 'שוב') $$,
  'P0001', 'member was recognised last week',
  'm1 in turn cannot be recognised again the following week - the rule is about adjacency and applies to whoever was last');

select lives_ok(
  $$ select public.member_of_week_publish(tests.mow_base() + 14, tests.uid('m3'), '') $$,
  'the challenge week goes to m3');

-- The coach's pick week, and the reason normalisation, in one call.
select lives_ok(
  $$ select public.member_of_week_publish(
       tests.mow_base() + 21, tests.uid('m2'),
       '   ' || repeat('א', 600) || chr(7) || '   ') $$,
  'ADJACENCY, NOT REPETITION: m2 - refused two weeks ago for being the previous week''s member - is published again now that a week sits between. Recognition spreads without being one-shot');

select results_eq(
  $$ select category, char_length(reason), position(chr(7) in reason), left(reason, 1)
     from public.member_of_week where week_start = tests.mow_base() + 21 $$,
  $$ values ('coachs_pick'::text, 500, 0, 'א'::text) $$,
  'the reason is trimmed, has its control characters stripped (it reaches the club feed, so post_create''s normalisation applies for the same reason it applies there) and is CAPPED at 500 rather than rejected - the same 500-char shape member_contact_log.note uses');

-- --- the fallback to coach's pick -------------------------------------
select results_eq(
  $$ select tests.mow_cand_ids(tests.mow_base() + 28) $$,
  $$ select array[tests.uid('m1')]::uuid[] $$,
  'the next consistency week suggests only m1: m2 has the longer streak but was recognised last week, so the shortlist drops them before the server would have to refuse them');

select lives_ok(
  $$ select public.member_of_week_publish(tests.mow_base() + 28, tests.uid('m3'), 'עזרה לחברים חדשים') $$,
  'staff publish m3 on a consistency week, even though m3 is not on that week''s shortlist - show_attendance is off, so they never could be');

select results_eq(
  $$ select category, reason from public.member_of_week where week_start = tests.mow_base() + 28 $$,
  $$ values ('coachs_pick'::text, 'עזרה לחברים חדשים'::text) $$,
  'THE FALLBACK, DERIVED RATHER THAN FLAGGED: publishing somebody the week''s computed shortlist did not contain IS a coach''s pick, and the row records it as one. That is COMM-315''s "staff can fall back to coach''s pick" empty state, expressed as a fact about who was chosen rather than as a parameter the client has to remember to send');

select results_eq(
  $$ select count(*)::int, count(distinct user_id)::int from public.member_of_week $$,
  $$ values (5, 3) $$,
  'five published weeks across three members, which is the point of a rotation: no member holds two adjacent weeks, and the same member can return later');

select results_eq(
  $$ select tests.mow_audit_count() $$,
  $$ values (5) $$,
  'one audit row per successful publish, all five naming the publishing coach and the member as target, and none for any of the five refusals');

-- --- the half of the filter the raw columns cannot do ----------------
-- can_view_profile_field() is kept alongside the column reads, not replaced
-- by them, and this is what it still contributes: a block edge in either
-- direction, settled once, in the module's single resolution point. Without
-- the helper call the columns alone would happily suggest a member the
-- calling coach is blocked from.
select results_eq(
  $$ select tests.mow_cand_ids(tests.mow_base() + 14) $$,
  $$ select array[tests.uid('m3')]::uuid[] $$,
  'the challenge week still suggests m3 to this coach (m1 now holds the week before it, so they drop out)');

select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('coach'));
select tests.set_auth(tests.uid('coach'));

select results_eq(
  $$ select tests.mow_cand_ids(tests.mow_base() + 14) $$,
  $$ select array[]::uuid[] $$,
  'and stops suggesting them the moment m3 blocks the coach - a block the COACH did not make, in the direction they did not make it. That is can_view_profile_field()''s contribution, which no column read can replace, which is why the helper call is kept alongside the columns rather than swapped for them');

select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m3') and blocked_id = tests.uid('coach');
select tests.set_auth(tests.uid('coach'));

-- =====================================================================
-- 7. THE RLS BOUNDARY, ONCE PUBLISHED
-- =====================================================================
select tests.set_auth(tests.uid('m3'));

select results_eq(
  $$ select count(*)::int from public.member_of_week $$,
  $$ values (5) $$,
  'CLUB-WIDE READ: a plain member sees every published week, including the four that are not about them. A published member of the week is the most public thing in the club - that is what publishing means');

select results_eq(
  $$ select count(*)::int from public.workout_posts
     where post_type = 'POST_ANNOUNCEMENT' and public.post_visible_to_viewer(id) $$,
  $$ values (5) $$,
  'and reads all five celebratory posts through the ordinary feed visibility rule, with no special case: they are club-visibility posts like any other');

select throws_ok(
  $$ insert into public.member_of_week (week_start, category, user_id)
     values (tests.mow_base() + 35, 'coachs_pick', tests.uid('m3')) $$,
  '42501', null,
  'NO CLIENT WRITE PATH: a plain member cannot insert. Refused by the missing grant, before any policy is even consulted');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ insert into public.member_of_week (week_start, category, user_id)
     values (tests.mow_base() + 35, 'coachs_pick', tests.uid('m3')) $$,
  '42501', null,
  'nor can a COACH - the staff who own this feature. Every rule publishing enforces (the week, the adjacency, the category, the audit row) would be bypassable by a direct insert, so there is no direct insert');
select throws_ok(
  $$ update public.member_of_week set user_id = tests.uid('coach') $$,
  '42501', null,
  'and a coach cannot rewrite a published week either');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ delete from public.member_of_week where week_start = tests.mow_base() $$,
  '42501', null,
  'and neither can an ADMIN, who reaches almost everything else in this schema through is_admin(). The table takes no client write of any kind');

select results_eq(
  $$ select count(*)::int from public.member_of_week $$,
  $$ values (5) $$,
  'five rows still, after three members of three different ranks each tried to write');

-- THE ADMIN CASE, which is the whole reason the raw columns are read
-- alongside can_view_profile_field(). That helper short-circuits to true for
-- an admin before it consults any toggle (202608280003), so for an admin
-- caller it filters nothing at all - and an admin is exactly the caller most
-- likely to be publishing. Each of the three toggles gets its own admin
-- assertion, because each is a separate column read.
select results_eq(
  $$ select tests.mow_cand_ids(tests.mow_base() + 7) $$,
  $$ select array[tests.uid('m1'), tests.uid('m3')]::uuid[] $$,
  'an ADMIN is still not offered the owner''s 10 PRs (visible_to_club off) nor m2''s 5 (show_prs off), even though can_view_profile_field() answers "yes, you may see both" for them. Both would have been at the head of the list. An admin''s rank governs what they may SEE, never what the club may be TOLD');

select results_eq(
  $$ select tests.mow_cand_ids(tests.mow_base() + 14) $$,
  $$ select array[tests.uid('m3')]::uuid[] $$,
  'and the same admin is not offered norec''s two challenge completions - the most of anyone that week - because in_leaderboards is read from the column too. This is the assertion that is NOT redundant with the coach''s: for a coach, can_view_profile_field() had already excluded norec; for an admin it excludes nobody. m1 is gone from this shortlist for the unrelated reason that they now hold the week before it');

select results_eq(
  $$ select tests.mow_cand_ids(tests.mow_base()) $$,
  $$ select array[tests.uid('m2'), tests.uid('m1')]::uuid[] $$,
  'and the admin''s consistency shortlist is the same two members a coach saw: norec (in_leaderboards off, longest streak) and m3 (show_attendance off) are both absent, the third toggle read from the column too. The rule is uniform - a candidate must have the relevant toggle actually ON, whoever is asking');

select tests.clear_auth();

-- =====================================================================
-- 8. THE CONSTRAINTS UNDER THE FUNCTION
-- =====================================================================
-- Asserted as the superuser, with RLS out of the way, because that is the
-- only caller they can ever have: they are backstops against a future
-- direct writer, not something a client can reach.
select throws_ok(
  $$ insert into public.member_of_week (week_start, category, user_id)
     values (tests.mow_base() + 36, 'coachs_pick', tests.uid('m1')) $$,
  '23514', null,
  'week_start must be a Monday. The unique key below is what makes "one publish per week" true, and a key on a free-form date is only unique per date - the same load-bearing CHECK weekly_recaps carries');

select throws_ok(
  $$ insert into public.member_of_week (week_start, category, user_id)
     values (tests.mow_base(), 'coachs_pick', tests.uid('m1')) $$,
  '23505', null,
  'and the week is unique at the constraint level too, so "one publish per week" survives a writer that forgets to check - the readable ''week already published'' error is on top of this, not instead of it');

select throws_ok(
  $$ insert into public.member_of_week (week_start, category, user_id, reason)
     values (tests.mow_base() + 35, 'coachs_pick', tests.uid('m1'), repeat('x', 501)) $$,
  '23514', null,
  'and reason is capped at 500 by the column, the same shape member_contact_log.note and challenge_progress.note use');

select throws_ok(
  $$ insert into public.member_of_week (week_start, category, user_id)
     values (tests.mow_base() + 35, 'employee_of_the_month', tests.uid('m1')) $$,
  '23514', null,
  'and category is a closed list of the four rotation categories, so a typo cannot invent a fifth one that no rotation week would ever produce');

select * from finish();
rollback;
