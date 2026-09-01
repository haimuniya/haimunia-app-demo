-- COMM-313, schema half: behavioural coverage for 202609010008
-- (retention_min_cohort_size, retention_member_weeks, retention_cohorts,
-- retention_onboarding_correlation, retention_welcome_correlation).
--
-- Seven boundaries, each proved by a SCENARIO against a real seeded cohort
-- rather than by a structural check, the style 0039 to 0051 established:
--
--   1. THE PERMISSION BOUNDARY, and specifically that it is NARROWER than
--      COMM-310's and COMM-311's. The assertion that matters here is the one
--      that does NOT exist in 0050 or 0051: a member who really does hold
--      community.analytics.view, and who is really allowed into
--      member_segments() two lines later, is REFUSED by all three functions
--      in this file. That is the whole content of COMM-313's "gated by real
--      is_admin, matching COMM-312's narrower bar".
--   2. THE CURVE ITSELF, on a five-member cohort with a hand-computed answer
--      for all twelve weeks: 0.8, 0.6, 0.4, then 0.2 nine times. Every one of
--      those numbers changes if a week boundary moves.
--   3. THE FLOOR, both halves. Two small months (3 members and 2) fold into
--      one 'other' line, and 'other' stops at week 11 because only 2 of its 5
--      members have lived through week 12.
--   4. A WEEK THAT HAS NOT FINISHED IS NOT A WEEK ANYBODY FAILED. A cohort 40
--      days old returns exactly weeks 1 to 5 and no week 6; a cohort 3 days
--      old returns nothing at all rather than twelve zeroes.
--   5. BOTH CORRELATIONS, as real two-group comparisons with hand-computed
--      shares on both sides, plus the two cases that are easy to get wrong: a
--      step nobody has ever been stamped with returns ONLY its false group,
--      and a stamped group of four returns nothing at all.
--   6. NO MEMBER IS NAMED, ANYWHERE, IN ANY OF THE THREE. The whole
--      serialised output of all three functions is searched for every
--      profile's id, handle and display name - the same sweep 0046 and 0050
--      make, applied here to the one ticket in the cluster whose fourth
--      acceptance criterion is precisely that.
--   7. THE PRIVATE HELPER IS PRIVATE. Granted to no role, and asserted to
--      return twelve rows for a member with zero elapsed weeks (which is what
--      makes "cohort size" mean "how many joined", not "how many have lived
--      through a week") and twelve rows for a SOFT-DELETED member (which is
--      what stops every curve being computed over survivors only).
--
-- FIXTURE MECHANIC WORTH READING FIRST
-- Five cohorts, each pinned to one exact instant N days back:
--
--   curve   140 days   5 members   all 12 weeks elapsed   the curve fixture
--   half     40 days   5 members   weeks 1-5 elapsed      the partial cohort
--   sa       78 days   3 members   weeks 1-11 elapsed  \  both under the
--   sb      109 days   2 members   all 12 weeks        /  floor -> 'other'
--   new       3 days   5 members   0 weeks elapsed        emits nothing
--
-- The five anchors are 31 or more days apart from each other, and two
-- instants 31 days apart CANNOT fall in the same calendar month (the widest
-- span inside one month is 30 days), so the five cohorts are five distinct
-- cohort_months whatever day of the year this file runs on. 140 days is also
-- always inside a 6-month window (the shortest distance from the first
-- instant of the month five months back to now is just over 150 days) and 400
-- days - where the seven rls_helpers members are parked - is always outside
-- it and always inside a 24-month one.
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

-- The join instant of each cohort. now() is fixed for the whole transaction,
-- so the value the fixture inserts and the value the function reads back are
-- the same instant to the microsecond.
create or replace function tests.rc_join(p_grp text) returns timestamptz
language sql stable as $fn$
  select case p_grp
    when 'curve' then now() - interval '140 days'
    when 'half'  then now() - interval '40 days'
    when 'sa'    then now() - interval '78 days'
    when 'sb'    then now() - interval '109 days'
    when 'new'   then now() - interval '3 days'
    when 'old'   then now() - interval '400 days'
  end;
$fn$;
grant execute on function tests.rc_join(text) to anon, authenticated, service_role;

-- The cohort_month key the function will compute for a group, derived the
-- same way the function derives it (date_trunc + to_char in this session's
-- TimeZone) rather than written out as a literal.
create or replace function tests.rc_month(p_grp text) returns text
language sql stable as $fn$
  select to_char(date_trunc('month', tests.rc_join(p_grp)), 'YYYY-MM');
$fn$;
grant execute on function tests.rc_month(text) to anon, authenticated, service_role;

-- Mid-week instant inside membership week N of a group: joined_at + (N-1)
-- weeks + 3 days. Far from either boundary, so an event placed here is
-- unambiguously in week N and a boundary bug shows up only where this file
-- puts an event ON a boundary deliberately.
create or replace function tests.rc_evt(p_grp text, p_week integer) returns timestamptz
language sql stable as $fn$
  select tests.rc_join(p_grp) + make_interval(secs => (p_week - 1) * 604800 + 259200);
$fn$;
grant execute on function tests.rc_evt(text, integer) to anon, authenticated, service_role;

-- Fixture ids, derived from the nickname so twenty-one members do not need a
-- twenty-one branch CASE. Fixed prefix + md5 of the nick, so the id is stable
-- across runs and an assertion can still name a member rather than a uuid.
create or replace function tests.rc_uid(p_nick text) returns uuid
language sql immutable as $fn$
  select ('e3130000-0000-4000-8000-' || substr(md5(p_nick), 1, 12))::uuid;
$fn$;
grant execute on function tests.rc_uid(text) to anon, authenticated, service_role;

