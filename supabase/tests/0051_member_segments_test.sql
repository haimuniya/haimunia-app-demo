-- COMM-311, schema half: behavioural coverage for 202609010007
-- (member_segments).
--
-- Seven boundaries, each proved by a SCENARIO against a real seeded member
-- rather than by a structural check, the style 0039 to 0050 established:
--
--   1. THE PERMISSION BOUNDARY, and specifically that it is NARROWER than
--      is_staff() - the same gate 0050 pins for analytics_dashboard(). The
--      assertion that matters here is different though: it is that a member
--      WHO ACTUALLY CARRIES AN OPEN DECLINE FLAG is refused. COMM-311's
--      "never expose a declining label to the member it describes" is
--      enforced by there being no function they can call, not by a UI check.
--   2. ONE FIXTURE PER BUCKET, each built so that a broken threshold changes
--      the LABEL: 3-of-8 must not be steady, 3-of-4 must not be highly
--      active, the in-progress week must not count, week 9 must not count,
--      and ten non-qualifying events across eight weeks must not make anyone
--      active.
--   3. THE PRECEDENCE LOGIC, on members deliberately built to match more
--      than one bucket: new-and-otherwise-dormant, new-and-flagged,
--      flagged-and-highly-active. Plus the negative case - a DISMISSED flag
--      is not `declining`.
--   4. EXACTLY ONE SEGMENT PER MEMBER, asserted as a cardinality over the
--      whole club rather than member by member: the row count equals the
--      member count, no user_id appears twice, and no row carries a segment
--      name outside the six.
--   5. visible_to_club ON THE DRILL-DOWN. The hidden member is COUNTED and
--      NOT NAMED - user_id, display_name and handle all null - and the whole
--      serialised response is searched for their id, handle and display name.
--   6. THE SELF-FLAG RULE. The admin and the owner both carry an open flag.
--      Each reads the OTHER as `declining` and reads THEMSELVES as whatever
--      their activity says, and both still appear exactly once, so the counts
--      still add up to the club.
--   7. p_as_of REALLY MOVES THE WINDOW. A second run ten weeks back returns
--      a different club (four members had not joined, one had not been
--      deleted) and a different segment for the same member.
--
-- FIXTURE MECHANIC WORTH READING FIRST
-- Everything is an offset from tests.mseg_wk(n), the Monday n COMPLETE ISO
-- weeks back from the Monday of the current week. So mseg_wk(0) is the week
-- in progress - which the function must never count - and mseg_wk(1) through
-- mseg_wk(8) are the eight whole weeks the segmentation is computed over.
-- The file means the same thing whatever day it runs on.
--
-- The function is called TWICE, from a real admin session, plus once from an
-- owner session, and each response is parked row by row in tests.mseg_out.
-- Every assertion below reads that table.
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

-- The Monday n complete ISO weeks back. n = 0 is the week in progress.
create or replace function tests.mseg_wk(p_n integer) returns date
language sql stable as $fn$
  select (date_trunc('week', current_date::timestamp) - (p_n * 7) * interval '1 day')::date;
$fn$;
grant execute on function tests.mseg_wk(integer) to anon, authenticated, service_role;

