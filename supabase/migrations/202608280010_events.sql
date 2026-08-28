begin;

-- COMM-007. Club events and RSVPs. Consumed in Phase 2 (COMM-213 onward).

create table public.events (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  event_type text not null check (event_type in (
    'workshop', 'competition', 'social_night', 'outdoor_workout', 'running_meetup',
    'holiday_event', 'seminar', 'community_event', 'other'
  )),
  image_url text check (image_url is null or char_length(image_url) <= 500),
  location text check (location is null or char_length(location) <= 240),
  map_link text check (map_link is null or char_length(map_link) <= 500),
  start_at timestamptz not null,
  end_at timestamptz,
  capacity integer check (capacity is null or capacity > 0),
  registration_deadline timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled', 'past')),
  created_at timestamptz not null default now(),
  check (end_at is null or end_at >= start_at)
);
create index events_upcoming_idx on public.events(status, start_at);

create table public.event_attendees (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  response text not null check (response in ('going', 'interested', 'not_going')),
  registered_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index event_attendees_user_idx on public.event_attendees(user_id);
create index event_attendees_going_idx on public.event_attendees(event_id) where response = 'going';

alter table public.events enable row level security;
alter table public.event_attendees enable row level security;

revoke all on public.events, public.event_attendees from public, anon;
grant select, insert, update, delete on public.events to authenticated;
grant select, insert, update, delete on public.event_attendees to authenticated;

create policy events_read on public.events for select to authenticated using (
  status <> 'draft'
  or created_by = auth.uid()
  or public.has_perm('community.event.manage')
);
create policy events_insert_perm on public.events for insert to authenticated
  with check (public.has_perm('community.event.manage') and created_by = auth.uid());
create policy events_update_perm on public.events for update to authenticated
  using (public.has_perm('community.event.manage'))
  with check (public.has_perm('community.event.manage'));
create policy events_delete_perm on public.events for delete to authenticated
  using (public.has_perm('community.event.manage'));

-- An attendee row is visible to the member themselves, to whoever manages
-- events, and to other members only when the attendee has not opted out of
-- attendee lists (their own toggle AND the club-wide override, both
-- resolved by can_view_profile_field).
create policy event_attendees_read on public.event_attendees for select to authenticated using (
  user_id = auth.uid()
  or public.has_perm('community.event.manage')
  or public.can_view_profile_field(user_id, 'show_in_attendee_lists')
);
create policy event_attendees_rsvp_self on public.event_attendees for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_community_member()
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'published')
  );
create policy event_attendees_update_self on public.event_attendees for update to authenticated
  using (user_id = auth.uid() or public.has_perm('community.event.manage'))
  with check (user_id = auth.uid() or public.has_perm('community.event.manage'));
create policy event_attendees_delete_self on public.event_attendees for delete to authenticated
  using (user_id = auth.uid() or public.has_perm('community.event.manage'));

-- Capacity and deadline live in a trigger, not only in event_rsvp(), so a
-- direct RLS upsert cannot walk past them. The count excludes the row
-- being written, which is what makes a going -> going update idempotent
-- on a full event instead of a spurious rejection.
--
-- SECURITY DEFINER is load-bearing here, not habit. event_attendees_read
-- hides attendees who opted out of attendee lists, so an invoker-rights
-- count would see only the subset of "going" rows THIS member is allowed
-- to see and would happily let them past a full event. The function takes
-- no arguments and can only ever be reached as a trigger on the row being
-- written, so there is no caller-supplied input to check.
create or replace function public.enforce_event_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_event public.events;
  v_going integer;
begin
  if new.response <> 'going' then return new; end if;
  select * into v_event from public.events where id = new.event_id;
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
create trigger event_attendees_capacity before insert or update of response
  on public.event_attendees for each row execute function public.enforce_event_capacity();

create or replace function public.event_rsvp(p_event_id uuid, p_response text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if p_response not in ('going', 'interested', 'not_going') then
    raise exception 'unknown rsvp response %', p_response;
  end if;
  if not exists (select 1 from public.events e where e.id = p_event_id and e.status = 'published') then
    raise exception 'event not open for rsvp';
  end if;
  insert into public.event_attendees (event_id, user_id, response)
  values (p_event_id, v_uid, p_response)
  on conflict (event_id, user_id) do update set response = excluded.response, registered_at = now();
end $$;
revoke all on function public.event_rsvp(uuid, text) from public, anon;
grant execute on function public.event_rsvp(uuid, text) to authenticated;

commit;
