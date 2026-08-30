# COMM-217 Upcoming event card in the feed top area

Phase: 2
Agent: events
Status: todo
Attendance-blocked: no

## User outcome

A member sees the next upcoming club event without leaving the feed.

## Acceptance criteria

- [ ] The feed top area (COMM-115) gains an upcoming-event card showing the
  soonest published, non-cancelled event with `start_at > now()`.
- [ ] The card shows title, date and time, going count, and quick Going or
  Interested actions that call `event_rsvp` directly without leaving the
  feed.
- [ ] When there is no upcoming event, the slot is omitted entirely, not
  rendered as an empty placeholder.
- [ ] Tapping the card opens the full event detail (COMM-213).
- [ ] The card refreshes on feed load; it does not need a realtime
  subscription of its own.

## Frontend states

- Empty: the slot is simply absent (see acceptance criteria).
- Loading: skeleton card matching the other top-area skeletons.
- Error: the slot degrades to absent rather than showing a broken card.
- Populated: title, date/time, going count, quick RSVP actions.

## Client calls and contracts

- Direct RLS read on `events` for the soonest published upcoming row.
- `event_rsvp(p_event_id, p_response)` for the quick actions.

## Validation rules and limits

- Only ever shows one event, the single soonest upcoming one.

## Migration outline

- None.

## Dependencies

- COMM-115, COMM-213, COMM-214.
