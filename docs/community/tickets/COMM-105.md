# COMM-105 PR post card and PR share prompt

Phase: 1
Agent: posts
Status: todo
Attendance-blocked: no

## User outcome

When the app detects a personal record, the member is offered a ready-made
card and decides whether to share it.

## Acceptance criteria

- [ ] On PR_CREATED from the event bus, a prompt appears: "New PR detected.
  Share with the Club?" with Share, Add photo, Add note, Not now.
- [ ] The prompt never auto-publishes.
- [ ] POST_PR card fields: movement, new result, previous result, improvement,
  date, PR badge, optional note, optional photo.
- [ ] "Not now" dismisses without creating a post and does not nag again for
  the same record.
- [ ] Share creates a POST_PR row linked to the record.
- [ ] The prompt is a focus-trapped dialog with Escape mapped to "Not now".

## Frontend states

- Prompt: the four actions.
- Loading: Share shows a spinner.
- Error: "Could not share. Try again." with the prompt kept.
- Populated: the POST_PR card in the feed.

## Client calls and contracts

- Consumes PR_CREATED from COMM-012.
- Create via `publishWorkout` extended for POST_PR, or `pr_share(record_id,
  note, media) returns uuid`.

## Validation rules and limits

- Note max 1000 characters.
- Improvement is computed server-side from the record, not sent by the
  client.

## Migration outline

- `pr_share` function if adopted. schema lands it.

## Dependencies

- COMM-001, COMM-012, COMM-132, COMM-101.
