-- COMM-310, schema half: behavioural coverage for 202609010006
-- (analytics_wcam_events, analytics_week_buckets, analytics_ratio,
-- analytics_event_uuid, analytics_breakdown, analytics_dashboard).
--
-- Six boundaries, each proved by a SCENARIO against real seeded events
-- rather than by a structural check, the style 0039 to 0049 established:
--
--   1. THE PERMISSION BOUNDARY, and specifically that it is NARROWER than
--      is_staff(). The coach is the assertion that matters: a coach can read
--      a monthly recap draft (0046) and can call coach_celebrate_feed, and is
--      REFUSED here, because community.analytics.view is seeded to admin and
--      owner only. A plain member is refused, and so is a session with no
--      auth.uid() at all. Admin and owner are allowed.
--   2. THE WCAM DEFINITION CANNOT DRIFT. analytics_wcam_events() is compared
--      against the 15-name list docs/community/metrics.md publishes as its
--      own worked query, name for name, in order. Then the dashboard's WCAM
--      figure is compared against that literal metrics.md query, run by hand
--      over the same fixtures - so the number this dashboard shows and the
--      number the doc defines are asserted equal rather than assumed equal.
--      The fixtures make that a real test: m3 performs TEN different
--      non-qualifying events and must not be counted.
--   3. A CROSS-SECTION OF THE METRICS, each against decoys built so that a
--      filter which stopped working changes the NUMBER. Every Core metric is
--      covered; seven of the thirteen Additional ones are, chosen for the
--      distinct MECHANISMS they exercise rather than for coverage count:
--      a prop breakdown, a full-join against a community table, a member-day
--      session approximation, a jsonb-boolean prop, a malformed prop, a
--      table cross-check that deliberately disagrees with the event count,
--      and a client-written integer prop.
--   4. THE PERIOD BOUNDS. Null, reversed, exactly 366 days (allowed) and 367
--      days (refused). Validated, never clamped.
--   5. AGGREGATE ONLY, ASSERTED OVER THE WHOLE RESPONSE. The full jsonb text
--      is searched for every fixture member's id, handle and display name,
--      and separately for ANY uuid at all in any position - the same shape of
--      assertion 0046 makes about a monthly recap, applied to a jsonb blob
--      that has no column list to enforce it.
--   6. THE EMPTY PERIOD, and the cardinality cap on a client-written group
--      key. A quiet week renders zeros and nulls, not an error; 30 distinct
--      tab values from a browser cannot make the admin response unbounded.
--
-- FIXTURE MECHANIC WORTH READING FIRST
-- Everything is an offset from tests.adash_week(), the Monday two weeks
-- back, so the file means the same thing whatever day it runs on and the
-- week under test is always fully in the past AND is exactly one whole ISO
-- week (partial = false). Two more weeks are used: ten weeks back for the
-- breakdown cardinality cap, twenty weeks back for the empty period.
--
-- The dashboard is called THREE times, from a real admin session, and each
-- response is parked in tests.adash_out. Every assertion below reads that
-- table, so the hundred-odd assertions cost three function calls rather than a hundred.
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

-- The week under test: the Monday two weeks back. A whole ISO week, in the
-- past, on any day this file runs.
create or replace function tests.adash_week() returns date
language sql stable as $fn$
  select (date_trunc('week', current_date::timestamp) - interval '2 weeks')::date;
$fn$;
grant execute on function tests.adash_week() to anon, authenticated, service_role;

-- Ten weeks back: the isolated week the breakdown cardinality cap is proved
-- in, so its thirty junk tab values cannot touch the sub-tab assertion.
create or replace function tests.adash_cap_week() returns date
language sql stable as $fn$
  select (date_trunc('week', current_date::timestamp) - interval '10 weeks')::date;
$fn$;
grant execute on function tests.adash_cap_week() to anon, authenticated, service_role;

-- Twenty weeks back: nothing at all happened here.
create or replace function tests.adash_quiet_week() returns date
language sql stable as $fn$
  select (date_trunc('week', current_date::timestamp) - interval '20 weeks')::date;
$fn$;
grant execute on function tests.adash_quiet_week() to anon, authenticated, service_role;

-- One parked response per period. Written from inside the admin session, so
-- authenticated needs insert; read back as the superuser afterwards.
create table tests.adash_out (k text primary key, doc jsonb);
grant select, insert on tests.adash_out to anon, authenticated, service_role;

create or replace function tests.adash_doc(p_key text) returns jsonb
language sql stable as $fn$
  select o.doc from tests.adash_out o where o.k = p_key;
$fn$;
grant execute on function tests.adash_doc(text) to anon, authenticated, service_role;

-- One value out of a parked response, as its JSON text. Returns SQL NULL for
-- a path that does not exist and the four characters 'null' for a JSON null,
-- so "the key is missing" and "the ratio is undefined" are distinguishable.
create or replace function tests.adash_v(p_key text, variadic p_path text[]) returns text
language sql stable as $fn$
  select (o.doc #> p_path)::text from tests.adash_out o where o.k = p_key;
$fn$;
grant execute on function tests.adash_v(text, text[]) to anon, authenticated, service_role;

-- Does this haystack mention ANY fixture member - their id, their handle or
-- their display name? The aggregate-only rule asked as one question over
-- every profile in the database rather than over a list the test author
-- remembered to write down. Same helper shape as 0046's.
create or replace function tests.adash_mentions_a_member(p_haystack text) returns boolean
language sql stable security definer as $fn$
  select coalesce(bool_or(
           position(p.id::text  in p_haystack) > 0 or
           position(p.handle    in p_haystack) > 0 or
           (btrim(p.display_name) <> '' and position(p.display_name in p_haystack) > 0)
         ), false)
  from public.profiles p;
$fn$;
grant execute on function tests.adash_mentions_a_member(text) to anon, authenticated, service_role;

-- The five fixture post ids, so an assertion can name a post without a bare
-- uuid literal three times over.
create or replace function tests.adash_post(p_nick text) returns uuid
language sql immutable as $fn$
  select case p_nick
    when 'a' then 'b0000000-0000-4000-8000-00000000000a'  -- m1, POST_TEXT, club, in window
    when 'b' then 'b0000000-0000-4000-8000-00000000000b'  -- m2, POST_WORKOUT, club, in window
    when 'c' then 'b0000000-0000-4000-8000-00000000000c'  -- m3, POST_TEXT, ONLY_ME, in window
    when 'd' then 'b0000000-0000-4000-8000-00000000000d'  -- m1, POST_TEXT, club, BEFORE window
    when 'e' then 'b0000000-0000-4000-8000-00000000000e'  -- m3, POST_PR, club, in window
  end::uuid
$fn$;
grant execute on function tests.adash_post(text) to anon, authenticated, service_role;

-- =====================================================================
-- 1. FUNCTION SHAPE AND GRANTS
-- =====================================================================
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'analytics_dashboard'),
  true,
  'analytics_dashboard is SECURITY DEFINER - notifications, push_subscriptions, reports, attendance_log, follows, post_comments, reactions and workout_posts are all own-row or viewer-relative, so counting any of them club-wide from an admin''s own session would return that admin''s slice and label it the club''s number');

