-- COMM-214: real behavioural coverage for 202608290009
-- (notif_on_event_cancelled, plus the event_cancelled -> events arm added
-- to notif_pref_key).
--
-- Boundaries: the trigger function is unreachable by a direct client RPC.
-- Cancelling a published event writes one immediate event_cancelled row for
-- every attendee whose response is going or interested, and nothing for a
-- not_going attendee, a member with no RSVP at all, or the staff member who
-- did the cancelling (they are the actor). The row carries the events
-- category, the event source_type/source_id, and the documented
-- /community/feed?event=<id> deep link, and nothing is ever enqueued into a
-- batch. An UPDATE that touches status without actually transitioning into
-- cancelled writes nothing, and a cancel -> republish -> cancel inside the
-- dedupe window is one cancellation, not two. A block edge between an
-- attendee and the canceller suppresses that attendee's row. An events
-- preference set to off suppresses it too, which is the whole point of the
-- new notif_pref_key arm - a row keyed literally event_cancelled does NOT
-- suppress, because the mapped key is the coarse events one the client's
-- preferences panel actually writes. A draft event that never had an
-- attendee cancels cleanly and notifies nobody.
--
-- Every state check runs as tests.clear_auth() (the bootstrap superuser,
-- which bypasses notifications' and notification_batches' own
-- select-your-own-row RLS) rather than as the acting member, so a check for
-- what landed in someone else's stream is not itself hidden by the RLS
-- boundary 0008/0018 already cover. Every cancellation is performed as the
-- coach, through the real events_update_perm policy, not as the superuser -
-- notif_create resolves the actor from auth.uid(), so the actor-exclusion
-- and block-edge branches only mean anything when a real member is acting.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- the trigger function is unreachable by a direct client RPC - the
-- migration's own "revoke execute from every client role" note
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.notif_on_event_cancelled() $$, '42501', null,
  'notif_on_event_cancelled cannot be called directly by a member');

-- =====================================================================
-- fixtures: four events and their RSVPs, a block edge between owner and
-- the coach who does every cancellation, and two preference rows. Built
-- as the bootstrap superuser.
-- =====================================================================
select tests.clear_auth();

insert into public.events (id, title, event_type, start_at, status, created_by) values
  ('e0290000-0000-4000-8000-000000000001', 'E1 mixed responses',   'workshop',
     now() + interval '3 days', 'published', tests.uid('coach')),
  ('e0290000-0000-4000-8000-000000000002', 'E2 block edge',        'seminar',
     now() + interval '4 days', 'published', tests.uid('coach')),
  ('e0290000-0000-4000-8000-000000000003', 'E3 preferences',       'social_night',
     now() + interval '5 days', 'published', tests.uid('coach')),
  ('e0290000-0000-4000-8000-000000000004', 'E4 draft, no RSVPs',   'other',
     now() + interval '6 days', 'draft',     tests.uid('coach'));

insert into public.event_attendees (event_id, user_id, response) values
  -- E1: one going, one interested, one not_going, and the canceller's own
  -- going RSVP.
  ('e0290000-0000-4000-8000-000000000001', tests.uid('m1'),    'going'),
  ('e0290000-0000-4000-8000-000000000001', tests.uid('m2'),    'interested'),
  ('e0290000-0000-4000-8000-000000000001', tests.uid('m3'),    'not_going'),
  ('e0290000-0000-4000-8000-000000000001', tests.uid('coach'), 'going'),
  -- E2: owner sits behind a block edge with the coach, m1 is the control.
  ('e0290000-0000-4000-8000-000000000002', tests.uid('owner'), 'going'),
  ('e0290000-0000-4000-8000-000000000002', tests.uid('m1'),    'going'),
  -- E3: norec has events off, m2 has a literal event_cancelled off row
  -- (the wrong key), m3 is the control with no preference row at all.
  ('e0290000-0000-4000-8000-000000000003', tests.uid('norec'), 'going'),
  ('e0290000-0000-4000-8000-000000000003', tests.uid('m2'),    'interested'),
  ('e0290000-0000-4000-8000-000000000003', tests.uid('m3'),    'going');

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('owner'), tests.uid('coach'));

insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('norec'), 'events', 'off'),
  (tests.uid('m2'),    'event_cancelled', 'off');

-- =====================================================================
-- E1: who gets a row when a published event is cancelled
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.events set status = 'cancelled'
     where id = 'e0290000-0000-4000-8000-000000000001' $$,
  'the coach cancels a published event through the real events_update_perm policy');

