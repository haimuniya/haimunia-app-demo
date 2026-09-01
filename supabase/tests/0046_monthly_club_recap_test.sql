-- COMM-309, schema half: behavioural coverage for 202609010002
-- (monthly_club_recaps, monthly_club_recaps_freeze,
-- recap_monthly_generate, recap_monthly_publish).
--
-- Six boundaries, each proved by a SCENARIO rather than by a structural
-- check, the style 0039 to 0045 established:
--
--   1. THE CONTENT IS CLUB-WIDE AGGREGATE, AND NOTHING ELSE. Proved twice
--      over, because one proof alone would be weak. Structurally: the
--      table's whole column list is pinned, so adding a `top_members` or a
--      `highlights jsonb` fails this file - there is no text, jsonb, array
--      or user_id column for a member name to live in. Behaviourally: the
--      generated row, the published notification body and the audit row's
--      after_data are each searched for EVERY fixture member's id, handle
--      and display name, and none of the three contains any of them.
--   2. EACH OF THE FIVE FIGURES COUNTS THE RIGHT THING. Every figure has
--      at least two decoys built to be counted by a filter that stopped
--      working - a deleted post, an only_me post, an authorless club
--      announcement, a draft challenge, a withdrawn completion, a
--      cancelled event, and a row one day outside the month on each side.
--      A broken filter changes a number, so the assertion names the number.
--   3. THE DRAFT BOUNDARY. A coach and an admin read the unpublished row;
--      a plain member reads NOTHING, and no notification exists yet. This
--      is the "not visible to any member, and no notif_create call fires,
--      until a staff member explicitly publishes" criterion, asserted
--      against a real generated draft rather than a planted row.
--   4. THE PUBLISH BOUNDARY, WHICH IS NARROWER THAN THE PREVIEW BOUNDARY.
--      The coach is the assertion that matters: the same coach who can
--      READ the draft in the line above is REFUSED the publish, because
--      `is_staff()` is not `community.analytics.view`. A plain member is
--      refused both. Then publishing flips the plain member's read from
--      zero rows to one, fires the fan-out, and writes exactly one
--      admin_actions row.
--   5. IDEMPOTENT REGENERATION, in both of its halves. A rerun over a
--      DRAFT month updates the same row id in place with fresh figures and
--      never duplicates. A rerun over a PUBLISHED month writes nothing at
--      all: same published_at, same generated_at, same figures, same row
--      count, no second notification. And a published row cannot be edited
--      or un-published even by the superuser, which is the freeze trigger.
--   6. NO CLIENT WRITE PATH OF ANY KIND, asserted for a member, a coach
--      and an admin separately, on the grant as well as on the policy set.
--
-- FIXTURE MECHANIC WORTH READING FIRST
-- Every date is an offset from tests.mcr_month(), the first of the calendar
-- month TWO months before the current one, so the file means the same thing
-- whatever day it runs on and the month it generates is always safely in
-- the past. The month after it - one month back - is the month
-- recap_monthly_generate(null) picks by itself, which is what section 10
-- uses to prove the default.
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

-- The month under test: the first of the month two months back.
create or replace function tests.mcr_month() returns date
language sql stable as $fn$
  select (date_trunc('month', current_date::timestamp) - interval '2 months')::date;
$fn$;
grant execute on function tests.mcr_month() to anon, authenticated, service_role;

-- The first of the month AFTER it, i.e. one month back. This is both the
-- exclusive upper bound of the window under test and the month
-- recap_monthly_generate(null) targets on its own.
create or replace function tests.mcr_next() returns date
language sql stable as $fn$
  select (tests.mcr_month() + interval '1 month')::date;
$fn$;
grant execute on function tests.mcr_next() to anon, authenticated, service_role;

-- The job, called the way a scheduler would: as service_role, the only
-- role holding execute on it. Same set_config shape 0044 uses for
-- coach_detect_engagement_decline and 0035 for chal_notify_ending_soon.
create or replace function tests.mcr_generate(p_month date default null) returns uuid
language plpgsql as $fn$
declare v_id uuid;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v_id := public.recap_monthly_generate(p_month);
  perform pg_catalog.set_config('role', 'postgres', true);
  return v_id;
end $fn$;
grant execute on function tests.mcr_generate(date) to anon, authenticated, service_role;

-- The whole row as text, read past RLS. Used by the aggregate-only content
-- assertion, which has to look at everything the row holds rather than at
-- the columns the test happens to remember to name.
create or replace function tests.mcr_row_text(p_id uuid) returns text
language sql stable security definer as $fn$
  select r::text from public.monthly_club_recaps r where r.id = p_id;
$fn$;
grant execute on function tests.mcr_row_text(uuid) to anon, authenticated, service_role;

-- notifications is own-row only (202608280008), so counting the fan-out
-- from inside any one member's session would read 1 for the wrong reason.
-- These cross that boundary on purpose.
create or replace function tests.mcr_notif_count(p_id uuid) returns integer
language sql stable security definer as $fn$
  select count(*)::integer from public.notifications n
  where n.type = 'monthly_club_recap' and n.source_id = p_id;
$fn$;
grant execute on function tests.mcr_notif_count(uuid) to anon, authenticated, service_role;