-- The fixture ids, so an assertion names a member rather than a uuid.
create or replace function tests.mseg_uid(p_nick text) returns uuid
language sql immutable as $fn$
  select case p_nick
    when 'new'      then 'e3110000-0000-4000-8000-000000000001'  -- joined 5 days ago, no activity
    when 'ha'       then 'e3110000-0000-4000-8000-000000000002'  -- active in each of weeks 1-4
    when 'steady'   then 'e3110000-0000-4000-8000-000000000003'  -- active in weeks 1,3,5,7 (4 of 8)
    when 'occ'      then 'e3110000-0000-4000-8000-000000000004'  -- active in weeks 1,2,3 (3 of 8)
    when 'dorm'     then 'e3110000-0000-4000-8000-000000000005'  -- active in week 12 only
    when 'decl'     then 'e3110000-0000-4000-8000-000000000006'  -- open flag, active weeks 1,3
    when 'declha'   then 'e3110000-0000-4000-8000-000000000007'  -- open flag AND active weeks 1-4
    when 'newdecl'  then 'e3110000-0000-4000-8000-000000000008'  -- joined 5 days ago AND open flag
    when 'hidden'   then 'e3110000-0000-4000-8000-000000000009'  -- visible_to_club = false
    when 'resolved' then 'e3110000-0000-4000-8000-00000000000a'  -- DISMISSED flag, active weeks 1,2
    when 'passive'  then 'e3110000-0000-4000-8000-00000000000b'  -- non-qualifying events, weeks 1-8
    when 'bound'    then 'e3110000-0000-4000-8000-00000000000c'  -- active weeks 0,1,2,3
    when 'newedge'  then 'e3110000-0000-4000-8000-00000000000d'  -- joined exactly 29 days ago
    when 'oldedge'  then 'e3110000-0000-4000-8000-00000000000e'  -- joined one second earlier
    when 'deleted'  then 'e3110000-0000-4000-8000-00000000000f'  -- soft-deleted profile
    when 'noinv'    then 'e3110000-0000-4000-8000-000000000010'  -- profile, no invite_redemption
  end::uuid
$fn$;
grant execute on function tests.mseg_uid(text) to anon, authenticated, service_role;

-- One parked row per (run, member). Written from inside the caller's own
-- session, so authenticated needs insert; read back as the superuser.
create table tests.mseg_out (k text, doc jsonb);
grant select, insert on tests.mseg_out to anon, authenticated, service_role;

-- The segment one member landed in, looked up by handle.
create or replace function tests.mseg_seg(p_k text, p_handle text) returns text
language sql stable as $fn$
  select o.doc ->> 'segment' from tests.mseg_out o
  where o.k = p_k and o.doc ->> 'handle' = p_handle;
$fn$;
grant execute on function tests.mseg_seg(text, text) to anon, authenticated, service_role;

-- How many members landed in one segment.
create or replace function tests.mseg_n(p_k text, p_segment text) returns integer
language sql stable as $fn$
  select count(*)::integer from tests.mseg_out o
  where o.k = p_k and o.doc ->> 'segment' = p_segment;
$fn$;
grant execute on function tests.mseg_n(text, text) to anon, authenticated, service_role;

-- The whole run, serialised, for the "does this name a hidden member" sweep.
create or replace function tests.mseg_text(p_k text) returns text
language sql stable as $fn$
  select coalesce(string_agg(o.doc::text, ' '), '') from tests.mseg_out o where o.k = p_k;
$fn$;
grant execute on function tests.mseg_text(text) to anon, authenticated, service_role;

-- The member universe, computed independently of the function under test:
-- COMM-310's denominator, written out here rather than reused, so "every
-- member gets exactly one row" is asserted against a second expression of
-- what a member is and not against the function's own idea of it.
create or replace function tests.mseg_members(p_as_of date) returns integer
language sql stable security definer as $fn$
  select count(*)::integer
  from public.profiles p
  join public.invite_redemptions ir on ir.user_id = p.id
  where ir.redeemed_at < (p_as_of + 1)::timestamptz
    and (p.deleted_at is null or p.deleted_at >= (p_as_of + 1)::timestamptz);
$fn$;
grant execute on function tests.mseg_members(date) to anon, authenticated, service_role;

-- =====================================================================
-- 1. FUNCTION SHAPE, GRANTS, AND THE NO-SECOND-WCAM-COPY RULE
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'member_segments'),
  true,
  'member_segments is SECURITY DEFINER - invite_redemptions is self-select-only, so without definer rights the "club" would be one row (the caller), and coach_engagement_flags excludes the flagged member from every policy');

select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.member_segments(date)', 'execute'),
  'authenticated may execute it - the permission test is inside the body, not in the grant, the same way analytics_dashboard does it');

select ok(
  not pg_catalog.has_function_privilege('anon', 'public.member_segments(date)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.member_segments(date)', 'execute'),
  'but not anon, and not PUBLIC - asserted separately, because a new function starts with execute granted to PUBLIC and forgetting that revoke is how a staff RPC quietly becomes an open one');

