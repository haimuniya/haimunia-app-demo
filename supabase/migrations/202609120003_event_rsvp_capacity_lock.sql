begin;

-- Security hunt, round 7 (2026-09-12), race-condition agent.
--
-- enforce_event_capacity() (202608280010) read the events row with a plain
-- select, then counted 'going' rows, then compared to capacity - a classic
-- count-then-act window. Confirmed live against real local Postgres with
-- two concurrent RSVPs for the last open slot on a capacity=1 event: both
-- transactions read the same pre-insert count under READ COMMITTED (the
-- second cannot see the first's still-uncommitted row) and both committed,
-- landing 2 'going' rows against capacity 1.
--
-- Fix: lock the events row with SELECT ... FOR UPDATE before counting, the
-- same pattern challenge_progress_apply() already uses correctly for its
-- own read-then-write window (both the challenges row and the
-- challenge_participants row are locked before the increment). A second
-- concurrent RSVP for the same event now blocks on the row lock until the
-- first transaction commits, then takes a fresh READ COMMITTED snapshot
-- for its count query and correctly sees the now-committed 'going' row.

create or replace function public.enforce_event_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_event public.events;
  v_going integer;
begin
  if new.response <> 'going' then return new; end if;
  select * into v_event from public.events where id = new.event_id for update;
  if not found then raise exception 'event not found'; end if;
  if v_event.registration_deadline is not null and now() > v_event.registration_deadline then
    raise exception 'registration_closed';
  end if;
  if v_event.capacity is not null then
    select count(*) into v_going from public.event_attendees a
    where a.event_id = new.event_id and a.response = 'going' and a.user_id <> new.user_id;
    if v_going >= v_event.capacity then raise exception 'event_full'; end if;
  end if;
  return new;
end $$;

commit;
