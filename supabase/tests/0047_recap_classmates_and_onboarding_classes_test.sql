-- COMM-316, schema half: behavioural coverage for 202609010003
-- (weekly_recaps.classmates, recap_weekly_classmates(),
-- onboarding_progress.first_class_shown_at / third_class_shown_at, and the
-- extended onboarding_progress_pin trigger).
--
-- Seven boundaries, each proved by a SCENARIO rather than by a structural
-- check, the style 0039 to 0046 established:
--
--   1. THE WEEK IS A REAL BOUNDARY. Every member in the fixture also trains
--      OUTSIDE the target week, on days the subject also trained. A day
--      shared one day before the week or one day after it must not count,
--      and the whole point of one decoy member (owner) is that ALL of their
--      overlap is outside - so a window bug promotes them from absent to
--      present, and a count bug moves m2's shared days from 3 to 4. Both are
--      changes to a NUMBER, which is what the assertions name.
--   2. THE CANDIDATE-SIDE show_attendance GATE. `norec` shares MORE days
--      with the subject than anybody (4 against m2's 3), so a broken gate
--      does not merely add a row, it puts a name that opted out at the TOP
--      of the line. Then the toggle is flipped on and they appear first,
--      which is the positive control that keeps the assertion from passing
--      against a query that returns nothing.
--   3. THE SUBJECT-SIDE show_attendance GATE, tested as a genuinely
--      DISTINCT case: the same fixture, every candidate still opted in, and
--      the subject's own toggle off produces '[]'. That is COMM-316's "gates
--      whether the line appears AT ALL for them, not just whether their name
--      appears in someone else's", and it is a different code path (a direct
--      profiles column read) from boundary 2.
--   4. THE ADMIN SHORT-CIRCUIT IS NOT REPRODUCED. An ADMIN subject, in a
--      week of their own, with one opted-out classmate and one opted-in one,
--      gets only the opted-in one. This is the deliberate divergence from
--      can_view_profile_field() and the one place this file would catch
--      somebody "fixing" the gate by reaching for the helper.
--   5. THE CAP AND THE ORDER. 25 eligible classmates, so the default 5 is a
--      real cut, and the order is shared days desc, display name, id - a
--      total order, asserted as a list rather than as a count.
--   6. THE GRANT BOUNDARY: service_role and nothing else. Asserted for
--      authenticated, anon and PUBLIC separately, and behaviourally from a
--      member's session - because p_user is a PARAMETER, so a member who
--      could call this could ask it about anybody.
--   7. THE PIN TRIGGER GENUINELY COVERS THE NEW COLUMNS. Not assumed: the
--      shipped trigger names its columns one by one, so a column added later
--      is not pinned by it at all. Proved twice - once per new column from a
--      real member session, and once by a SWEEP over every timestamptz
--      column the table has, so a future sixth step fails this file instead
--      of quietly becoming clearable.
--
-- FIXTURE MECHANIC WORTH READING FIRST
-- Every date is an offset from tests.rwc_week(), the Monday of the ISO week
-- containing (today - 21). So the file means the same thing whatever day it
-- runs on, the week under test is always safely in the past, and
-- tests.rwc_week() + 14 is always the most recently COMPLETED week (the one
-- a null p_week_start selects) - which is what section 6 uses.
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

-- The week under test: the Monday of the week containing (today - 21).
create or replace function tests.rwc_week() returns date
language sql stable as $fn$
  select (date_trunc('week', (current_date - 21)::timestamp))::date;
$fn$;
grant execute on function tests.rwc_week() to anon, authenticated, service_role;

-- A second, older week, used only by the admin section so its fixtures
-- cannot interfere with the main week's counts.
create or replace function tests.rwc_week2() returns date
language sql stable as $fn$
  select tests.rwc_week() - 28;
$fn$;
grant execute on function tests.rwc_week2() to anon, authenticated, service_role;

-- The function called the way the recap_weekly Edge Function calls it: as
-- service_role, the only role holding execute on it. Same set_config shape
-- 0046 uses for recap_monthly_generate and 0044 for
-- coach_detect_engagement_decline.
create or replace function tests.rwc(p_user uuid, p_week date default null) returns jsonb
language plpgsql as $fn$
declare v jsonb;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v := public.recap_weekly_classmates(p_user, p_week);
  perform pg_catalog.set_config('role', 'postgres', true);
  return v;
end $fn$;
grant execute on function tests.rwc(uuid, date) to anon, authenticated, service_role;

-- The same, with p_limit passed EXPLICITLY - including explicitly null, so
-- "null means the default" is a real assertion and not the default arriving
-- because nothing was passed.
create or replace function tests.rwc_lim(p_user uuid, p_week date, p_limit int) returns jsonb
language plpgsql as $fn$
declare v jsonb;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v := public.recap_weekly_classmates(p_user, p_week, p_limit);
  perform pg_catalog.set_config('role', 'postgres', true);
  return v;
