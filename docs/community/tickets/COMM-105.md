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
- [ ] **Known limitation, not a bug to chase:** `movement` resolves only for a
  CUSTOM movement. Only `customMovements` are synced to `private_records`
  (`queueAllLocalRecordsForSync`, app.js), and `pr_share` publishes only what
  it can read from the caller's own server-side rows, so a PR on a built-in
  movement publishes its numbers with no name and the card falls back to
  `שיא אישי`. Closing it needs either a signature change carrying the
  movement name or a server-side catalogue of built-in movements — a separate
  ticket, not a silent client-supplied string.
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
- `pr_share(record_id text, note text default '', media jsonb default
  '[]'::jsonb, p_idempotency_key uuid default null) returns uuid` — adopted,
  and **shipped 202609060019**, not before. The client half was wired from the
  day this ticket landed and answered PGRST202 on every call until then.
- **`record_id` is `text`.** It is `entry.id` from the offline log —
  `uid("set")`, i.e. `"set-" + crypto.randomUUID()` — which will never cast to
  `uuid`. Contracts.md published `uuid` here until 202609060019 landed; that
  line is corrected. Do not "fix" the parameter type.

## Validation rules and limits

- Note max 1000 characters.
- Improvement is computed server-side from the record, not sent by the
  client. So are movement, new result, previous result and date: the call
  carries an id, a note and media and nothing else, and no caller-supplied
  figure can reach a card.
- A record id belonging to another member is refused (`not authorized`). A
  record id nobody holds server-side is **allowed** and publishes note and
  photo only — cloud backup is opt-out, so a member who declined it still
  owns the PR and must still be able to share it.
- A repeat share returns the first post's id and writes nothing.

## Migration outline

- `pr_share` function. Shipped by schema in 202609060019.

## Dependencies

- COMM-001, COMM-012, COMM-132, COMM-101.
