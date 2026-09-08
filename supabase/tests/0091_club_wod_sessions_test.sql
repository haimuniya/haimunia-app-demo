-- 202609080001 / 202609080002: club WOD sessions, and the boards members
-- attach their own results to.
--
-- THE PRODUCT CHANGE THIS PINS. The community layer competes with WhatsApp
-- on typed posts and loses. So the feed has to produce value from data the
-- app already collects: a coach programs a catalogue WOD to a day, that
-- becomes ONE feed card with ONE board, and members attach their own logged
-- results to it with a tap instead of composing anything.
--
-- What this file pins, in order:
--   1. the boundary - who reads, who writes, and that NOBODY writes either
--      table directly
--   2. POST_CLUB_WOD is a privileged label a member cannot mint
--   3. publishing: the permission, the one-day window, the per-day cap, the
--      snapshot rule and idempotency
--   4. attaching: ownership, the wodId match, the closed states, one row
--      per member per board, and that the figure is SERVER-FORMATTED
--   5. THE PRIVACY PROOF the brief asks for - a member cannot see another
--      member's result while show_workout_results is false, at the RLS
--      boundary AND through the read RPC, with participation and the figure
--      as two separate permissions
--   6. that NOTHING auto-publishes: syncing a training log creates no board
--      row, and there is no trigger that could
--   7. cancel / re-publish / detach, including that detaching is never
--      blocked

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

\set w1 '''customwod-aa111111-1111-4111-8111-111111111111'''
\set w2 '''customwod-bb222222-2222-4222-8222-222222222222'''
\set w3 '''customwod-cc333333-3333-4333-8333-333333333333'''
\set w4 '''customwod-dd444444-4444-4444-8444-444444444444'''
\set w5 '''customwod-ee555555-5555-4555-8555-555555555555'''
\set w6 '''customwod-ff666666-6666-4666-8666-666666666666'''

-- =====================================================================
-- 1. THE TABLES AND THEIR BOUNDARY
-- =====================================================================
select has_table('public', 'club_wod_sessions', 'the session table exists...');
select has_table('public', 'club_wod_results',  '...and the board table exists');

select is(
  (select count(*)::int from pg_class
    where oid in ('public.club_wod_sessions'::regclass, 'public.club_wod_results'::regclass)
      and relrowsecurity),
  2,
  'both have RLS enabled - no table in this module is reachable without a policy');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('club_wod_sessions', 'club_wod_results')),
  2,
  'and exactly one policy each, so neither is unreachable nor open by accident');

select ok(
  has_table_privilege('authenticated', 'public.club_wod_sessions', 'select')
  and has_table_privilege('authenticated', 'public.club_wod_results', 'select'),
  'authenticated may SELECT both (the policies narrow that)');

select ok(
  not has_table_privilege('authenticated', 'public.club_wod_sessions', 'insert')
  and not has_table_privilege('authenticated', 'public.club_wod_sessions', 'update')
  and not has_table_privilege('authenticated', 'public.club_wod_sessions', 'delete'),
  'and can NEVER write club_wod_sessions directly - the one-day window, the per-day cap and the audit row cannot be stepped around with a raw PostgREST call');

select ok(
  not has_table_privilege('authenticated', 'public.club_wod_results', 'insert')
  and not has_table_privilege('authenticated', 'public.club_wod_results', 'update')
  and not has_table_privilege('authenticated', 'public.club_wod_results', 'delete'),
  'and can NEVER write club_wod_results directly either - so the ownership probe, the wodId match and the SERVER-SIDE formatting are not optional');

select ok(
  not has_table_privilege('anon', 'public.club_wod_sessions', 'select')
  and not has_table_privilege('anon', 'public.club_wod_results', 'select'),
  'anon reads neither');

-- DB-M3 (202609060015), restated locally for the two new tables. 0081
-- asserts it as a property over the whole catalog; this says which four
-- columns it is about here, so a future reader can see the rule was met on
-- purpose rather than by luck.
select is(
  (select count(*)::int
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_attribute a on a.attrelid = c.oid and a.attnum = any(con.conkey)
    where con.contype = 'f'
      and c.oid in ('public.club_wod_sessions'::regclass, 'public.club_wod_results'::regclass)
      and a.attname <> 'club_id'
      and not exists (
        select 1 from pg_index i where i.indrelid = c.oid and a.attnum = i.indkey[0])),
  0,
  'every FK column on both tables outside club_id leads an index (DB-M3)');

