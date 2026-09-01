-- COMM-312, schema half: behavioural coverage for 202609010009
-- (community_health_scores, community_health_component,
-- community_health_generate, community_health_history).
--
-- Eight boundaries, each proved by a SCENARIO against a real seeded week with
-- a hand-computed answer rather than by a structural check, the style 0039 to
-- 0052 established:
--
--   1. THE SCORE ITSELF, on a fixture where all four components are known:
--      WCAM share 8/20, engagement 6 interactions on 4 posts, 1 report in a
--      20-member club, and a 10-member pooled cohort of which 6 were still
--      active in membership week 4. Under the shipped weights that is
--      EXACTLY 48.50, and every one of those numbers changes it.
--   2. THE COMPONENT BREAKDOWN, key by key, including the two mappings that
--      are pure judgement (the 3.0 engagement target and the 10.0 moderation
--      ceiling) and the one component whose value and sub_score move in
--      OPPOSITE directions.
--   3. RENORMALISATION. A second week with no posts at all: the engagement
--      component drops out with weight_applied 0, the other three are
--      renormalised over 0.75, and the score is 33.33 rather than the 25.00 a
--      zero-instead-of-null reading would give.
--   4. THE PERMISSION BOUNDARY, and specifically that it is NARROWER than
--      COMM-310's and COMM-311's - the same interesting negative case 0052
--      built. A member who really does hold community.analytics.view, and who
--      is really let into member_segments() two lines later, cannot read one
--      row of this table and cannot call community_health_history().
--   5. NO CLIENT WRITE GRANT AT ALL. Not insert, not update, not delete, for
--      an ADMIN and for the OWNER - the two callers a "surely they can" bug
--      would let through. Asserted as a grant, as a policy count, and as a
--      real refused statement.
--   6. THE SCHEDULED JOB IS SERVICE-ROLE ONLY, and a week that has not
--      finished is refused rather than scored partially.
--   7. IDEMPOTENT RECOMPUTE. Running the generator twice for the same week
--      leaves one row with one id and the same score - `week_start unique`
--      makes a plain insert raise 23505 on the second run, and a scheduled
--      job that throws on a retry is a job that pages somebody.
--   8. THE components BLOB NAMES NO MEMBER. Every LEAF value of every stored
--      row and of every history row is swept against every profile in the
--      database - the same sweep 0046, 0050 and 0052 make.
--
-- FIXTURE MECHANIC WORTH READING FIRST
-- The scored week W is the most recently COMPLETED ISO week, which is exactly
-- what community_health_generate(null) picks, so the fixture and the function
-- agree without either hardcoding a date. P is the week before it.
--
--   20 club members, in four groups, all redeemed before W ended:
--     7   rls_helpers members, re-dated to 400 days back
--     1   chs_perm    400 days back, role `staff` + community.analytics.view
--     10  chs_k1..k10 60 days back - the retention cohort
--     2   chs_s1, s2  400 days back - spares, to make the total a round 20
--
--   The 400-day anchor is deliberate twice over: it is inside COMM-310's
--   membership denominator (which only asks "redeemed before the week ended")
--   and OUTSIDE retention_member_weeks(6)'s cohort window, so those twelve
--   members cannot disturb the retention component. Left at rls_helpers' own
--   now() they would not have counted as members of week W at all.
--
--   Week W activity, mostly mid-week, with three deliberate boundary probes:
--     m1                      4x post_created, 4x reaction_added,
--                             2x comment_created
--     m3 norec coach
--     owner admin             1x event_rsvp each
--     m2                      1x event_rsvp ON THE INCLUSIVE LOWER BOUND
--     chs_s1                  1x attendance_recorded
--     chs_k9                  1x event_rsvp ON THE EXCLUSIVE UPPER BOUND,
--                             which must NOT count
--     chs_k7 chs_k8           2x non-qualifying events each, which must not
--                             count either
--     -> 8 distinct WCAM-qualifying members, 4 posts, 6 interactions
--     1 report row ON THE INCLUSIVE LOWER BOUND, plus two past the exclusive
--     upper bound that must not count
--
--   Week P: nothing at all. No events, no reports. Note that this is why there
--   is no decoy report just BEFORE week W - the instant before W begins is
--   inside P, and P has to hold exactly zero.
--
--   Retention: chs_k1..k6 have one post_created at join + 24 days, which is
--   inside their membership week 4 and outside both W and P.
--
-- THE HAND-COMPUTED SCORE FOR W
--   wcam_share          8/20      = 0.40  x 0.40 = 0.160
--   engagement_per_post 6/4 = 1.5, /3.0 = 0.50  x 0.25 = 0.125
--   retention           6/10      = 0.60  x 0.25 = 0.150
--   moderation_load     1 report / 20 members = 5.0 per 100,
--                       1 - 5.0/10.0         = 0.50  x 0.10 = 0.050
--                                              total = 0.485 -> 48.50
--
-- THE HAND-COMPUTED SCORE FOR P
--   wcam_share          0/20      = 0.00  x 0.40
--   engagement_per_post NO POSTS  = null  x 0     <- the renormalisation
--   retention           6/10      = 0.60  x 0.25
--   moderation_load     0 reports = 1.00  x 0.10
--                       (0.15 + 0.10) / 0.75 = 0.3333 -> 33.33
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

-- The scored week, derived the same way the function derives it rather than
-- written out as a literal, so this file passes on every day of the week.
create or replace function tests.chs_week() returns date
language sql stable as $fn$
  select date_trunc('week', current_date - 7)::date;
$fn$;
grant execute on function tests.chs_week() to anon, authenticated, service_role;

create or replace function tests.chs_prev() returns date
language sql stable as $fn$ select tests.chs_week() - 7; $fn$;
grant execute on function tests.chs_prev() to anon, authenticated, service_role;

-- Mid-week instant inside a given week: Thursday noon-ish. Far from either
-- boundary, so nothing in this file depends on an off-by-one that it is not
-- deliberately testing.
create or replace function tests.chs_mid(p_week date) returns timestamptz
language sql stable as $fn$ select p_week::timestamptz + interval '3 days 12 hours'; $fn$;
grant execute on function tests.chs_mid(date) to anon, authenticated, service_role;

-- The retention cohort's join instant, and a point inside their membership
-- week 4 (join + 21 days is the start of week 4; +24 days is mid-week 4).
create or replace function tests.chs_join() returns timestamptz
language sql stable as $fn$ select now() - interval '60 days'; $fn$;
grant execute on function tests.chs_join() to anon, authenticated, service_role;

create or replace function tests.chs_w4() returns timestamptz
language sql stable as $fn$ select tests.chs_join() + interval '24 days'; $fn$;
grant execute on function tests.chs_w4() to anon, authenticated, service_role;