end $fn$;
grant execute on function tests.rwc_lim(uuid, date, int) to anon, authenticated, service_role;

-- The handles in the array, in array order, as one comma-joined string. The
-- ORDER is half of what is being asserted, so it is never compared as a set.
create or replace function tests.rwc_handles(p jsonb) returns text
language sql immutable as $fn$
  select coalesce((select string_agg(e ->> 'handle', ',' order by ord)
                   from jsonb_array_elements(p) with ordinality t(e, ord)), '');
$fn$;
grant execute on function tests.rwc_handles(jsonb) to anon, authenticated, service_role;

-- Every distinct key present across every element, sorted. The whole of
-- "what leaves the function", asked over the payload rather than over the
-- keys this file remembered to name.
create or replace function tests.rwc_keys(p jsonb) returns text
language sql immutable as $fn$
  select coalesce((select string_agg(distinct k, ',' order by k)
                   from jsonb_array_elements(p) e, jsonb_object_keys(e) k), '');
$fn$;
grant execute on function tests.rwc_keys(jsonb) to anon, authenticated, service_role;

-- attendance_log has no write grant for any client role, so every fixture
-- day is written as the bootstrap superuser.
create or replace function tests.rwc_attend(p_user uuid, p_days int[]) returns void
language sql as $fn$
  insert into public.attendance_log (user_id, occurred_on)
  select p_user, tests.rwc_week() + d from unnest(p_days) d
  on conflict (user_id, occurred_on) do nothing;
$fn$;
grant execute on function tests.rwc_attend(uuid, int[]) to anon, authenticated, service_role;

create or replace function tests.rwc_attend_on(p_user uuid, p_day date) returns void
language sql as $fn$
  insert into public.attendance_log (user_id, occurred_on) values (p_user, p_day)
  on conflict (user_id, occurred_on) do nothing;
$fn$;
grant execute on function tests.rwc_attend_on(uuid, date) to anon, authenticated, service_role;

-- Read one onboarding stamp past RLS, so a superuser-side sweep and a
-- member-side assertion can look at the same column.
create or replace function tests.ob_stamp(p_user uuid, p_col text) returns timestamptz
language plpgsql stable security definer as $fn$
declare v timestamptz;
begin
  execute format('select %I from public.onboarding_progress where user_id = $1', p_col)
    into v using p_user;
  return v;
end $fn$;
grant execute on function tests.ob_stamp(uuid, text) to anon, authenticated, service_role;

-- THE SWEEP behind boundary 7. For EVERY timestamptz column on
-- onboarding_progress: stamp it, try to clear it, try to move it, and record
-- the column name if either attempt succeeded. Returns the names that are
-- NOT one-way. A future sixth onboarding step that nobody adds a line for in
-- onboarding_progress_pin_shown() turns up here as a failure, which is the
-- whole reason this is a sweep and not five hand-written assertions.
--
-- Runs as the bootstrap superuser: the trigger is BEFORE UPDATE with no role
-- predicate, so it fires for the superuser exactly as it does for a member,
-- and the member-side path is asserted separately below.
create or replace function tests.ob_unpinned(p_user uuid) returns text[]
language plpgsql as $fn$
declare
  c    text;
  bad  text[] := array[]::text[];
  t1   constant timestamptz := timestamptz '2020-01-02 03:04:05+00';
  t2   constant timestamptz := timestamptz '2021-06-07 08:09:10+00';
begin
  for c in
    select a.attname::text
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.onboarding_progress'::regclass
      and a.attnum > 0 and not a.attisdropped
      and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
    order by a.attnum
  loop
    -- Every column starts null on a freshly seeded row, so the first write
    -- is the legitimate one-and-only stamp.
    execute format('update public.onboarding_progress set %I = $2 where user_id = $1', c)
      using p_user, t1;
    if tests.ob_stamp(p_user, c) is distinct from t1 then
      bad := bad || (c || ':not-settable'); continue;
    end if;

    execute format('update public.onboarding_progress set %I = null where user_id = $1', c)
      using p_user;
    if tests.ob_stamp(p_user, c) is distinct from t1 then
      bad := bad || (c || ':clearable'); continue;
    end if;

    execute format('update public.onboarding_progress set %I = $2 where user_id = $1', c)
      using p_user, t2;
    if tests.ob_stamp(p_user, c) is distinct from t1 then
      bad := bad || (c || ':movable'); continue;
    end if;
  end loop;
  return bad;
end $fn$;
grant execute on function tests.ob_unpinned(uuid) to anon, authenticated, service_role;