create or replace function tests.mcr_notif_for(p_id uuid, p_user uuid) returns integer
language sql stable security definer as $fn$
  select count(*)::integer from public.notifications n
  where n.type = 'monthly_club_recap' and n.source_id = p_id and n.user_id = p_user;
$fn$;
grant execute on function tests.mcr_notif_for(uuid, uuid) to anon, authenticated, service_role;

-- Title, body, category and deep link of one fan-out row, concatenated:
-- the entire human-visible surface of the notification, in one string, so
-- the aggregate-only search below cannot miss a field.
create or replace function tests.mcr_notif_text(p_id uuid) returns text
language sql stable security definer as $fn$
  select coalesce(min(n.title || ' ' || n.body || ' ' || n.category || ' ' ||
                      coalesce(n.deep_link, '') || ' ' || coalesce(n.source_type, '')), '')
  from public.notifications n
  where n.type = 'monthly_club_recap' and n.source_id = p_id;
$fn$;
grant execute on function tests.mcr_notif_text(uuid) to anon, authenticated, service_role;

-- admin_actions is readable only under community.analytics.view
-- (202608280002); a coach does not hold it, so counting from a coach's
-- session would read zero for the wrong reason.
create or replace function tests.mcr_audit_count(p_id uuid) returns integer
language sql stable security definer as $fn$
  select count(*)::integer from public.admin_actions a
  where a.action_type = 'monthly_recap_publish'
    and a.target_type = 'monthly_club_recap'
    and a.target_id = p_id;
$fn$;
grant execute on function tests.mcr_audit_count(uuid) to anon, authenticated, service_role;

create or replace function tests.mcr_audit_after(p_id uuid) returns jsonb
language sql stable security definer as $fn$
  select a.after_data from public.admin_actions a
  where a.action_type = 'monthly_recap_publish' and a.target_id = p_id
  order by a.created_at desc limit 1;
$fn$;
grant execute on function tests.mcr_audit_after(uuid) to anon, authenticated, service_role;

-- Does this haystack mention ANY fixture member - their id, their handle or
-- their display name? The whole aggregate-only rule, asked as one question
-- over every profile in the database rather than over a list the test
-- author remembered to write down.
create or replace function tests.mcr_mentions_a_member(p_haystack text) returns boolean
language sql stable security definer as $fn$
  select coalesce(bool_or(
           position(p.id::text  in p_haystack) > 0 or
           position(p.handle    in p_haystack) > 0 or
           (btrim(p.display_name) <> '' and position(p.display_name in p_haystack) > 0)
         ), false)
  from public.profiles p;
$fn$;
grant execute on function tests.mcr_mentions_a_member(text) to anon, authenticated, service_role;

-- One attendance day per (user, offset). attendance_log has no write grant
-- for any client role, so this runs as the bootstrap superuser like every
-- other fixture here.
create or replace function tests.mcr_attend(p_user uuid, p_from int, p_to int) returns void
language sql as $fn$
  insert into public.attendance_log (user_id, occurred_on)
  select p_user, tests.mcr_month() + g from generate_series(p_from, p_to) g
  on conflict (user_id, occurred_on) do nothing;
$fn$;
grant execute on function tests.mcr_attend(uuid, int, int) to anon, authenticated, service_role;

-- Snapshots, so "the same row was updated" is a claim about an id and a
-- timestamp rather than about the contents.
create table tests.mcr_snap (k text primary key, id uuid, ts timestamptz, ts2 timestamptz);
-- Read from inside impersonated sessions (a member calling publish with the
-- draft's id), so it needs a select grant. Written only as the superuser.
grant select on tests.mcr_snap to anon, authenticated, service_role;

-- =====================================================================
-- 1. AGGREGATE ONLY, BY CONSTRUCTION
-- =====================================================================
-- The table's shape is the privacy guarantee, so the shape is pinned. This
-- is the strongest form of COMM-309's "no member name, handle, or
-- individually-attributable figure anywhere in the generated content":
-- weekly_recaps.club_challenge_progress (202608290011) states the same rule
-- for a jsonb blob and therefore has to trust its writer; here there is no
-- blob to write into.
-- Read from pg_catalog and compared as ONE string rather than through
-- results_eq: information_schema's identifier columns are domains with an
-- indeterminate collation, and a row-wise comparison against a VALUES list
-- cannot resolve one. A pgTAP-side detail, not anything about this table.
select is(
  (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod),
                     ', ' order by a.attnum)
   from pg_catalog.pg_attribute a
   where a.attrelid = 'public.monthly_club_recaps'::regclass
     and a.attnum > 0 and not a.attisdropped),
  'id uuid, club_id uuid, month_start date, sessions_logged integer, '
  || 'posts_created integer, new_members integer, challenges_completed integer, '
  || 'events_held integer, generated_at timestamp with time zone, '
  || 'published_at timestamp with time zone',
  'THE COLUMN LIST IS THE PRIVACY RULE: two uuids, a date, five integers and two timestamps. No user_id, no text column, no jsonb, no array - there is nowhere in this table for a member name, a handle or an individually-attributable figure to be stored, even by a careless future producer. Adding a top_members or a highlights column fails this assertion, which is the point of pinning the whole list rather than spot-checking it');