select tests.clear_auth();
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m1') and type = 'event_cancelled'
       and source_id = 'e0290000-0000-4000-8000-000000000001' $$,
  'a going attendee gets an immediate event_cancelled row');
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m2') and type = 'event_cancelled'
       and source_id = 'e0290000-0000-4000-8000-000000000001' $$,
  'an interested attendee gets one too');
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m3')
       and source_id = 'e0290000-0000-4000-8000-000000000001' $$,
  'a not_going attendee gets nothing - a not_going RSVP is an opt-out');
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('coach')
       and source_id = 'e0290000-0000-4000-8000-000000000001' $$,
  'the staff member who cancelled gets nothing, even though they RSVPd going - they are the actor');
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('owner')
       and source_id = 'e0290000-0000-4000-8000-000000000001' $$,
  'a member who never RSVPd to this event is not in the fan-out at all');
select results_eq(
  $$ select count(*)::int from public.notifications
     where source_id = 'e0290000-0000-4000-8000-000000000001' $$,
  $$ values (2) $$,
  'exactly two rows for the whole cancellation - the going and the interested attendee, nobody else');

-- --- the row shape the client's deep-link resolver depends on ---------
select results_eq(
  $$ select category, source_type, deep_link, body from public.notifications
     where user_id = tests.uid('m1') and source_id = 'e0290000-0000-4000-8000-000000000001' $$,
  $$ values ('events'::text, 'event'::text,
             '/community/feed?event=e0290000-0000-4000-8000-000000000001'::text,
             'E1 mixed responses'::text) $$,
  'the row carries the events category, the event source_type, the documented deep link, and the event title as its body');

-- --- immediate only, never batched -----------------------------------
select is_empty(
  $$ select 1 from public.notification_batches where category = 'events' $$,
  'event_cancelled is immediate - no events batch row was created for anyone');

-- =====================================================================
-- E1 again: a status UPDATE that is not a real transition, and a
-- re-cancellation inside the dedupe window
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.events set status = 'cancelled'
     where id = 'e0290000-0000-4000-8000-000000000001' $$,
  'the coach writes cancelled over cancelled - the trigger fires, the transition guard does not');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where source_id = 'e0290000-0000-4000-8000-000000000001' $$,
  $$ values (2) $$,
  're-writing the same status wrote no second round of rows');

select tests.set_auth(tests.uid('coach'));
update public.events set status = 'published'
  where id = 'e0290000-0000-4000-8000-000000000001';
select lives_ok(
  $$ update public.events set status = 'cancelled'
     where id = 'e0290000-0000-4000-8000-000000000001' $$,
  'the event is republished and cancelled again inside the dedupe window');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where source_id = 'e0290000-0000-4000-8000-000000000001' $$,
  $$ values (2) $$,
  'the dedupe window treats cancel -> republish -> cancel as one cancellation, not two');

-- =====================================================================
-- E2: a block edge between an attendee and the canceller
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.events set status = 'cancelled'
     where id = 'e0290000-0000-4000-8000-000000000002' $$,
  'the coach cancels the event owner has RSVPd going to');

select tests.clear_auth();
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('owner')
       and source_id = 'e0290000-0000-4000-8000-000000000002' $$,
  'the attendee on the other side of a block edge with the canceller gets nothing');
select results_eq(
  $$ select count(*)::int from public.notifications
     where source_id = 'e0290000-0000-4000-8000-000000000002' $$,
  $$ values (1) $$,
  'only the unblocked going attendee got a row - the block suppressed exactly one recipient, not the fan-out');

-- =====================================================================
-- E3: the notification_preferences key this migration added
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.events set status = 'cancelled'
     where id = 'e0290000-0000-4000-8000-000000000003' $$,
  'the coach cancels the event with the preference fixtures on it');

select tests.clear_auth();
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('norec')
       and source_id = 'e0290000-0000-4000-8000-000000000003' $$,
  'an events preference set to off suppresses the row - notif_pref_key maps event_cancelled onto the coarse events key');
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m2')
       and source_id = 'e0290000-0000-4000-8000-000000000003' $$,
  'a preference row keyed literally event_cancelled does not suppress anything - events is the mapped key, so the fallback is not in play');
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m3')
       and source_id = 'e0290000-0000-4000-8000-000000000003' $$,
  'the control attendee with no preference row at all is notified - a missing row is in_app');
select results_eq(
  $$ select count(*)::int from public.notifications
     where source_id = 'e0290000-0000-4000-8000-000000000003' $$,
  $$ values (2) $$,
  'exactly the two non-off attendees got a row');

-- =====================================================================
-- E4: a draft event with no attendees cancels cleanly
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ update public.events set status = 'cancelled'
     where id = 'e0290000-0000-4000-8000-000000000004' $$,
  'cancelling a draft event that never had an RSVP raises nothing');

select tests.clear_auth();
select is_empty(
  $$ select 1 from public.notifications
     where source_id = 'e0290000-0000-4000-8000-000000000004' $$,
  'and notifies nobody, because a draft event can have no attendees to begin with');

select * from finish();
rollback;