-- =====================================================================
-- 1. THE SHAPE: two tables gained columns, and neither gained a grant
-- =====================================================================
select has_column('public', 'weekly_recaps', 'classmates',
  'weekly_recaps gained the classmates column COMM-316''s migration outline names');

select is(
  (select pg_catalog.format_type(a.atttypid, a.atttypmod) || ' | ' ||
          a.attnotnull::text || ' | ' ||
          pg_catalog.pg_get_expr(d.adbin, d.adrelid)
   from pg_catalog.pg_attribute a
   left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.weekly_recaps'::regclass and a.attname = 'classmates'),
  'jsonb | true | ''[]''::jsonb',
  'jsonb, NOT NULL, default ''[]'' - the quiet-week floor prs, achievements and challenge_progress already use. A member with no overlap gets an honest empty array rather than a null the recap UI has to branch on, which is COMM-316''s "quiet week shape is unaffected" criterion expressed as a default instead of as a rule recap_weekly must remember');

select results_eq(
  $$ select polname, polcmd::text from pg_catalog.pg_policy
     where polrelid = 'public.weekly_recaps'::regclass order by polname $$,
  $$ values ('weekly_recaps_self_select'::name, 'r'::text) $$,
  'THE GRANT SHAPE THE NEW COLUMN INHERITS, asserted rather than assumed: still exactly ONE policy on weekly_recaps and it is own-row SELECT. Adding a column changed no policy, and there was never an insert, update or delete policy to change');

select ok(
  pg_catalog.has_table_privilege('authenticated', 'public.weekly_recaps', 'select')
  and not pg_catalog.has_table_privilege('authenticated', 'public.weekly_recaps', 'insert')
  and not pg_catalog.has_table_privilege('authenticated', 'public.weekly_recaps', 'update')
  and not pg_catalog.has_table_privilege('authenticated', 'public.weekly_recaps', 'delete'),
  'and the grant half of the same shape: select only, no write of any kind for any client, the owning member included. classmates is therefore written by exactly one caller - recap_weekly, as service_role, bypassing RLS');

select ok(
  not pg_catalog.has_table_privilege('anon', 'public.weekly_recaps', 'select'),
  'anon reaches weekly_recaps not at all');

select has_column('public', 'onboarding_progress', 'first_class_shown_at',
  'onboarding_progress gained first_class_shown_at (COMM-P07)');
select has_column('public', 'onboarding_progress', 'third_class_shown_at',
  'and third_class_shown_at');

select is(
  (select string_agg(a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod),
                     ', ' order by a.attnum)
   from pg_catalog.pg_attribute a
   where a.attrelid = 'public.onboarding_progress'::regclass
     and a.attnum > 0 and not a.attisdropped),
  'user_id uuid, welcomed_at timestamp with time zone, '
  || 'first_week_shown_at timestamp with time zone, '
  || 'first_month_shown_at timestamp with time zone, '
  || 'first_class_shown_at timestamp with time zone, '
  || 'third_class_shown_at timestamp with time zone',
  'FIVE STAMPS AND A KEY, and both new ones are NULLABLE like the three before them - null means "not shown yet". There is deliberately still no joined_at and no attendance counter here: the clock for the three original steps is invite_redemptions.redeemed_at and the clock for these two is public.attendance_log, both of which the member already reads on their own rows');

select ok(
  pg_catalog.has_column_privilege('authenticated', 'public.onboarding_progress', 'first_class_shown_at', 'select')
  and pg_catalog.has_column_privilege('authenticated', 'public.onboarding_progress', 'first_class_shown_at', 'update')
  and pg_catalog.has_column_privilege('authenticated', 'public.onboarding_progress', 'third_class_shown_at', 'select')
  and pg_catalog.has_column_privilege('authenticated', 'public.onboarding_progress', 'third_class_shown_at', 'update'),
  'both new columns are readable AND updatable by their owner with no new grant: 202608290011''s grant is table-level with no column list, so it covers a column added later. This is what makes COMM-222''s direct-RLS mark-seen call work on the two new steps with no client-side change beyond the column names');

select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.onboarding_progress', 'insert')
  and not pg_catalog.has_table_privilege('authenticated', 'public.onboarding_progress', 'delete'),
  'and there is still no insert and no delete grant, which is what keeps "each step fires exactly once per member" true - a member who could delete and re-insert their row could re-see every step');

-- =====================================================================
-- 2. THE FUNCTION'S BOUNDARY: service_role and nobody else
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'recap_weekly_classmates'),
  true,
  'recap_weekly_classmates is SECURITY DEFINER - attendance_log is own-row plus staff, so reading who else trained on a member''s days crosses an RLS boundary on purpose');

select ok(
  pg_catalog.has_function_privilege('service_role',
    'public.recap_weekly_classmates(uuid, date, int)', 'execute'),
  'service_role can execute it - the grant the recap_weekly Edge Function uses');