-- Who is in which cohort. A table rather than a function so every fixture
-- insert below is one `select ... from tests.rc_member`.
create table tests.rc_member (nick text primary key, grp text not null);
insert into tests.rc_member (nick, grp) values
  ('c1','curve'), ('c2','curve'), ('c3','curve'), ('c4','curve'), ('c5','curve'),
  ('h1','half'),  ('h2','half'),  ('h3','half'),  ('h4','half'),  ('h5','half'),
  ('sa1','sa'),   ('sa2','sa'),   ('sa3','sa'),
  ('sb1','sb'),   ('sb2','sb'),
  ('n1','new'),   ('n2','new'),   ('n3','new'),   ('n4','new'),   ('n5','new');

-- One parked row per (run, output row). Written from inside the caller's own
-- session, read back as the superuser.
create table tests.rc_out (k text, doc jsonb);
grant select, insert on tests.rc_out to anon, authenticated, service_role;

-- The three row accessors. Each returns the single parked row for one cell,
-- or SQL NULL if the function did not emit that cell at all - which is itself
-- an assertion this file makes several times.
create or replace function tests.rc_cohort_row(p_month text, p_week integer) returns jsonb
language sql stable as $fn$
  select o.doc from tests.rc_out o
  where o.k = 'cohorts'
    and o.doc ->> 'cohort_month' = p_month
    and (o.doc ->> 'week_number')::integer = p_week;
$fn$;
grant execute on function tests.rc_cohort_row(text, integer) to anon, authenticated, service_role;

create or replace function tests.rc_ob_row(p_step text, p_stamped boolean, p_week integer) returns jsonb
language sql stable as $fn$
  select o.doc from tests.rc_out o
  where o.k = 'onboarding'
    and o.doc ->> 'step' = p_step
    and (o.doc ->> 'stamped')::boolean = p_stamped
    and (o.doc ->> 'week_number')::integer = p_week;
$fn$;
grant execute on function tests.rc_ob_row(text, boolean, integer) to anon, authenticated, service_role;

create or replace function tests.rc_wel_row(p_contacted boolean, p_week integer) returns jsonb
language sql stable as $fn$
  select o.doc from tests.rc_out o
  where o.k = 'welcome'
    and (o.doc ->> 'contacted')::boolean = p_contacted
    and (o.doc ->> 'week_number')::integer = p_week;
$fn$;
grant execute on function tests.rc_wel_row(boolean, integer) to anon, authenticated, service_role;

-- The share and the denominator out of any of those rows, as their own types,
-- so an assertion compares numbers and not JSON text with a scale.
create or replace function tests.rc_share(p_doc jsonb) returns numeric
language sql immutable as $fn$ select (p_doc ->> 'retained_share')::numeric; $fn$;
grant execute on function tests.rc_share(jsonb) to anon, authenticated, service_role;

create or replace function tests.rc_n(p_doc jsonb) returns integer
language sql immutable as $fn$ select (p_doc ->> 'member_count')::integer; $fn$;
grant execute on function tests.rc_n(jsonb) to anon, authenticated, service_role;

-- Every VALUE of one whole run, concatenated, for the does-this-name-a-member
-- sweep. The VALUES and not the raw jsonb text, deliberately and not to make
-- the sweep easier to pass: a member can only ever be leaked as a value,
-- because the keys are constant strings inside jsonb_build_object() and
-- section 7 pins the exact key set of all three functions separately. Over
-- the raw text the sweep is not merely noisy, it is WRONG - the key
-- `member_count` contains the rls_helpers handle `member_c` as a substring,
-- so a haystack that includes key names reports a leak on every row of every
-- aggregate this file could possibly produce.
create or replace function tests.rc_text(p_k text) returns text
language sql stable as $fn$
  select coalesce(string_agg(v.value, ' '), '')
  from tests.rc_out o, jsonb_each_text(o.doc) v
  where o.k = p_k;
$fn$;
grant execute on function tests.rc_text(text) to anon, authenticated, service_role;

-- Does this haystack mention ANY profile - id, handle or display name? Asked
-- over every profile in the database rather than over a list the test author
-- remembered to write down. Same helper shape as 0046's and 0050's.
create or replace function tests.rc_mentions_a_member(p_haystack text) returns boolean
language sql stable security definer as $fn$
  select coalesce(bool_or(
           position(p.id::text in p_haystack) > 0
           or position(p.handle in p_haystack) > 0
           or (btrim(p.display_name) <> '' and position(p.display_name in p_haystack) > 0)
         ), false)
  from public.profiles p;
$fn$;
grant execute on function tests.rc_mentions_a_member(text) to anon, authenticated, service_role;

-- =====================================================================
-- 1. FUNCTION SHAPE, GRANTS, AND THE NO-SECOND-WCAM-COPY RULE
-- =====================================================================
select is(
  (select count(*)::text from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('retention_cohorts','retention_onboarding_correlation',
                       'retention_welcome_correlation','retention_member_weeks')
     and p.prosecdef),
  '4',
  'all four data-reading functions are SECURITY DEFINER - invite_redemptions is self-select-only, so without definer rights every cohort would be one member (the caller), and analytics_events is readable only by a community.analytics.view holder, which this file''s is_admin() gate does not imply');

select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.retention_cohorts(integer)', 'execute')
  and pg_catalog.has_function_privilege('authenticated', 'public.retention_onboarding_correlation()', 'execute')
  and pg_catalog.has_function_privilege('authenticated', 'public.retention_welcome_correlation()', 'execute'),
  'authenticated may execute all three public functions - the permission test is inside each body, not in the grant, the same way analytics_dashboard() and member_segments() do it');

select ok(
  not pg_catalog.has_function_privilege('anon', 'public.retention_cohorts(integer)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.retention_cohorts(integer)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.retention_onboarding_correlation()', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.retention_onboarding_correlation()', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.retention_welcome_correlation()', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.retention_welcome_correlation()', 'execute'),
  'but not anon, and not PUBLIC - asserted separately, because a new function starts with execute granted to PUBLIC and forgetting that revoke is how an admin RPC quietly becomes an open one');

-- THE HELPER IS THE ONE THING HERE THAT CARRIES A user_id.
select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.retention_member_weeks(integer)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.retention_member_weeks(integer)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.retention_member_weeks(integer)', 'execute'),
  'retention_member_weeks() is granted to NO ROLE AT ALL, not even authenticated - the grant is the gate, as it is for analytics_breakdown(). It is the only function in this migration whose result carries a user_id, and a client-callable version of it would be a per-member retained/churned feed, which is exactly what COMM-313''s fourth acceptance criterion forbids');