-- THE HARD REQUIREMENT COMM-310 BUILT analytics_wcam_events() FOR.
select ok(
  (select p.prosrc from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'member_segments') like '%analytics_wcam_events%',
  'the body CALLS analytics_wcam_events() - 202609010006 wrote that function precisely so COMM-311, COMM-312 and COMM-313 could not each grow their own copy of the qualifying list');

select ok(
  (select p.prosrc not like '%post_created%'
      and p.prosrc not like '%reaction_added%'
      and p.prosrc not like '%attendance_recorded%'
      and p.prosrc not like '%notification_opened%'
      and p.prosrc not like '%challenge_completed%'
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'member_segments'),
  'and contains NO SECOND COPY of the WCAM event-name list - not one of the fifteen names appears anywhere in the body. This is the assertion that catches the real hazard: a segmentation that re-derived "who was active" would disagree with the dashboard for reasons nobody could see');

-- =====================================================================
-- 2. FIXTURES
-- =====================================================================
-- The seven rls_helpers members are backdated so none of them reads as
-- `new`; redeemed_at is left at now() by that file, which would put every
-- one of them inside the 30-day window. 200 days is clear of it and clear of
-- every tenure achievement threshold.
update public.invite_redemptions set redeemed_at = now() - interval '200 days';

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', tests.mseg_uid(nick),
       'authenticated', 'authenticated',
       'mseg_' || nick || '@members.haimuniya.invalid',
       '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()
from unnest(array['new','ha','steady','occ','dorm','decl','declha','newdecl',
                  'hidden','resolved','passive','bound','newedge','oldedge',
                  'deleted','noinv']) nick;

insert into public.profiles (id, handle, display_name, recovery_verified_at, visible_to_club, deleted_at)
select tests.mseg_uid(nick),
       'seg_' || nick,
       'Seg ' || nick,
       now(),
       nick <> 'hidden',                                   -- only `hidden` opts out
       case when nick = 'deleted' then now() end
from unnest(array['new','ha','steady','occ','dorm','decl','declha','newdecl',
                  'hidden','resolved','passive','bound','newedge','oldedge',
                  'deleted','noinv']) nick;

-- Membership. `noinv` gets NO row on purpose: a profile with no
-- invite_redemption is not a club member under COMM-310's denominator, and
-- must not appear in any segment.
insert into public.invite_redemptions (user_id, invite_id, role, redeemed_at)
select tests.mseg_uid(nick), '11111111-2222-4333-8444-555555555555', 'member',
       case nick
         -- inside the first 30 days
         when 'new'     then now() - interval '5 days'
         when 'newdecl' then now() - interval '5 days'
         -- the boundary itself: v_new_cutoff is (current_date + 1) - 30 days
         -- = midnight at the start of current_date - 29. `newedge` sits
         -- exactly on it and is still new; `oldedge` is one second earlier
         -- and is not.
         when 'newedge' then (current_date - 29)::timestamptz
         when 'oldedge' then (current_date - 29)::timestamptz - interval '1 second'
         else now() - interval '200 days'
       end
from unnest(array['new','ha','steady','occ','dorm','decl','declha','newdecl',
                  'hidden','resolved','passive','bound','newedge','oldedge',
                  'deleted']) nick;

-- --- WCAM-qualifying activity, on the ISO-week grid ---------------------
-- Different qualifying event names per member, so a bug that only matched
-- one name would show up as a wrong label somewhere.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.mseg_uid('ha'), 'post_created', '{}'::jsonb, (tests.mseg_wk(w) + 1)::timestamptz
from unnest(array[1, 2, 3, 4]) w;

insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.mseg_uid('steady'), 'reaction_added', '{}'::jsonb, (tests.mseg_wk(w) + 2)::timestamptz
from unnest(array[1, 3, 5, 7]) w;

-- `occ` is three of the last eight (so NOT steady) and three of the last four
-- (so NOT highly active), plus two decoy weeks just outside the 8-week
-- window. If the window bound leaked by one week in either direction this
-- member's label changes.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.mseg_uid('occ'), 'comment_created', '{}'::jsonb, (tests.mseg_wk(w) + 3)::timestamptz
from unnest(array[1, 2, 3, 9, 10]) w;