select ok(
  not pg_catalog.has_function_privilege('authenticated',
        'public.recap_weekly_classmates(uuid, date, int)', 'execute')
  and not pg_catalog.has_function_privilege('anon',
        'public.recap_weekly_classmates(uuid, date, int)', 'execute')
  and not pg_catalog.has_function_privilege('public',
        'public.recap_weekly_classmates(uuid, date, int)', 'execute'),
  'AND NOBODY ELSE CAN, PUBLIC INCLUDED. This grant matters more than the identical one on recap_monthly_generate: p_user is a PARAMETER, so a member-callable version of this function would answer "who did member X train with in week W" about anybody in the club. PUBLIC is asserted separately because a new function starts with execute granted to PUBLIC, and forgetting that revoke is exactly how a service-role job quietly becomes an open RPC');

-- =====================================================================
-- 3. FIXTURES: one week, with the overlap that must not count
-- =====================================================================
-- SUBJECT: m1, trains Mon-Thu of the target week, plus the Sunday before it
-- and the Monday after it. Those two outside days are what every "the week
-- is a real boundary" assertion below leans on.
--
--   member   inside the week           outside      shared days IN the week
--   -------  ------------------------  -----------  -----------------------
--   m1       Mon Tue Wed Thu           Sun-1, Mon+7  (the subject)
--   m2       Mon Tue Wed               Sun-1         3
--   m3       Mon Tue                   -             2
--   coach    Mon                       -             1
--   norec    Mon Tue Wed Thu           -             4, but opted OUT
--   owner    -                         Sun-1, Mon+7  0 - all overlap outside
--   admin    Sat                       -             0 - m1 was not there
update public.profiles set show_attendance = true
  where id in (tests.uid('m1'), tests.uid('m2'), tests.uid('m3'),
               tests.uid('coach'), tests.uid('owner'), tests.uid('admin'));
-- norec is left at the column default, false. It is the default for every
-- member in the real club too (202608280003), which is why the empty line is
-- the out-of-the-box state rather than a bug.

select tests.rwc_attend(tests.uid('m1'), array[0, 1, 2, 3]);
select tests.rwc_attend(tests.uid('m2'), array[0, 1, 2]);
select tests.rwc_attend(tests.uid('m3'), array[0, 1]);
select tests.rwc_attend(tests.uid('coach'), array[0]);
select tests.rwc_attend(tests.uid('norec'), array[0, 1, 2, 3]);
select tests.rwc_attend(tests.uid('admin'), array[5]);

-- The days OUTSIDE the week. m1 shares both with owner and the first with
-- m2 - so owner must stay absent and m2's count must stay 3.
select tests.rwc_attend(tests.uid('m1'), array[-1, 7]);
select tests.rwc_attend(tests.uid('m2'), array[-1]);
select tests.rwc_attend(tests.uid('owner'), array[-1, 7]);

select is(
  (select count(*)::int from public.attendance_log
   where occurred_on between tests.rwc_week() - 1 and tests.rwc_week() + 7),
  20,
  'twenty attendance days across the target week and its two flanking days, so every filter below cuts something real');

-- =====================================================================
-- 4. THE WEEK BOUNDARY, THE CANDIDATE GATE, AND THE ORDER
-- =====================================================================
select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'member_b,member_c,coach_x',
  'THE LINE, and four separate rules in one list. (a) ORDER: shared days descending - m2 on 3, m3 on 2, coach on 1. (b) THE WEEK IS A BOUNDARY: owner shares two whole days with m1 and both are outside the week, so owner is absent entirely; a lower-bound-only window like classmate_day_counts'' rolling 60 days would have listed them. (c) THE CANDIDATE GATE: norec shares FOUR days, more than anybody, and does not appear at all, because their show_attendance is off. (d) admin trained that week but not on a day m1 did, so there is no overlap to gate');

select is(
  tests.rwc_keys(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'avatar_url,display_name,handle,user_id',
  'FOUR KEYS AND NO FIFTH. shared_days is computed - it is the ordering key - and it stays inside the function: the recap tells the member WHO they trained beside, not on how many of which days, the same restraint attendance_classmates_today shows. These four are also exactly what community_profile already returns to any member for any member, so nothing new about a classmate becomes reachable');

-- The count itself, proved through the order rather than through a returned
-- number: if m2's shared day outside the week were counted they would still
-- be first, so the assertion is built the other way round - push m3 above m2
-- by giving m3 two more days INSIDE the week and check the list flips.
select tests.rwc_attend(tests.uid('m3'), array[2, 3]);
select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'member_c,member_b,coach_x',
  'm3 now shares FOUR days inside the week and overtakes m2, which is the shared-day COUNT being asserted through the only channel that carries it. m2 is on 3 and not 4 - their day outside the week is still not counted - so a window bug on the aggregate side would have kept m2 first');