select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.retention_min_cohort_size()', 'execute'),
  'while the floor constant IS callable by authenticated - it is one integer, and the client half needs it to write its "cohorts under N members are grouped together" caption without keeping a second copy of the number');

select is(public.retention_min_cohort_size(), 5,
  'and that integer is 5, the value COMM-313 offers as its example. Every assertion below about a suppressed cell is an assertion about this number');

-- THE HARD REQUIREMENT COMM-310 BUILT analytics_wcam_events() FOR.
select ok(
  (select p.prosrc from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'retention_member_weeks') like '%analytics_wcam_events%',
  'retention_member_weeks() CALLS analytics_wcam_events() - 202609010006 wrote that function precisely so COMM-311, COMM-312 and COMM-313 could not each grow their own copy of the qualifying list');

select is(
  (select count(*)::text from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('retention_cohorts','retention_onboarding_correlation',
                       'retention_welcome_correlation','retention_member_weeks',
                       'retention_min_cohort_size')
     and (p.prosrc like '%post_created%' or p.prosrc like '%reaction_added%'
       or p.prosrc like '%attendance_recorded%' or p.prosrc like '%notification_opened%'
       or p.prosrc like '%challenge_completed%' or p.prosrc like '%workout_shared%')),
  '0',
  'and NOT ONE of the five functions contains a second copy of the WCAM event names. This is the assertion that catches the real hazard: a retention curve that re-derived "who was active" would disagree with the dashboard and the segments for reasons nobody could see');

-- =====================================================================
-- 2. FIXTURES
-- =====================================================================
-- The seven rls_helpers members are parked 400 days back: outside a 6-month
-- window entirely (so they never touch the cohorts under test) and inside a
-- 24-month one (so section 5 can prove the clamp really moved the window).
-- Left at rls_helpers' own now() they would have been a same-month cohort
-- with the `new` fixture and would have changed its size.
update public.invite_redemptions set redeemed_at = now() - interval '400 days';

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', tests.rc_uid(m.nick),
       'authenticated', 'authenticated',
       'rc_' || m.nick || '@members.haimuniya.invalid',
       '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()
from tests.rc_member m;

-- Two more accounts that are not cohort members of the ordinary kind:
--   perm    holds community.analytics.view and is NOT an admin (section 4)
--   orphan  has a redemption and NO PROFILE (section 9)
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', tests.rc_uid(nick),
       'authenticated', 'authenticated',
       'rc_' || nick || '@members.haimuniya.invalid',
       '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()
from unnest(array['perm','orphan']) nick;

-- c5 is SOFT-DELETED. They must stay in the curve cohort's denominator for
-- all twelve weeks: a member who deleted their account is the clearest churn
-- there is, and dropping them would compute the curve over survivors only.
insert into public.profiles (id, handle, display_name, recovery_verified_at, deleted_at)
select tests.rc_uid(m.nick), 'ret_' || m.nick, 'Ret ' || m.nick, now(),
       case when m.nick = 'c5' then now() - interval '20 days' end
from tests.rc_member m;

insert into public.profiles (id, handle, display_name, recovery_verified_at)
values (tests.rc_uid('perm'), 'ret_perm', 'Ret perm', now());

-- NO PROFILE for `orphan`, on purpose.

insert into public.invite_redemptions (user_id, invite_id, role, redeemed_at)
select tests.rc_uid(m.nick), '11111111-2222-4333-8444-555555555555', 'member',
       tests.rc_join(m.grp)
from tests.rc_member m;

-- The analytics-permission holder joins in the 400-day cohort so they never
-- disturb the five under test. Their role is `staff` (rank 40): is_staff()
-- true, is_admin() FALSE, and one seed row below gives that role the
-- analytics permission an admin already has.
insert into public.invite_redemptions (user_id, invite_id, role, redeemed_at)
values (tests.rc_uid('perm'), '11111111-2222-4333-8444-555555555555', 'staff',
        tests.rc_join('old'));

insert into public.role_permissions (role_code, permission_code)
values ('staff', 'community.analytics.view');

-- A redemption with NO profile, in the curve cohort's month. It must not be
-- counted: every member figure in this module is profile + redemption.
insert into public.invite_redemptions (user_id, invite_id, role, redeemed_at)
values (tests.rc_uid('orphan'), '11111111-2222-4333-8444-555555555555', 'member',
        tests.rc_join('curve'));

-- --- WCAM-qualifying activity, inside the curve cohort ------------------
-- The hand-computed curve. Different qualifying event names per member, so a
-- bug that only matched one name would show up as a wrong share somewhere.
--
--   c1  every one of weeks 1-12      c2  weeks 1, 2, 3
--   c3  weeks 1 and 2                c4  week 1 only, ON THE JOIN INSTANT
--   c5  nothing that qualifies
--
-- retained/5:  w1 4/5=0.8   w2 3/5=0.6   w3 2/5=0.4   w4..w12 1/5=0.2
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.rc_uid('c1'), 'post_created', '{}'::jsonb, tests.rc_evt('curve', w)
from generate_series(1, 12) w;

insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.rc_uid('c2'), 'comment_created', '{}'::jsonb, tests.rc_evt('curve', w)
from unnest(array[1, 2, 3]) w;

-- c3's week-2 event sits EXACTLY on the week 1 / week 2 boundary. If the
-- lower bound of a membership week were exclusive, or the index were off by
-- one, this event lands in week 1 and w2 reads 0.4 instead of 0.6.
insert into public.analytics_events (user_id, event_name, props, created_at) values
  (tests.rc_uid('c3'), 'reaction_added', '{}'::jsonb, tests.rc_evt('curve', 1)),
  (tests.rc_uid('c3'), 'reaction_added', '{}'::jsonb, tests.rc_join('curve') + make_interval(secs => 604800));

