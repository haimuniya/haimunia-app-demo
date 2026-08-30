# COMM-214 Event RSVP and capacity

Phase: 2
Agent: events
Status: todo
Attendance-blocked: no

## User outcome

A member RSVPs to an event, sees capacity reflected honestly, and is told if
an event they are going to gets cancelled.

## Acceptance criteria

- [ ] Going, Not Going, and Interested buttons call `event_rsvp(event_id,
  response)` (already shipped).
- [ ] A full event disables Going with a clear "האירוע מלא" state, and still
  allows Interested.
- [ ] An event past its registration deadline disables any RSVP change with
  "ההרשמה נסגרה."
- [ ] A capacity race between two members RSVPing for the last spot leaves
  exactly one `going`; the loser sees the `event_full` error, matching the
  existing `enforce_event_capacity` trigger.
- [ ] Cancelling an event (staff action from COMM-213) sends an immediate
  `event_cancelled` notification to every member whose RSVP on that event is
  `going` or `interested`.
- [ ] A `going` to `going` RSVP update on a full event still succeeds
  (idempotent), matching the trigger's existing exclusion of the row being
  written from its own capacity count.

## Frontend states

- Empty: not applicable, RSVP controls always render once an event exists.
- Loading: the tapped RSVP button shows a spinner.
- Error: "לא ניתן היה לעדכן את ההרשמה. נסו שוב." or the specific full/closed
  message.
- Populated: the button reflects the caller's current response.

## Client calls and contracts

- `event_rsvp(p_event_id uuid, p_response text) returns void` (shipped).

## Validation rules and limits

- `p_response` one of going, interested, not_going.
- Capacity and deadline enforced server-side by the existing trigger, not
  only by the client.

## Migration outline

- `notif_on_event_cancelled` trigger. See "Needs from schema, events" and
  "Needs from schema, notifications (Phase 2)" in
  `docs/community/contracts.md`. schema lands it.

## Dependencies

- COMM-007, COMM-213, COMM-005.
