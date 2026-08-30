-- COMM-020: real two-user RLS enforcement for 202608280010 (events set).
-- Boundaries: a draft event is readable only by its creator or a
-- community.event.manage holder, and only that permission creates, edits,
-- or deletes one. RSVP only for yourself, only on a published event, only
-- with recovery. Capacity and deadline are enforced by the trigger on the
-- direct RLS upsert, and a going->going update on a full event still
-- succeeds. An attendee who turned show_in_attendee_lists off is invisible
-- to other members but not to themselves or an event manager.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --- events created by the coach ----------------------------
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.events (id, title, event_type, start_at, status, capacity, created_by)
     values ('e0100000-0000-4000-8000-000000000001', 'Published', 'workshop',
             now() + interval '2 days', 'published', 1, tests.uid('coach')) $$,
  'a community.event.manage holder creates a published event');
insert into public.events (id, title, event_type, start_at, status, created_by)
  values ('e0100000-0000-4000-8000-000000000002', 'Draft', 'workshop',
          now() + interval '2 days', 'draft', tests.uid('coach'));
-- Published and uncapped, so the "no recovery method" RSVP assertion
-- below can hit an RLS rejection without also colliding with the
-- capacity-1 event's own trigger test further down this file.
insert into public.events (id, title, event_type, start_at, status, created_by)
  values ('e0100000-0000-4000-8000-000000000006', 'Published, open capacity', 'workshop',
          now() + interval '2 days', 'published', tests.uid('coach'));

-- --- draft visibility --------------------------------------
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.events where id = 'e0100000-0000-4000-8000-000000000002' $$,
  'a plain member cannot see a draft event');
select isnt_empty(
  $$ select 1 from public.events where id = 'e0100000-0000-4000-8000-000000000001' $$,
  'a plain member sees a published event');
select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select 1 from public.events where id = 'e0100000-0000-4000-8000-000000000002' $$,
  'the creator sees their own draft event');

-- --- only the permission can create -----------------------
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.events (title, event_type, start_at, created_by)
     values ('Mine', 'other', now() + interval '1 day', tests.uid('m1')) $$,
  '42501',
  null,
  'a plain member cannot create an event');

-- --- RSVP boundary ---------------------------------------
select lives_ok(
  $$ insert into public.event_attendees (event_id, user_id, response)
     values ('e0100000-0000-4000-8000-000000000001', tests.uid('m1'), 'going') $$,
  'a member RSVPs going for themselves on a published event');
select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ insert into public.event_attendees (event_id, user_id, response)
     values ('e0100000-0000-4000-8000-000000000006', tests.uid('norec'), 'going') $$,
  '42501',
  null,
  'a member with no recovery method cannot RSVP');
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ insert into public.event_attendees (event_id, user_id, response)
     values ('e0100000-0000-4000-8000-000000000002', tests.uid('m2'), 'going') $$,
  '42501',
  null,
  'a member cannot RSVP to a draft event');

-- --- capacity trigger on the direct upsert ---------------
select throws_ok(
  $$ insert into public.event_attendees (event_id, user_id, response)
     values ('e0100000-0000-4000-8000-000000000001', tests.uid('m2'), 'going') $$,
  'P0001',
  'event_full',
  'the capacity trigger blocks a second going on a capacity-1 event');
select lives_ok(
  $$ insert into public.event_attendees (event_id, user_id, response)
     values ('e0100000-0000-4000-8000-000000000001', tests.uid('m2'), 'interested') $$,
  'a non-going response is still allowed on a full event');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.event_attendees set response = 'going'
     where event_id = 'e0100000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  'a going->going update on a full event still succeeds');

-- --- show_in_attendee_lists ----------------------------
select tests.set_auth(tests.uid('m3'));
select results_eq(
  $$ select count(*)::int from public.event_attendees
     where event_id = 'e0100000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'another member sees an attendee whose list toggle is on');

select tests.clear_auth();
update public.profiles set show_in_attendee_lists = false where id = tests.uid('m1');
select tests.set_auth(tests.uid('m3'));
select is_empty(
  $$ select 1 from public.event_attendees
     where event_id = 'e0100000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  'an opted-out attendee is invisible to another member');
select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.event_attendees
     where event_id = 'e0100000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'an opted-out attendee still sees their own RSVP');
select tests.set_auth(tests.uid('coach'));
select results_eq(
  $$ select count(*)::int from public.event_attendees
     where event_id = 'e0100000-0000-4000-8000-000000000001' and user_id = tests.uid('m1') $$,
  $$ values (1) $$,
  'an event manager still sees an opted-out attendee');

select * from finish();
rollback;