-- c4's ONLY event is at the join instant itself - the inclusive lower bound
-- of week 1. If that bound were exclusive, w1 reads 0.6 instead of 0.8.
insert into public.analytics_events (user_id, event_name, props, created_at) values
  (tests.rc_uid('c4'), 'event_rsvp', '{}'::jsonb, tests.rc_join('curve'));

-- c5's two decoys: one qualifying event ONE SECOND BEFORE joining, and one
-- EXACTLY at the end of week 12 (the exclusive upper bound of the whole
-- grid). Neither may ever count, and because c5 has nothing else, either one
-- counting moves a share off 0.2 or invents a thirteenth week.
insert into public.analytics_events (user_id, event_name, props, created_at) values
  (tests.rc_uid('c5'), 'challenge_joined', '{}'::jsonb, tests.rc_join('curve') - interval '1 second'),
  (tests.rc_uid('c5'), 'challenge_joined', '{}'::jsonb, tests.rc_join('curve') + make_interval(secs => 12 * 604800));

-- ...and ten NON-qualifying events in every one of c5's twelve weeks. This is
-- the fixture that makes the WCAM list load-bearing rather than decorative:
-- 120 rows of passive viewing must leave c5 unretained in every week.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.rc_uid('c5'), ev, '{}'::jsonb, tests.rc_evt('curve', w)
from generate_series(1, 12) w,
     unnest(array['club_tab_viewed','feed_viewed','post_impression','leaderboard_viewed',
                  'challenge_viewed','event_viewed','weekly_recap_opened','search_performed',
                  'directory_opened','push_opt_in']) ev;

-- No member of the half, sa, sb or new cohorts does anything that qualifies.
-- Their curves are flat zero, which is what makes the two correlation cuts
-- below read as a clean comparison against the curve cohort.

-- --- onboarding_progress ------------------------------------------------
-- The seeding trigger on invite_redemptions has already created one row per
-- member with five null stamps, so these are UPDATEs.
--
--   welcomed_at           c1..c5              5 stamped - the whole curve cohort
--   first_week_shown_at   c1,c2,c3,h1,h2      5 stamped - a group spanning two cohorts
--   first_month_shown_at  c1,c2,c3,c4         4 stamped - UNDER the floor
--   first_class_shown_at  nobody              COMM-316's post-deploy state
--   third_class_shown_at  nobody              COMM-316's post-deploy state
update public.onboarding_progress set welcomed_at = now() - interval '100 days'
where user_id in (select tests.rc_uid(m.nick) from tests.rc_member m where m.grp = 'curve');

update public.onboarding_progress set first_week_shown_at = now() - interval '30 days'
where user_id in (tests.rc_uid('c1'), tests.rc_uid('c2'), tests.rc_uid('c3'),
                  tests.rc_uid('h1'), tests.rc_uid('h2'));

update public.onboarding_progress set first_month_shown_at = now() - interval '30 days'
where user_id in (tests.rc_uid('c1'), tests.rc_uid('c2'), tests.rc_uid('c3'), tests.rc_uid('c4'));

-- --- member_contact_log -------------------------------------------------
--   contacted (inside 14 days):  c1 +2d, c2 +13d, c3 +1d, c4 +6d, h1 AT the
--                                join instant  -> 5 members
--   NOT contacted:               c5 at EXACTLY +14 days (the exclusive upper
--                                bound), h2 at +20 days (outside it)
--
-- h1's contact on the join instant is the inclusive lower bound: if it were
-- exclusive the contacted group drops to 4, falls under the floor, and every
-- contacted row disappears.
insert into public.member_contact_log (user_id, contacted_by, contacted_at, note) values
  (tests.rc_uid('c1'), tests.uid('coach'), tests.rc_join('curve') + interval '2 days',  ''),
  (tests.rc_uid('c2'), tests.uid('coach'), tests.rc_join('curve') + interval '13 days', ''),
  (tests.rc_uid('c3'), tests.uid('coach'), tests.rc_join('curve') + interval '1 day',   ''),
  (tests.rc_uid('c4'), tests.uid('coach'), tests.rc_join('curve') + interval '6 days',  ''),
  (tests.rc_uid('h1'), tests.uid('coach'), tests.rc_join('half'),                       ''),
  (tests.rc_uid('c5'), tests.uid('coach'), tests.rc_join('curve') + make_interval(secs => 14 * 86400), ''),
  (tests.rc_uid('h2'), tests.uid('coach'), tests.rc_join('half')  + interval '20 days', '');

-- =====================================================================
-- 3. THE PRIVATE HELPER, read as the superuser
-- =====================================================================
-- These are the two structural facts the public functions' correctness rests
-- on, and neither is observable from the public output.
select is(
  (select count(*)::integer from public.retention_member_weeks(6) mw
   where mw.user_id = tests.rc_uid('n1')),
  12,
  'a member who joined THREE DAYS AGO still gets twelve grid rows. That is what makes "cohort size" mean "how many people joined that month" rather than "how many have lived through a week" - without it, a six-member cohort in which only two members have reached week 1 would be folded into `other` for a reason that has nothing to do with how many people joined');

select is(
  (select count(*) filter (where mw.elapsed)::integer from public.retention_member_weeks(6) mw
   where mw.user_id = tests.rc_uid('n1')),
  0,
  'and NONE of those twelve weeks is `elapsed`, so that member contributes to no denominator anywhere. A week that has not finished is not a week anybody failed');

select is(
  (select count(*) filter (where mw.elapsed)::integer from public.retention_member_weeks(6) mw
   where mw.user_id = tests.rc_uid('c5')),
  12,
  'THE SURVIVORSHIP RULE: c5''s profile is SOFT-DELETED and they are still in the grid for all twelve weeks. COMM-310''s denominator and COMM-311''s member universe both exclude a deleted profile because both are snapshots of who the club IS; a cohort is a fixed group fixed at join time, and the member who deleted their account is the clearest churn there is. Excluding them would bias every curve upward, worst exactly where staff would most want the truth');