-- Put the fixture back.
select tests.clear_auth();
delete from public.attendance_log
  where user_id = tests.uid('m3') and occurred_on in (tests.rwc_week() + 2, tests.rwc_week() + 3);

select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week() + 3)),
  'member_b,member_c,coach_x',
  'A MID-WEEK p_week_start IS NORMALISED to its own week''s Monday rather than rejected - the same courtesy member_of_week_candidates() and recap_monthly_generate() extend. Thursday of the week returns the week');

select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week() - 7)),
  'member_b,owner_x',
  'THE OTHER HALF OF THE WEEK BOUNDARY, and the sharpest assertion in this section: OWNER - absent from the target week''s line entirely - turns up in the PREVIOUS week''s. The day they share with m1 is the Sunday before the target week, which is the LAST day of the previous ISO week, so the same two members and the same one shared day land in exactly one of the two weeks and never in both. It also pins the week to MONDAY: were weeks Sunday-based, that day would fall inside the target week and owner would have appeared in the line above. m2 is here for the same reason and on the same day - their fourth day, the one that did NOT inflate their count to 4 up there');

select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week() - 14)),
  '',
  'and a week nobody trained in is an empty line rather than an error - COMM-316''s quiet-week criterion, which is the state most weeks will be in for most members');

-- =====================================================================
-- 5. THE TWO GATES, EACH ON ITS OWN
-- =====================================================================
-- 5a. The candidate side, with its positive control.
update public.profiles set show_attendance = true where id = tests.uid('norec');
select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'member_norec,member_b,member_c,coach_x',
  'THE POSITIVE CONTROL FOR THE CANDIDATE GATE: the same member, the same four shared days, one toggle flipped, and now they lead the line. So "norec does not appear" above is a fact about show_attendance and not about a query that never returns them - which is exactly how a privacy assertion rots into decoration');
update public.profiles set show_attendance = false where id = tests.uid('norec');

-- 5b. visible_to_club, which the candidate gate also carries.
update public.profiles set visible_to_club = false where id = tests.uid('m3');
select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'member_b,coach_x',
  'a member hidden from the club is not on the line either, without a second predicate saying so - can_view_profile_field() requires visible_to_club before it answers about any other field, and the hand-written gate reproduces that term rather than only the named toggle');
update public.profiles set visible_to_club = true where id = tests.uid('m3');

-- 5c. Blocks, in either direction.
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'member_c,coach_x',
  'a member the subject blocked is off the line, and the rest of it is untouched - so it is the block edge doing it and not a broken fixture');
delete from public.blocks;

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('m1'));
select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'member_c,coach_x',
  'and so is a member who blocked the SUBJECT - the edge counts in either direction, which the hand-written gate has to state explicitly because can_view_profile_field() is not there to settle it');
delete from public.blocks;

-- 5d. A soft-deleted profile.
update public.profiles set deleted_at = now() where id = tests.uid('coach');
select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'member_b,member_c',
  'a soft-deleted profile drops off the line. Their attendance_log rows survive - the table is append-only and the club-wide monthly figure still counts them - but a deleted member is not named to anybody');
update public.profiles set deleted_at = null where id = tests.uid('coach');

-- 5e. THE SUBJECT SIDE. A different code path from 5a: a direct profiles
-- column read about the subject, not a viewer-relative question about a
-- candidate. Every candidate below is still fully eligible.
update public.profiles set show_attendance = false where id = tests.uid('m1');
select is(
  tests.rwc(tests.uid('m1'), tests.rwc_week()),
  '[]'::jsonb,
  'THE SUBJECT''S OWN TOGGLE GATES THE WHOLE LINE. Same week, same three eligible classmates, all still opted in - and the subject gets NOTHING because their own show_attendance is off. This is COMM-316''s "gates whether the line appears at all for them, not just whether their name appears in someone else''s", and it is a reciprocity rule: every member named on a line has opted into being seen training, so a member who declined that trade does not read the other side of it');

select is(
  tests.rwc(tests.uid('m1'), tests.rwc_week()),
  tests.rwc(tests.uid('m2'), tests.rwc_week() - 14),
  'and an opted-out subject''s empty array is INDISTINGUISHABLE from a genuinely quiet week - both are ''[]'', neither is a raise. Nothing about the member''s privacy setting leaks into the shape of their own recap row, and the recap UI needs no new branch for it');
update public.profiles set show_attendance = true where id = tests.uid('m1');

select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'member_b,member_c,coach_x',
  'and the line comes back when the subject opts in again - the positive control for the subject-side gate, matching the one the candidate side has');

-- 5f. A subject who is not there at all.
select is(
  tests.rwc('00000000-0000-4000-8000-0000000000ff'::uuid, tests.rwc_week()),
  '[]'::jsonb,
  'an unknown p_user is an empty array, not an error: a missing or soft-deleted profile coalesces the subject toggle to false, which is the same quiet line. Only a NULL p_user is treated as a caller bug');