-- The anti-leaderboard rule, as a fact about the schema rather than a
-- promise in a comment: there is nothing on a board row to rank by.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'club_wod_results'
      and column_name in ('score_value', 'score_direction', 'rank', 'position')),
  0,
  'a board row carries NO score_value, score_direction, rank or position - weekly_challenges is the ranked feature and this cannot become one without new columns');

-- =====================================================================
-- 2. POST_CLUB_WOD IS A PRIVILEGED LABEL
-- =====================================================================
select ok(
  'POST_CLUB_WOD' = any (enum_range(null::public.post_type)::text[]),
  'POST_CLUB_WOD exists on the post_type enum');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$insert into public.workout_posts (author_id, post_type, visibility, body, occurred_on)
    values (tests.uid('m1'), 'POST_CLUB_WOD', 'club', 'not programming', current_date)$$,
  'post type is staff only',
  'a member cannot INSERT a POST_CLUB_WOD - otherwise they could mint a card the client renders as club programming, with a board under it');

select lives_ok(
  $$insert into public.workout_posts (id, author_id, post_type, visibility, body, occurred_on)
    values ('99999999-1111-4111-8111-111111111111', tests.uid('m1'), 'POST_TEXT', 'club', 'ordinary post', current_date)$$,
  'a member can still post ordinary text');
select throws_ok(
  $$update public.workout_posts set post_type = 'POST_CLUB_WOD'
     where id = '99999999-1111-4111-8111-111111111111'$$,
  'post type is staff only',
  'and cannot PATCH an existing post of their own into one');

-- =====================================================================
-- 3. PUBLISHING A SESSION
-- =====================================================================
-- The catalogue rows every session below points at, made the way the app
-- makes them.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  format($$select public.club_wod_publish(%L, 'Coach Metcon', 'time', 'For time')$$, :w1),
  'the coach publishes a WOD to the catalogue (202609060028)');
select lives_ok(
  format($$select public.club_wod_publish(%L, 'Second Metcon', 'amrap', '')$$, :w2),
  '...and a second one');
select lives_ok(
  format($$select public.club_wod_publish(%L, 'Retired One', 'load', '')$$, :w3),
  '...and a third, which is then retired');
select lives_ok(
  format($$select public.club_wod_retire(%L, 'no longer programmed')$$, :w3),
  '...retired');

-- The permission, not is_staff(): a member holds community.post.create but
-- not community.challenge.create.
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  format($$select public.club_wod_session_publish(%L)$$, :w1),
  'not authorized',
  'a MEMBER cannot program a session - community.challenge.create, the same permission club_wod_publish requires');

select tests.set_auth(tests.uid('norec'));
select throws_ok(
  format($$select public.club_wod_session_publish(%L)$$, :w1),
  'recovery method required',
  'and a member with no verified recovery method is refused before the permission is even consulted');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$select public.club_wod_session_publish('customwod-00000000-0000-4000-8000-000000000000')$$,
  'wod not found',
  'programming a WOD that is not in the catalogue is refused');
select throws_ok(
  format($$select public.club_wod_session_publish(%L)$$, :w3),
  'wod is retired',
  'and so is programming a RETIRED one - retirement means out of circulation for new logs, and a session would put it straight back in');
select throws_ok(
  format($$select public.club_wod_session_publish(%L, current_date + 5)$$, :w1),
  'a session can only be posted for yesterday, today or tomorrow',
  'the session date is bounded to one day either side - the STRUCTURAL bound on how many of these cards the feed can gain, in place of a rate limit');
select throws_ok(
  format($$select public.club_wod_session_publish(%L, current_date - 5)$$, :w1),
  'a session can only be posted for yesterday, today or tomorrow',
  '...in both directions');

select lives_ok(
  format($$select public.club_wod_session_publish(%L, current_date, 'Rx is 43/30')$$, :w1),
  'the coach programs today''s WOD');

-- Pin the session id for the rest of the file.
create temp table t_ids as
select s.id as session_id, s.post_id as post_id
from public.club_wod_sessions s where s.wod_id = :w1 and s.session_date = current_date;

select is(
  (select count(*)::int from public.workout_posts p
    join t_ids t on t.post_id = p.id
   where p.post_type = 'POST_CLUB_WOD' and p.visibility = 'club'
     and p.author_id = tests.uid('coach') and p.deleted_at is null),
  1,
  'it produced exactly ONE feed card, POST_CLUB_WOD, club visibility, authored by the coach');

select is(
  (select p.metadata ->> 'club_wod_session_id' from public.workout_posts p join t_ids t on t.post_id = p.id),
  (select t.session_id::text from t_ids t),
  'and the card carries club_wod_session_id in metadata - which is how the client gets from a feed row to the board');

