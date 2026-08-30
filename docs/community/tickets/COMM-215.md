# COMM-215 Event types and add to calendar

Phase: 2
Agent: events
Status: todo
Attendance-blocked: no

## User outcome

A member can tell what kind of event it is at a glance and add it to their
own calendar app.

## Acceptance criteria

- [ ] Each of the nine `event_type` values (workshop, competition,
  social_night, outdoor_workout, running_meetup, holiday_event, seminar,
  community_event, other) renders a distinct label and icon.
- [ ] "Add to Calendar" produces a downloadable `.ics` file built entirely
  client-side from the event's own fields, no external service call.
- [ ] The `.ics` includes title, start, end (defaults to `start_at` plus one
  hour when `end_at` is null), location, description, and a link back to the
  event inside the app.
- [ ] Generating the file works offline once the event detail has already
  loaded.
- [ ] A cancelled event's calendar file, if downloaded before cancellation,
  is the member's own concern; the app does not attempt to revoke a file
  already saved to a device.

## Frontend states

- Empty: not applicable.
- Loading: the Add to Calendar button shows a brief spinner while the file is
  generated (typically instant).
- Error: "לא ניתן היה ליצור קובץ יומן." on a malformed date (should not occur
  given the table CHECKs, defensive only).
- Populated: type badge on the card and detail, working download link.

## Client calls and contracts

- No new contract. Reads the same `events` row COMM-213 already fetched.

## Validation rules and limits

- `.ics` content escapes text fields per the iCalendar spec (commas,
  semicolons, newlines).

## Migration outline

- None.

## Dependencies

- COMM-213.