-- Fixture ids, derived from the nickname, so thirteen members do not need a
-- thirteen-branch CASE and an assertion can still name a member.
create or replace function tests.chs_uid(p_nick text) returns uuid
language sql immutable as $fn$
  select ('e3120000-0000-4000-8000-' || substr(md5(p_nick), 1, 12))::uuid;
$fn$;
grant execute on function tests.chs_uid(text) to anon, authenticated, service_role;

-- The stored row for one week, read as the superuser.
create or replace function tests.chs_row(p_week date) returns jsonb
language sql stable as $fn$
  select jsonb_build_object('score', s.score, 'components', s.components)
  from public.community_health_scores s where s.week_start = p_week;
$fn$;
grant execute on function tests.chs_row(date) to anon, authenticated, service_role;

create or replace function tests.chs_score(p_week date) returns numeric
language sql stable as $fn$
  select s.score from public.community_health_scores s where s.week_start = p_week;
$fn$;
grant execute on function tests.chs_score(date) to anon, authenticated, service_role;

-- One component object out of a stored week.
create or replace function tests.chs_comp(p_week date, p_key text) returns jsonb
language sql stable as $fn$
  select s.components -> p_key
  from public.community_health_scores s where s.week_start = p_week;
$fn$;
grant execute on function tests.chs_comp(date, text) to anon, authenticated, service_role;

-- A numeric out of a component (or out of its detail), as its own type, so an
-- assertion compares numbers and not JSON text with a scale.
create or replace function tests.chs_num(p_doc jsonb, p_key text) returns numeric
language sql immutable as $fn$ select (p_doc ->> p_key)::numeric; $fn$;
grant execute on function tests.chs_num(jsonb, text) to anon, authenticated, service_role;

create or replace function tests.chs_detail(p_doc jsonb, p_key text) returns numeric
language sql immutable as $fn$ select (p_doc -> 'detail' ->> p_key)::numeric; $fn$;
grant execute on function tests.chs_detail(jsonb, text) to anon, authenticated, service_role;

-- THE ROW EXPLAINS ITSELF. Recomputes the composite from nothing but the
-- weights and sub-scores stored in the blob. If this ever disagrees with the
-- stored score, the breakdown a human reads is not the arithmetic that
-- produced the number they are reading it under.
create or replace function tests.chs_recompute(p_components jsonb) returns numeric
language sql immutable as $fn$
  select round(100 * sum((c.value ->> 'weight')::numeric * (c.value ->> 'sub_score')::numeric)
                   / sum((c.value ->> 'weight')::numeric), 2)
  from jsonb_each(p_components) c
  where c.key in ('wcam_share', 'engagement_per_post', 'moderation_load', 'retention')
    and c.value ->> 'sub_score' is not null;
$fn$;
grant execute on function tests.chs_recompute(jsonb) to anon, authenticated, service_role;

-- Every LEAF value of a components blob, concatenated, for the
-- does-this-name-a-member sweep.
--
-- LEAVES AND NOT THE RAW TEXT, deliberately, and not to make the sweep easier
-- to pass: a member can only ever be leaked as a VALUE, because every key is a
-- constant string inside jsonb_build_object() and section 3 pins the exact key
-- set separately. Over the raw text the sweep would be WRONG rather than
-- merely noisy - 0052 hit exactly that, where the key `member_count` contains
-- the rls_helpers handle `member_c` as a substring and reported a leak on
-- every row of every aggregate it could produce. (202609010009 renames that
-- key to `cohort_size` for the same reason, and section 3 asserts it.)
--
-- The blob is exactly three levels deep - top, component, detail - and section
-- 3 asserts that there is no fourth, so unrolling the walk rather than writing
-- a recursive CTE is complete and not merely convenient.
create or replace function tests.chs_leaves(p_doc jsonb) returns text
language sql immutable as $fn$
  select coalesce(string_agg(t.v, ' '), '') from (
    select l1.value #>> '{}' as v
    from jsonb_each(p_doc) l1
    where jsonb_typeof(l1.value) not in ('object', 'array')
    union all
    select l2.value #>> '{}'
    from jsonb_each(p_doc) l1, jsonb_each(l1.value) l2
    where jsonb_typeof(l1.value) = 'object'
      and jsonb_typeof(l2.value) not in ('object', 'array')
    union all
    select l3.value #>> '{}'
    from jsonb_each(p_doc) l1, jsonb_each(l1.value) l2, jsonb_each(l2.value) l3
    where jsonb_typeof(l1.value) = 'object'
      and jsonb_typeof(l2.value) = 'object'
      and jsonb_typeof(l3.value) not in ('object', 'array')
  ) t;
$fn$;
grant execute on function tests.chs_leaves(jsonb) to anon, authenticated, service_role;

-- How many objects/arrays sit at the third level. Must be zero, or the walk
-- above is incomplete and the sweep below is not a proof.
create or replace function tests.chs_depth4(p_doc jsonb) returns integer
language sql immutable as $fn$
  select count(*)::integer
  from jsonb_each(p_doc) l1, jsonb_each(l1.value) l2, jsonb_each(l2.value) l3
  where jsonb_typeof(l1.value) = 'object'
    and jsonb_typeof(l2.value) = 'object'
    and jsonb_typeof(l3.value) in ('object', 'array');
$fn$;
grant execute on function tests.chs_depth4(jsonb) to anon, authenticated, service_role;

-- Does this haystack mention ANY profile - id, handle or display name? Asked
-- over every profile in the database rather than over a list the test author
-- remembered to write down.
create or replace function tests.chs_mentions_a_member(p_haystack text) returns boolean
language sql stable security definer as $fn$
  select coalesce(bool_or(
           position(p.id::text in p_haystack) > 0
           or position(p.handle in p_haystack) > 0
           or (btrim(p.display_name) <> '' and position(p.display_name in p_haystack) > 0)
         ), false)
  from public.profiles p;
$fn$;
grant execute on function tests.chs_mentions_a_member(text) to anon, authenticated, service_role;

-- One parked row per history row, written from inside the admin's own session
-- and read back as the superuser.
create table tests.chs_out (k text, doc jsonb);
grant select, insert on tests.chs_out to anon, authenticated, service_role;

-- =====================================================================
-- 1. THE TABLE: SHAPE, GRANTS, POLICIES, AND "INTERNAL ONLY" AS STRUCTURE
-- =====================================================================
select has_table('public', 'community_health_scores',
  'community_health_scores exists, the one table COMM-312 adds and the one Phase 3 analytics ticket that stores its answer instead of computing it live');

select ok(
  (select c.relrowsecurity from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'community_health_scores'),
  'RLS is enabled on it - the standing rule for every new table in this schema, and here it is the whole of the "internal only" acceptance criterion');