select ok(
  (select p.result_text is null and p.comparison_key is null and p.score_value is null
      and p.rx is null and p.source_type is null and p.source_id is null
   from public.workout_posts p join t_ids t on t.post_id = p.id),
  'the card carries NO member figures of any kind and no source deep link - it is programming, and every result lives in club_wod_results where the privacy rules are');

-- Idempotency, both halves.
select is(
  (select (public.club_wod_session_publish(:w1, current_date, 'Rx is 43/30') ->> 'session_id')),
  (select t.session_id::text from t_ids t),
  'republishing with an IDENTICAL note returns the same board - a double tap is safe');
select is(
  (select count(*)::int from public.club_wod_sessions where wod_id = :w1 and session_date = current_date),
  1,
  '...and creates no second session');
select is(
  (select count(*)::int from public.workout_posts where post_type = 'POST_CLUB_WOD' and deleted_at is null),
  1,
  '...and no second card');
select throws_ok(
  format($$select public.club_wod_session_publish(%L, current_date, 'a different note')$$, :w1),
  'session already posted',
  'but a CHANGED note raises rather than silently dropping the edit - club_wod_publish''s snapshot rule, so a coach is told');

-- The per-day cap.
select lives_ok(
  format($$select public.club_wod_publish(%L, 'Filler A', 'time', '')$$, :w4),
  'three more catalogue WODs, to reach the per-day cap');
select lives_ok(format($$select public.club_wod_publish(%L, 'Filler B', 'time', '')$$, :w5), '...');
select lives_ok(format($$select public.club_wod_publish(%L, 'Filler C', 'time', '')$$, :w6), '...');
select lives_ok(format($$select public.club_wod_session_publish(%L, current_date)$$, :w2), 'session 2 of the day');
select lives_ok(format($$select public.club_wod_session_publish(%L, current_date)$$, :w4), 'session 3 of the day');
select lives_ok(format($$select public.club_wod_session_publish(%L, current_date)$$, :w5), 'session 4 of the day');
select throws_ok(
  format($$select public.club_wod_session_publish(%L, current_date)$$, :w6),
  'too many sessions posted for that day',
  'the fifth live session in one day is refused - the feed cannot be flooded with programming cards even by a client in a loop');

-- =====================================================================
-- 4. ATTACHING A RESULT
-- =====================================================================
-- m1 has no server copy of this entry (cloud backup is opt-out), so the
-- attach falls back to p_entry - normalised and formatted HERE.
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  format($$select public.club_wod_attach_result(
    (select session_id from t_ids), 'wodentry-m1-1',
    jsonb_build_object('wodId', %L, 'scoreType', 'time', 'timeSeconds', 221, 'rx', true, 'date', current_date::text))$$, :w1),
  'a member with NO server copy of the entry can still attach - backup is opt-out, and they are not a second-class member');

select is(
  (select result_text from public.club_wod_results r join t_ids t on t.session_id = r.session_id
    where r.user_id = tests.uid('m1')),
  '3:41',
  'and the figure is FORMATTED SERVER-SIDE from the structured fields - formatClock(221) - so no caller string is ever stored and the board cannot smuggle text past post moderation');

select is(
  (select count(*)::int from public.club_wod_results r join t_ids t on t.session_id = r.session_id
    where r.user_id = tests.uid('m1')),
  1,
  'one row');

-- The wodId match.
select throws_ok(
  format($$select public.club_wod_attach_result(
    (select session_id from t_ids), 'wodentry-m1-x',
    jsonb_build_object('wodId', %L, 'scoreType', 'amrap', 'rounds', 7, 'reps', 3, 'rx', true))$$, :w2),
  'that result is for a different workout',
  'a result for a DIFFERENT workout cannot be attached - a stale client would otherwise put a Fran time on the Murph board');
select throws_ok(
  $$select public.club_wod_attach_result(
    (select session_id from t_ids), 'wodentry-m1-y',
    jsonb_build_object('scoreType', 'time', 'timeSeconds', 100, 'rx', true))$$,
  'that result is for a different workout',
  '...and an entry with no wodId at all cannot be confirmed, so it is refused too');

-- Ownership: m2 syncs an entry, m1 tries to attach under its id.
select tests.clear_auth();
insert into public.private_records (user_id, record_type, record_id, payload)
values (tests.uid('m2'), 'wod_entry', 'wodentry-m2-owned',
        jsonb_build_object('id', 'wodentry-m2-owned', 'wodId', :w1,
                           'scoreType', 'time', 'timeSeconds', 180, 'rx', true,
                           'date', current_date::text));
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$select public.club_wod_attach_result((select session_id from t_ids), 'wodentry-m2-owned')$$,
  'not authorized',
  'a member cannot attach under ANOTHER member''s entry id - pr_share''s case (c), asked of this write path');

