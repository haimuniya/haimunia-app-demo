# COMM-134 Achievement unlock celebration and optional share

Phase: 1
Agent: achievements
Status: todo
Attendance-blocked: no

## User outcome

When a member unlocks an achievement, they see a small celebration and can
choose to share the badge.

## Acceptance criteria

- [ ] On ACHIEVEMENT_UNLOCKED, an in-app celebration shows the badge, title,
  and short explanation.
- [ ] Actions: Share to Club, Add a note, Not now.
- [ ] Share creates a POST_ACHIEVEMENT via `ach_share` and sets `shared_at`.
- [ ] Not now leaves the achievement earned and unshared.
- [ ] The Account achievements view lists earned badges and offers a later
  Share for any not yet shared.
- [ ] A private-visibility achievement offers no Share.

## Frontend states

- Celebration: badge and the three actions.
- Loading: Share shows a spinner.
- Error: "Could not share. Try again." with the achievement still earned.
- Account view: badge grid with earned and locked states.

## Client calls and contracts

- Consumes ACHIEVEMENT_UNLOCKED.
- `ach_share(member_achievement_id uuid, caption text, media jsonb) returns
  uuid`.

## Validation rules and limits

- Note max 1000 characters.

## Migration outline

- `ach_share` function. schema lands it.

## Dependencies

- COMM-004, COMM-106, COMM-130.