select is(
  (select count(*)::integer from public.retention_member_weeks(6) mw
   where mw.user_id = tests.rc_uid('orphan')),
  0,
  'while a redemption with NO PROFILE row contributes nothing at all - that is somebody who redeemed an invite and abandoned the flow, and every member figure in this module is profile + redemption');

-- =====================================================================
-- 4. THE PERMISSION BOUNDARY
-- =====================================================================
select throws_ok(
  $$ select * from public.retention_cohorts() $$,
  'P0001', 'not authorized',
  'with no auth.uid() at all the function refuses before it reads a single row - auth.uid() is checked first, per this schema''s standing rule for a definer function');

select throws_ok(
  $$ select * from public.retention_onboarding_correlation() $$,
  'P0001', 'not authorized',
  'same for the onboarding correlation');

select throws_ok(
  $$ select * from public.retention_welcome_correlation() $$,
  'P0001', 'not authorized',
  'and the welcome correlation - all three carry their own check, none of them relies on a caller having checked first');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.retention_cohorts() $$,
  'P0001', 'not authorized',
  'a plain member is refused');

select tests.set_auth(tests.uid('coach'));
select ok(public.is_staff() and not public.is_admin(),
  'the coach really is staff and really is not an admin, so the next assertion is about the gate and not about a broken fixture');
select throws_ok(
  $$ select * from public.retention_cohorts() $$,
  'P0001', 'not authorized',
  'a COACH is refused, exactly as they are refused analytics_dashboard() and member_segments()');

-- THE ASSERTION THAT DOES NOT EXIST IN 0050 OR 0051.
select tests.set_auth(tests.rc_uid('perm'));
select ok(
  public.has_perm('community.analytics.view'),
  'ret_perm REALLY HOLDS community.analytics.view - stated first, so the refusal below is about the gate and not about a fixture that happened to be broken');
select ok(
  not public.is_admin(),
  'and really is NOT an admin: their role is `staff`, rank 40, and is_admin() wants 50');

select lives_ok(
  $$ select * from public.member_segments() $$,
  'THE CONTRAST, HALF ONE: that same caller IS allowed into member_segments(), because COMM-311 gates on `has_perm(''community.analytics.view'') or is_admin()`');

select throws_ok(
  $$ select * from public.retention_cohorts() $$,
  'P0001', 'not authorized',
  'THE CONTRAST, HALF TWO, AND THE POINT OF THIS SECTION: the very same caller is REFUSED a retention curve. COMM-313 gates on real is_admin() ALONE, with no community.analytics.view alternative - "matching COMM-312''s narrower bar rather than the broader bar COMM-310 and COMM-311 use". Today the two gates select nearly the same people, because 202608280001 seeds that permission to admin and owner only; this fixture is what the difference looks like the moment anybody grants it one rank lower');

select throws_ok(
  $$ select * from public.retention_onboarding_correlation() $$,
  'P0001', 'not authorized',
  'the onboarding correlation refuses them too');

select throws_ok(
  $$ select * from public.retention_welcome_correlation() $$,
  'P0001', 'not authorized',
  'and so does the welcome correlation - all three carry the same narrower gate, not just the headline one');

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select * from public.retention_cohorts() $$,
  'the owner is allowed - rank 60 clears is_admin()''s bar of 50');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select * from public.retention_cohorts() $$,
  'and the admin is allowed');

-- =====================================================================
-- 5. p_cohort_months IS CLAMPED, NOT REFUSED
-- =====================================================================
-- Still the admin. The 400-day cohort (the seven rls_helpers members plus
-- ret_perm) is outside a 6-month window and inside a 24-month one, so it is
-- the probe for both ends of the clamp.
select is(
  (select count(*)::text from public.retention_cohorts(999) d
   where d ->> 'cohort_month' = tests.rc_month('old')),
  '12',
  'p_cohort_months = 999 CLAMPS to 24 rather than raising: the 400-day cohort is inside a 24-month window and comes back with all twelve of its weeks. COMM-313 says clamp where analytics_dashboard() and member_segments() both refuse, and it is safe here because every row names its own cohort_month, so a caller who asked for 99 months can see exactly which months answered');

select is(
  (select count(*)::text from public.retention_cohorts() d
   where d ->> 'cohort_month' = tests.rc_month('old')),
  '0',
  'while the default 6 excludes it entirely - which is also what proves the 999 run above was the window moving and not the floor');

select is(
  (select count(*)::text from public.retention_cohorts() d),
  '28',
  'the default window returns exactly 28 rows in total - 12 for the 140-day cohort, 5 for the 40-day one and 11 for `other` - which is the whole chart, counted once, so the sections below are reading a complete answer and not a truncated one');

select is(
  (select count(*)::text from public.retention_cohorts(0) d),
  '0',
  'p_cohort_months = 0 CLAMPS UP TO 1 rather than raising or returning the lot: the window becomes the current calendar month alone, no fixture cohort has a finished week inside it, and the answer is empty. Read against the 28 above, that is the window genuinely moving with the parameter');

select is(
  (select count(*)::text from public.retention_cohorts(0) d
   where d ->> 'cohort_month' <> to_char(date_trunc('month', now()), 'YYYY-MM')),
  '0',
  'and nothing outside the current calendar month can come back from that run whatever the fixture holds - the clamp asked as a property rather than as a count');

select is(
  (select count(*)::text from public.retention_cohorts(-5) d),
  (select count(*)::text from public.retention_cohorts(1) d),
  'and a negative month count is the same as 1, rather than an empty window or an error');

select lives_ok(
  $$ select * from public.retention_cohorts(null) $$,
  'a null p_cohort_months means the same thing as omitting it - the parameter has a sensible default in its own signature, the same reading member_segments() gives a null p_as_of');