select is_empty(
  $$ select a.attname::text collate "C"
     from pg_catalog.pg_attribute a
     where a.attrelid = 'public.monthly_club_recaps'::regclass
       and a.attnum > 0 and not a.attisdropped
       and (format_type(a.atttypid, a.atttypmod)
              in ('text', 'jsonb', 'json', 'character varying')
            or format_type(a.atttypid, a.atttypmod) like '%[]'
            or (a.attname::text collate "C") ~ 'user|member_id|handle|name|author') $$,
  'restated as the rule a reviewer actually applies, so a future column is caught by its TYPE or its NAME and not only by the exact-list assertion above - club_id and new_members are uuid and integer, so neither trips it');

-- =====================================================================
-- 2. REACHABILITY, GRANTS AND POLICY SHAPE
-- =====================================================================
select ok(
  (select c.relrowsecurity from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'monthly_club_recaps'),
  'monthly_club_recaps has RLS enabled');

select results_eq(
  $$ select polname, polcmd::text from pg_catalog.pg_policy
     where polrelid = 'public.monthly_club_recaps'::regclass order by polname $$,
  $$ values ('monthly_club_recaps_published_select'::name, 'r'::text),
            ('monthly_club_recaps_staff_select'::name, 'r'::text) $$,
  'exactly two policies and both are SELECT - the two audiences the ticket names, kept as separate permissive policies (which OR together) rather than one predicate with an `or` in it, so each is visible to a reviewer on its own. There is no insert, update or delete policy for anybody');

select ok(
  pg_catalog.has_table_privilege('authenticated', 'public.monthly_club_recaps', 'select'),
  'authenticated may select');
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.monthly_club_recaps', 'insert')
  and not pg_catalog.has_table_privilege('authenticated', 'public.monthly_club_recaps', 'update')
  and not pg_catalog.has_table_privilege('authenticated', 'public.monthly_club_recaps', 'delete'),
  'and holds no insert, update or delete grant - asserted on the GRANT as well as on the policy set, because either one alone would leave a write path open. This is what makes "no client insert, update or delete" true for staff and admins too');
select ok(
  not pg_catalog.has_table_privilege('anon', 'public.monthly_club_recaps', 'select'),
  'anon reaches nothing');

select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'recap_monthly_generate'),
  true,
  'recap_monthly_generate is SECURITY DEFINER - it counts attendance_log (own-row plus staff) and invite_redemptions (own-row only) club-wide, so it crosses two RLS boundaries on purpose and returns integers rather than rows');

select ok(
  pg_catalog.has_function_privilege('service_role', 'public.recap_monthly_generate(date)', 'execute'),
  'service_role can execute the generator - the grant a pg_cron entry or a scheduled invoker will use');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.recap_monthly_generate(date)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.recap_monthly_generate(date)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.recap_monthly_generate(date)', 'execute'),
  'THE GENERATION DECISION, ENFORCED: no client role can call the generator at all, PUBLIC included. This is the concrete reason it is a Postgres function rather than a second Edge Function - the grant IS the gate, where an Edge Function''s default verify_jwt accepts any valid JWT including the public anon key, which is the gap recap_weekly had to close by hand');

select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'recap_monthly_publish'),
  true,
  'recap_monthly_publish is SECURITY DEFINER - it updates a table with no write policy at all, and calls notif_create and log_admin_action, neither of which any client may call');

select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.recap_monthly_publish(uuid)', 'execute'),
  'and it is executable by authenticated - the permission test is inside the body, not in the grant');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.recap_monthly_publish(uuid)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.recap_monthly_publish(uuid)', 'execute'),
  'but not by anon nor by PUBLIC - PUBLIC asserted separately, because a new function starts with execute granted to PUBLIC and forgetting that revoke is how a staff RPC quietly becomes an open one');

-- =====================================================================
-- 3. FIXTURES: one month, with a decoy for every filter
-- =====================================================================
-- Each figure below is built so that a filter which stopped working would
-- change the NUMBER, not merely the row set.

-- --- sessions: 8 + 5 + 2 = 15 inside the month --------------------------
select tests.mcr_attend(tests.uid('m1'), 0, 7);    -- 8 days
select tests.mcr_attend(tests.uid('m2'), 0, 4);    -- 5 days
select tests.mcr_attend(tests.uid('m3'), 10, 11);  -- 2 days
-- Two decoys, one day outside each end of the month.
insert into public.attendance_log (user_id, occurred_on)
values (tests.uid('m1'), tests.mcr_month() - 1),
       (tests.uid('m1'), tests.mcr_next());

-- --- posts: 3 inside the month -----------------------------------------
insert into public.workout_posts
  (author_id, post_type, visibility, title, body, status, created_at, deleted_at)
values
  -- counted
  (tests.uid('m1'), 'POST_TEXT',    'club',      'p1', 'x', 'active', (tests.mcr_month() + 2)::timestamptz, null),
  (tests.uid('m2'), 'POST_WORKOUT', 'followers', 'p2', 'x', 'active', (tests.mcr_month() + 3)::timestamptz, null),
  (tests.uid('m3'), 'POST_PR',      'club',      'p3', 'x', 'active', (tests.mcr_month() + 4)::timestamptz, null),
  -- decoy: soft-deleted
  (tests.uid('m1'), 'POST_TEXT',    'club',      'd1', 'x', 'active', (tests.mcr_month() + 5)::timestamptz, now()),
  -- decoy: hidden by moderation
  (tests.uid('m1'), 'POST_TEXT',    'club',      'd2', 'x', 'hidden', (tests.mcr_month() + 5)::timestamptz, null),
  -- decoy: private to its author
  (tests.uid('m2'), 'POST_TEXT',    'only_me',   'd3', 'x', 'active', (tests.mcr_month() + 6)::timestamptz, null),
  -- decoy: one day before the month, one day into the next
  (tests.uid('m1'), 'POST_TEXT',    'club',      'd4', 'x', 'active', (tests.mcr_month() - 1)::timestamptz, null),
  (tests.uid('m1'), 'POST_TEXT',    'club',      'd5', 'x', 'active', (tests.mcr_next())::timestamptz, null);