select throws_ok(
  $$ select tests.rwc(null, tests.rwc_week()) $$,
  'P0001', 'recap_weekly_classmates: p_user is required',
  'A NULL p_user RAISES, and that is the one raise in the function. It is a caller bug rather than a data state - a job looping members cannot legitimately reach here without one - and silently writing an empty line would bake that bug into a stored row where nobody would ever see it. recap_weekly''s per-member try/catch turns it into a logged failure');
select tests.clear_auth();

-- =====================================================================
-- 6. NULL p_week_start MEANS THE MOST RECENTLY COMPLETED ISO WEEK
-- =====================================================================
-- rwc_week() + 14 is always the Monday of the week before the current one,
-- whatever day this runs on.
select tests.rwc_attend(tests.uid('m1'), array[14]);
select tests.rwc_attend(tests.uid('m3'), array[14]);

select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), null)),
  'member_c',
  'A NULL p_week_start MEANS THE MOST RECENTLY COMPLETED ISO WEEK - the same week recap_weekly''s targetWeek() picks, and never the running one. The answer is that week''s classmates and not the target week''s three, which is what proves the default resolves rather than falling through to "all time"');

select is(
  (select date_trunc('week', (current_date - 7)::timestamp)::date),
  tests.rwc_week() + 14,
  'and the fixture week really is that week, so the assertion above is not agreeing with itself by accident');

-- =====================================================================
-- 7. THE ADMIN SHORT-CIRCUIT IS DELIBERATELY NOT REPRODUCED
-- =====================================================================
-- Its own week, four weeks earlier, so nothing here touches section 4's
-- counts. The admin fixture carries profiles.is_admin = true, which is what
-- can_view_profile_field() short-circuits on.
select tests.rwc_attend_on(tests.uid('admin'), tests.rwc_week2());
select tests.rwc_attend_on(tests.uid('norec'), tests.rwc_week2());  -- opted OUT
select tests.rwc_attend_on(tests.uid('m2'),    tests.rwc_week2());  -- opted IN

select is(
  tests.rwc_handles(tests.rwc(tests.uid('admin'), tests.rwc_week2())),
  'member_b',
  'AN ADMIN''S OWN RECAP NAMES ONLY CLASSMATES WHO OPTED IN. The opted-out member trained beside them that day and is still absent, while the opted-in one is there - so the gate ran and the admin''s rank did not open it. This is the one term of can_view_profile_field() the hand-written gate deliberately does NOT reproduce, and the assertion exists because reaching for that helper is the obvious "fix" somebody will try: it would silently hand every admin the names of members who opted out, written permanently into a row COMM-221''s Share Recap can put on the feed. An admin''s rank governs what they may look up (attendance_log''s staff read policy), never what gets stored in a recap');

select ok(
  (select p.is_admin from public.profiles p where p.id = tests.uid('admin')),
  'and the admin fixture really does carry is_admin, so the assertion above is about the short-circuit and not about a member who was never an admin');