select throws_ok(
  $$select public.club_wod_attach_result((select session_id from t_ids), '')$$,
  'record is required',
  'a blank record id is refused');
select throws_ok(
  $$select public.club_wod_attach_result('99999999-9999-4999-8999-999999999999', 'wodentry-m1-1')$$,
  'session not found',
  'and an unknown session is refused');

-- The figure is recomputed from the SERVER copy when one exists, not taken
-- from the request.
select tests.clear_auth();
insert into public.private_records (user_id, record_type, record_id, payload)
values (tests.uid('m2'), 'wod_entry', 'wodentry-m2-real',
        jsonb_build_object('id', 'wodentry-m2-real', 'wodId', :w1,
                           'scoreType', 'time', 'timeSeconds', 305, 'rx', false,
                           'scaledWeight', 30, 'date', current_date::text));
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$select public.club_wod_attach_result((select session_id from t_ids), 'wodentry-m2-real',
      jsonb_build_object('scoreType', 'time', 'timeSeconds', 1))$$,
  'm2 attaches, supplying a p_entry that claims a one-second time');
select is(
  (select result_text from public.club_wod_results r join t_ids t on t.session_id = r.session_id
    where r.user_id = tests.uid('m2')),
  '5:05 @ 30 ק"ג',
  'the SERVER copy wins over the request, and a scaled entry keeps its "@ <weight> kg" suffix in the SAME list as an Rx one - there is no separate scaled board');
select is(
  (select rx::text from public.club_wod_results r join t_ids t on t.session_id = r.session_id
    where r.user_id = tests.uid('m2')),
  'false',
  'and the row records that it was scaled, for the client to badge');

-- One member, one row: a second attach replaces, and does not move them up
-- a board ordered by attached_at.
select tests.set_auth(tests.uid('m1'));
create temp table t_first as
select attached_at from public.club_wod_results r join t_ids t on t.session_id = r.session_id
where r.user_id = tests.uid('m1');
select lives_ok(
  format($$select public.club_wod_attach_result(
    (select session_id from t_ids), 'wodentry-m1-2',
    jsonb_build_object('wodId', %L, 'scoreType', 'time', 'timeSeconds', 200, 'rx', true, 'date', current_date::text))$$, :w1),
  'm1 attaches a SECOND attempt to the same board');
select is(
  (select count(*)::int from public.club_wod_results r join t_ids t on t.session_id = r.session_id
    where r.user_id = tests.uid('m1')),
  1,
  'still ONE row - (session_id, user_id) is the primary key, which is the answer to "what if they log it twice"');
select is(
  (select result_text from public.club_wod_results r join t_ids t on t.session_id = r.session_id
    where r.user_id = tests.uid('m1')),
  '3:20',
  '...replaced with the attempt the member chose to show');
select is(
  (select r.attached_at from public.club_wod_results r join t_ids t on t.session_id = r.session_id
    where r.user_id = tests.uid('m1')),
  (select attached_at from t_first),
  '...and attached_at is NOT bumped, so re-attaching cannot be used to move up a board ordered by it');

-- A half-filled entry publishes participation, not "0:00".
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  format($$select public.club_wod_attach_result(
    (select session_id from t_ids), 'wodentry-m3-blank',
    jsonb_build_object('wodId', %L, 'scoreType', 'time', 'timeSeconds', 0, 'rx', true))$$, :w1),
  'a member with a half-filled log entry can still attach');
select is(
  (select result_text from public.club_wod_results r join t_ids t on t.session_id = r.session_id
    where r.user_id = tests.uid('m3')),
  null,
  '...and gets participation with NO figure rather than a published "0:00", which would be a number worse than none');

-- =====================================================================
-- 5. THE PRIVACY PROOF
-- =====================================================================
-- show_workout_results DEFAULTS FALSE. Everything below is the shipped
-- default state.
select is(
  (select show_workout_results::text from public.profiles where id = tests.uid('m1')),
  'false',
  'show_workout_results defaults FALSE - the board''s default state is names with few numbers, and that is the honest shipped behaviour');

-- (a) The RLS boundary, which is stricter than the read RPC on purpose.
select tests.set_auth(tests.uid('m2'));
select is(
  (select count(*)::int from public.club_wod_results r
    join t_ids t on t.session_id = r.session_id where r.user_id = tests.uid('m1')),
  0,
  'RLS PROOF: a member cannot read another member''s board row AT ALL over a direct select while show_workout_results is false - so no read function bug could ever leak the figure');