-- decoy: the club's OWN authorless announcement, the row
-- member_of_week_publish writes every week.
insert into public.workout_posts
  (author_id, post_type, visibility, title, body, status, created_at)
values (null, 'POST_ANNOUNCEMENT', 'club', 'd6', 'x', 'active', (tests.mcr_month() + 7)::timestamptz);

-- --- new members: 2 inside the month -----------------------------------
-- invite_redemptions.redeemed_at is the module's MEMBER_JOINED timestamp,
-- so the fixture moves it rather than inventing a second join date.
update public.invite_redemptions set redeemed_at = (tests.mcr_month() + 1)::timestamptz
  where user_id = tests.uid('m1');
update public.invite_redemptions set redeemed_at = (tests.mcr_month() + 9)::timestamptz
  where user_id = tests.uid('m2');
-- decoy: one day before the month starts.
update public.invite_redemptions set redeemed_at = (tests.mcr_month() - 1)::timestamptz
  where user_id = tests.uid('m3');

-- --- challenges completed: 2 inside the month --------------------------
insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, status)
values
  ('e0000000-0000-4000-8000-000000000001', 'Live One',  'individual_target', 'reps',
   now() - interval '200 days', now() + interval '90 days', 'active'),
  ('e0000000-0000-4000-8000-000000000002', 'Live Two',  'individual_target', 'reps',
   now() - interval '200 days', now() + interval '90 days', 'active'),
  ('e0000000-0000-4000-8000-000000000003', 'Draft One', 'individual_target', 'reps',
   now() - interval '200 days', now() + interval '90 days', 'draft'),
  ('e0000000-0000-4000-8000-000000000004', 'Live Four', 'individual_target', 'reps',
   now() - interval '200 days', now() + interval '90 days', 'active');

insert into public.challenge_participants (challenge_id, user_id, status, completed_at) values
  -- counted
  ('e0000000-0000-4000-8000-000000000001', tests.uid('m1'), 'completed', (tests.mcr_month() + 3)::timestamptz),
  ('e0000000-0000-4000-8000-000000000001', tests.uid('m2'), 'completed', (tests.mcr_month() + 4)::timestamptz),
  -- decoy: a completion on a DRAFT challenge, which the club never saw
  ('e0000000-0000-4000-8000-000000000003', tests.uid('m3'), 'completed', (tests.mcr_month() + 5)::timestamptz),
  -- decoy: withdrawn, with a completed_at still on the row
  ('e0000000-0000-4000-8000-000000000002', tests.uid('norec'), 'withdrawn', (tests.mcr_month() + 6)::timestamptz),
  -- decoy: a real completion one day outside the month
  ('e0000000-0000-4000-8000-000000000004', tests.uid('m1'), 'completed', (tests.mcr_next())::timestamptz);

-- --- events held: 2 inside the month -----------------------------------
insert into public.events (title, event_type, start_at, status) values
  -- counted: still labelled published, and one a human has tidied to past
  ('Held A',      'workshop',  (tests.mcr_month() + 2)::timestamptz,  'published'),
  ('Held B',      'seminar',   (tests.mcr_month() + 12)::timestamptz, 'past'),
  -- decoy: never reached the club
  ('Draft E',     'workshop',  (tests.mcr_month() + 3)::timestamptz,  'draft'),
  -- decoy: did not happen
  ('Cancelled E', 'workshop',  (tests.mcr_month() + 4)::timestamptz,  'cancelled'),
  -- decoy: a real event one day outside the month
  ('Next month',  'workshop',  (tests.mcr_next())::timestamptz,       'published');

-- =====================================================================
-- 4. GENERATION: the five figures, each against its decoys
-- =====================================================================
select is_empty(
  $$ select 1 from public.monthly_club_recaps $$,
  'nothing exists before the job runs - the table has no seeder and no trigger producer, which is why the staff preview surface has to render an honest empty state until a scheduler exists');

insert into tests.mcr_snap (k, id) values ('gen1', tests.mcr_generate(tests.mcr_month()));

select results_eq(
  $$ select sessions_logged, posts_created, new_members, challenges_completed, events_held
     from public.monthly_club_recaps where month_start = tests.mcr_month() $$,
  $$ values (15, 3, 2, 2, 2) $$,
  'THE FIVE FIGURES, each with its decoys in the database and none of them counted: 15 attendance days (8 + 5 + 2, with one day outside each end of the month ignored); 3 posts (a soft-deleted one, a hidden one, an only_me one, the club''s own AUTHORLESS announcement and two outside the month all excluded); 2 new members (a redemption one day early excluded); 2 challenge completions (a draft challenge, a withdrawn participant and a completion one day late excluded); 2 events held (a draft, a cancelled and one a day late excluded)');