-- =====================================================================
-- 8. THE CAP AND THE TOTAL ORDER
-- =====================================================================
-- 22 more opted-in members, all training the target week's Monday, so the
-- eligible pool for m1 is 25 and every clamp below cuts something real. No
-- invite_redemptions for them: nothing in this function reads membership,
-- and leaving them out keeps the POST_NEW_MEMBER trigger quiet.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000',
       ('c3160000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'authenticated', 'authenticated',
       'rwcbulk' || lpad(g::text, 2, '0') || '@members.haimuniya.invalid',
       '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()
from generate_series(1, 22) g;

insert into public.profiles (id, handle, display_name, recovery_verified_at, show_attendance)
select ('c3160000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'rwc_' || lpad(g::text, 2, '0'),
       'Bulk ' || lpad(g::text, 2, '0'),
       now(), true
from generate_series(1, 22) g;

insert into public.attendance_log (user_id, occurred_on)
select ('c3160000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       tests.rwc_week()
from generate_series(1, 22) g;

select is(
  (select jsonb_array_length(tests.rwc_lim(tests.uid('m1'), tests.rwc_week(), 50))),
  20,
  'twenty-five members are eligible and the hard clamp cuts the answer to 20 - the same 1..20 clamp people_suggestions and attendance_classmates_today carry, so no argument can turn a recap line into a club roster');

select is(
  tests.rwc_handles(tests.rwc(tests.uid('m1'), tests.rwc_week())),
  'member_b,member_c,rwc_01,rwc_02,rwc_03',
  'THE DEFAULT IS 5 AND THE ORDER IS TOTAL: shared days descending (m2 on 3, m3 on 2, then twenty-three members tied on 1), then display name ascending, then id. "Bulk 01" sorts before "Coach X", so coach_x is cut and rwc_01..03 are not - which is only deterministic BECAUSE the third key exists. Five is a recap line - a sentence naming people, read once a week - where COMM-307''s card is 6 and people_suggestions'' strip is 10');

select is(
  (select jsonb_array_length(tests.rwc_lim(tests.uid('m1'), tests.rwc_week(), 2))),
  2,
  'a smaller argument is honoured, so the recaps agent can revisit the line''s length from the Edge Function without a migration');

select is(
  (select jsonb_array_length(tests.rwc_lim(tests.uid('m1'), tests.rwc_week(), null))),
  5,
  'an EXPLICIT null p_limit means the default 5, not zero names and not an error - the accommodation every clamped reader in this module makes');

select is(
  (select jsonb_array_length(tests.rwc_lim(tests.uid('m1'), tests.rwc_week(), 0))),
  1,
  'and zero clamps UP to 1 rather than returning an empty line, which would have looked exactly like a member who trained alone');

-- =====================================================================
-- 9. THE MEMBER'S SIDE OF THE FUNCTION BOUNDARY
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.recap_weekly_classmates(tests.uid('m1'), tests.rwc_week()) $$,
  '42501', null,
  'A MEMBER CANNOT CALL IT ABOUT ANOTHER MEMBER - refused by the missing EXECUTE grant, before the body is entered. p_user being a parameter is exactly why this assertion is here and not merely implied by the has_function_privilege check above');

select throws_ok(
  $$ select public.recap_weekly_classmates(tests.uid('m2'), tests.rwc_week()) $$,
  '42501', null,
  'nor about THEMSELVES. There is no member-facing form of this function at all: a member who wants to know who they trained beside has COMM-307''s attendance_classmates_today(), which answers only for today and only for the caller');

select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.recap_weekly_classmates(tests.uid('m1'), tests.rwc_week()) $$,
  '42501', null,
  'and neither can an admin. The grant is the gate, and it names one role');

-- =====================================================================
-- 10. THE COLUMN ROUND-TRIPS THROUGH THE TABLE
-- =====================================================================
select tests.clear_auth();

insert into public.weekly_recaps (user_id, week_start)
values (tests.uid('m1'), tests.rwc_week());

select is(
  (select classmates from public.weekly_recaps
   where user_id = tests.uid('m1') and week_start = tests.rwc_week()),
  '[]'::jsonb,
  'a recap row written without a classmates value gets the empty array, not null - the quiet-week floor holding for the column the same way it holds for prs and achievements');

-- Computed into a snapshot table in its own statement first, rather than
-- called inside the UPDATE: tests.rwc_lim switches `role` for the duration of
-- the call, and a role switch part-way through a statement that is itself
-- writing an RLS-protected table is not something a test should depend on.
create table tests.rwc_snap (k text primary key, v jsonb);
grant select on tests.rwc_snap to anon, authenticated, service_role;
insert into tests.rwc_snap (k, v)
  values ('line3', tests.rwc_lim(tests.uid('m1'), tests.rwc_week(), 3));

update public.weekly_recaps
  set classmates = (select v from tests.rwc_snap where k = 'line3')
  where user_id = tests.uid('m1') and week_start = tests.rwc_week();

select tests.set_auth(tests.uid('m1'));
select is(
  tests.rwc_handles((select classmates from public.weekly_recaps where user_id = tests.uid('m1'))),
  'member_b,member_c,rwc_01',
  'THE WHOLE PATH, end to end: the function''s output stored in the column and read back by the member through weekly_recaps_self_select. This is what recap_weekly will do once per member per week');

select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.weekly_recaps $$,
  'AND NOBODY ELSE CAN READ IT. This is the entire reason naming individual classmates is allowed here at all: weekly_recaps is own-row select only, so a classmates line reaches exactly one member - the one who was in the room. The club-wide monthly recap (COMM-309) has no column a name could even be written into, and stays aggregate-only forever');

-- =====================================================================
-- 11. THE PIN TRIGGER, ON THE TWO NEW COLUMNS
-- =====================================================================
-- The shipped trigger names its columns one at a time, so "the existing
-- trigger already covers them" was not something to assume. These assertions
-- run from a real member session, through the RLS update policy, which is the
-- path COMM-222's mark-seen call actually takes.
select tests.set_auth(tests.uid('m1'));

select is(
  (select first_class_shown_at from public.onboarding_progress where user_id = tests.uid('m1')),
  null,
  'the new steps start unshown on a row seeded before this migration existed. No backfill stamped them, which is right: a member who has already logged fifty classes sees the first-class card once, on their next visit, rather than having a past day invented as the moment it was "shown"');