select is(
  (select count(*)::text from pg_catalog.pg_policies
   where schemaname = 'public' and tablename = 'community_health_scores'),
  '1',
  'EXACTLY ONE policy on the table. Not one for staff and one for admins, not a draft/published pair like monthly_club_recaps - one, because COMM-312 has exactly one audience and every additional policy would be a second way in');

select is(
  (select p.cmd from pg_catalog.pg_policies p
   where p.schemaname = 'public' and p.tablename = 'community_health_scores'),
  'SELECT',
  'and it is a SELECT policy. There is no INSERT, UPDATE or DELETE policy for any client role - not for a coach, not for an admin, not for the owner - which is what makes "only a scheduled service-role job writes it" a property of the database rather than a convention');

select ok(
  (select p.qual from pg_catalog.pg_policies p
   where p.schemaname = 'public' and p.tablename = 'community_health_scores')
    like '%is_admin%',
  'and its predicate is is_admin()');

select ok(
  (select p.qual from pg_catalog.pg_policies p
   where p.schemaname = 'public' and p.tablename = 'community_health_scores')
    not like '%analytics.view%',
  'and NOT has_perm(''community.analytics.view''). This is the assertion that encodes COMM-312''s second acceptance criterion - "real is_admin, not merely any community.analytics.view holder ... narrower than every other admin dashboard ticket in this phase". Section 6 proves the difference with a real caller');

select ok(
  (select p.qual from pg_catalog.pg_policies p
   where p.schemaname = 'public' and p.tablename = 'community_health_scores')
    not like '%is_staff%',
  'and not is_staff() either - monthly_club_recaps lets a coach preview a draft club-wide figure; this table lets a coach see nothing at all');

select ok(
  pg_catalog.has_table_privilege('authenticated', 'public.community_health_scores', 'select'),
  'authenticated holds SELECT on the table - the policy above, not the grant, is what narrows it to admins');

select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.community_health_scores', 'insert')
  and not pg_catalog.has_table_privilege('authenticated', 'public.community_health_scores', 'update')
  and not pg_catalog.has_table_privilege('authenticated', 'public.community_health_scores', 'delete'),
  'THE "NO CLIENT WRITE GRANT AT ALL" BOUNDARY, at the grant level: authenticated holds no insert, no update and no delete. A missing policy alone would not be enough to reason about - a future permissive write policy would immediately be live if the grant were sitting there');

select ok(
  not pg_catalog.has_table_privilege('anon', 'public.community_health_scores', 'select')
  and not pg_catalog.has_table_privilege('anon', 'public.community_health_scores', 'insert')
  and not pg_catalog.has_table_privilege('anon', 'public.community_health_scores', 'update')
  and not pg_catalog.has_table_privilege('anon', 'public.community_health_scores', 'delete'),
  'and anon holds nothing at all on it');

-- "NO SCORE IS EVER SURFACED IN ANY NOTIFICATION, RECAP OR POST", structurally.
select is(
  (select count(*)::text from pg_catalog.pg_trigger t
   where t.tgrelid = 'public.community_health_scores'::regclass and not t.tgisinternal),
  '0',
  'NO TRIGGER on the table. COMM-312''s fourth acceptance criterion is that no score is ever surfaced in a notification, a recap or a post; the only way a stored row could reach one is a trigger, and there is none');

select is(
  (select count(*)::text from pg_catalog.pg_publication_tables
   where pubname = 'supabase_realtime'
     and schemaname = 'public' and tablename = 'community_health_scores'),
  '0',
  'and it is NOT in the supabase_realtime publication (202608290007), so postgres_changes cannot stream a score to a subscriber either');

select is(
  (select count(*)::text from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('community_health_generate', 'community_health_history',
                       'community_health_component')
     and (p.prosrc like '%notif_create%'
       or p.prosrc like '%workout_posts%'
       or p.prosrc like '%weekly_recaps%'
       or p.prosrc like '%monthly_club_recaps%'
       or p.prosrc like '%notifications%')),
  '0',
  'and none of the three functions mentions notif_create, workout_posts, weekly_recaps, monthly_club_recaps or notifications - the score has no path to a member-visible surface, by construction rather than by discipline');

-- THE HARD REQUIREMENT COMM-310 BUILT analytics_wcam_events() FOR.
select ok(
  (select p.prosrc from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'community_health_generate')
    like '%analytics_wcam_events%',
  'community_health_generate() CALLS analytics_wcam_events() - 202609010006 wrote that function precisely so COMM-311, COMM-312 and COMM-313 could not each grow their own copy of the qualifying list');

select is(
  (select count(*)::text from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('community_health_generate', 'community_health_history',
                       'community_health_component')
     and (p.prosrc like '%attendance_recorded%' or p.prosrc like '%notification_opened%'
       or p.prosrc like '%challenge_completed%' or p.prosrc like '%workout_shared%'
       or p.prosrc like '%achievement_shared%'  or p.prosrc like '%member_followed%'
       or p.prosrc like '%profile_opened%'      or p.prosrc like '%event_rsvp%'
       or p.prosrc like '%post_opened%')),
  '0',
  'and NOT ONE of them contains a second copy of the WCAM event names. post_created, reaction_added and comment_created DO appear in the generator, legitimately and not as a WCAM list: they are metrics.md''s own definition of engagement per post, named the same way analytics_dashboard() names them for the same metric. The nine names checked here are WCAM-only, so any of them appearing would mean the list had been pasted');