select results_eq(
  $$ select month_start, published_at is null, club_id = public.default_club_id()
     from public.monthly_club_recaps where id = (select id from tests.mcr_snap where k = 'gen1') $$,
  $$ select tests.mcr_month(), true, true $$,
  'THE ROW STARTS AS A DRAFT. published_at is null, which is both "no member can see this" and "no notification has fired". club_id came from default_club_id() rather than being passed, the same way every other table in this schema takes it');

select is(
  tests.mcr_notif_count((select id from tests.mcr_snap where k = 'gen1')),
  0,
  'and generation fired NO notification of any kind - not one row, for anybody. Generation is structurally incapable of publishing: published_at is in neither the insert column list nor the ON CONFLICT update SET list');

-- =====================================================================
-- 5. THE DRAFT BOUNDARY
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.monthly_club_recaps $$,
  'A PLAIN MEMBER SEES NOTHING while the recap is a draft. Not a redacted row, not a row with nulls - no row. The only policy that could match them requires published_at is not null');

select throws_ok(
  $$ select public.recap_monthly_generate(tests.mcr_month()) $$,
  '42501', null,
  'and a member cannot run generation either - refused by the missing EXECUTE grant, before the function body is entered');

select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select count(*)::int from public.monthly_club_recaps $$,
  $$ values (1) $$,
  'A COACH PREVIEWS THE DRAFT. is_staff() is coach rank and above, and the staff select policy is has_perm(''community.analytics.view'') or is_staff() - copied verbatim from attendance_log''s own staff read policy, so the two tables answer "who may see unpublished club-wide attendance figures" identically');

select tests.set_auth(tests.uid('admin'));
select results_eq(
  $$ select count(*)::int from public.monthly_club_recaps $$,
  $$ values (1) $$,
  'and so does an admin, through the permission half of the same policy');

-- =====================================================================
-- 6. IDEMPOTENT REGENERATION OVER A DRAFT
-- =====================================================================
select tests.clear_auth();

-- Two more attendance days and one more post land after the first run.
select tests.mcr_attend(tests.uid('norec'), 20, 21);
insert into public.workout_posts
  (author_id, post_type, visibility, title, body, status, created_at)
values (tests.uid('norec'), 'POST_TEXT', 'club', 'p4', 'x', 'active', (tests.mcr_month() + 20)::timestamptz);

update tests.mcr_snap set ts = (select generated_at from public.monthly_club_recaps
                                where id = tests.mcr_snap.id)
  where k = 'gen1';

select is(
  tests.mcr_generate(tests.mcr_month()),
  (select id from tests.mcr_snap where k = 'gen1'),
  'A RERUN RETURNS THE SAME ROW ID. `insert ... on conflict (month_start) do update` updates the draft in place; there is no delete-and-reinsert and no second id for a client to have cached');

select results_eq(
  $$ select count(*)::int from public.monthly_club_recaps $$,
  $$ values (1) $$,
  'still exactly ONE row for the month - the unique constraint on month_start is what makes that true even for a writer that forgets to check, and the CHECK that pins month_start to the 1st is what stops a run keying the 1st and a run keying the 3rd from both inserting');

select results_eq(
  $$ select sessions_logged, posts_created from public.monthly_club_recaps
     where month_start = tests.mcr_month() $$,
  $$ values (17, 4) $$,
  'and the draft''s figures were REFRESHED, not left stale: two attendance days and one post landed between the runs and the rerun picked all three up. Updating in place is the point of the upsert, not a side effect of it');

select ok(
  (select generated_at from public.monthly_club_recaps where month_start = tests.mcr_month())
    >= (select ts from tests.mcr_snap where k = 'gen1'),
  'generated_at moved forward with the rerun, so "when were these figures last computed" is answerable for a draft a coach is about to publish');

select is(
  (select published_at from public.monthly_club_recaps where month_start = tests.mcr_month()),
  null,
  'and the rerun still left published_at null. A regenerated draft is still a draft: generation never publishes, so no number of reruns can put a recap in front of the club');

select is(
  tests.mcr_notif_count((select id from tests.mcr_snap where k = 'gen1')),
  0,
  'and still no notification after two full generation runs');

-- =====================================================================
-- 7. THE PUBLISH PERMISSION BOUNDARY
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.recap_monthly_publish((select id from tests.mcr_snap where k = 'gen1')) $$,
  'P0001', 'not authorized',
  'a plain member cannot publish. The gate is inside the body, so it holds for a direct PostgREST call and not only for a hidden button');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.recap_monthly_publish((select id from tests.mcr_snap where k = 'gen1')) $$,
  'P0001', 'not authorized',
  'THE ASYMMETRY, AND THE ASSERTION THAT MATTERS MOST HERE: the very same coach who READ this draft three assertions ago is REFUSED the publish. Previewing needs is_staff(); publishing needs community.analytics.view or is_admin(), and 202608280001 seeds that permission to admin and owner only. Looking at a draft is not an act; putting a permanent club-wide summary in front of every member is. The client half must gate the "פרסם" control on the permission, not on staffness');

select results_eq(
  $$ select count(*)::int from public.monthly_club_recaps $$,
  $$ values (1) $$,
  'and the refused coach can still see the draft they were refused permission to publish - the two boundaries are genuinely separate, not one boundary asserted twice');