select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.analytics_dashboard(date, date)', 'execute'),
  'authenticated may execute it - the permission test is inside the body, not in the grant, the same way recap_monthly_publish does it');

select ok(
  not pg_catalog.has_function_privilege('anon', 'public.analytics_dashboard(date, date)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.analytics_dashboard(date, date)', 'execute'),
  'but not anon, and not PUBLIC - PUBLIC asserted separately, because a new function starts with execute granted to PUBLIC and forgetting that revoke is how a staff RPC quietly becomes an open one');

-- The four internal helpers are reachable by NO client role. analytics_
-- breakdown is the one that matters: it is a definer reader of
-- analytics_events that takes the event name as a parameter, so a
-- client-callable version would be an unpermissioned reader of the whole
-- analytics stream regardless of what policy that table carries.
select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.analytics_breakdown(text, text, timestamptz, timestamptz)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.analytics_breakdown(text, text, timestamptz, timestamptz)', 'execute')
  and not pg_catalog.has_function_privilege('public', 'public.analytics_breakdown(text, text, timestamptz, timestamptz)', 'execute'),
  'analytics_breakdown() is granted to NO role at all, PUBLIC included: it reads analytics_events past RLS and takes the event name as a parameter, so the grant is the gate and auth is checked one level up');

select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.analytics_week_buckets(date, date)', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'public.analytics_ratio(numeric, numeric)', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'public.analytics_event_uuid(jsonb, text)', 'execute'),
  'and neither are the three pure helpers, for uniformity - none of them is part of any client contract');

select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.analytics_wcam_events()', 'execute'),
  'analytics_wcam_events() IS granted to authenticated, the one deliberate exception: it is a list of event names that already ships to every browser inside src/analytics.js, so withholding it server-side would protect nothing');

select is(
  (select p.provolatile from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'analytics_wcam_events'),
  'i'::"char",
  'and it is IMMUTABLE, which is not decoration: `event_name = any(analytics_wcam_events())` only keeps using analytics_events_name_idx because the planner can fold it to a constant');

-- =====================================================================
-- 2. THE WCAM DEFINITION, PINNED AGAINST metrics.md
-- =====================================================================
-- There is no other server-side WCAM computation in this schema for this to
-- agree with - this migration wrote the first one. So the thing it is pinned
-- against is the definition itself: the IN list in the "Computed from the
-- stored events" block of docs/community/metrics.md, which is also
-- ACTIVE_MEMBER_EVENTS in src/analytics.js. Written out here as a literal on
-- purpose. Copying the array from the function would assert nothing.
select is(
  public.analytics_wcam_events(),
  array['post_created','workout_shared','achievement_shared','comment_created',
        'reaction_added','challenge_joined','challenge_completed','event_rsvp',
        'post_opened','profile_opened','member_followed','notification_opened',
        'weekly_recap_shared','coach_congratulate_sent','attendance_recorded']::text[],
  'analytics_wcam_events() is byte-for-byte the 15-name list docs/community/metrics.md publishes, in order, and byte-for-byte ACTIVE_MEMBER_EVENTS in src/analytics.js. A name added to one and not the others fails here');

select is(
  array_length(public.analytics_wcam_events(), 1),
  15,
  'fifteen names, stated as its own assertion so an accidental duplicate or a dropped line is caught by the count as well as by the list');

select ok(
  not (public.analytics_wcam_events() && array[
    'club_tab_viewed','feed_viewed','post_impression','leaderboard_viewed',
    'challenge_viewed','event_viewed','weekly_recap_opened','search_performed',
    'directory_opened','classmates_card_viewed','report_submitted','push_opt_in']),
  'and NONE of the twelve deliberately non-qualifying names is in it - the ten passive views metrics.md rules out ("viewing is not the bar"), report_submitted, and push_opt_in ("changing a notification setting is account configuration"). Restated as its own assertion so a future name that defaults IN is caught by intent and not only by the exact-list comparison above');

-- =====================================================================
-- 3. FIXTURES
-- =====================================================================
-- Membership is backdated so the WCAM-share DENOMINATOR is a real number.
-- invite_redemptions.redeemed_at is this module's authoritative
-- MEMBER_JOINED stamp (202608290011) and rls_helpers leaves it at now(),
-- which would put every fixture member outside a window two weeks back and
-- make club_members zero. Thirty days before the week under test puts all
-- seven inside it, and is far enough from any tenure threshold that no
-- anniversary lands in the celebrate-items count either.
update public.invite_redemptions set redeemed_at = (tests.adash_week() - 30)::timestamptz;

-- --- posts -------------------------------------------------------------
-- A and B are the two ordinary in-window posts. C is only_me and must be
-- excluded from every post count. D is one day before the window and is the
-- decoy for "an impression inside the window on a post from outside it". E
-- is the PR post the celebrate-items denominator is built from.
insert into public.workout_posts
  (id, author_id, post_type, visibility, title, body, status, created_at, deleted_at)
values
  (tests.adash_post('a'), tests.uid('m1'), 'POST_TEXT',    'club',    'A', 'x', 'active', (tests.adash_week() + 1)::timestamptz, null),
  (tests.adash_post('b'), tests.uid('m2'), 'POST_WORKOUT', 'club',    'B', 'x', 'active', (tests.adash_week() + 2)::timestamptz, null),
  (tests.adash_post('c'), tests.uid('m3'), 'POST_TEXT',    'only_me', 'C', 'x', 'active', (tests.adash_week() + 3)::timestamptz, null),
  (tests.adash_post('d'), tests.uid('m1'), 'POST_TEXT',    'club',    'D', 'x', 'active', (tests.adash_week() - 1)::timestamptz, null),
  (tests.adash_post('e'), tests.uid('m3'), 'POST_PR',      'club',    'E', 'x', 'active', (tests.adash_week() + 2)::timestamptz, null);