-- =====================================================================
-- 2. FIXTURES
-- =====================================================================
-- The seven rls_helpers members move to 400 days back: inside COMM-310's
-- membership denominator for week W (which only asks "redeemed before the week
-- ended") and OUTSIDE retention_member_weeks(6)'s cohort window, so they
-- cannot disturb the retention component. Left at rls_helpers' own now() they
-- would have redeemed AFTER week W ended and counted as no members at all.
update public.invite_redemptions set redeemed_at = now() - interval '400 days';

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', tests.chs_uid(nick),
       'authenticated', 'authenticated',
       'chs_' || nick || '@members.haimuniya.invalid',
       '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()
from unnest(array['k1','k2','k3','k4','k5','k6','k7','k8','k9','k10',
                  's1','s2','perm']) nick;

insert into public.profiles (id, handle, display_name, recovery_verified_at)
select tests.chs_uid(nick), 'chs_' || nick, 'CHS ' || nick, now()
from unnest(array['k1','k2','k3','k4','k5','k6','k7','k8','k9','k10',
                  's1','s2','perm']) nick;

-- The ten-member retention cohort, 60 days back: inside
-- retention_member_weeks(6)'s window, and old enough that all twelve of each
-- member's grid weeks up to week 8 have elapsed, so week 4's denominator is
-- the whole cohort.
insert into public.invite_redemptions (user_id, invite_id, role, redeemed_at)
select tests.chs_uid(nick), '11111111-2222-4333-8444-555555555555', 'member', tests.chs_join()
from unnest(array['k1','k2','k3','k4','k5','k6','k7','k8','k9','k10']) nick;

-- Two spares at 400 days, purely to make the club a round 20 so every share in
-- this file is exact rather than a repeating decimal.
insert into public.invite_redemptions (user_id, invite_id, role, redeemed_at)
select tests.chs_uid(nick), '11111111-2222-4333-8444-555555555555', 'member',
       now() - interval '400 days'
from unnest(array['s1','s2']) nick;

-- The analytics-permission holder. Role `staff` (rank 40): is_staff() true,
-- is_admin() FALSE, and one seed row below gives that role the analytics
-- permission an admin already holds. Parked at 400 days with the rest.
insert into public.invite_redemptions (user_id, invite_id, role, redeemed_at)
values (tests.chs_uid('perm'), '11111111-2222-4333-8444-555555555555', 'staff',
        now() - interval '400 days');

insert into public.role_permissions (role_code, permission_code)
values ('staff', 'community.analytics.view');

-- --- WEEK W ACTIVITY ----------------------------------------------------
-- m1 carries the whole engagement figure: 4 posts, 4 reactions, 2 comments.
-- All three event names are WCAM-qualifying, so m1 is also one of the eight
-- active members and the two metrics are computed off overlapping rows on
-- purpose - that is exactly how they overlap in production.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.uid('m1'), 'post_created', '{}'::jsonb, tests.chs_mid(tests.chs_week())
from generate_series(1, 4);

insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.uid('m1'), 'reaction_added', '{}'::jsonb, tests.chs_mid(tests.chs_week())
from generate_series(1, 4);

insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.uid('m1'), 'comment_created', '{}'::jsonb, tests.chs_mid(tests.chs_week())
from generate_series(1, 2);

-- Five more distinct WCAM-qualifying members, on an event name that is NOT
-- part of the engagement-per-post definition, so the two figures stay
-- independent.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.uid(nick), 'event_rsvp', '{}'::jsonb, tests.chs_mid(tests.chs_week())
from unnest(array['m3','norec','coach','owner','admin']) nick;

-- THE SEVENTH sits EXACTLY ON THE INCLUSIVE LOWER BOUND of week W - the first
-- instant of the Monday. If that bound were exclusive, the active count is 7
-- and the WCAM share reads 0.35 instead of 0.40.
insert into public.analytics_events (user_id, event_name, props, created_at)
values (tests.uid('m2'), 'event_rsvp', '{}'::jsonb, tests.chs_week()::timestamptz);

-- The eighth: a fixture member, on a third qualifying name.
insert into public.analytics_events (user_id, event_name, props, created_at)
values (tests.chs_uid('s1'), 'attendance_recorded', '{}'::jsonb, tests.chs_mid(tests.chs_week()));

-- A NINTH MEMBER WHO WOULD QUALIFY, placed EXACTLY ON THE EXCLUSIVE UPPER
-- BOUND (the first instant of the following Monday). It must not count: if it
-- did, the active total is 9 and the share is 0.45. That instant is inside the
-- week in progress, which is never scored.
insert into public.analytics_events (user_id, event_name, props, created_at)
values (tests.chs_uid('k9'), 'event_rsvp', '{}'::jsonb, (tests.chs_week() + 7)::timestamptz);

-- FOUR NON-QUALIFYING EVENTS from members who are otherwise silent. This is
-- what makes the WCAM list load-bearing here rather than decorative: if any of
-- these counted, the active total is 9 or more and the share is not 0.40.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.chs_uid(nick), ev, '{}'::jsonb, tests.chs_mid(tests.chs_week())
from unnest(array['k7','k8']) nick,
     unnest(array['feed_viewed','post_impression']) ev;

-- ONE report inside week W, sitting EXACTLY ON THE INCLUSIVE LOWER BOUND. The
-- reports TABLE, not the report_submitted event, is what the moderation
-- component reads - "the reports side is what the club has to act on". If the
-- lower bound were exclusive, the count is 0, the sub-score is a full 1.0
-- instead of 0.5, and the week's score is 53.50 rather than 48.50.
insert into public.reports (reporter_id, target_type, target_id, reason, details, created_at)
values (tests.uid('m1'), 'post', gen_random_uuid(), 'spam', '', tests.chs_week()::timestamptz);

-- Two decoy reports past the EXCLUSIVE upper bound - one exactly on it, one two
-- hours later. Both are inside the week in progress, which is never scored, so
-- neither may ever appear in a stored row. Either one counting moves
-- per_100_members off 5.0.
--
-- There is deliberately no decoy BEFORE week W: the instant before W begins is
-- inside week P, and week P is the fixture for the no-data renormalisation case
-- below, which needs it to hold exactly zero reports.
insert into public.reports (reporter_id, target_type, target_id, reason, details, created_at)
values
  (tests.uid('m2'), 'post', gen_random_uuid(), 'spam', '',
   (tests.chs_week() + 7)::timestamptz),
  (tests.uid('m3'), 'post', gen_random_uuid(), 'spam', '',
   (tests.chs_week() + 7)::timestamptz + interval '2 hours');

-- --- THE RETENTION COHORT'S MEMBERSHIP WEEK 4 ---------------------------
-- Six of the ten were WCAM-qualifying in their own membership week 4, at
-- join + 24 days. That instant is ~36 days back, so it is outside week W and
-- outside week P and cannot touch either week's WCAM or engagement figures.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.chs_uid(nick), 'post_created', '{}'::jsonb, tests.chs_w4()
from unnest(array['k1','k2','k3','k4','k5','k6']) nick;

-- WEEK P gets nothing at all: no events, no reports. That is the fixture for
-- the renormalisation case.

-- =====================================================================
-- 3. THE SCHEDULED JOB'S OWN BOUNDARY
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'community_health_generate'),
  true,
  'community_health_generate() is SECURITY DEFINER - it crosses three real boundaries: analytics_events (readable only by a community.analytics.view holder), invite_redemptions (self-select only), and retention_member_weeks() (granted to no role at all, so only a definer function can call it)');

