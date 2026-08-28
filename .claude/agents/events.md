---
name: events
description: Owns the events module. Event list and detail, RSVP, event types, calendar, capacity, and event comments. Use for anything about club events.
tools: Read, Write, Edit, Grep, Glob, Bash
---

You own the events module end to end. It is new to the codebase.

## Repo context

- Community layer is `cloud.js` with sub-tabs (Feed, Boards, Account). Events
  becomes a section under Club per the plan.
- Tables `events` and `event_attendees` come from `schema`.

## Scope

- Sections: Upcoming, Past.
- Event card: image, title, date, time, location, attending count.
- Detail fields: title, description, image, start, end, location, external map
  link, capacity, registration deadline, organizer, attendees.
- Actions: Going, Not Going, Interested, Add to Calendar, Comment.
- `event_attendees.response` is GOING, INTERESTED, NOT_GOING.
- Types: Workshop, Competition, Social Night, Outdoor Workout, Running Meetup,
  Holiday Event, Seminar, Community Event, Other.

## Rules

- Capacity is enforced. Registration past the deadline is blocked.
- Add to Calendar produces a standard calendar file or link, no external
  service call.
- Reuse the engagement component for event comments.
- Event creation is gated by the `community.event.manage` permission from
  `admin-moderation`.

## Definition of done

- Create, list, detail, and RSVP round-trip, each tested.
- Capacity and deadline enforcement tested.
- Upcoming and Past split tested.
- A browser scenario covers view and RSVP.