-- =====================================================================
-- 6. THREE RUNS, PARKED
-- =====================================================================
insert into tests.rc_out (k, doc) select 'cohorts',    d from public.retention_cohorts() d;
insert into tests.rc_out (k, doc) select 'onboarding', d from public.retention_onboarding_correlation() d;
insert into tests.rc_out (k, doc) select 'welcome',    d from public.retention_welcome_correlation() d;

select tests.clear_auth();

-- =====================================================================
-- 7. THE ROW SHAPES
-- =====================================================================
select is(
  (select string_agg(t.kk, ',' order by t.kk collate "C") from (
     select distinct kk from tests.rc_out o, jsonb_object_keys(o.doc) kk
     where o.k = 'cohorts') t),
  'cohort_month,member_count,retained_share,week_number',
  'every cohort row carries exactly the four keys COMM-313''s contract names - cohort_month, week_number, retained_share, member_count - and nothing else');

select is(
  (select string_agg(t.kk, ',' order by t.kk collate "C") from (
     select distinct kk from tests.rc_out o, jsonb_object_keys(o.doc) kk
     where o.k = 'onboarding') t),
  'member_count,retained_share,stamped,step,week_number',
  'the onboarding cut adds exactly two: which step, and whether it was stamped. `stamped` is a fact about the onboarding_progress row, not a claim about the member');

select is(
  (select string_agg(t.kk, ',' order by t.kk collate "C") from (
     select distinct kk from tests.rc_out o, jsonb_object_keys(o.doc) kk
     where o.k = 'welcome') t),
  'contacted,member_count,retained_share,week_number',
  'and the welcome cut adds exactly one');

select is(
  (select count(*)::text from tests.rc_out o, jsonb_object_keys(o.doc) kk
   where kk ~ '(effect|impact|lift|uplift|caus)'),
  '0',
  'NO KEY ANYWHERE IN ANY OF THE THREE IMPLIES CAUSATION. COMM-313 asks that the correlations be "explicitly not presented as causation"; the copy is the client half''s job, but a field called onboarding_effect would make an honest label impossible to write. Each cut returns two independent curves and no difference between them - a reader who wants a gap subtracts it themselves, which is the point at which they own the claim');

select is(
  (select count(*)::text from tests.rc_out o
   where (o.doc ->> 'week_number')::integer not between 1 and 12),
  '0',
  'and no row anywhere reports a week outside 1..12 - c5''s decoy event at exactly the end of week 12 did not invent a thirteenth');

select is(
  (select count(*)::text from tests.rc_out o
   where (o.doc ->> 'retained_share')::numeric not between 0 and 1
      or (o.doc ->> 'member_count')::integer < public.retention_min_cohort_size()),
  '0',
  'every share is a real proportion and NO ROW ANYWHERE, in any of the three functions, is computed from fewer than retention_min_cohort_size() members - the floor asked as one question over the whole output');

-- =====================================================================
-- 8. THE CURVE ITSELF
-- =====================================================================
select is(tests.rc_n(tests.rc_cohort_row(tests.rc_month('curve'), 1)), 5,
  'the curve cohort''s denominator is 5 in week 1 - five members, and the SOFT-DELETED c5 is one of them, while the profile-less `orphan` redemption in the same month is not');

select is(tests.rc_n(tests.rc_cohort_row(tests.rc_month('curve'), 12)), 5,
  'and still 5 in week 12: a retention curve''s denominator is the cohort, not the survivors. If it shrank week by week, every line in this chart would trend toward 100%');

select is(tests.rc_share(tests.rc_cohort_row(tests.rc_month('curve'), 1)), 0.8::numeric,
  'WEEK 1 IS 0.8: c1, c2, c3 and c4 were WCAM-qualifying, c5 was not. c4''s only event is AT THE JOIN INSTANT, so this number also pins the inclusive lower bound of week 1 - an exclusive one reads 0.6');

select is(tests.rc_share(tests.rc_cohort_row(tests.rc_month('curve'), 2)), 0.6::numeric,
  'WEEK 2 IS 0.6: c1, c2 and c3. c3''s week-2 event sits EXACTLY on the week 1 / week 2 boundary, so an off-by-one in the week index reads 0.4 here');

select is(tests.rc_share(tests.rc_cohort_row(tests.rc_month('curve'), 3)), 0.4::numeric,
  'WEEK 3 IS 0.4: c1 and c2');

select is(
  (select count(*)::text from tests.rc_out o
   where o.k = 'cohorts'
     and o.doc ->> 'cohort_month' = tests.rc_month('curve')
     and (o.doc ->> 'week_number')::integer between 4 and 12
     and (o.doc ->> 'retained_share')::numeric = 0.2),
  '9',
  'and WEEKS 4 THROUGH 12 ARE ALL 0.2 - c1 alone, in each of nine consecutive weeks. This is the assertion that makes the whole thing a CURVE and not a single number: one cohort, twelve points, four distinct values');

select is(
  (select count(*)::text from tests.rc_out o
   where o.k = 'cohorts' and o.doc ->> 'cohort_month' = tests.rc_month('curve')),
  '12',
  'twelve rows for that cohort, no more and no fewer');

select is(tests.rc_share(tests.rc_cohort_row(tests.rc_month('curve'), 6)), 0.2::numeric,
  'THE WCAM LIST IS LOAD-BEARING: c5 fired ten different NON-qualifying events (club_tab_viewed, feed_viewed, post_impression, leaderboard_viewed, challenge_viewed, event_viewed, weekly_recap_opened, search_performed, directory_opened, push_opt_in) in every one of their twelve weeks - 120 rows - and is retained in none of them. Passive viewing is not activity, which is metrics.md''s rule and analytics_wcam_events()''s job to hold');

-- =====================================================================
-- 9. THE WEEK THAT HAS NOT FINISHED
-- =====================================================================
select is(tests.rc_n(tests.rc_cohort_row(tests.rc_month('half'), 5)), 5,
  'the 40-day-old cohort answers week 5 with all five of its members');