select ok(
  pg_catalog.has_function_privilege('service_role', 'public.community_health_generate(date)', 'execute'),
  'service_role can execute it - the grant a scheduler calls over RPC, the same shape recap_monthly_generate(), purge_abandoned_profiles() and recap_weekly_classmates() all have');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.community_health_generate(date)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.community_health_generate(date)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.community_health_generate(date)', 'execute'),
  'and authenticated, anon and PUBLIC cannot - PUBLIC asserted alongside, because a new function starts with execute granted to PUBLIC and forgetting that one revoke is how a service-role-only job quietly becomes an RPC any logged-in member can fire. The grant IS the gate here: the function carries no auth.uid() check, which is the documented exception a scheduled job gets in this schema');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.community_health_component(numeric, numeric, numeric, numeric, jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.community_health_component(numeric, numeric, numeric, numeric, jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.community_health_component(numeric, numeric, numeric, numeric, jsonb)', 'execute'),
  'and the component shape helper is granted to no role either - it is an implementation detail of the generator, and a client-callable version would be a second way to mint something that looks like a stored component');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.community_health_generate() $$,
  '42501',
  null,
  'an ADMIN calling the generator directly gets 42501, from the grant rather than from a check inside the body. The one caller most likely to be handed this by mistake is the one who can read the result');
select tests.clear_auth();

-- =====================================================================
-- 4. THE WEEK BOUNDARY: A WEEK THAT HAS NOT FINISHED IS NOT SCORED
-- =====================================================================
select throws_ok(
  format($$ select public.community_health_generate(date %L) $$,
         date_trunc('week', current_date)::date),
  'P0001', 'week has not finished',
  'THE CURRENT week is REFUSED, not scored. Every component is a whole-week figure: a mid-week run would divide three days of activity by a full week''s membership and store the result permanently as that week''s health, and nobody downstream would ever see that it was partial. analytics_dashboard()''s posture (validate and raise), not retention_cohorts()'' (clamp)');

select throws_ok(
  format($$ select public.community_health_generate(date %L) $$, current_date + 30),
  'P0001', 'week has not finished',
  'and so is a future week, by the same check rather than by a second one');

select is(
  (select count(*)::text from public.community_health_scores),
  '0',
  'and neither refusal left a row behind');

-- A WEEK BEFORE THE CLUB EXISTED WRITES NOTHING AND RETURNS NULL.
select is(
  public.community_health_generate(date_trunc('week', current_date - interval '1000 days')::date),
  null::uuid,
  'a week 1000 days back - before the oldest fixture member redeemed anything - returns NULL and writes no row. A club with no members has no community health to measure: WCAM share and the moderation rate are both divisions by zero there, and storing a zero would put a real-looking low point at the left end of every trend line. It is also what makes a backfill loop safe to run further back than the club has existed');

select is(
  (select count(*)::text from public.community_health_scores),
  '0',
  'and that call really did write nothing');

-- =====================================================================
-- 5. THE SCORE ITSELF
-- =====================================================================
select isnt(public.community_health_generate(), null::uuid,
  'generating the most recently COMPLETED week (the null default) returns a row id');

select isnt(public.community_health_generate(tests.chs_prev()), null::uuid,
  'and so does the week before it');

select is(
  (select count(*)::text from public.community_health_scores),
  '2',
  'two weeks stored, one row each');

select is(
  (select count(*)::text from public.community_health_scores s where s.week_start = tests.chs_week()),
  '1',
  'and the default-argument run really did key the most recently completed ISO week, which is what a scheduler running the morning after a week ends will get');

-- THE HEADLINE NUMBER.
select is(tests.chs_score(tests.chs_week()), 48.50::numeric,
  'THE SCORE FOR WEEK W IS EXACTLY 48.50: 0.40x0.40 + 0.25x0.50 + 0.25x0.60 + 0.10x0.50 = 0.485. Every one of the four component values and every one of the four weights changes this number, so this single assertion is the tripwire for the whole computation');

select is(tests.chs_recompute((select s.components from public.community_health_scores s
                               where s.week_start = tests.chs_week())),
          48.50::numeric,
  'and the stored breakdown REPRODUCES it: recomputing sum(weight x sub_score) / sum(weight) from nothing but the blob gives the same 48.50. If these two ever disagree, the explanation an admin reads is not the arithmetic that produced the number they are reading it under');

-- COMPONENT 1: WCAM SHARE.
select is(tests.chs_num(tests.chs_comp(tests.chs_week(), 'wcam_share'), 'value'), 0.4::numeric,
  'WCAM SHARE IS 0.40, and that one number pins four separate rules: eight distinct members did something WCAM-qualifying in week W out of twenty club members at the end of it; m2''s event sits ON the inclusive lower bound and DID count (an exclusive bound reads 0.35); chs_k9''s sits ON the exclusive upper bound and did NOT (an inclusive one reads 0.45); and the four non-qualifying events from two otherwise-silent members (feed_viewed, post_impression) did not count either (they would read 0.50)');

select is(tests.chs_detail(tests.chs_comp(tests.chs_week(), 'wcam_share'), 'active_members'), 8::numeric,
  'the numerator is carried in the breakdown as a raw count, so a reader can check the share without re-querying');

select is(tests.chs_detail(tests.chs_comp(tests.chs_week(), 'wcam_share'), 'club_members'), 20::numeric,
  'and so is the denominator - twenty members, which is COMM-310''s definition applied to one week: a redemption before the week ended, on a profile not soft-deleted before the week ended');

select is(tests.chs_num(tests.chs_comp(tests.chs_week(), 'wcam_share'), 'weight'), 0.40::numeric,
  'WCAM share carries the largest single weight, 0.40. It is metrics.md''s first core metric and the one figure that most directly answers "is the community layer being used at all"');

-- COMPONENT 2: ENGAGEMENT PER POST, AND ITS NORMALISATION TARGET.
select is(tests.chs_num(tests.chs_comp(tests.chs_week(), 'engagement_per_post'), 'value'), 1.5::numeric,
  'ENGAGEMENT PER POST IS 1.5: four post_created against four reaction_added plus two comment_created, events on both sides exactly as metrics.md defines it and exactly as analytics_dashboard() computes it');

select is(tests.chs_num(tests.chs_comp(tests.chs_week(), 'engagement_per_post'), 'sub_score'), 0.5::numeric,
  'and its SUB-SCORE is 0.5, because 1.5 is half of the 3.0-interactions-per-post target. That target is pure judgement - metrics.md defines the metric and sets no target - so it is a named constant and it is carried in the row');

select is(tests.chs_detail(tests.chs_comp(tests.chs_week(), 'engagement_per_post'), 'target'), 3.0::numeric,
  'the target travels IN THE STORED ROW, not only in the migration, so a week scored under a different target is readable as such rather than silently comparable');

-- COMPONENT 3: MODERATION LOAD, THE INVERSE ONE.
select is(tests.chs_detail(tests.chs_comp(tests.chs_week(), 'moderation_load'), 'reports'), 1::numeric,
  'MODERATION LOAD counts ONE report in week W, and that report sits exactly ON the inclusive lower bound. Two more exist in the fixture, one exactly on the exclusive upper bound and one two hours past it, and neither is counted - so the figure is genuinely period-bounded at both ends');

