# COMM-221 Weekly recap surface and share

Phase: 2
Agent: recaps
Status: todo
Attendance-blocked: no

## User outcome

A member opens their weekly recap and can share one part of it to the feed
if they choose to.

## Acceptance criteria

- [ ] A recap screen is reachable from the `weekly_recap` notification's deep
  link and from an entry point in the member's account tab ("View Week").
- [ ] Shows exactly the fields COMM-220 generated: sessions, streak, PRs,
  achievements, own challenge progress, club challenge progress, one
  upcoming event.
- [ ] A week with no logged activity shows an honest "quiet week" state
  built from the same row (see COMM-220), never a blank or broken screen.
- [ ] "Share Recap" is the only way recap content reaches the feed; it is
  never posted automatically. It creates a post via `post_create` carrying a
  figure the member picks (for example, sessions this week or current
  streak).
- [ ] Only the member's own recaps are readable; a request for another
  member's `weekly_recaps` row is refused by RLS, not by client logic.
- [ ] Past weeks are browsable, not just the current one.

## Frontend states

- Empty: `weekly_recaps` has no row yet for a brand-new member shows "אין
  עדיין סיכום שבועי."
- Loading: skeleton recap card.
- Error: "לא ניתן היה לטעון את הסיכום השבועי. נסו שוב."
- Populated: the recap fields, plus the "quiet week" variant when applicable.

## Client calls and contracts

- Direct RLS select on `weekly_recaps`, own row.
- `post_create(body, visibility, media, links)` for Share Recap.

## Validation rules and limits

- Share Recap body still obeys the existing 1000-char post cap and the
  existing post rate limit.

## Migration outline

- None new. Uses `weekly_recaps` from COMM-220.

## Dependencies

- COMM-220, COMM-102, COMM-140.