-- `dorm` has activity, but only twelve weeks back - outside the window today
-- and INSIDE it for the as-of run in section 9.
insert into public.analytics_events (user_id, event_name, props, created_at)
values (tests.mseg_uid('dorm'), 'workout_shared', '{}'::jsonb, (tests.mseg_wk(12) + 1)::timestamptz);

insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.mseg_uid('decl'), 'challenge_joined', '{}'::jsonb, (tests.mseg_wk(w) + 1)::timestamptz
from unnest(array[1, 3]) w;

-- `declha` is the precedence fixture: WCAM-qualifying in EACH of the last
-- four weeks AND carrying an open flag.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.mseg_uid('declha'), 'event_rsvp', '{}'::jsonb, (tests.mseg_wk(w) + 1)::timestamptz
from unnest(array[1, 2, 3, 4]) w;

insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.mseg_uid('hidden'), 'member_followed', '{}'::jsonb, (tests.mseg_wk(w) + 1)::timestamptz
from unnest(array[1, 2, 3, 4]) w;

insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.mseg_uid('resolved'), 'achievement_shared', '{}'::jsonb, (tests.mseg_wk(w) + 1)::timestamptz
from unnest(array[1, 2]) w;

-- `bound` is active in the week IN PROGRESS plus weeks 1, 2 and 3. If the
-- in-progress week were counted this member would read `highly_active` off a
-- week that has not finished; it must read `occasional` off three whole ones.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.mseg_uid('bound'), 'post_opened', '{}'::jsonb, tests.mseg_wk(w)::timestamptz
from unnest(array[0, 1, 2, 3]) w;

-- `passive` does ten non-qualifying things a week for eight weeks and must
-- still be dormant. This is the fixture that makes the WCAM list load-bearing
-- rather than decorative.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.mseg_uid('passive'), ev, '{}'::jsonb, (tests.mseg_wk(w) + 1)::timestamptz
from unnest(array[1, 2, 3, 4, 5, 6, 7, 8]) w,
     unnest(array['club_tab_viewed','feed_viewed','post_impression','leaderboard_viewed',
                  'challenge_viewed','event_viewed','weekly_recap_opened','search_performed',
                  'directory_opened','push_opt_in']) ev;

-- --- coach_engagement_flags --------------------------------------------
-- Three open flags on ordinary members, one DISMISSED flag, and one open
-- flag each on the admin and the owner - the self-flag pair section 8 uses.
insert into public.coach_engagement_flags (user_id, level, status) values
  (tests.mseg_uid('decl'),    'mild',        'open'),
  (tests.mseg_uid('declha'),  'significant', 'open'),
  (tests.mseg_uid('newdecl'), 'inactive',    'open'),
  (tests.mseg_uid('resolved'),'significant', 'dismissed'),
  (tests.uid('admin'),        'mild',        'open'),
  (tests.uid('owner'),        'inactive',    'open');

-- =====================================================================
-- 3. THE PERMISSION BOUNDARY
-- =====================================================================
select throws_ok(
  $$ select * from public.member_segments() $$,
  'P0001', 'not authorized',
  'with no auth.uid() at all the function refuses before it reads a single row - auth.uid() is checked first, per this schema''s standing rule for a definer function');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.member_segments() $$,
  'P0001', 'not authorized',
  'a plain member is refused');

select tests.set_auth(tests.uid('coach'));
select ok(public.is_staff(), 'the coach really is staff, so the next assertion is about the permission and not about a broken fixture');
select ok(not public.has_perm('community.analytics.view'), 'and really does not hold community.analytics.view - 202608280001 seeds it to admin and owner only');
select throws_ok(
  $$ select * from public.member_segments() $$,
  'P0001', 'not authorized',
  'a COACH is refused. This gate is deliberately narrower than is_staff(), exactly as analytics_dashboard()''s is - gate the nav item on the permission, not on staffness, or a coach is shown a screen the database refuses');

