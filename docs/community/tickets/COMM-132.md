# COMM-132 PR detection hook

Phase: 1
Agent: achievements
Status: todo
Attendance-blocked: no

## User outcome

The moment a member logs a lift that beats their best, the app knows.

## Acceptance criteria

- [ ] The workout log save path in `app.js` checks the new result against the
  member's prior best for that movement and rep scheme.
- [ ] On a new record, the app emits PR_CREATED on the event bus with
  movement, new result, previous result, improvement, and the record id.
- [ ] The check reuses the existing offline best-estimate helpers, no new
  math.
- [ ] Detection runs offline. The share prompt and any post wait for
  connectivity and a signed-in community session.
- [ ] No PR is inferred from an edit that lowers a value.
- [ ] Duplicate PR events for the same record are suppressed.

## Frontend states

- Offline: detection still runs, the prompt is queued for later.
- Online and signed in: the prompt from COMM-133 appears.

## Client calls and contracts

- Emits PR_CREATED via COMM-012. No RPC.

## Validation rules and limits

- Improvement is recomputed server-side before any post is created.

## Migration outline

- None.

## Dependencies

- COMM-012.