-- --- reactions and comments: the TABLE side of engagement ---------------
-- One reaction and one comment on A. A second reaction on C, which is
-- only_me: the cross-check must not count engagement on a post nobody but
-- its author can see.
insert into public.reactions (post_id, user_id, kind, created_at) values
  (tests.adash_post('a'), tests.uid('m2'), 'cheer', (tests.adash_week() + 2)::timestamptz),
  (tests.adash_post('c'), tests.uid('m1'), 'cheer', (tests.adash_week() + 2)::timestamptz);

insert into public.post_comments (post_id, author_id, body, created_at) values
  (tests.adash_post('a'), tests.uid('m2'), 'nice', (tests.adash_week() + 3)::timestamptz);

-- --- notifications: the DELIVERED side of notification effectiveness ----
-- Three comment_reply and one weekly_recap inside the week, one
-- comment_reply the day before it as the window decoy.
insert into public.notifications (user_id, type, category, title, body, created_at) values
  (tests.uid('m1'), 'comment_reply', 'community', 't', 'b', (tests.adash_week() + 1)::timestamptz),
  (tests.uid('m1'), 'comment_reply', 'community', 't', 'b', (tests.adash_week() + 1)::timestamptz),
  (tests.uid('m2'), 'comment_reply', 'community', 't', 'b', (tests.adash_week() + 1)::timestamptz),
  (tests.uid('m3'), 'weekly_recap',  'community', 't', 'b', (tests.adash_week() + 1)::timestamptz),
  (tests.uid('m1'), 'comment_reply', 'community', 't', 'b', (tests.adash_week() - 1)::timestamptz);

-- --- reports: the QUEUE side of moderation load ------------------------
-- Two inside the window (one post, one comment), one before it. All three
-- still open, which is what makes open_now (a fact about NOW, deliberately
-- not period-bounded) differ from rows_created_in_period.
insert into public.reports
  (reporter_id, post_id, target_type, target_id, reason, status, created_at)
values
  (tests.uid('m1'), tests.adash_post('a'), 'post',    tests.adash_post('a'), 'spam',       'open', (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m2'), null,                  'comment', tests.adash_post('b'), 'harassment', 'open', (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m3'), tests.adash_post('b'), 'post',    tests.adash_post('b'), 'spam',       'open', (tests.adash_week() - 1)::timestamptz);