-- THE ASSERTION COMM-311's FOURTH CRITERION IS REALLY ABOUT.
select tests.set_auth(tests.mseg_uid('decl'));
select ok(
  not public.has_perm('community.analytics.view') and not public.is_admin(),
  'seg_decl holds neither community.analytics.view nor is_admin - stated first, so the refusal below is about the gate and not about a fixture that happened to be broken');

select throws_ok(
  $$ select * from public.member_segments() $$,
  'P0001', 'not authorized',
  'THE ASSERTION THAT MATTERS: a member who ACTUALLY CARRIES AN OPEN DECLINE FLAG cannot call this function at all. COMM-311''s "segmentation never exposes a declining label to the member it describes" is enforced by there being no member-facing version, not by a hidden UI control - and section 7 proves that same member really is labelled `declining` when staff ask');

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select * from public.member_segments() $$,
  'the owner is allowed - has_perm() short-circuits true for owner on every permission');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select * from public.member_segments() $$,
  'and the admin is allowed, through community.analytics.view');

select throws_ok(
  $$ select * from public.member_segments(current_date + 1) $$,
  'P0001', 'as-of date is in the future',
  'a future as-of date is refused rather than clamped, the same reasoning analytics_dashboard() validates its period with: a clamped date would put a segmentation on screen labelled with a date it was not computed for, and nothing in the output would say so');

select lives_ok(
  $$ select * from public.member_segments(null) $$,
  'a null p_as_of means the same thing as omitting it, because the parameter has a sensible default in its own signature - unlike analytics_dashboard()''s two bounds, which are both required');

-- =====================================================================
-- 4. THREE RUNS, PARKED
-- =====================================================================
-- Still the admin. Every assertion from here on reads tests.mseg_out.
insert into tests.mseg_out (k, doc) select 'admin', d from public.member_segments() d;
insert into tests.mseg_out (k, doc) select 'past',  d from public.member_segments(tests.mseg_wk(10)) d;

select tests.set_auth(tests.uid('owner'));
insert into tests.mseg_out (k, doc) select 'owner', d from public.member_segments() d;

select tests.clear_auth();

-- =====================================================================
-- 5. THE ROW SHAPE
-- =====================================================================
select is(
  (select string_agg(t.kk, ',' order by t.kk collate "C") from (
     select distinct kk from tests.mseg_out o, jsonb_object_keys(o.doc) kk
     where o.k = 'admin') t),
  'display_name,handle,segment,user_id',
  'every row carries exactly the four keys COMM-311''s contract names - user_id, display_name, handle, segment - and nothing else. No level, no rates, no flagged_at: the DETAIL behind a declining label stays in coach_engagement_flags where its own policies govern it');

select is(
  (select count(*)::text from tests.mseg_out o
   where o.k = 'admin'
     and o.doc ->> 'segment' not in ('new','declining','highly_active','steady','occasional','dormant')),
  '0',
  'and every segment value is one of the six names, so a typo in the CASE cannot invent a seventh bucket that the client would render as a blank card');

-- =====================================================================
-- 6. ONE FIXTURE PER BUCKET
-- =====================================================================
select is(tests.mseg_seg('admin', 'seg_new'), 'new',
  'a member who joined five days ago is `new` - and note they have NO activity at all, so by the letter of the definition they are also `dormant`. See section 7');

select is(tests.mseg_seg('admin', 'seg_ha'), 'highly_active',
  'WCAM-qualifying in EACH of the last four complete weeks is `highly_active`. All four, not three of four - seg_occ below has three and must not reach it');

select is(tests.mseg_seg('admin', 'seg_steady'), 'steady',
  'active in weeks 1, 3, 5 and 7 is `steady`: four of the last eight, which is "at least half". Only two of those four are inside the recent window, so a broken highly_active test would show up here as the wrong label');

select is(tests.mseg_seg('admin', 'seg_occ'), 'occasional',
  'THE SIXTH BUCKET. Three of the last eight weeks is not `steady` (the bar is four), is not `highly_active` (the bar is all four of the last four), and is emphatically not `dormant` - this member was in the app three weeks out of eight. COMM-311''s five buckets do not cover them, and the first acceptance criterion says every member must land somewhere, so 202609010007 names the residual instead of stretching `dormant` over it');