select is(
  (select count(*)::int from public.club_wod_results r
    join t_ids t on t.session_id = r.session_id where r.user_id = tests.uid('m2')),
  1,
  '...while their own row is always readable');

-- (b) The read RPC, which crosses that boundary in ONE direction: it shows
-- the member's participation and strips the figure.
select is(
  (select count(*)::int from jsonb_array_elements(
     public.club_wod_board((select session_id from t_ids)) -> 'results') e
    where (e ->> 'user_id') = tests.uid('m1')::text),
  1,
  'the BOARD still lists m1 - they attached deliberately, so participation is consented');
select is(
  (select e ->> 'result_text' from jsonb_array_elements(
     public.club_wod_board((select session_id from t_ids)) -> 'results') e
    where (e ->> 'user_id') = tests.uid('m1')::text),
  null,
  '...with result_text STRIPPED, exactly as COMM-018 strips a POST_WORKOUT''s result without removing the post');
select is(
  (select e ->> 'result_hidden' from jsonb_array_elements(
     public.club_wod_board((select session_id from t_ids)) -> 'results') e
    where (e ->> 'user_id') = tests.uid('m1')::text),
  'true',
  '...and result_hidden true, so the client can say "hidden" rather than "no result" - different facts about a member');

select tests.set_auth(tests.uid('m1'));
select is(
  (select e ->> 'result_text' from jsonb_array_elements(
     public.club_wod_board((select session_id from t_ids)) -> 'results') e
    where (e ->> 'user_id') = tests.uid('m1')::text),
  '3:20',
  'm1 sees their OWN figure - the subject is never stripped from themselves');

-- (b2) THE COACH IS NOT EXEMPT. can_view_profile_field short-circuits for
-- is_admin() - rank 50 and above - and NOT for is_staff(). A coach who
-- programmed the session still cannot read a member's figure while that
-- member's toggle is off. That is a real product consequence and is
-- asserted rather than discovered later.
select tests.set_auth(tests.uid('coach'));
select is(
  (select e ->> 'result_text' from jsonb_array_elements(
     public.club_wod_board((select session_id from t_ids)) -> 'results') e
    where (e ->> 'user_id') = tests.uid('m1')::text),
  null,
  'the COACH who programmed the session cannot read the figure either - show_workout_results is not a staff-visibility switch, and can_view_profile_field short-circuits for is_admin, not is_staff');
select is(
  (select count(*)::int from jsonb_array_elements(
     public.club_wod_board((select session_id from t_ids)) -> 'results') e
    where (e ->> 'user_id') = tests.uid('m1')::text),
  1,
  '...while still seeing that they took part, which is what a coach actually needs from this board');

-- (c) Opting in shows the figure, through both paths.
select tests.clear_auth();
update public.profiles set show_workout_results = true where id = tests.uid('m1');
select tests.set_auth(tests.uid('m2'));
select is(
  (select e ->> 'result_text' from jsonb_array_elements(
     public.club_wod_board((select session_id from t_ids)) -> 'results') e
    where (e ->> 'user_id') = tests.uid('m1')::text),
  '3:20',
  'once m1 turns show_workout_results ON, m2 sees the figure - the toggle is the only thing that moved');
select is(
  (select count(*)::int from public.club_wod_results r
    join t_ids t on t.session_id = r.session_id where r.user_id = tests.uid('m1')),
  1,
  '...and the RLS boundary opens with it, in step');

-- (d) visible_to_club governs being LISTED, which is a different question
-- from the figure.
select tests.clear_auth();
update public.profiles set visible_to_club = false where id = tests.uid('m1');
select tests.set_auth(tests.uid('m2'));
select is(
  (select count(*)::int from jsonb_array_elements(
     public.club_wod_board((select session_id from t_ids)) -> 'results') e
    where (e ->> 'user_id') = tests.uid('m1')::text),
  0,
  'a member hidden from the club is not LISTED on the board at all - participation and the figure are two separate permissions');
select is(
  (public.club_wod_board((select session_id from t_ids)) ->> 'result_count')::int,
  (select jsonb_array_length(public.club_wod_board((select session_id from t_ids)) -> 'results')),
  'and result_count is counted over the SAME filtered set as the list, so it cannot disclose a member this viewer may not see');

select tests.clear_auth();
update public.profiles set visible_to_club = true, show_workout_results = false where id = tests.uid('m1');