select is(tests.chs_num(tests.chs_comp(tests.chs_week(), 'moderation_load'), 'value'), 5.0::numeric,
  'its VALUE is 5.0 reports per 100 members - a RATE, not a raw count, so a club that doubles in size is not penalised for the reports that come with it');

select is(tests.chs_num(tests.chs_comp(tests.chs_week(), 'moderation_load'), 'sub_score'), 0.5::numeric,
  'and its SUB-SCORE is 0.5, which is 1 - 5.0/10.0. THIS IS THE ONE COMPONENT WHOSE value AND sub_score MOVE IN OPPOSITE DIRECTIONS: COMM-312''s first acceptance criterion asks for "a moderation-load figure (inverse - more reports lowers the score)", and a higher value here is a worse week');

select ok(
  (tests.chs_comp(tests.chs_week(), 'moderation_load') -> 'detail' ->> 'inverted') = 'true',
  'the breakdown says so in the row itself. The sign is the one thing about this component a reader can get backwards, so it is not left to a comment in a migration');

select is(tests.chs_num(tests.chs_comp(tests.chs_week(), 'moderation_load'), 'weight'), 0.10::numeric,
  'moderation carries the SMALLEST weight, 0.10, and deliberately not zero: it is a penalty signal with a tiny natural range - a healthy club sits at the top of it permanently - so a larger weight would be ten free points most weeks, while 0.10 still lets a real moderation crisis take a visible ten points off the number');

-- COMPONENT 4: RETENTION, FROM COMM-313.
select is(tests.chs_num(tests.chs_comp(tests.chs_week(), 'retention'), 'value'), 0.6::numeric,
  'THE RETENTION SIGNAL IS 0.60: six of the ten-member cohort were still WCAM-qualifying in their own membership week 4. This is COMM-313''s private retention_member_weeks() - the only one of that migration''s functions a service-role job can call, since the other three raise on a null auth.uid()');

select is(tests.chs_detail(tests.chs_comp(tests.chs_week(), 'retention'), 'cohort_size'), 10::numeric,
  'pooled over a denominator of ten - every cohort in the 6-month window whose membership week 4 has fully elapsed. Pooled and not per-month on purpose: this number lands in a WEEKLY series, and a five-person cohort denominator moves in 20-point steps for reasons that have nothing to do with the week being scored');

select is(tests.chs_detail(tests.chs_comp(tests.chs_week(), 'retention'), 'week_number'), 4::numeric,
  'at membership WEEK 4. Week 1 is close to a restatement of "did they open the app the week they signed up"; week 12 exists only for members who joined 84+ days ago and would lag the score by a quarter');

select is(tests.chs_detail(tests.chs_comp(tests.chs_week(), 'retention'), 'floor'),
          public.retention_min_cohort_size()::numeric,
  'and the suppression floor is COMM-313''s own retention_min_cohort_size(), reused rather than reinvented - there is not a second minimum-cohort constant in this schema');

select ok(
  (tests.chs_comp(tests.chs_week(), 'retention') -> 'detail' ->> 'as_of_basis') = 'run_time_not_week_end',
  'THE SHARPEST LIMITATION IN THE FILE, CARRIED IN THE ROW: retention_member_weeks() is anchored on now() and takes no as-of parameter, so this component is measured AS OF THE RUN, not as of the end of the scored week. A backfill gives every generated week the same retention input, and a recompute of an old week will not reproduce its original score. The next assertion shows exactly that');

select is(tests.chs_num(tests.chs_comp(tests.chs_prev(), 'retention'), 'value'),
          tests.chs_num(tests.chs_comp(tests.chs_week(), 'retention'), 'value'),
  'and here it is: two DIFFERENT weeks, generated in the same run, carry an IDENTICAL retention component. That is the as-of-now property made visible rather than argued about - on a real weekly schedule the two runs are a week apart and the values diverge, but in a backfill they will not');

-- THE WEIGHTS THEMSELVES.
select is(
  (select sum((c.value ->> 'weight')::numeric)
   from jsonb_each((select s.components from public.community_health_scores s
                    where s.week_start = tests.chs_week())) c
   where c.key in ('wcam_share', 'engagement_per_post', 'moderation_load', 'retention')),
  1.00::numeric,
  'THE FOUR WEIGHTS SUM TO 1.00, asserted from the STORED ROW rather than from the migration source, so an edit that changes one and forgets another cannot pass quietly. COMM-312 calls this split "a reasonable starting split ... expected to move"; when it moves, this assertion is the one that has to be updated deliberately');

select is(
  (select count(*)::text
   from jsonb_each((select s.components from public.community_health_scores s
                    where s.week_start = tests.chs_week())) c
   where c.key in ('wcam_share', 'engagement_per_post', 'moderation_load', 'retention')
     and (c.value ->> 'weight_applied')::numeric <> (c.value ->> 'weight')::numeric),
  '0',
  'and in a week where all four components have data, weight_applied EQUALS weight for every one of them - nothing was renormalised, because nothing dropped out');

-- =====================================================================
-- 6. RENORMALISATION: THE WEEK WITH NO POSTS
-- =====================================================================
select is(tests.chs_comp(tests.chs_prev(), 'engagement_per_post') -> 'value', 'null'::jsonb,
  'WEEK P HAD NO POSTS, so engagement per post is NULL, not zero. This is analytics_ratio()''s rule applied to a component: "a count of zero is an honest zero, a RATE over a zero denominator is not". With nothing posted there is nothing to measure, and scoring it 0 would double-penalise a quiet week the WCAM component has already scored as quiet');

select is(tests.chs_num(tests.chs_comp(tests.chs_prev(), 'engagement_per_post'), 'weight_applied'), 0::numeric,
  'and its weight_applied is 0 - "this week''s score ignored engagement entirely" is a fact IN the row, not something a reader has to infer from a null');

select is(tests.chs_num(tests.chs_comp(tests.chs_prev(), 'engagement_per_post'), 'weight'), 0.25::numeric,
  'while its nominal weight is still recorded as 0.25, so the reader can see what was redistributed and not merely that something was');

select is(
  (select (s.components ->> 'weight_total_applied')::numeric
   from public.community_health_scores s where s.week_start = tests.chs_prev()),
  0.75::numeric,
  'the applied weight total for week P is 0.75, the three surviving weights');

select is(tests.chs_num(tests.chs_comp(tests.chs_prev(), 'wcam_share'), 'weight_applied'), 0.5333::numeric,
  'and WCAM''s share of the decision rises from 0.40 to 0.5333 - 0.40 renormalised over 0.75 - which is what keeps the score on the same 0..100 scale instead of dragging it toward zero because one metric had nothing to say');