select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.recap_monthly_publish('00000000-0000-4000-8000-000000000000'::uuid) $$,
  'P0001', 'not authorized',
  'and the permission check runs BEFORE the row lookup, so a member probing with a made-up id gets "not authorized" rather than "recap not found" - which would otherwise be an oracle telling them which recap ids exist');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.recap_monthly_publish('00000000-0000-4000-8000-000000000000'::uuid) $$,
  'P0001', 'recap not found',
  'a permitted caller with an unknown id gets the real error');

-- =====================================================================
-- 8. PUBLISHING
-- =====================================================================
select lives_ok(
  $$ select public.recap_monthly_publish((select id from tests.mcr_snap where k = 'gen1')) $$,
  'the admin publishes the recap');

select tests.clear_auth();

select ok(
  (select published_at is not null from public.monthly_club_recaps
   where id = (select id from tests.mcr_snap where k = 'gen1')),
  'published_at is stamped');

select is(
  tests.mcr_notif_count((select id from tests.mcr_snap where k = 'gen1')),
  6,
  'THE FAN-OUT FIRES ONLY NOW, and reaches six of the seven fixture members. The membership set is the one notif_announcement_fanout and recap_weekly both use - a non-deleted profile with an invite_redemptions row - which deliberately includes the quiet members a club summary is for, rather than WCAM''s "did something this week"');

select is(
  tests.mcr_notif_for((select id from tests.mcr_snap where k = 'gen1'), tests.uid('admin')),
  0,
  'and the seventh is the ADMIN WHO PUBLISHED IT. notif_create suppresses a row whose recipient is the actor for every type but the two self-directed ones; the publisher is looking at the recap already. Inherited behaviour, stated because it is real - notif_announcement_fanout has the same shape');

select is(
  tests.mcr_notif_for((select id from tests.mcr_snap where k = 'gen1'), tests.uid('norec')),
  1,
  'a member with no recovery method still gets it: recovery_verified_at gates WRITE paths, and being told about a club summary is not a write the member makes - the same reading recap_weekly records for its own "active member" definition');

select is(
  tests.mcr_audit_count((select id from tests.mcr_snap where k = 'gen1')),
  1,
  'exactly one admin_actions row, under a new action_type and a new target_type this migration added to the two closed lists rather than borrowing labels that would have made the audit log describe something else');

select results_eq(
  $$ select tests.mcr_audit_after((select id from tests.mcr_snap where k = 'gen1')) ->> 'notified',
            tests.mcr_audit_after((select id from tests.mcr_snap where k = 'gen1')) ->> 'sessions_logged',
            (tests.mcr_audit_after((select id from tests.mcr_snap where k = 'gen1')) ? 'month_start') $$,
  $$ values ('6'::text, '17'::text, true) $$,
  'and its after_data records a COUNT of who was notified alongside the five figures - the "success and failure counts with no personal content in its logs" discipline recap_weekly established, applied to an audit row: a recipient LIST here would put per-member data into the log for a feature whose entire point is that it holds none');

-- =====================================================================
-- 9. AGGREGATE ONLY, BEHAVIOURALLY
-- =====================================================================
-- Section 1 proved there is nowhere for member data to live. This proves
-- none of it is there, in each of the three places COMM-309's "generated
-- content" actually reaches a human: the row, the notification and the
-- audit trail.
select ok(
  not tests.mcr_mentions_a_member(
    tests.mcr_row_text((select id from tests.mcr_snap where k = 'gen1'))),
  'THE PUBLISHED ROW mentions no member: not one profile id, handle or display name appears anywhere in it, asked over every profile in the database rather than over a list this file remembered to write down. The row is club totals, a club id, a month and two timestamps');

select ok(
  not tests.mcr_mentions_a_member(tests.mcr_notif_text((select id from tests.mcr_snap where k = 'gen1'))),
  'THE NOTIFICATION mentions no member either - title, body, category, deep link and source_type all searched together. The body is three club totals and nothing else, which is where a "well done to X for their 20 sessions" would have crept in if anywhere');

select ok(
  not tests.mcr_mentions_a_member(
    tests.mcr_audit_after((select id from tests.mcr_snap where k = 'gen1'))::text),
  'and neither does the AUDIT ROW''s after_data. The one place a recipient list would have been convenient is the one place it would have been a per-member record of a feature that holds none');

-- THE POSITIVE CONTROL for all three assertions above. Without it, they
-- would pass just as happily against a searcher that never matches
-- anything, or against an empty haystack - which is exactly how a privacy
-- assertion rots into decoration.
select ok(
  tests.mcr_mentions_a_member(
    tests.mcr_row_text((select id from tests.mcr_snap where k = 'gen1'))
    || ' ' || (select handle from public.profiles where id = tests.uid('m1'))),
  'THE POSITIVE CONTROL: the same searcher, over the same row text with one member handle appended, DOES find it. So "no member is mentioned" above is a fact about the content and not about a search that can never match');

select ok(
  tests.mcr_mentions_a_member(
    (select display_name from public.profiles where id = tests.uid('m2'))),
  'and it matches on a display name as well as a handle - the searcher asks all three of id, handle and display name for every profile in the database');