-- (e) A block edge removes the row in either direction.
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m2'));
select tests.set_auth(tests.uid('m3'));
select is(
  (select count(*)::int from jsonb_array_elements(
     public.club_wod_board((select session_id from t_ids)) -> 'results') e
    where (e ->> 'user_id') = tests.uid('m2')::text),
  0,
  'a blocked member''s row is absent from the blocker''s board - can_view_profile_field settles blocks in both directions in the same call that settles the toggles');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m3');

-- =====================================================================
-- 6. NOTHING AUTO-PUBLISHES
-- =====================================================================
-- The single most important promise in this feature, asserted twice: once
-- behaviourally, once as a fact about the catalog.
select tests.clear_auth();
insert into public.private_records (user_id, record_type, record_id, payload)
values (tests.uid('norec'), 'wod_entry', 'wodentry-norec-sync',
        jsonb_build_object('id', 'wodentry-norec-sync', 'wodId', :w1,
                           'scoreType', 'time', 'timeSeconds', 150, 'rx', true,
                           'date', current_date::text));
select is(
  (select count(*)::int from public.club_wod_results r
    join t_ids t on t.session_id = r.session_id where r.user_id = tests.uid('norec')),
  0,
  'syncing a training log entry for a WOD the club is doing TODAY creates NO board row - publishing your log and syncing it stay two different acts');

select is(
  (select count(*)::int from pg_trigger tg
     join pg_class c on c.oid = tg.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not tg.tgisinternal
      and pg_get_functiondef(tg.tgfoid) like '%club\_wod\_results%'),
  0,
  'and NO trigger anywhere in public writes club_wod_results - the promise is structural, not a convention someone can forget');

select is(
  (select count(*)::int from pg_trigger tg
     join pg_class c on c.oid = tg.tgrelid
    where c.oid = 'public.club_wod_results'::regclass and not tg.tgisinternal),
  1,
  'the board table carries exactly one trigger of its own, the updated_at touch');

-- =====================================================================
-- 7. CANCEL, RE-PUBLISH, DETACH
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$select public.club_wod_session_cancel((select session_id from t_ids))$$,
  'not authorized',
  'a member cannot cancel a session');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$select public.club_wod_session_cancel((select session_id from t_ids), 'wrong day')$$,
  'the coach withdraws the session');
-- Read as the bootstrap superuser, not as the coach. Both facts below are
-- deliberately NOT visible to a coach session, and that is itself correct:
-- posts_feed_select filters deleted_at, and club_wod_results_read hides
-- every member whose show_workout_results is off - from staff too, because
-- a coach is not an admin and the toggle is not a staff-visibility switch.
select tests.clear_auth();
select ok(
  (select p.deleted_at is not null and p.status = 'active'
   from public.workout_posts p join t_ids t on t.post_id = p.id),
  'the card leaves the feed by deleted_at ONLY, with status still ''active'' - ''removed'' is the moderation label, and a coach withdrawing their own programming is not a moderator acting on content');
select is(
  (select count(*)::int from public.club_wod_results r join t_ids t on t.session_id = r.session_id),
  3,
  'and the board is NOT deleted - three members'' results survive the withdrawal');
select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::int from public.club_wod_boards() b
    where (b ->> 'session_id') = (select session_id::text from t_ids)),
  0,
  'club_wod_boards() excludes it: the list answers "what is the club doing"');
select is(
  (public.club_wod_board((select session_id from t_ids)) -> 'viewer' ->> 'closed_reason'),
  'cancelled',
  'but club_wod_board(id) still returns it, saying WHY the attach control is gone rather than hiding a button');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$select public.club_wod_attach_result((select session_id from t_ids), 'wodentry-m1-2')$$,
  'this board is closed',
  'attaching to a cancelled board is refused');
select lives_ok(
  $$select public.club_wod_detach_result((select session_id from t_ids))$$,
  'but DETACHING from one still works - taking your own result off a club surface must never be blocked');
select is(
  (select count(*)::int from public.club_wod_results r join t_ids t on t.session_id = r.session_id
    where r.user_id = tests.uid('m1')),
  0,
  '...and the row is gone');
select lives_ok(
  $$select public.club_wod_detach_result((select session_id from t_ids))$$,
  'detaching twice is a success, not an error - a double tap means the row is gone, which is what was asked');

-- Re-publishing a cancelled session is a new decision, and the board
-- survives it.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  format($$select public.club_wod_session_publish(%L, current_date, 'take two')$$, :w1),
  'the coach re-publishes the withdrawn session');
select is(
  (select count(*)::int from public.club_wod_sessions where wod_id = :w1 and session_date = current_date),
  1,
  '...as the SAME session row, not a second one');