select is(tests.chs_score(tests.chs_prev()), 33.33::numeric,
  'THE SCORE FOR WEEK P IS 33.33: (0.40x0 + 0.25x0.60 + 0.10x1.00) / 0.75, times 100. The number a zero-instead-of-null reading would have produced is 25.00, so this assertion is specifically the renormalisation rule and not merely the arithmetic');

select is(tests.chs_recompute((select s.components from public.community_health_scores s
                               where s.week_start = tests.chs_prev())),
          33.33::numeric,
  'and the breakdown reproduces that one too - the null component contributes to neither the numerator nor the denominator of the recomputation, exactly as it contributed to neither in the generator');

select is(tests.chs_num(tests.chs_comp(tests.chs_prev(), 'wcam_share'), 'value'), 0::numeric,
  'week P''s WCAM share is an honest ZERO, not a null - nobody was active, and that is a measurement rather than a missing one. The distinction between the two is the whole of the previous six assertions');

select is(tests.chs_num(tests.chs_comp(tests.chs_prev(), 'moderation_load'), 'sub_score'), 1::numeric,
  'and its moderation sub-score is a full 1.0 on zero reports, which is why moderation is the one component that can never be unavailable while the club has members - and therefore why the score can always be computed');

-- =====================================================================
-- 7. IDEMPOTENT RECOMPUTE
-- =====================================================================
create temporary table chs_ids as
  select s.id, s.score, s.computed_at from public.community_health_scores s
  where s.week_start = tests.chs_week();

select isnt(public.community_health_generate(tests.chs_week()), null::uuid,
  'the generator is run a SECOND time for a week that is already scored');

select is(
  (select count(*)::text from public.community_health_scores s where s.week_start = tests.chs_week()),
  '1',
  'and there is still exactly ONE row for that week. `week_start ... unique` means a plain insert would raise 23505 on the second run, and a scheduled job that throws on a retry is a job that pages somebody every time a run is retried - so the write is `on conflict (week_start) do update`, matching recap_monthly_generate()');

select is(
  (select s.id from public.community_health_scores s where s.week_start = tests.chs_week()),
  (select c.id from chs_ids c),
  'the row keeps its ORIGINAL id - it was updated in place, not deleted and reinserted, so anything that ever references a score row by id is stable across a rerun');

select is(
  (select s.score from public.community_health_scores s where s.week_start = tests.chs_week()),
  (select c.score from chs_ids c),
  'and the score is unchanged, because the underlying data is unchanged. This is the honest form of idempotency for this function: a rerun over the same data reproduces the same answer. A rerun WEEKS LATER would not, because the retention component is measured as of the run - see section 5');

select is(
  (select count(*)::text from public.community_health_scores),
  '2',
  'and the rerun did not disturb the other stored week');

-- =====================================================================
-- 8. THE READ BOUNDARY, AT BOTH HALVES
-- =====================================================================
-- The table's policy and the function's own check are separate mechanisms that
-- must agree; each is asserted against each caller.
select throws_ok(
  $$ select * from public.community_health_history() $$,
  'P0001', 'not authorized',
  'with no auth.uid() at all community_health_history() refuses before it reads a row - auth.uid() is checked first, per this schema''s standing rule for a definer function');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.community_health_history() $$,
  'P0001', 'not authorized',
  'a plain member is refused the function');
select is(
  (select count(*)::text from public.community_health_scores),
  '0',
  'and reads zero rows from the table - COMM-312''s "no score is ever shown to a member", enforced by the policy and not by a client that remembers not to ask');

select tests.set_auth(tests.uid('coach'));
select ok(public.is_staff() and not public.is_admin(),
  'the coach really is staff and really is not an admin, so the next two assertions are about the gate and not about a broken fixture');
select throws_ok(
  $$ select * from public.community_health_history() $$,
  'P0001', 'not authorized',
  'A COACH WITHOUT ADMIN RANK IS REFUSED - COMM-312''s fourth acceptance criterion names that caller explicitly. Note this is narrower than monthly_club_recaps, where a coach CAN preview an unpublished club-wide figure');
select is(
  (select count(*)::text from public.community_health_scores),
  '0',
  'and the table shows a coach nothing either');

-- THE INTERESTING NEGATIVE CASE, the same one 0052 built for COMM-313.
select tests.set_auth(tests.chs_uid('perm'));
select ok(
  public.has_perm('community.analytics.view'),
  'chs_perm REALLY HOLDS community.analytics.view - stated first, so the refusals below are about the gate and not about a fixture that happened to be broken');
select ok(
  not public.is_admin(),
  'and really is NOT an admin: their role is `staff`, rank 40, and is_admin() wants 50');

select lives_ok(
  $$ select * from public.member_segments() $$,
  'THE CONTRAST, HALF ONE: that same caller IS allowed into member_segments(), because COMM-311 gates on `has_perm(''community.analytics.view'') or is_admin()`');

select throws_ok(
  $$ select * from public.community_health_history() $$,
  'P0001', 'not authorized',
  'THE CONTRAST, HALF TWO, AND THE POINT OF THIS SECTION: the very same caller is REFUSED the health history. COMM-312 gates on real is_admin() ALONE, with no community.analytics.view alternative - "narrower than every other admin dashboard ticket in this phase, since this figure is interpretive and easy to misread out of context". Today the two bars select nearly the same people, because 202608280001 seeds that permission to admin and owner only; this fixture is what the difference looks like the moment anybody grants it one rank lower');

select is(
  (select count(*)::text from public.community_health_scores),
  '0',
  'and the TABLE refuses them too, independently of the function. Both halves matter: the function is SECURITY DEFINER and so bypasses the policy, and the policy is what a future direct PostgREST select would hit');

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select * from public.community_health_history() $$,
  'the owner is allowed - rank 60 clears is_admin()''s bar of 50');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select * from public.community_health_history() $$,
  'and the admin is allowed');
select is(
  (select count(*)::text from public.community_health_scores),
  '2',
  'and the admin reads both stored rows straight off the table, through the policy');

-- =====================================================================
-- 9. NO CLIENT WRITE PATH, AS A REFUSED STATEMENT
-- =====================================================================
-- Still the admin: the caller who CAN read every row is the one a "surely they
-- can also fix a wrong number" bug would let through.
select throws_ok(
  format($$ insert into public.community_health_scores (week_start, score) values (date %L, 100) $$,
         tests.chs_week() - 70),
  '42501', null,
  'AN ADMIN CANNOT INSERT a score. There is no insert grant and no insert policy, so a hand-written row cannot be conjured into a trend line');

select throws_ok(
  $$ update public.community_health_scores set score = 100 $$,
  '42501', null,
  'an admin cannot UPDATE one either - a figure cannot be edited after the fact, and the composite is only ever what the generator computed');