-- =====================================================================
-- 10. THE PUBLISHED BOUNDARY, AND WHAT PUBLISHING CANNOT BE UNDONE
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int, min(sessions_logged), bool_and(published_at is not null)
     from public.monthly_club_recaps $$,
  $$ values (1, 17, true) $$,
  'THE PLAIN MEMBER''S READ FLIPS FROM ZERO ROWS TO ONE at the moment of publish, and they read the real figures. Same member, same query, same session shape as section 5 - the only thing that changed is published_at');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.recap_monthly_publish((select id from tests.mcr_snap where k = 'gen1')) $$,
  'P0001', 'recap already published',
  'a second publish RAISES. Checked under FOR UPDATE, so two staff members hitting the button at the same moment serialise rather than both fanning out');

select tests.clear_auth();
select results_eq(
  $$ select tests.mcr_notif_count((select id from tests.mcr_snap where k = 'gen1')),
            tests.mcr_audit_count((select id from tests.mcr_snap where k = 'gen1')) $$,
  $$ values (6, 1) $$,
  'and the refused call left NOTHING behind: still six notifications and one audit row. The refusal is checked before the update, so a rejected publish is not a half-published one');

-- --- regeneration over a PUBLISHED month --------------------------------
update tests.mcr_snap
  set ts = (select published_at from public.monthly_club_recaps where id = tests.mcr_snap.id),
      ts2 = (select generated_at from public.monthly_club_recaps where id = tests.mcr_snap.id)
  where k = 'gen1';

-- More activity lands in the already-published month. A regeneration that
-- did not respect published_at would rewrite history with it.
select tests.mcr_attend(tests.uid('coach'), 22, 25);
insert into public.workout_posts
  (author_id, post_type, visibility, title, body, status, created_at)
values (tests.uid('coach'), 'POST_TEXT', 'club', 'p5', 'x', 'active', (tests.mcr_month() + 22)::timestamptz);

select is(
  tests.mcr_generate(tests.mcr_month()),
  (select id from tests.mcr_snap where k = 'gen1'),
  'A RERUN OVER A PUBLISHED MONTH still returns the row id - the caller gets a usable answer rather than a null - but see the next three assertions for what it did NOT do');

select results_eq(
  $$ select sessions_logged, posts_created from public.monthly_club_recaps
     where id = (select id from tests.mcr_snap where k = 'gen1') $$,
  $$ values (17, 4) $$,
  'IT WROTE NOTHING. Four more attendance days and another post landed in that month between the runs, and the published figures did not move by one. "Content is what it was published as" - a mistaken figure is corrected in the next month''s real data, never by rewriting a historical recap');

select results_eq(
  $$ select (select published_at from public.monthly_club_recaps
             where id = (select id from tests.mcr_snap where k = 'gen1'))
            = (select ts from tests.mcr_snap where k = 'gen1'),
            (select generated_at from public.monthly_club_recaps
             where id = (select id from tests.mcr_snap where k = 'gen1'))
            = (select ts2 from tests.mcr_snap where k = 'gen1') $$,
  $$ values (true, true) $$,
  'published_at is untouched to the microsecond - the rerun could not un-publish or re-publish it - and so is generated_at, because the ON CONFLICT clause carries `where published_at is null` and therefore executed no UPDATE at all. This is a genuine no-op, not a refused write that still bumped a timestamp');

select results_eq(
  $$ select count(*)::int from public.monthly_club_recaps $$,
  $$ values (1) $$,
  'and no second row was created for the month either, which is the failure mode a "skip if published" written as an early return would still have been safe from but a delete-and-reinsert would not');

select is(
  tests.mcr_notif_count((select id from tests.mcr_snap where k = 'gen1')),
  6,
  'still six notifications after three generation runs and two publish attempts. Nobody was told twice');

-- --- the freeze trigger, the guarantee under the SQL --------------------
-- Asserted as the bootstrap superuser with RLS out of the way, because
-- that is the only caller it can ever have: no client role holds an UPDATE
-- grant, so this guards the service role and any future direct writer.
select throws_ok(
  $$ update public.monthly_club_recaps set published_at = null
     where id = (select id from tests.mcr_snap where k = 'gen1') $$,
  'P0001', 'a published monthly recap is immutable',
  'A PUBLISHED RECAP CANNOT BE UN-PUBLISHED, and this is asserted against the SUPERUSER, the most privileged caller there is. Without the trigger, "cannot be un-published" would be a property of the generator''s SQL rather than of the table - and the service role bypasses RLS entirely');

select throws_ok(
  $$ update public.monthly_club_recaps set sessions_logged = 9999
     where id = (select id from tests.mcr_snap where k = 'gen1') $$,
  'P0001', 'a published monthly recap is immutable',
  'nor can a published figure be edited. The two are one rule - the trigger refuses ANY update of a row whose published_at is already set - which is why a mistaken figure is a next-month correction and not a rewrite');

select results_eq(
  $$ select sessions_logged, published_at is not null from public.monthly_club_recaps
     where id = (select id from tests.mcr_snap where k = 'gen1') $$,
  $$ values (17, true) $$,
  'and the row is exactly as it was published after both refusals');

