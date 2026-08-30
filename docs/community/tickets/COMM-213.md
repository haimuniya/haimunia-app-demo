# COMM-213 Events tables consumption, list and detail

Phase: 2
Agent: events
Status: todo
Attendance-blocked: no

## User outcome

A member browses upcoming and past club events, opens one for full detail,
and a coach can create or edit one.

## Acceptance criteria

- [ ] Upcoming and Past sections, split on `status` and `start_at`.
- [ ] Event card: image, title, date, time, location, attending (`going`)
  count.
- [ ] Detail: title, description, image, start, end, location, external map
  link, capacity, registration deadline, organizer (creator's display name),
  attendee list respecting `show_in_attendee_lists`.
- [ ] A coach or admin create/edit form, gated by `community.event.manage`,
  writes directly to `events` under the existing RLS policies, with a
  draft-to-published status toggle.
- [ ] Cancelling an event sets `status = 'cancelled'`; it moves out of
  Upcoming, stays visible in Past marked cancelled.
- [ ] `renderPostCard`'s POST_EVENT renderer is upgraded from the COMM-101
  fallback link card to a real event card.

## Frontend states

- Empty: no upcoming events shows "אין אירועים קרובים כרגע."
- Loading: skeleton event card and skeleton detail.
- Error: "לא ניתן היה לטעון את האירוע. נסו שוב."
- Populated: sections and detail as specified.

## Client calls and contracts

- Direct RLS read/insert/update on `events` (existing policies, COMM-007).
- Direct RLS read on `event_attendees` for the going count and attendee list.

## Validation rules and limits

- Title 1-120 chars, description up to 4000 chars, location up to 240 chars,
  matching the table CHECKs.
- `end_at >= start_at` when set, enforced by the table CHECK.

## Migration outline

- None new. Uses `events` and `event_attendees` from 202608280010.

## Dependencies

- COMM-007, COMM-101, COMM-008.