select is(tests.mseg_seg('admin', 'seg_dorm'), 'dormant',
  'no qualifying activity in the last eight weeks is `dormant`. This member DOES have activity - twelve weeks back - so the label is a statement about the window and not about an empty event table. Section 9 asks the same question as of ten weeks ago and gets a different answer');

select is(tests.mseg_seg('admin', 'seg_decl'), 'declining',
  'an open coach_engagement_flags row is `declining`');

select is(tests.mseg_seg('admin', 'seg_passive'), 'dormant',
  'THE WCAM LIST IS LOAD-BEARING: this member fired ten different NON-qualifying events (club_tab_viewed, feed_viewed, post_impression, leaderboard_viewed, challenge_viewed, event_viewed, weekly_recap_opened, search_performed, directory_opened, push_opt_in) in every one of the last eight weeks - eighty rows - and is dormant. Passive viewing is not activity, which is metrics.md''s rule and analytics_wcam_events()''s job to hold');

select is(tests.mseg_seg('admin', 'seg_bound'), 'occasional',
  'THE IN-PROGRESS WEEK IS NEVER COUNTED: this member is active in the current week plus weeks 1, 2 and 3. Counting the week in progress would make that four-in-four and read `highly_active` off a week that has not finished - which on a Monday morning would also mean nobody in the club could reach that bucket at all');

select is(tests.mseg_seg('admin', 'seg_newedge'), 'new',
  'the 30-day boundary itself: a member who redeemed exactly at midnight of (as_of - 29) is still new. "Inside their first 30 days" means the join day is day 1 and day 30 is the last new day');

select is(tests.mseg_seg('admin', 'seg_oldedge'), 'dormant',
  'and one second earlier is not new. Asserted as its own member rather than as an arithmetic comment, because an off-by-one in v_new_cutoff would otherwise pass every other assertion in this file');

-- =====================================================================
-- 7. THE PRECEDENCE LOGIC
-- =====================================================================
-- The three members below each match more than one bucket. COMM-311 lists
-- its buckets in the order new, highly_active, steady, declining, dormant and
-- says nothing about precedence; 202609010007 resolves it as
-- new > declining > highly_active > steady > occasional > dormant and these
-- are the assertions that pin that decision.

select is(tests.mseg_seg('admin', 'seg_new'), 'new',
  'PRECEDENCE 1, new over dormant: seg_new joined five days ago and has done nothing, so they satisfy `dormant`''s definition word for word ("no qualifying activity in the last 8 weeks"). `new` wins. Calling a five-day-old member dormant is the worst false positive this function could produce - the same error coach_detect_engagement_decline() refuses to make with its no-baseline-no-flag rule');

select is(tests.mseg_seg('admin', 'seg_newdecl'), 'new',
  'PRECEDENCE 2, new over declining: seg_newdecl joined five days ago AND carries an open flag. `new` wins - a member in their first month has no baseline to have declined from, and the action a club takes on them is onboarding either way');

select is(tests.mseg_seg('admin', 'seg_declha'), 'declining',
  'PRECEDENCE 3, THE ONE THAT DEPARTS FROM THE ORDER THE TICKET LISTS ITS BUCKETS IN: seg_declha is WCAM-qualifying in EACH of the last four weeks and carries an open flag, and reads `declining`, not `highly_active`. The two signals measure different things - the flag is verified attendance decline out of attendance_log, WCAM is app engagement and can be earned by opening four notifications - so a member who stopped training but still opens the app is exactly who this segmentation exists to surface, and must not be hidden behind `highly_active`. The exit is the dismiss button COMM-304 already shipped the write path for, which is what stops this precedence trapping anyone');

select is(tests.mseg_seg('admin', 'seg_resolved'), 'occasional',
  'AND THE NEGATIVE CASE: a DISMISSED flag is not `declining`. Only `status = ''open''` counts - a reviewed or dismissed flag is a conversation that already happened, and if it still segmented the member then dismissing would be a button that does nothing, which is the failure COMM-304''s own cooldown reasoning warns about. This member falls through to their activity: two of eight weeks, so `occasional`');