select lives_ok(
  $$ update public.onboarding_progress
       set first_class_shown_at = timestamptz '2026-03-01 10:00:00+00'
     where user_id = tests.uid('m1') $$,
  'the member stamps the first-class step at render time, through the same own-row update policy the three original steps use');

select is(
  (select first_class_shown_at from public.onboarding_progress where user_id = tests.uid('m1')),
  timestamptz '2026-03-01 10:00:00+00',
  'and it landed');

select lives_ok(
  $$ update public.onboarding_progress set first_class_shown_at = null
     where user_id = tests.uid('m1') $$,
  'clearing it is ACCEPTED rather than refused - COMM-222 wants a failed dismiss-write to retry quietly, and two tabs racing on a new member''s first day is not an error worth surfacing');

select is(
  (select first_class_shown_at from public.onboarding_progress where user_id = tests.uid('m1')),
  timestamptz '2026-03-01 10:00:00+00',
  'AND SILENTLY HAD NO EFFECT. The stamp is one-way: this is the assertion that would have FAILED before this migration extended onboarding_progress_pin_shown(), because that function names its columns one by one and a column added later is not pinned by it at all');

select lives_ok(
  $$ update public.onboarding_progress
       set first_class_shown_at = timestamptz '2026-09-01 10:00:00+00'
     where user_id = tests.uid('m1') $$,
  'moving it forward is accepted too');

select is(
  (select first_class_shown_at from public.onboarding_progress where user_id = tests.uid('m1')),
  timestamptz '2026-03-01 10:00:00+00',
  'and also had no effect - so a member cannot re-arm a step by re-stamping it, any more than by clearing it');

select lives_ok(
  $$ update public.onboarding_progress
       set third_class_shown_at = timestamptz '2026-04-01 10:00:00+00'
     where user_id = tests.uid('m1') $$,
  'the third-class step stamps independently');

select results_eq(
  $$ update public.onboarding_progress
       set third_class_shown_at = null, first_class_shown_at = null
     where user_id = tests.uid('m1')
     returning third_class_shown_at, first_class_shown_at $$,
  $$ values (timestamptz '2026-04-01 10:00:00+00', timestamptz '2026-03-01 10:00:00+00') $$,
  'and BOTH new stamps survive a single statement that tries to clear both at once - asserted through RETURNING, so it is the value the trigger handed back rather than a re-read that could have hidden a rewrite');

select results_eq(
  $$ select welcomed_at, first_week_shown_at, first_month_shown_at
     from public.onboarding_progress where user_id = tests.uid('m1') $$,
  $$ values (null::timestamptz, null::timestamptz, null::timestamptz) $$,
  'and the three ORIGINAL steps are untouched by any of it. COMM-316''s "these two steps do not block or reorder the three already-shipped steps" is structural: five independent nullable stamps, no ordering between them anywhere in the schema');

select lives_ok(
  $$ update public.onboarding_progress set welcomed_at = timestamptz '2026-01-01 10:00:00+00'
     where user_id = tests.uid('m1') $$,
  'the Day 1 welcome still stamps normally with two class steps already set - no regression on the shipped three');

select is(
  (select welcomed_at from public.onboarding_progress where user_id = tests.uid('m1')),
  timestamptz '2026-01-01 10:00:00+00',
  'out of order, and later than both class steps, because there is no order to be out of');

-- user_id is still pinned, which is the half of the trigger that is an
-- authorization rule rather than a UX one.
select lives_ok(
  $$ update public.onboarding_progress set user_id = tests.uid('m2')
     where user_id = tests.uid('m1') $$,
  'a member may issue an update that moves their row onto another member''s id...');

select is(
  (select count(*)::int from public.onboarding_progress where user_id = tests.uid('m1')),
  1,
  '...and it silently does nothing. user_id is pinned by the same trigger, on top of the policy''s WITH CHECK - without it a member could burn another member''s onboarding');

-- =====================================================================
-- 12. THE SWEEP: every timestamptz column, not only the ones this file names
-- =====================================================================
select tests.clear_auth();

select is(
  (select count(*)::int from pg_catalog.pg_attribute a
   where a.attrelid = 'public.onboarding_progress'::regclass
     and a.attnum > 0 and not a.attisdropped
     and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'),
  5,
  'five timestamptz columns for the sweep below to cover - so it is covering the two new ones and not silently passing over three');

select is(
  tests.ob_unpinned(tests.uid('m3')),
  array[]::text[],
  'EVERY timestamptz column on onboarding_progress is one-way: settable once, then neither clearable nor movable. Asserted as a SWEEP over pg_attribute rather than as five hand-written cases, because onboarding_progress_pin_shown() names its columns one at a time - so a SIXTH onboarding step added by a later ticket without a matching line in that function fails HERE, instead of shipping as a step that silently re-arms itself');

select * from finish();
rollback;