select tests.clear_auth();
select is(
  (select count(*)::int from public.club_wod_results r join t_ids t on t.session_id = r.session_id),
  2,
  '...and the two members who had not detached keep their results - they do not have to attach again');
select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::int from public.workout_posts p
    where p.post_type = 'POST_CLUB_WOD' and p.deleted_at is null
      and p.metadata ->> 'club_wod_session_id' = (select session_id::text from t_ids)),
  1,
  '...with a FRESH card, because re-publishing is a new decision and not a retry');

-- =====================================================================
-- 8. THE READS, THEIR GATES AND THEIR EMPTY STATES
-- =====================================================================
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$select public.club_wod_board((select session_id from t_ids))$$,
  'recovery method required',
  'club_wod_board is gated on is_community_member - an anonymous-session JWT gets an honest message, not an empty board');
select throws_ok(
  $$select * from public.club_wod_boards()$$,
  'recovery method required',
  '...and so is club_wod_boards');

select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$select public.club_wod_board('99999999-9999-4999-8999-999999999999')$$,
  'session not found',
  'an unknown session id raises rather than returning null');

-- The empty board: a session nobody has attached to is still worth opening,
-- which is what breaks the log-adoption circularity.
create temp table t_empty as
select s.id as session_id from public.club_wod_sessions s where s.wod_id = :w2;
select is(
  (public.club_wod_board((select session_id from t_empty)) ->> 'result_count')::int,
  0,
  'a board nobody has attached to reports result_count 0...');
select is(
  (select jsonb_array_length(public.club_wod_board((select session_id from t_empty)) -> 'results')),
  0,
  '...with an empty results array...');
select is(
  (public.club_wod_board((select session_id from t_empty)) -> 'wod' ->> 'name'),
  'Second Metcon',
  '...and the PROGRAMMING still there, so the card carries value at zero member contributions - the whole point of the feature');
select is(
  (public.club_wod_board((select session_id from t_empty)) -> 'viewer' ->> 'attached'),
  'false',
  '...and viewer.attached false, always present so the client never tests for absence');
select is(
  (public.club_wod_board((select session_id from t_empty)) -> 'viewer' ->> 'can_attach'),
  'true',
  '...with can_attach true and closed_reason null on a live board');

-- Tomorrow's programming is postable but not attachable.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  format($$select public.club_wod_session_publish(%L, current_date + 1)$$, :w6),
  'a coach can post TOMORROW''s programming tonight');
create temp table t_future as
select s.id as session_id from public.club_wod_sessions s
where s.wod_id = :w6 and s.session_date = current_date + 1;
select tests.set_auth(tests.uid('m2'));
select is(
  (public.club_wod_board((select session_id from t_future)) -> 'viewer' ->> 'closed_reason'),
  'future',
  '...and the board says so rather than offering a control that cannot work');
select throws_ok(
  format($$select public.club_wod_attach_result((select session_id from t_future), 'wodentry-m2-future',
    jsonb_build_object('wodId', %L, 'scoreType', 'time', 'timeSeconds', 100, 'rx', true))$$, :w6),
  'the session has not happened yet',
  '...and the write agrees with the board, in the same order');

-- club_wod_boards() defaults to TODAY, which is the product.
select is(
  (select count(*)::int from public.club_wod_boards() b
    where (b -> 'wod' ->> 'id') = :w6),
  0,
  'club_wod_boards() with no arguments means TODAY, so tomorrow''s card is not in it');
select ok(
  (select count(*) from public.club_wod_boards() b) >= 1,
  '...while today''s live sessions are');
select ok(
  (select count(*) from public.club_wod_boards(current_date, current_date + 1) b) >
  (select count(*) from public.club_wod_boards() b),
  'and an explicit range reaches tomorrow');
select ok(
  (select count(*) from public.club_wod_boards(current_date + 1, current_date)) =
  (select count(*) from public.club_wod_boards(current_date + 1, current_date + 1)),
  'a reversed range is CLAMPED to one day rather than raising - a client bug should not surface as an error to a member');

-- =====================================================================
-- 9. THE AUDIT LOG
-- =====================================================================
select tests.clear_auth();
select is(
  (select count(*)::int from public.admin_actions
    where action_type = 'club_wod_session_published'),
  6,
  'every session publish is audited - four for today, one re-publish, one for tomorrow, and none for the calls that raised or were idempotent');
select is(
  (select count(*)::int from public.admin_actions
    where action_type = 'club_wod_session_cancelled'),
  1,
  'and the cancellation is a SEPARATE action type - 202609060022 was written because one label for both directions is a defect');