-- =====================================================================
-- 8. EXACTLY ONE SEGMENT PER MEMBER, AND THE SELF-FLAG RULE
-- =====================================================================
select is(
  (select count(*)::integer from tests.mseg_out where k = 'admin'),
  tests.mseg_members(current_date),
  'THE FIRST ACCEPTANCE CRITERION, as a cardinality: the run returns exactly as many rows as there are club members, counted independently here from profiles JOIN invite_redemptions with the same as-of bounds. No member missing, no member twice');

select is(
  (select count(*)::text from tests.mseg_out where k = 'admin'),
  '21',
  'and that number is 21, written out as a literal too - so a fixture that silently stopped inserting members would fail here rather than agreeing with a helper that had gone wrong in the same direction');

select is(
  (select count(*)::text from (
     select o.doc ->> 'user_id' u from tests.mseg_out o
     where o.k = 'admin' and o.doc ->> 'user_id' is not null
     group by 1 having count(*) > 1) t),
  '0',
  'no user_id appears in two rows - "exactly one segment" asked from the other side');

select is(
  (select (tests.mseg_n('admin','new') + tests.mseg_n('admin','declining')
         + tests.mseg_n('admin','highly_active') + tests.mseg_n('admin','steady')
         + tests.mseg_n('admin','occasional') + tests.mseg_n('admin','dormant'))::text),
  '21',
  'and the six segment counts sum back to the club, which is what makes the dashboard cards'' shares add to 100%');

select is(tests.mseg_n('admin', 'new'),           3, 'three new members: seg_new, seg_newdecl and seg_newedge');
select is(tests.mseg_n('admin', 'highly_active'), 2, 'two highly active: seg_ha and the HIDDEN member, who is counted even though they are not named - see section 9');
select is(tests.mseg_n('admin', 'steady'),        1, 'one steady');
select is(tests.mseg_n('admin', 'occasional'),    3, 'three occasional: seg_occ, seg_resolved and seg_bound');

select is(tests.mseg_n('admin', 'declining'), 3,
  'three declining as the ADMIN sees it: seg_decl, seg_declha and THE OWNER - but not the admin themselves, who also carries an open flag');

select is(tests.mseg_seg('admin', 'admin_x'), 'dormant',
  'THE SELF-FLAG RULE: the admin carries an open flag and reads THEMSELVES as `dormant`, off their own (absent) activity. coach_engagement_flags carries `user_id <> auth.uid()` on all four of its policies and 202608280011 is explicit that this covers a member who is themselves an admin or the owner; this function is definer and reads past those policies, so the rule is re-applied by hand');

select is(tests.mseg_seg('admin', 'owner_x'), 'declining',
  'and the admin DOES see the owner''s flag, which is what proves the assertion above is the self-exclusion working rather than the flag lookup being broken');

select is(tests.mseg_seg('owner', 'owner_x'), 'dormant',
  'the mirror image from the owner''s own session: the owner reads themselves as dormant');

select is(tests.mseg_seg('owner', 'admin_x'), 'declining',
  'and reads the admin as declining. The same member has a different label in two staff sessions, which is the one viewer-relative thing in an otherwise viewer-independent answer, and it is the table''s own guarantee held one level up rather than an inconsistency to be ironed out');

select is(
  (select count(*)::integer from tests.mseg_out where k = 'owner'),
  21,
  'THE ROW IS NOT DROPPED, only its label changes: the owner''s run returns the same 21 members as the admin''s, so the self-flag rule never makes the club count differ by one between two staff members');

select is(tests.mseg_n('owner', 'declining'), 3,
  'and the owner also counts three declining - seg_decl, seg_declha and the ADMIN. The set differs by one member in each direction; the total does not');

-- =====================================================================
-- 9. visible_to_club ON THE DRILL-DOWN
-- =====================================================================
select is(
  (select count(*)::text from tests.mseg_out o
   where o.k = 'admin' and o.doc ->> 'handle' is null),
  '1',
  'exactly one row in the whole run carries no handle - the member who set visible_to_club = false');