select throws_ok(
  $$ delete from public.community_health_scores $$,
  '42501', null,
  'and cannot DELETE one, so an inconvenient week cannot be removed from the history');

select tests.set_auth(tests.uid('owner'));
select throws_ok(
  format($$ insert into public.community_health_scores (week_start, score) values (date %L, 100) $$,
         tests.chs_week() - 77),
  '42501', null,
  'and neither can the OWNER, the one role has_perm() short-circuits to true for. The write path is closed by GRANT, which no permission check can reopen');

-- =====================================================================
-- 10. THE HISTORY FUNCTION'S OWN CONTRACT
-- =====================================================================
select tests.set_auth(tests.uid('admin'));

insert into tests.chs_out (k, doc) select 'history', d from public.community_health_history() d;

select is(
  (select string_agg(t.kk, ',' order by t.kk collate "C") from (
     select distinct kk from tests.chs_out o, jsonb_object_keys(o.doc) kk
     where o.k = 'history') t),
  'components,score,week_start',
  'every history row carries EXACTLY the three keys COMM-312''s contract names - week_start, score, components - and nothing else. The row''s id, club_id and computed_at are in the table and are deliberately not in the contract');

select is(
  (select count(*)::text from tests.chs_out o where o.k = 'history'),
  '2',
  'and the default p_weeks = 12 returns both stored weeks');

-- WITH ORDINALITY, not ctid and not an unordered array_agg: it is the only
-- construct that GUARANTEES the numbering follows the order the function
-- actually returned its rows in, which is the thing being asserted.
select is(
  (select (h.doc ->> 'week_start')::date
   from public.community_health_history() with ordinality as h(doc, n)
   where h.n = 1),
  tests.chs_prev(),
  'ORDERED OLDEST FIRST, so a client draws the trend line left to right without re-sorting');

select is(
  (select (h.doc ->> 'week_start')::date
   from public.community_health_history() with ordinality as h(doc, n)
   where h.n = 2),
  tests.chs_week(),
  'and the newest week is last');

select is(
  (select count(*)::text from public.community_health_history(1) d),
  '1',
  'p_weeks = 1 returns one row');

select is(
  (select (d ->> 'week_start')::date from public.community_health_history(1) d),
  tests.chs_week(),
  'and it is the NEWEST week, not the oldest - which is what proves the limit is applied to a descending subquery rather than to the final ascending order');

select is(
  (select count(*)::text from public.community_health_history(0) d),
  '1',
  'p_weeks = 0 CLAMPS up to 1 rather than raising or returning nothing - COMM-312''s validation rules say "p_weeks clamps to 1..52"');

select is(
  (select count(*)::text from public.community_health_history(999) d),
  '2',
  'and p_weeks = 999 clamps down to 52 and returns everything there is. Clamping is safe here for retention_cohorts()'' reason: every row names its own week_start, so a caller who asked for 999 weeks can see exactly which weeks answered');

select is(
  (select count(*)::text from public.community_health_history(null) d),
  '2',
  'a null p_weeks means the same thing as omitting it - the parameter has a sensible default in its own signature');

select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.community_health_history(integer)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.community_health_history(integer)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.community_health_history(integer)', 'execute'),
  'authenticated may execute the history function and anon and PUBLIC may not - the permission test is inside the body, not in the grant, the same way every other definer read in this cluster does it');

select tests.clear_auth();

-- =====================================================================
-- 11. THE BREAKDOWN NAMES NO MEMBER, ANYWHERE
-- =====================================================================
select is(
  (select string_agg(t.kk, ',' order by t.kk collate "C") from (
     select distinct kk from public.community_health_scores s, jsonb_object_keys(s.components) kk) t),
  'club_members,engagement_per_post,moderation_load,retention,version,wcam_share,week_end_exclusive,week_start,weight_total_applied',
  'the components blob has exactly nine top-level keys: a version, the week it covers, the shared denominator, the applied weight total, and the four named components. No fifth component crept in and nothing was renamed');

select is(
  (select count(distinct t.kk)::text from (
     select jsonb_object_keys(c.value) as kk
     from public.community_health_scores s, jsonb_each(s.components) c
     where c.key in ('wcam_share', 'engagement_per_post', 'moderation_load', 'retention')) t),
  '5',
  'and all four components share ONE key set of five - value, sub_score, weight, weight_applied, detail - because they are all built by community_health_component() rather than by four hand-written jsonb_build_object() calls that could drift apart');

select is(
  (select coalesce(sum(tests.chs_depth4(s.components)), 0)::text
   from public.community_health_scores s),
  '0',
  'nothing in the blob is nested deeper than three levels (top, component, detail), which is what makes the leaf walk below COMPLETE rather than merely convenient - a fourth level would hide values from the sweep');

select ok(
  not tests.chs_mentions_a_member(
    (select string_agg(tests.chs_leaves(s.components), ' ') from public.community_health_scores s)),
  'NO STORED COMPONENTS BLOB NAMES A MEMBER. Every leaf value of every stored row is searched for every profile''s id, handle and display name, over the whole profiles table rather than over a list the test author remembered to write down. components is free-form jsonb, so unlike monthly_club_recaps the table shape cannot enforce aggregate-only - the rule is enforced by what the generator PUTS there, and this is the assertion that holds it. Do not add a "worst offender", a "top poster" or a "members who churned" key');

select ok(
  not tests.chs_mentions_a_member(
    (select string_agg(tests.chs_leaves(o.doc), ' ') from tests.chs_out o where o.k = 'history')),
  'and neither does anything the history function actually hands a client - asserted over the RPC''s own output as well as over the table, because the two could in principle differ');

select is(
  (select count(*)::text from public.community_health_scores s
   where s.components::text ~* '(user_id|handle|display_name|author|reporter|post_id|top_|worst_)'),
  '0',
  'and no KEY in the blob is even shaped like an identifier. The leaf sweep above catches a value that leaked; this catches a key that invites one, which is the form the mistake would actually take');

select is(
  (select count(*)::text from public.community_health_scores s where s.score < 0 or s.score > 100),
  '0',
  'every stored score is inside 0..100 - the range COMM-312''s first acceptance criterion names, backed by a CHECK on the column as well as by the renormalising arithmetic that cannot leave it');

select is(
  (select count(*)::text from public.community_health_scores s
   where extract(isodow from s.week_start) <> 1),
  '0',
  'and every stored week_start is a Monday. The isodow CHECK is what makes `week_start unique` mean "one score per WEEK" rather than "one score per DATE" - without it a run keying Monday and a run keying Wednesday would both insert and the club would get two scores for one week with no constraint violation');

select * from finish();
rollback;
