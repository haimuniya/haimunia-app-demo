# COMM-112 Feed diversity rules

Phase: 1
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

The feed does not bury the member in a run of near-identical posts from one
person or one system source.

## Acceptance criteria

- [ ] No more than 2 consecutive posts from the same member.
- [ ] No more than 2 consecutive system-generated posts.
- [ ] No more than 3 consecutive workout cards.
- [ ] After a run of workout posts, the next slot prefers an achievement,
  coach, challenge, or event post when one is available in the candidate set.
- [ ] The rule runs inside `feed_page` after scoring, before pagination, so
  pages stay stable.
- [ ] A fixture with a member posting five workouts in a row proves the
  reorder.

## Frontend states

Not applicable. Server ordering behavior. Visible through the rendered feed.

## Client calls and contracts

- Internal to `feed_page`. No new contract.

## Validation rules and limits

- If the candidate set cannot satisfy a rule, the function relaxes that rule
  rather than returning fewer items.

## Migration outline

- Logic inside `feed_page`. schema owns the function body.

## Dependencies

- COMM-110.