select is(
  (select o.doc ->> 'segment' from tests.mseg_out o
   where o.k = 'admin' and o.doc ->> 'handle' is null),
  'highly_active',
  'and it still carries its SEGMENT. That is the half of the criterion that is easy to lose: the hidden member is inside the highly_active COUNT, so the dashboard card is a share of the whole club and a member who hid themselves is not quietly deducted from the denominator');

select ok(
  (select o.doc ->> 'user_id' is null and o.doc ->> 'display_name' is null
   from tests.mseg_out o where o.k = 'admin' and o.doc ->> 'handle' is null),
  'user_id and display_name are null on that row too. All three identifying fields are nulled TOGETHER - a row carrying a bare uuid but no name would still be attributable on a staff screen that can join it against anything else');

select ok(
  (select o.doc ? 'user_id' and o.doc ? 'display_name' and o.doc ? 'handle'
   from tests.mseg_out o where o.k = 'admin' and o.doc ->> 'handle' is null),
  'the three keys are PRESENT and null rather than absent, so the client renders one row shape and never has to branch on a missing key');

select ok(
  position(tests.mseg_uid('hidden')::text in tests.mseg_text('admin')) = 0
  and position('seg_hidden' in tests.mseg_text('admin')) = 0
  and position('Seg hidden' in tests.mseg_text('admin')) = 0,
  'and the ENTIRE serialised run mentions the hidden member''s id, handle and display name nowhere at all - the same shape of sweep 0050 makes over the analytics dashboard, applied to the one surface in this cluster where naming members IS the point');

select ok(
  position(tests.mseg_uid('ha')::text in tests.mseg_text('admin')) > 0
  and position('seg_ha' in tests.mseg_text('admin')) > 0,
  'while a member who did NOT opt out is named in full, id and handle both - which is what makes the assertion above a privacy result rather than a function that names nobody');

-- =====================================================================
-- 10. p_as_of REALLY MOVES THE WINDOW
-- =====================================================================
select is(
  (select count(*)::integer from tests.mseg_out where k = 'past'),
  tests.mseg_members(tests.mseg_wk(10)),
  'the ten-weeks-ago run returns the club AS IT WAS THEN, again counted independently: membership is an invite_redemptions row redeemed before the end of p_as_of on a profile not soft-deleted before it, which is COMM-310''s denominator term for term');

select is(
  (select count(*)::text from tests.mseg_out where k = 'past'),
  '18',
  'which is 18, not 21: four members had not joined ten weeks ago (seg_new, seg_newdecl, seg_newedge, seg_oldedge) and one member who is soft-deleted TODAY was still a member THEN, so the historical club is larger in that one direction and smaller in the other');

select is(tests.mseg_seg('past', 'seg_new'), null::text,
  'a member who joined five days ago is absent from a run dated ten weeks back - not `new` with a zero, absent, because they were not in the club');

select ok(tests.mseg_seg('past', 'seg_deleted') is not null,
  'and the soft-deleted member IS present in that run, because their deleted_at is after the as-of date. Both bounds are as-of, not as-of-now');

select is(tests.mseg_seg('admin', 'seg_deleted'), null::text,
  'while today''s run excludes them');

select is(tests.mseg_seg('admin', 'seg_noinv'), null::text,
  'and a profile with NO invite_redemptions row is absent from every run - the invite gate is what makes someone a club member, so a half-created account is not an undifferentiated `dormant` entry on a staff screen');

select is(tests.mseg_seg('past', 'seg_dorm'), 'occasional',
  'THE WINDOW REALLY MOVED: seg_dorm''s only activity is twelve weeks back. Today that is outside the eight-week window and they read `dormant`; as of ten weeks ago it is INSIDE it and they read `occasional`. Same member, same single event, two different segments, because p_as_of moves the grid and nothing else does');

select is(tests.mseg_seg('past', 'seg_declha'), 'dormant',
  'and seg_declha reads `dormant` in the historical run rather than `declining`: their flag was raised today, and a flag is only counted when it was raised on or before p_as_of. Its OPEN-ness is still a fact about now - there is no status history on that table to reconstruct - the same asymmetry analytics_dashboard() records for moderation_load.queue.open_now');

select * from finish();
rollback;
