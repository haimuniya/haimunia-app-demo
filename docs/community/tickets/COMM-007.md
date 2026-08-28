# COMM-007 Migration: events and event_attendees

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

The database can hold club events and RSVPs, so the events feature has a home
in Phase 2.

## Acceptance criteria

- [ ] `events`: `id` uuid pk, `club_id` uuid, `title` text, `description`
  text, `event_type` text (workshop, competition, social_night,
  outdoor_workout, running_meetup, holiday_event, seminar, community_event,
  other), `image_url` text null, `location` text null, `map_link` text null,
  `start_at` timestamptz, `end_at` timestamptz null, `capacity` int null,
  `registration_deadline` timestamptz null, `created_by` uuid, `status` text
  (draft, published, cancelled, past).
- [ ] `event_attendees`: (`event_id`, `user_id`) primary key, `response` text
  (going, interested, not_going), `registered_at` timestamptz default now.
- [ ] RLS: published events readable by club members, create and edit by
  `community.event.manage` holders, attendees write only their own row.
- [ ] A trigger or function blocks a new `going` row when capacity is full.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- Direct reads under RLS. RSVP is an upsert into `event_attendees`.
- Capacity check runs in `event_rsvp(event_id, response)`.

## Validation rules and limits

- `event_type`, `status`, `response` restricted by check constraints.
- RSVP `going` past `registration_deadline` is rejected.

## Migration outline

- Two `create table` statements.
- `event_rsvp` function with capacity and deadline checks.
- RLS policies keyed to `has_perm` and own-row.

## Dependencies

- COMM-008 for `has_perm`.