select is(
  (select count(*)::int from public.admin_actions
    where action_type like 'club\_wod\_session\_%' and target_type <> 'club_wod_session'),
  0,
  'every session action targets ''club_wod_session''');
select is(
  (select count(*)::int from public.admin_actions
    where action_type like 'club\_wod\_session\_%' and target_user_id is not null),
  0,
  'and none names a target MEMBER: programming a day is an action on club content, not on a person');
select is(
  (select count(*)::int from public.admin_actions
    where target_type = 'club_wod_session' and admin_display is null),
  0,
  'while every row does name the acting staff member');
select is(
  (select count(*)::int from public.admin_actions a
    join public.club_wod_results r on r.user_id = a.target_user_id),
  0,
  'and NO member attach or detach is written to the staff audit log - a member publishing their own result is not a staff act');

-- ---------------------------------------------------------------------------
-- 8. A RESTRICTED MEMBER IS TOLD BEFORE THEY TAP, NOT AFTER (202609080004).
--
-- club_wod_attach_result() refuses in five ways; club_wod_board_json()
-- originally computed closed_reason from only the last three, so a member
-- under a posting restriction was handed can_attach true and an offer to put
-- their result on the club board, and was refused only once they had tapped
-- it. The board and the write path have to agree, and this pins that they do
-- - including the asymmetry that makes the sanction a fair one.
-- ---------------------------------------------------------------------------

-- m2 logs the empty board's WOD and attaches BEFORE any restriction, so the
-- detach assertions below have a real row to act on.
insert into public.private_records (user_id, record_type, record_id, payload)
values (tests.uid('m2'), 'wod_entry', 'wodentry-m2-restrict',
        jsonb_build_object('id', 'wodentry-m2-restrict', 'wodId', :w2,
                           'scoreType', 'time', 'timeSeconds', 240, 'rx', true,
                           'date', current_date::text));
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$select public.club_wod_attach_result((select session_id from t_empty), 'wodentry-m2-restrict')$$,
  'an unrestricted member attaches to a live board');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  format($$select public.mod_restrict_member(%L, 'temporary', now() + interval '7 days', 'test restriction')$$,
         tests.uid('m2')),
  'an admin restricts that member from posting');
-- mod_lift_restriction() takes the RESTRICTION id, not the member's, so keep it.
create temp table t_restr as
select id from public.posting_restrictions
where user_id = tests.uid('m2') and lifted_at is null;

select tests.set_auth(tests.uid('m2'));
select is(
  (public.club_wod_board((select session_id from t_empty)) -> 'viewer' ->> 'closed_reason'),
  'restricted',
  'THE FIX: the board now names the restriction as the reason, instead of reporting the board open');
select is(
  (public.club_wod_board((select session_id from t_empty)) -> 'viewer' ->> 'can_attach'),
  'false',
  '...and can_attach is false, so no client can offer a control the write path will refuse');
select throws_ok(
  format($$select public.club_wod_attach_result((select session_id from t_empty), 'wodentry-m2-restrict',
    jsonb_build_object('wodId', %L, 'scoreType', 'time', 'timeSeconds', 240, 'rx', true))$$, :w2),
  'posting_restricted',
  '...and the write still refuses, in the same order the board asks - the two cannot drift apart');

-- THE ASYMMETRY. A restriction stops a member ADDING content. It must never
-- trap what they already added, or the sanction quietly becomes "your result
-- is stuck on a club surface you can no longer control".
select is(
  (public.club_wod_board((select session_id from t_empty)) -> 'viewer' ->> 'can_detach'),
  'true',
  'a RESTRICTED member can still detach - the sanction is on adding, never on withdrawing');
select is(
  (public.club_wod_board((select session_id from t_empty)) -> 'viewer' ->> 'attached'),
  'true',
  '...and they can still SEE that their result is on the board, so the control is not offered blindly');
select lives_ok(
  $$select public.club_wod_detach_result((select session_id from t_empty))$$,
  '...and detaching genuinely works while restricted, not just advertised');
select is(
  (select count(*)::int from public.club_wod_results r join t_empty t on t.session_id = r.session_id
    where r.user_id = tests.uid('m2')),
  0,
  '...leaving no row behind');

-- Lifting the restriction restores the offer, so the closed state is the
-- restriction's and not a one-way door.
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$select public.mod_lift_restriction((select id from t_restr))$$,
  'an admin lifts the restriction');
select tests.set_auth(tests.uid('m2'));
select is(
  (public.club_wod_board((select session_id from t_empty)) -> 'viewer' ->> 'can_attach'),
  'true',
  '...and the member can attach again, closed_reason back to null');

select * from finish();
rollback;
