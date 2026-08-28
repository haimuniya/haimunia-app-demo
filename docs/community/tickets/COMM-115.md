# COMM-115 Feed top area

Phase: 1
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

The top of the feed surfaces the one announcement, the way to post, and the
active challenge, before the scroll begins.

## Acceptance criteria

- [ ] Order: top announcement if any, Create post button, active challenge
  card if any, then the feed items, with an optional upcoming event card
  inserted after the first few items.
- [ ] The announcement slot shows only a pinned or priority announcement, and
  only the single most important one.
- [ ] The active challenge card shows name, progress, and a Join or View
  action. It links to the challenge, which is a compact placeholder until
  Phase 2.
- [ ] The upcoming event card is hidden until the events feature lands in
  Phase 2. The slot is coded and dormant.
- [ ] The Create post button opens the composer from COMM-102.

## Frontend states

- Empty: only the Create post button when there is no announcement or
  challenge.
- Loading: skeletons for the announcement and challenge slots.
- Error: the top area degrades to just the Create post button.
- Populated: all present slots.

## Client calls and contracts

- Reads the current pinned announcement and the active challenge summary.
- No new contract. Uses existing announcement and weekly challenge reads.

## Validation rules and limits

- At most one announcement in the top slot.

## Migration outline

- None.

## Dependencies

- COMM-102, COMM-110.