select is(tests.rc_cohort_row(tests.rc_month('half'), 6), null::jsonb,
  'AND EMITS NO WEEK 6 AT ALL. Forty days is five whole membership weeks and five spare days; counting week 6 would record five members as having failed a week that has not happened. A young cohort gives a SHORT LINE, never a false one - which is also why this chart cannot be read as "recent cohorts retain worse"');

select is(
  (select count(*)::text from tests.rc_out o
   where o.k = 'cohorts' and o.doc ->> 'cohort_month' = tests.rc_month('half')),
  '5',
  'exactly five rows for that cohort, weeks 1 to 5');

select is(tests.rc_share(tests.rc_cohort_row(tests.rc_month('half'), 1)), 0::numeric,
  'and its curve is flat zero - nobody in that cohort has ever done anything WCAM-qualifying, which is what makes the two correlation cuts below read as a clean comparison');

select is(
  (select count(*)::text from tests.rc_out o
   where o.k = 'cohorts' and o.doc ->> 'cohort_month' = tests.rc_month('new')),
  '0',
  'the three-day-old cohort returns NOTHING - not twelve zeroes, not a week-1 row with an empty denominator. Five people joined and not one of their first weeks has finished. A client renders that cohort as "not yet", and section 3 already proved those five are still counted as a cohort of five for the folding rule');

-- =====================================================================
-- 10. THE FLOOR: FOLDING, AND TRUNCATION
-- =====================================================================
select is(
  (select count(*)::text from tests.rc_out o
   where o.k = 'cohorts'
     and o.doc ->> 'cohort_month' in (tests.rc_month('sa'), tests.rc_month('sb'))),
  '0',
  'NEITHER SMALL MONTH APPEARS AS ITSELF: three members in one, two in the other, both under retention_min_cohort_size() = 5. COMM-313''s empty state is explicit that a cohort that small is never drawn as its own unstable line');

select is(tests.rc_n(tests.rc_cohort_row('other', 1)), 5,
  'they are POOLED INTO `other` instead of dropped: 3 + 2 = 5 members, which is exactly the floor. A dropped cohort would be a chart that silently omits members; a pooled one still shows their shape');

select is(tests.rc_share(tests.rc_cohort_row('other', 1)), 0::numeric,
  'with its own curve, flat zero here');

select is(tests.rc_n(tests.rc_cohort_row('other', 11)), 5,
  '`other` still has all five members in week 11 - the 78-day cohort has lived through eleven whole weeks');

select is(tests.rc_cohort_row('other', 12), null::jsonb,
  'AND STOPS AT WEEK 11. Only the two members of the 109-day cohort have finished week 12, and a two-person point is exactly the "curve built from 1-2 people" the floor exists to prevent. The ticket writes this rule only for whole cohorts; applying it per cell as well is this implementation''s extension of the same reason, and it always truncates the tail of a line rather than punching a hole in it, because the denominator can only fall as the week number rises');

select is(
  (select count(*)::text from tests.rc_out o
   where o.k = 'cohorts' and o.doc ->> 'cohort_month' = 'other'),
  '11',
  'eleven rows for `other`, weeks 1 to 11');

select is(
  (select count(distinct o.doc ->> 'cohort_month')::text from tests.rc_out o where o.k = 'cohorts'),
  '3',
  'three lines on the chart in total: the two cohorts that cleared the floor, plus `other`. The 3-day cohort cleared it too and contributed no rows, which is a fourth line the client will not be asked to draw');

-- =====================================================================
-- 11. THE ONBOARDING CORRELATION
-- =====================================================================
-- Denominators, over the pooled 6-month window: 15 members have finished week
-- 1 (curve 5 + half 5 + sa 3 + sb 2; the 3-day cohort has finished nothing),
-- 10 have finished week 6, and 7 have finished week 12.
select is(tests.rc_n(tests.rc_ob_row('welcomed_at', true, 1)), 5,
  'welcomed_at was stamped for the five members of the curve cohort, so the stamped group is five deep in week 1');

select is(tests.rc_share(tests.rc_ob_row('welcomed_at', true, 1)), 0.8::numeric,
  'and its week-1 share is the curve cohort''s own 0.8 - the cut really is the same twelve-week curve, sliced by the stamp');

select is(tests.rc_n(tests.rc_ob_row('welcomed_at', false, 1)), 10,
  'the NOT-stamped group is the other ten members who have finished week 1');

select is(tests.rc_share(tests.rc_ob_row('welcomed_at', false, 1)), 0::numeric,
  'THE TWO-GROUP COMPARISON, WEEK 1: 0.8 against 0.0. Both curves are returned whole and no difference between them is computed here - and the caveat that makes that restraint necessary is that a step is stamped only when the client RENDERS it, which requires the member to open the app, so the exposure is downstream of the very engagement the curve measures');

select is(tests.rc_share(tests.rc_ob_row('welcomed_at', true, 12)), 0.2::numeric,
  'the stamped curve runs all the way to week 12 at 0.2');

select is(tests.rc_ob_row('welcomed_at', false, 12), null::jsonb,
  'while the not-stamped curve stops before it: only two of those ten have finished week 12, under the floor');

-- A cut that spans two cohorts, so the pooling is real.
select is(tests.rc_n(tests.rc_ob_row('first_week_shown_at', true, 1)), 5,
  'first_week_shown_at was stamped for a group SPANNING TWO COHORTS - c1, c2, c3 from the 140-day cohort and h1, h2 from the 40-day one. The correlations pool across cohort months on purpose: cutting by month as well would give 5 steps x 2 groups x 12 weeks x 6 months of cells, nearly all under the floor');

select is(tests.rc_share(tests.rc_ob_row('first_week_shown_at', true, 1)), 0.6::numeric,
  'three of those five were qualifying in week 1');

select is(tests.rc_share(tests.rc_ob_row('first_week_shown_at', false, 1)), 0.1::numeric,
  'against 0.1 for the ten who were not stamped - c4, whose single event is on the join instant, and nobody else');

select is(tests.rc_ob_row('first_week_shown_at', true, 6), null::jsonb,
  'and that stamped curve stops after week 5, because h1 and h2 have not finished week 6 and three people are under the floor');