-- =====================================================================
-- 11. THE DEFAULT MONTH, AND THE OWNER
-- =====================================================================
-- Generated in its own statement: a row written by a volatile function
-- called inside a WHERE clause is not visible to that same statement's
-- snapshot.
insert into tests.mcr_snap (k, id) values ('gen2', tests.mcr_generate(null));

select is(
  (select month_start from public.monthly_club_recaps
   where id = (select id from tests.mcr_snap where k = 'gen2')),
  (date_trunc('month', current_date::timestamp) - interval '1 month')::date,
  'A NULL p_month_start MEANS THE MOST RECENTLY COMPLETED CALENDAR MONTH, never the running one - the same reasoning recap_weekly''s targetWeek() records for its own "never the current, still-running week". A recap for a month that has not finished would keep changing shape under whoever opened it, and a staff member previewing a half-month would be previewing a figure about to be wrong. This is what a scheduler firing on the 1st calls with no arguments');

select results_eq(
  $$ select count(*)::int, count(*) filter (where published_at is null)::int
     from public.monthly_club_recaps $$,
  $$ values (2, 1) $$,
  'two months now: the published one and a fresh draft');

select tests.set_auth(tests.uid('m3'));
select results_eq(
  $$ select count(*)::int from public.monthly_club_recaps $$,
  $$ values (1) $$,
  'and a plain member still sees only the published one. Two rows in the table, one row through the policy - the draft boundary holds per row, not per table');

select tests.set_auth(tests.uid('owner'));
select results_eq(
  $$ select count(*)::int from public.monthly_club_recaps $$,
  $$ values (2) $$,
  'the owner sees both');

select lives_ok(
  $$ select public.recap_monthly_publish(
       (select id from public.monthly_club_recaps where published_at is null)) $$,
  'and the OWNER can publish, through has_perm''s owner short-circuit rather than through a seeded role_permissions row - so a permission string added by a later migration is held by owner immediately, which is what 202608280001 designed that short-circuit for');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.monthly_club_recaps where published_at is not null $$,
  $$ values (2) $$,
  'both months are published now');

-- =====================================================================
-- 12. NO CLIENT WRITE PATH, FOR ANY RANK
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.monthly_club_recaps (month_start) values (date '2099-01-01') $$,
  '42501', null,
  'a plain member cannot insert a recap into existence - refused by the missing grant, before any policy is consulted');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ insert into public.monthly_club_recaps (month_start) values (date '2099-01-01') $$,
  '42501', null,
  'nor can a coach. If they could, they would have a route around the publish permission they were refused in section 7: insert a row with published_at already set and the club has been told, with no audit row and no fan-out');

select throws_ok(
  $$ update public.monthly_club_recaps set sessions_logged = 0 $$,
  '42501', null,
  'and a coach cannot edit a figure');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ update public.monthly_club_recaps set published_at = null $$,
  '42501', null,
  'an ADMIN - who may publish, and who reaches almost everything else in this schema - still cannot un-publish through a direct write. recap_monthly_publish is the only route in, and it only ever moves published_at from null');

select throws_ok(
  $$ delete from public.monthly_club_recaps $$,
  '42501', null,
  'and cannot delete a recap either');

select tests.set_auth(tests.uid('owner'));
select throws_ok(
  $$ delete from public.monthly_club_recaps $$,
  '42501', null,
  'and neither can the owner. The table takes no client write of any kind, at any rank - the pins/attendance_log/member_of_week shape');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.monthly_club_recaps $$,
  $$ values (2) $$,
  'two rows still, after four members of four different ranks each tried to write');

-- =====================================================================
-- 13. THE CONSTRAINTS UNDER THE FUNCTION
-- =====================================================================
-- Asserted as the superuser with RLS out of the way, because that is the
-- only caller they can ever have: backstops against a future direct
-- writer, not something a client can reach.
select throws_ok(
  $$ insert into public.monthly_club_recaps (month_start) values (date '2099-01-15') $$,
  '23514', null,
  'month_start must be the FIRST of the month. The unique key is what makes generation idempotent per month, and a key on a free-form date is only unique per date - one run keying the 1st and another keying the 15th would both insert and the club would get two recaps for one month. The same load-bearing CHECK weekly_recaps.week_start and member_of_week.week_start carry');

select throws_ok(
  $$ insert into public.monthly_club_recaps (month_start) values (tests.mcr_month()) $$,
  '23505', null,
  'and the month is unique at the constraint level too, so "one row per calendar month" survives a writer that forgets to check - recap_monthly_generate''s ON CONFLICT clause sits on top of this, not instead of it');

select throws_ok(
  $$ insert into public.monthly_club_recaps (month_start, sessions_logged)
     values (date '2099-01-01', -1) $$,
  '23514', null,
  'and a figure cannot be negative. A count never can be, so this only ever catches a writer that is not counting');

select lives_ok(
  $$ insert into public.monthly_club_recaps (month_start) values (date '2099-01-01') $$,
  'a bare month inserts as an honest row of zeros rather than a null-shaped one - the same "quiet month floor" reasoning weekly_recaps records for its own defaults, and what a month in which the club did nothing must look like');

select results_eq(
  $$ select sessions_logged, posts_created, new_members, challenges_completed,
            events_held, published_at is null
     from public.monthly_club_recaps where month_start = date '2099-01-01' $$,
  $$ values (0, 0, 0, 0, 0, true) $$,
  'five zeros and a draft');

select * from finish();
rollback;