-- --- follows: the cross-check side of social graph growth --------------
insert into public.follows (follower_id, followed_id, created_at) values
  (tests.uid('m1'), tests.uid('m2'), (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m2'), tests.uid('m1'), (tests.adash_week() + 3)::timestamptz);

-- --- push_subscriptions ------------------------------------------------
-- One created inside the window and live, one created long before it and
-- since revoked. created_in_period, active_now and revoked_now are three
-- different numbers, which is the point.
insert into public.push_subscriptions (user_id, endpoint, created_at, revoked_at) values
  (tests.uid('m1'), 'https://push.invalid/live',    (tests.adash_week() + 2)::timestamptz, null),
  (tests.uid('m2'), 'https://push.invalid/revoked', (tests.adash_week() - 10)::timestamptz, now());

-- --- attendance_log: the cross-check side of trained-with-you ----------
insert into public.attendance_log (user_id, occurred_on) values
  (tests.uid('m1'), tests.adash_week() + 1),
  (tests.uid('m2'), tests.adash_week() + 2),
  (tests.uid('m1'), tests.adash_week() + 3),
  (tests.uid('m3'), tests.adash_week() - 1)
on conflict (user_id, occurred_on) do nothing;

-- --- the event stream ---------------------------------------------------
-- m1, m2 and the coach do WCAM-qualifying things. m3 does TEN different
-- non-qualifying things and must never be counted as active. One row has a
-- null user_id (a pre-profile event, which analytics_events allows) and two
-- sit one day outside each end of the window - the later one lands exactly
-- on the exclusive upper bound, so it also proves the bound is exclusive.
insert into public.analytics_events (user_id, event_name, props, created_at) values
  -- qualifying: m1
  (tests.uid('m1'), 'post_created',        jsonb_build_object('post_id', tests.adash_post('a'), 'post_type', 'POST_TEXT', 'visibility', 'club', 'has_media', false), (tests.adash_week() + 1)::timestamptz),
  (tests.uid('m1'), 'comment_created',     jsonb_build_object('post_id', tests.adash_post('a'), 'mention_count', 0),                                                 (tests.adash_week() + 4)::timestamptz),
  (tests.uid('m1'), 'workout_shared',      '{"source_type":"wod_entry","visibility":"followers","has_photo":true}',                                                  (tests.adash_week() + 5)::timestamptz),
  (tests.uid('m1'), 'post_opened',         jsonb_build_object('post_id', tests.adash_post('a'), 'post_type', 'POST_TEXT', 'source', 'feed'),                         (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m1'), 'member_followed',     jsonb_build_object('user_id', tests.uid('m2')),                                                                           (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m1'), 'profile_opened',      jsonb_build_object('user_id', tests.uid('m2'), 'self', false),                                                            (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m1'), 'profile_opened',      jsonb_build_object('user_id', tests.uid('m1'), 'self', true),                                                             (tests.adash_week() + 4)::timestamptz),
  (tests.uid('m1'), 'notification_opened', '{"type":"comment_reply","was_unread":true}',                                                                             (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m1'), 'notification_opened', '{"type":"comment_reply","was_unread":false}',                                                                            (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m1'), 'weekly_recap_shared', '{"figure":"streak"}',                                                                                                    (tests.adash_week() + 4)::timestamptz),
  (tests.uid('m1'), 'challenge_joined',    '{"challenge_type":"individual_target"}',                                                                                 (tests.adash_week() + 4)::timestamptz),
  (tests.uid('m1'), 'attendance_recorded', '{}',                                                                                                                     (tests.adash_week() + 1)::timestamptz),
  (tests.uid('m1'), 'attendance_recorded', '{}',                                                                                                                     (tests.adash_week() + 3)::timestamptz),
  -- qualifying: m2
  (tests.uid('m2'), 'post_created',        jsonb_build_object('post_id', tests.adash_post('b'), 'post_type', 'POST_WORKOUT', 'visibility', 'club'),                   (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m2'), 'reaction_added',      jsonb_build_object('post_id', tests.adash_post('a'), 'reaction_type', 'cheer'),                                            (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m2'), 'workout_shared',      '{"source_type":"strength_entry","visibility":"club","has_photo":false}',                                                  (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m2'), 'achievement_shared',  '{"code":"first_post","source":"unlock_sheet"}',                                                                           (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m2'), 'member_followed',     jsonb_build_object('user_id', tests.uid('m1')),                                                                            (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m2'), 'profile_opened',      jsonb_build_object('user_id', tests.uid('m1'), 'self', false),                                                             (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m2'), 'notification_opened', '{"type":"comment_reply","was_unread":true}',                                                                              (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m2'), 'notification_opened', '{"type":"weekly_recap","was_unread":true}',                                                                               (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m2'), 'attendance_recorded', '{}',                                                                                                                      (tests.adash_week() + 2)::timestamptz),
  -- qualifying: the coach, and only through coach_congratulate_sent, which
  -- metrics.md says counts FOR THE COACH
  (tests.uid('coach'), 'coach_congratulate_sent', '{"kind":"pr","via":"comment"}',                                                                                     (tests.adash_week() + 2)::timestamptz),
  -- NON-qualifying: m3 does ten different things and stays inactive
  (tests.uid('m3'), 'club_tab_viewed',        '{"tab":"feed"}',                                                                                                       (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m3'), 'club_tab_viewed',        '{"tab":"boards"}',                                                                                                     (tests.adash_week() + 4)::timestamptz),
  (tests.uid('m3'), 'feed_viewed',            '{"scope":"all","source":"club_tab"}',                                                                                   (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m3'), 'feed_viewed',            '{"scope":"following","source":"scope_change"}',                                                                         (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m3'), 'weekly_recap_opened',    '{"source":"notification"}',                                                                                             (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m3'), 'search_performed',       '{"source":"community_search","query_length":4,"member_count":3}',                                                        (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m3'), 'search_performed',       '{"source":"directory","query_length":6,"member_count":0}',                                                               (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m3'), 'directory_opened',       '{"source":"club_tab"}',                                                                                                 (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m3'), 'report_submitted',       '{"target_type":"post","reason":"spam"}',                                                                                (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m3'), 'report_submitted',       '{"target_type":"post","reason":"spam"}',                                                                                (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m3'), 'report_submitted',       '{"target_type":"comment","reason":"harassment"}',                                                                        (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m3'), 'challenge_viewed',       '{"source":"boards"}',                                                                                                   (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m3'), 'challenge_viewed',       '{"source":"post_card"}',                                                                                                (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m3'), 'leaderboard_viewed',     '{"board":"weekly_challenge","rows":5}',                                                                                 (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m3'), 'classmates_card_viewed', '{"rows":"bogus","source":"feed"}',                                                                                      (tests.adash_week() + 4)::timestamptz),
  -- NON-qualifying: m1 and m2, so the passive counts are not all one member
  (tests.uid('m1'), 'club_tab_viewed',        '{"tab":"feed"}',                                                                                                       (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m1'), 'feed_viewed',            '{"scope":"all","source":"club_tab"}',                                                                                   (tests.adash_week() + 5)::timestamptz),
  (tests.uid('m1'), 'weekly_recap_opened',    '{"source":"account"}',                                                                                                  (tests.adash_week() + 3)::timestamptz),
  (tests.uid('m1'), 'search_performed',       '{"source":"community_search","query_length":3,"member_count":0}',                                                        (tests.adash_week() + 4)::timestamptz),
  (tests.uid('m1'), 'push_opt_in',            '{"source":"notif_pref","pref_type":"comment"}',                                                                          (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m1'), 'classmates_card_viewed', '{"rows":3,"source":"feed"}',                                                                                            (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m2'), 'classmates_card_viewed', '{"rows":2,"source":"feed"}',                                                                                            (tests.adash_week() + 3)::timestamptz),
  -- impressions: two on A, one on B, one on the OUT-OF-WINDOW post D, and
  -- one whose post_id is not a uuid at all
  (tests.uid('m1'), 'post_impression', jsonb_build_object('post_id', tests.adash_post('a'), 'position', 0), (tests.adash_week() + 1)::timestamptz),
  (tests.uid('m2'), 'post_impression', jsonb_build_object('post_id', tests.adash_post('a'), 'position', 1), (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m2'), 'post_impression', jsonb_build_object('post_id', tests.adash_post('b'), 'position', 0), (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m3'), 'post_impression', jsonb_build_object('post_id', tests.adash_post('d'), 'position', 0), (tests.adash_week() + 2)::timestamptz),
  (tests.uid('m3'), 'post_impression', '{"post_id":"not-a-uuid","position":0}',                             (tests.adash_week() + 2)::timestamptz),
  -- a null-user row: allowed by analytics_events, must not become a member
  (null,             'post_opened',    jsonb_build_object('post_id', tests.adash_post('a'), 'post_type', 'POST_TEXT'), (tests.adash_week() + 3)::timestamptz),
  -- window decoys: one day before the start, and exactly ON the exclusive
  -- upper bound
  (tests.uid('norec'), 'attendance_recorded', '{}',                                                    (tests.adash_week() - 1)::timestamptz),
  (tests.uid('norec'), 'profile_opened',      jsonb_build_object('user_id', tests.uid('m1'), 'self', false), (tests.adash_week() + 7)::timestamptz);

-- --- the cardinality-cap week, ten weeks back --------------------------
-- Thirty distinct tab values plus one 100-character value, all from a
-- browser that analytics_events_insert_self happily accepts.
insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.uid('m1'), 'club_tab_viewed',
       jsonb_build_object('tab', 'tab_' || lpad(g::text, 2, '0')),
       (tests.adash_cap_week() + 1)::timestamptz
from generate_series(1, 30) g;

insert into public.analytics_events (user_id, event_name, props, created_at)
select tests.uid('m1'), 'club_tab_viewed',
       jsonb_build_object('tab', repeat('z', 100)),
       (tests.adash_cap_week() + 1)::timestamptz
from generate_series(1, 99) g;

-- =====================================================================
-- 4. THE PERMISSION BOUNDARY
-- =====================================================================
-- No session at all. auth.uid() is checked before anything is read, so this
-- is the first raise and not a policy error.
select throws_ok(
  $$ select public.analytics_dashboard(current_date - 6, current_date) $$,
  'P0001', 'not authorized',
  'with no auth.uid() at all the function refuses before it reads a single row - auth.uid() is checked first, per this schema''s standing rule for a definer function');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.analytics_dashboard(current_date - 6, current_date) $$,
  'P0001', 'not authorized',
  'a plain member is refused');

select tests.set_auth(tests.uid('coach'));
select ok(public.is_staff(), 'the coach really is staff, so the next assertion is about the permission and not about a broken fixture');
select ok(not public.has_perm('community.analytics.view'), 'and really does not hold community.analytics.view - 202608280001 seeds it to admin and owner only');
select throws_ok(
  $$ select public.analytics_dashboard(current_date - 6, current_date) $$,
  'P0001', 'not authorized',
  'THE ASSERTION THAT MATTERS: a COACH is refused. This gate is deliberately narrower than is_staff() - the same coach may preview a monthly recap draft (0046) and may call coach_celebrate_feed, and is refused club-wide behavioural analytics. Gate the nav item on the permission, not on staffness, or a coach is shown a screen the database refuses');

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.analytics_dashboard(current_date - 6, current_date) $$,
  'the owner is allowed - has_perm() short-circuits true for owner on every permission');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.analytics_dashboard(current_date - 6, current_date) $$,
  'and the admin is allowed, through community.analytics.view');

-- =====================================================================
-- 5. THE PERIOD BOUNDS - validated, never clamped
-- =====================================================================
-- Still in the admin session, so a raise here is about the period and not
-- about the permission.
select throws_ok(
  $$ select public.analytics_dashboard(null, current_date) $$,
  'P0001', 'period required',
  'a null start is refused');

select throws_ok(
  $$ select public.analytics_dashboard(current_date, null) $$,
  'P0001', 'period required',
  'and so is a null end');

select throws_ok(
  $$ select public.analytics_dashboard(current_date, current_date - 1) $$,
  'P0001', 'period end before start',
  'a reversed range is refused rather than silently swapped - a swapped range would put a number on screen labelled with a period nobody asked for');

select lives_ok(
  $$ select public.analytics_dashboard(current_date - 365, current_date) $$,
  'exactly 366 days inclusive is allowed - the boundary itself, so "one year" means a leap year and a this-day-last-year-to-today range both fit');

select throws_ok(
  $$ select public.analytics_dashboard(current_date - 366, current_date) $$,
  'P0001', 'period exceeds 366 days',
  'one day past the boundary is refused. analytics_events'' only time index is (event_name, created_at desc), so an unbounded range from a dashboard would be a full scan per metric');

select is(
  (select public.analytics_dashboard(current_date, current_date) #>> '{period,days}'),
  '1',
  'a single-day period is a legal one-day window, not a zero-length one - p_period_end is INCLUSIVE of its day');

-- =====================================================================
-- 6. THREE RESPONSES, PARKED
-- =====================================================================
-- Still the admin. Every assertion from here on reads tests.adash_out, so
-- every metric assertion below costs nothing beyond these three calls.
insert into tests.adash_out (k, doc) values
  ('week',  public.analytics_dashboard(tests.adash_week(),       tests.adash_week()       + 6)),
  ('cap',   public.analytics_dashboard(tests.adash_cap_week(),   tests.adash_cap_week()   + 6)),
  ('quiet', public.analytics_dashboard(tests.adash_quiet_week(), tests.adash_quiet_week() + 6));

select tests.clear_auth();

-- =====================================================================
-- 7. THE RESPONSE SHAPE - every named metric, and nothing else
-- =====================================================================
select is(
  (select string_agg(kk, ',' order by kk collate "C") from jsonb_object_keys(tests.adash_doc('week')) kk),
  'additional,core,generated_at,period',
  'the top level is exactly period, generated_at, core and additional - grouped to match metrics.md''s own Core/Additional split, which is also the section split COMM-310 asks the screen to render');

select is(
  (select string_agg(kk, ',' order by kk collate "C") from jsonb_object_keys(tests.adash_doc('week') -> 'core') kk),
  'engagement_per_post,feed_reach,posting_members,wcam,wcam_share',
  'core carries exactly the five "Core metrics" metrics.md names, keyed by name, and nothing else');

select is(
  (select string_agg(kk, ',' order by kk collate "C") from jsonb_object_keys(tests.adash_doc('week') -> 'additional') kk),
  'challenge_leaderboard_pull,coach_reach,discovery_split,filter_use,moderation_load,'
  || 'notification_effectiveness,open_rate,push_adoption,recap_pull_through,'
  || 'share_intent_split,social_graph_growth,sub_tab_split,trained_with_you_reach',
  'and additional carries exactly the thirteen "Additional metrics" metrics.md names. THIS IS THE "no metric is invented beyond that list" CRITERION: a metric added without a line in metrics.md fails here, and so does a metric quietly dropped');

select is(tests.adash_v('week', 'period', 'days'),          '7',            'the period reports 7 days for a Monday-to-Sunday inclusive range');
select is(tests.adash_v('week', 'period', 'weeks'),         '1.0000',       'and exactly one week, which is what makes every per_week figure below equal to its total');
select is(tests.adash_v('week', 'period', 'end_exclusive'),
          ('"' || (tests.adash_week() + 7)::text || '"'),
          'and it returns the resolved EXCLUSIVE upper bound alongside the inclusive one, so a caller never has to guess which convention it got');

-- =====================================================================
-- 8. CORE METRICS
-- =====================================================================

-- --- WCAM -------------------------------------------------------------
select is(tests.adash_v('week', 'core', 'wcam', 'weeks', '0', 'partial'), 'false',
  'the week under test is a WHOLE ISO week, so it is not flagged partial - the flag exists for the edge weeks of a month and must not fire for a week selector');

select is(tests.adash_v('week', 'core', 'wcam', 'weeks', '0', 'active_members'), '3',
  'WCAM IS 3: m1, m2 and the coach. Every filter is load-bearing here - m3 performed TEN non-qualifying events (two club_tab_viewed, two feed_viewed, weekly_recap_opened, two search_performed, directory_opened, three report_submitted, two challenge_viewed, leaderboard_viewed, classmates_card_viewed, post_impression) and is not counted; a null-user_id row is not counted; norec''s two events sit one day outside each end and are not counted; and m1''s thirteen separate qualifying events count once');

-- The same number, computed by hand from the literal query metrics.md
-- publishes. If analytics_dashboard and the doc ever disagree, this fails
-- and the assertion above still passes, which is the point of having both.
select is(
  (select count(distinct e.user_id)::text
   from public.analytics_events e
   where e.event_name in (
     'post_created','workout_shared','achievement_shared','comment_created',
     'reaction_added','challenge_joined','challenge_completed','event_rsvp',
     'post_opened','profile_opened','member_followed','notification_opened',
     'weekly_recap_shared','coach_congratulate_sent','attendance_recorded')
     and e.created_at >= tests.adash_week()::timestamptz
     and e.created_at <  (tests.adash_week() + 7)::timestamptz
     and e.user_id is not null),
  tests.adash_v('week', 'core', 'wcam', 'weeks', '0', 'active_members'),
  'AND IT AGREES WITH metrics.md''s OWN QUERY, run by hand over the same rows with the IN list written out as a literal. The dashboard''s headline number and the number the doc defines are asserted equal, not assumed equal');

select is(tests.adash_v('week', 'core', 'wcam', 'period_active_members'), '3',
  'period_active_members is the distinct actives over the whole period - the same 3 for a one-week period, and labelled separately from WCAM because for a month it is a bigger number than any of that month''s weeks and is not comparable to one');

select is(tests.adash_v('week', 'core', 'wcam', 'average_weekly'), '3.0000', 'average_weekly over a single week is that week');
select is(tests.adash_v('week', 'core', 'wcam', 'peak_weekly'),    '3',      'and so is the peak');

-- --- WCAM share -------------------------------------------------------
select is(tests.adash_v('week', 'core', 'wcam_share', 'weeks', '0', 'club_members'), '7',
  'the WCAM-share DENOMINATOR is the seven fixture members, counted as membership AS OF THE END OF THAT WEEK from invite_redemptions.redeemed_at - not a bare count(profiles) today, which would put a member who joined in March into January''s denominator');

select is(tests.adash_v('week', 'core', 'wcam_share', 'weeks', '0', 'share'), '0.4286',
  'so the share is 3/7 = 0.4286, and it is computed in the same pass as the count above, so the headline number and its share can never be computed off different rows');

-- --- posting members --------------------------------------------------
select is(tests.adash_v('week', 'core', 'posting_members', 'weeks', '0', 'posting_members'), '2',
  'posting members is 2: m1 (post_created, workout_shared) and m2 (post_created, workout_shared, achievement_shared), each counted once across all three qualifying names. The coach is WCAM-active and did not post, so a broken distinct would read 3');

-- --- engagement per post ----------------------------------------------
select is(tests.adash_v('week', 'core', 'engagement_per_post', 'weeks', '0', 'posts'),               '2',      'engagement counts 2 post_created EVENTS in the week');
select is(tests.adash_v('week', 'core', 'engagement_per_post', 'weeks', '0', 'engagement_per_post'), '1.0000', 'and (1 reaction_added + 1 comment_created) / 2 = 1.0000, from the EVENT stream, exactly as metrics.md defines it');

select is(tests.adash_v('week', 'core', 'engagement_per_post', 'table_cross_check', 'posts'), '3',
  'the TABLE cross-check counts 3 posts, not 2, and that difference is the whole point: the tables are "the cross-check, not the source" (metrics.md). A only_me post and a post one day outside the window are both excluded from it, and the PR post that produced no post_created event is included');

select is(tests.adash_v('week', 'core', 'engagement_per_post', 'table_cross_check', 'reactions'), '1',
  'and 1 reaction, not 2 - the second reaction sits on the only_me post, and engagement on a post nobody but its author can see is not club engagement');

select is(tests.adash_v('week', 'core', 'engagement_per_post', 'table_cross_check', 'engagement_per_post'), '0.6667',
  'so the cross-check ratio is 2/3 and the event ratio is 1.0000. Two different numbers from two different sources, which is exactly the drift signal metrics.md asks this dashboard to make visible');

-- --- feed reach -------------------------------------------------------
select is(tests.adash_v('week', 'core', 'feed_reach', 'posts_published'), '3',
  'feed reach publishes 3 posts - A, B and the PR post E. The only_me post is excluded and the post created one day before the window is excluded. Note this denominator deliberately does NOT require author_id: a club announcement is a card members scroll past');

select is(tests.adash_v('week', 'core', 'feed_reach', 'posts_with_impressions'), '2',
  'two of them were actually seen. The PR post got no impression, which is what makes reach a real measurement rather than a restatement of posts_published');

select is(tests.adash_v('week', 'core', 'feed_reach', 'reach_share'), '0.6667', 'so reach is 2/3');

select is(tests.adash_v('week', 'core', 'feed_reach', 'impressions_total'), '5',
  'five post_impression rows were recorded in the window, INCLUDING the one whose post_id is the string "not-a-uuid" - analytics_events props are client-written and only size-checked, so a malformed row must not fail the call');

select is(tests.adash_v('week', 'core', 'feed_reach', 'impressions_on_period_posts'), '3',
  'but only three of the five landed on a post published in the window: the malformed one resolves to no post at all, and the fourth is a real impression on a post from the day before the window');

-- =====================================================================
-- 9. ADDITIONAL METRICS - a cross-section, chosen by mechanism
-- =====================================================================

-- --- open rate: both sides typed from ONE source ----------------------
select is(tests.adash_v('week', 'additional', 'open_rate', 'POST_TEXT', 'impressions'), '3',
  'POST_TEXT impressions are 3 - two on A and one on D. Both sides of this ratio are typed from workout_posts.post_type through the shared post_id, because post_impression carries no post_type prop at all (its props are post_id, position, feed_session_id), so the numerator and the denominator cannot be typed by two different sources');

select is(tests.adash_v('week', 'additional', 'open_rate', 'POST_TEXT', 'open_rate'), '0.6667',
  'two opens over three impressions - and the second open is the NULL-user_id row. That row is excluded from WCAM, which is a count of distinct MEMBERS, and included here, which is a count of what happened to a SURFACE. The two are different questions and the same row correctly answers them differently');
select is(tests.adash_v('week', 'additional', 'open_rate', 'POST_WORKOUT', 'open_rate'), '0.0000',
  'and POST_WORKOUT is an honest 0.0000, not null and not absent - one impression, no opens. A count of zero over a real denominator is a measurement');

-- --- filter use: the member-day session approximation ------------------
select is(tests.adash_v('week', 'additional', 'filter_use', 'by_scope', 'all'),       '2', 'feed_viewed by scope: two "all"');
select is(tests.adash_v('week', 'additional', 'filter_use', 'by_scope', 'following'), '1', 'and one "following"');
select is(tests.adash_v('week', 'additional', 'filter_use', 'sessions', 'basis'), '"member_day"',
  'the session basis is DECLARED in the payload rather than left implicit: feed_viewed carries no session id (post_impression has feed_session_id, feed_viewed does not), so a "session" here is a member-day and the number is a FLOOR on the true per-session rate, not an estimate of it');

select is(tests.adash_v('week', 'additional', 'filter_use', 'sessions', 'feed_sessions'), '2',
  'two member-days saw the feed: m3 on one day (twice, which is still one member-day) and m1 on another');

select is(tests.adash_v('week', 'additional', 'filter_use', 'sessions', 'scope_change_share'), '0.5000',
  'and one of the two changed scope, so 0.5000. m3''s two feed_viewed rows are the same day, which is what makes this a real test of the member-day collapse rather than an event count in disguise');

-- --- sub-tab split: the plain breakdown -------------------------------
select is(tests.adash_v('week', 'additional', 'sub_tab_split', 'total'), '3', 'three club_tab_viewed rows in the week');
select is(tests.adash_v('week', 'additional', 'sub_tab_split', 'by_tab', 'feed'),   '2', 'two on the feed tab, from two different members');
select is(tests.adash_v('week', 'additional', 'sub_tab_split', 'by_tab', 'boards'), '1', 'and one on boards');

-- --- notification effectiveness: the full join ------------------------
select is(tests.adash_v('week', 'additional', 'notification_effectiveness', 'comment_reply', 'delivered'), '3',
  'three comment_reply notifications DELIVERED in the window, from the notifications table - there is no delivery event, so the table is the only possible denominator. The fourth comment_reply row sits one day before the window');

select is(tests.adash_v('week', 'additional', 'notification_effectiveness', 'comment_reply', 'opened'), '3', 'three opens');
select is(tests.adash_v('week', 'additional', 'notification_effectiveness', 'comment_reply', 'opened_unread'),  '2', 'of which two were unread - a real open');
select is(tests.adash_v('week', 'additional', 'notification_effectiveness', 'comment_reply', 'opened_revisit'), '1', 'and one was a revisit');

select is(tests.adash_v('week', 'additional', 'notification_effectiveness', 'comment_reply', 'open_rate'), '0.6667',
  'so the open rate is 2/3 and uses the UNREAD opens only. Counting revisits would let one member re-reading an old notification push a type over 100%, which is the distinction metrics.md draws with "was_unread separating a real open from a revisit"');

select is(tests.adash_v('week', 'additional', 'notification_effectiveness', 'weekly_recap', 'open_rate'), '1.0000',
  'weekly_recap is 1/1. It appears at all because the join between delivered and opened is a FULL join: a type with deliveries and no opens, and a type with opens and no deliveries, are both interesting and a left join in either direction hides one of them');

-- --- social graph growth: a jsonb boolean prop ------------------------
select is(tests.adash_v('week', 'additional', 'social_graph_growth', 'member_followed', 'total'), '2', 'two follows recorded as events');
select is(tests.adash_v('week', 'additional', 'social_graph_growth', 'profile_opened', 'other'), '2',
  'two profile opens of SOMEBODY ELSE. self arrives as a jsonb boolean and is compared as text, and anything that is not exactly "true" counts as another member - the safe direction, because a malformed self prop then deflates the conversion rate rather than inflating it');

select is(tests.adash_v('week', 'additional', 'social_graph_growth', 'profile_opened', 'self'), '1',
  'and exactly one self-open, which is the assertion that proves the two branches are not both matching everything');

select is(tests.adash_v('week', 'additional', 'social_graph_growth', 'table_cross_check', 'follow_edges_created'), '2',
  'the follows table agrees at 2. It can legitimately disagree in either direction - an older cached client produces the edge and no event, and an undone follow leaves no edge - which is why it is a cross-check and not the metric');

-- --- moderation load: two sources, and a queue depth that is about NOW -
select is(tests.adash_v('week', 'additional', 'moderation_load', 'reports_submitted', 'by_reason', 'spam'),        '2', 'two spam reports submitted');
select is(tests.adash_v('week', 'additional', 'moderation_load', 'reports_submitted', 'by_target_type', 'comment'), '1', 'and one against a comment');
select is(tests.adash_v('week', 'additional', 'moderation_load', 'queue', 'rows_created_in_period'), '2',
  'the reports TABLE gained two rows in the window - one fewer than the three events, which is the honest state of a fixture where a report row also exists from before the window');

select is(tests.adash_v('week', 'additional', 'moderation_load', 'queue', 'open_now'), '3',
  'and the open queue is 3, deliberately NOT period-bounded: a backlog is a fact about right now, and an admin looking at last March needs to know the queue is three deep today rather than that it was empty then');

-- --- discovery split: a client-written count prop ---------------------
select is(tests.adash_v('week', 'additional', 'discovery_split', 'search_performed', 'total'), '3', 'three searches');
select is(tests.adash_v('week', 'additional', 'discovery_split', 'search_performed', 'zero_member_result'), '2',
  'two of them found no member. member_count is compared as TEXT against ''0'' rather than cast - the prop is client-written, and a cast would raise on a malformed value where anything-that-is-not-literally-zero simply is not a proven zero-result search');

select is(tests.adash_v('week', 'additional', 'discovery_split', 'search_performed', 'zero_member_rate'), '0.6667', 'so the found-nothing rate is 2/3');
select is(tests.adash_v('week', 'additional', 'discovery_split', 'directory_opened', 'total'), '1', 'and one member browsed the roster instead of searching it');

-- --- trained-with-you reach: the show_attendance caveat, in the payload
select is(tests.adash_v('week', 'additional', 'trained_with_you_reach', 'card_views', 'total'), '3', 'three trained-with-you cards were seen');
select is(tests.adash_v('week', 'additional', 'trained_with_you_reach', 'classmates_shown_total'), '5',
  'and they showed 5 classmates between them: 3 + 2 + a third card whose rows prop is the string "bogus", which contributes 0 rather than raising');

select is(tests.adash_v('week', 'additional', 'trained_with_you_reach', 'attendance_events'), '3', 'against three attendance_recorded events');
select is(tests.adash_v('week', 'additional', 'trained_with_you_reach', 'card_rate'), '1.0000', 'so card_rate is 3/3');
select is(tests.adash_v('week', 'additional', 'trained_with_you_reach', 'table_cross_check', 'attendance_days_logged'), '3',
  'and attendance_log agrees at 3 days inside the window, with a fourth the day before it. metrics.md records that the two can legitimately disagree - the table is written by a trigger and the event by the client, independently');

select ok(
  tests.adash_v('week', 'additional', 'trained_with_you_reach', 'note') like '%show_attendance%',
  'the show_attendance caveat travels IN the payload rather than only in a doc, because a low card_rate is otherwise easy to read as a defect when it is adoption: the toggle defaults to false and both sides of every pair have to have flipped it');

-- --- push adoption and coach reach: three numbers that must differ ----
select is(tests.adash_v('week', 'additional', 'push_adoption', 'subscriptions', 'created_in_period'), '1', 'one push subscription was created in the window');
select is(tests.adash_v('week', 'additional', 'push_adoption', 'subscriptions', 'active_now'),        '1', 'one is unrevoked right now');
select is(tests.adash_v('week', 'additional', 'push_adoption', 'subscriptions', 'revoked_now'),       '1',
  'and one is revoked - three separate numbers from three separate filters, so a subscription that was created long ago and has since been revoked cannot be mistaken for adoption in this period');

select is(tests.adash_v('week', 'additional', 'coach_reach', 'congratulations', 'total'), '1', 'one congratulation was sent');
select is(tests.adash_v('week', 'additional', 'coach_reach', 'celebrate_items_eligible'), '1',
  'against one eligible celebrate item - the PR post, derived from the same three sources coach_celebrate_feed() unions (PR posts, tenure anniversaries, challenge completions) with the same non-privacy filters. It is an UPPER bound on what any one coach was shown, because that function''s per-viewer can_view_profile_field() gates cannot be replayed historically');

-- =====================================================================
-- 10. AGGREGATE ONLY, OVER THE WHOLE RESPONSE
-- =====================================================================
-- COMM-309 could enforce this with a column list. A jsonb blob has none, so
-- it is enforced by what every query SELECTs and asserted here over the
-- entire serialised response rather than over the keys the test author
-- happened to remember.
select ok(
  not tests.adash_mentions_a_member(tests.adash_doc('week')::text),
  'THE AGGREGATE-ONLY RULE: the ENTIRE response mentions no fixture member''s id, handle or display name, asked over every profile in the database. Seven members produced fifty-four events plus posts, reactions, comments, notifications, reports, follows, subscriptions and attendance rows in this window, and not one of them is identifiable in the output');

select ok(
  tests.adash_doc('week')::text !~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
  'and NO UUID OF ANY KIND appears anywhere in it, in any position, key or value - not a post id, not a notification id, not a challenge id, not a club id. This is the assertion that catches the real hazard: analytics_breakdown() groups by a prop, and grouping by an id-bearing prop (post_id, user_id, notification_id) would turn a club-wide metric into a per-item breakdown without anyone noticing');

select ok(
  not tests.adash_mentions_a_member(tests.adash_doc('cap')::text)
  and tests.adash_doc('cap')::text !~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
  'the same holds for the cardinality-cap response, whose group keys are thirty values a browser chose - a member who names their scope after another member still cannot get an id into the output, because no query here reads one');

-- =====================================================================
-- 11. THE CARDINALITY CAP ON A CLIENT-WRITTEN GROUP KEY
-- =====================================================================
select is(
  (select count(*)::text from jsonb_object_keys(tests.adash_doc('cap') #> '{additional,sub_tab_split,by_tab}') kk),
  '26',
  'thirty-one distinct tab values from a browser collapse to 26 keys: the largest 25, plus "(other)". analytics_events_insert_self lets any member insert any props, so without this cap one member could make a staff dashboard response arbitrarily large');

select ok(
  (tests.adash_doc('cap') #> '{additional,sub_tab_split,by_tab}') ? '(other)',
  'and the remainder is not dropped, it is summed into "(other)" - the total still adds up, so the cap costs detail and never costs accuracy');

select is(
  (select max(length(kk))::text from jsonb_object_keys(tests.adash_doc('cap') #> '{additional,sub_tab_split,by_tab}') kk),
  '64',
  'the 100-character tab value is truncated to 64 rather than stored whole: a group key is a label, and an unbounded one is a second place for a browser to put whatever it likes into a staff surface');

select is(tests.adash_v('cap', 'additional', 'sub_tab_split', 'total'), '129',
  'the TOTAL is uncapped and untruncated at 129 (30 + 99), so the cap is visibly a presentation bound on the breakdown and not a loss of the underlying count');

-- =====================================================================
-- 12. THE EMPTY PERIOD - honest zeros, and honest nulls
-- =====================================================================
select is(tests.adash_v('quiet', 'core', 'wcam', 'weeks', '0', 'active_members'), '0',
  'a genuinely quiet week is a zero, not an error and not a missing key - COMM-310''s empty state renders honest zeros');

select is(tests.adash_v('quiet', 'core', 'feed_reach', 'posts_published'), '0', 'nothing was published');
select is(tests.adash_v('quiet', 'core', 'feed_reach', 'reach_share'), 'null',
  'but reach_share is NULL, not 0. A count of zero is an honest zero; a RATE over a zero denominator is not - "0% reach" for a week in which nothing was published is a false statement about the feed rather than a measurement of it. Every ratio in the dashboard goes through analytics_ratio() so no metric gets to make a different choice');

select is(tests.adash_v('quiet', 'additional', 'notification_effectiveness'), '{}',
  'and an empty breakdown is an empty object, never null - the client renders an empty section without a null check');

select is(tests.adash_v('quiet', 'additional', 'moderation_load', 'queue', 'open_now'), '3',
  'the one figure that is NOT zero for a quiet week is the open queue, because it is a snapshot of now rather than of the period. That asymmetry is deliberate and is asserted so it cannot be "fixed" into a period filter by accident');

select is(
  (select string_agg(kk, ',' order by kk collate "C") from jsonb_object_keys(tests.adash_doc('quiet') -> 'additional') kk),
  'challenge_leaderboard_pull,coach_reach,discovery_split,filter_use,moderation_load,'
  || 'notification_effectiveness,open_rate,push_adoption,recap_pull_through,'
  || 'share_intent_split,social_graph_growth,sub_tab_split,trained_with_you_reach',
  'and an empty period returns the SAME thirteen keys as a busy one, so a skeleton card never has to disappear because a week was quiet');

select * from finish();
rollback;