-- The two cases that are easy to get wrong.
select is(
  (select count(*)::text from tests.rc_out o
   where o.k = 'onboarding' and o.doc ->> 'step' = 'first_month_shown_at'
     and (o.doc ->> 'stamped')::boolean),
  '0',
  'A STAMPED GROUP OF FOUR RETURNS NOTHING: first_month_shown_at was stamped for c1..c4, one member short of the floor, and not one of its twelve weeks is emitted. A two-curve comparison in which one curve is four people is not a comparison');

select is(tests.rc_n(tests.rc_ob_row('first_month_shown_at', false, 1)), 11,
  'while its not-stamped side is emitted normally, eleven deep - the suppression is per cell, not per step');

select is(
  (select count(*)::text from tests.rc_out o
   where o.k = 'onboarding'
     and o.doc ->> 'step' in ('first_class_shown_at','third_class_shown_at')
     and (o.doc ->> 'stamped')::boolean),
  '0',
  'A STEP NOBODY HAS EVER BEEN STAMPED WITH RETURNS ONLY ITS FALSE GROUP. This is not a corner case: it is the exact state of both COMM-316 columns on the day they deploy, because 202609010003 deliberately does not backfill them. A client must not read a missing `stamped: true` group as "this step is bad for retention"');

select is(tests.rc_n(tests.rc_ob_row('first_class_shown_at', false, 1)), 15,
  'and their false group is the whole window - all fifteen members who have finished week 1');

select is(tests.rc_share(tests.rc_ob_row('first_class_shown_at', false, 1)), 0.2667::numeric,
  'at 4/15, rounded to four places. That is the pooled week-1 retention of every cohort in the window, which is what a cut with an empty side degenerates to');

select is(tests.rc_n(tests.rc_ob_row('first_class_shown_at', false, 12)), 7,
  'falling to seven members by week 12 - the five of the 140-day cohort plus the two of the 109-day one');

select is(
  (select count(distinct o.doc ->> 'step')::text from tests.rc_out o where o.k = 'onboarding'),
  '5',
  'all five onboarding_progress stamps are cut: welcomed_at, first_week_shown_at and first_month_shown_at from COMM-222, plus first_class_shown_at and third_class_shown_at from COMM-316. The step key IS the column name, so a reader can go straight to the column comment that says when it is stamped');

-- =====================================================================
-- 12. THE WELCOME CORRELATION
-- =====================================================================
select is(tests.rc_n(tests.rc_wel_row(true, 1)), 5,
  'FIVE members were contacted inside their first two weeks: c1 on day 2, c2 on day 13, c3 on day 1, c4 on day 6, and h1 AT THE JOIN INSTANT. h1 is the inclusive lower bound of the window - were it exclusive the group would be four, fall under the floor, and every contacted row here would vanish');

select is(tests.rc_n(tests.rc_wel_row(false, 1)), 10,
  'and ten were not - INCLUDING c5, whose contact is at exactly 14 days (the exclusive upper bound), and h2, whose contact is at 20 days. Either one leaking in makes this number 11 and the one above 6');

select is(tests.rc_share(tests.rc_wel_row(true, 1)), 0.8::numeric,
  'THE TWO-GROUP COMPARISON, WEEK 1: 0.8 for the contacted');

select is(tests.rc_share(tests.rc_wel_row(false, 1)), 0::numeric,
  'against 0.0 for the rest. Read as causation this says a coach hello quadrupled retention, which is exactly why COMM-313 asks the surface not to say that: coaches contact the members who are around to be noticed, and the fixture that produced these two numbers was built by hand with no mechanism between them at all');

select is(tests.rc_share(tests.rc_wel_row(true, 3)), 0.4::numeric,
  'the contacted curve decays like the cohort it is drawn from - 0.8, 0.6, 0.4');

select is(tests.rc_wel_row(true, 6), null::jsonb,
  'and stops after week 5, when h1 runs out of elapsed weeks and the remaining four fall under the floor');

select is(tests.rc_n(tests.rc_wel_row(false, 6)), 6,
  'while the not-contacted side carries on to week 6 with six members - c5, the three of the 78-day cohort and the two of the 109-day one. The four members of the 40-day cohort who were not contacted drop out here for the same elapsed-week reason h1 does, which is why both sides of this cut change denominator at the same point without the two curves ever being compared on unequal weeks');

-- =====================================================================
-- 13. AGGREGATE ONLY: NO MEMBER IS NAMED, ANYWHERE, IN ANY OF THE THREE
-- =====================================================================
select ok(
  not tests.rc_mentions_a_member(tests.rc_text('cohorts')),
  'THE FOURTH ACCEPTANCE CRITERION: the entire serialised cohort output mentions no profile''s id, handle or display name, asked over every profile in the database rather than over a list this file remembered to write down. Twenty-two members produced 140-odd events, seven contact-log rows and thirteen onboarding stamps, and not one of them is identifiable in the output');

select ok(
  not tests.rc_mentions_a_member(tests.rc_text('onboarding')),
  'the same over the onboarding correlation');

select ok(
  not tests.rc_mentions_a_member(tests.rc_text('welcome')),
  'and over the welcome correlation. This is one step MORE aggregate than member_segments(), which names individuals on purpose - "did this member churn" is a far more sensitive framing than "which bucket are they in today", and it is not a question these three functions can be asked');

select ok(
  length(tests.rc_text('cohorts')) > 0
  and length(tests.rc_text('onboarding')) > 0
  and length(tests.rc_text('welcome')) > 0,
  'while all three runs really did return something - stated so the three sweeps above are a privacy result and not three functions that happened to answer nothing');

select ok(
  tests.rc_mentions_a_member(tests.rc_text('cohorts') || ' ' || (select p.handle from public.profiles p where p.id = tests.rc_uid('c1'))),
  'and the sweep itself really does fire when a handle IS present - the same output plus one member''s handle is detected, so the three assertions above are not a helper that always returns false');

select * from finish();
rollback;
