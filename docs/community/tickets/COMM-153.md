# COMM-153 Moderation queue actions

Phase: 1
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

A reviewer can act on a report and the outcome is recorded with who did it
and when.

## Acceptance criteria

- [ ] Actions: view context, remove content, warn member, temporary posting
  restriction, permanent posting restriction, dismiss report.
- [ ] Every action routes through `mod_review` and writes reviewer id, note,
  and timestamp.
- [ ] Remove content sets the post or comment status to removed, it stops
  showing for everyone.
- [ ] A temporary restriction has an end time. A permanent one does not.
- [ ] A restricted member cannot create posts or comments until the
  restriction ends, enforced by policy, not the client.
- [ ] Each action writes an `admin_actions` row with before and after.
- [ ] Dismiss closes the report with a dismissed status.

## Frontend states

- Per action: a confirm with an optional note.
- Loading: the action shows a spinner.
- Error: "Could not complete the action. Try again."
- Populated: the row moves to its new status.

## Client calls and contracts

- `mod_review(report_id uuid, decision text, note text) returns void`.
- Restriction enforced by a `posting_restrictions` check in the post and
  comment create policies.

## Validation rules and limits

- `decision` in remove, warn, restrict_temp, restrict_permanent, dismiss.
- Note max 500 characters.

## Migration outline

- `posting_restrictions` table, `mod_review` extended to handle restrictions
  and to call `log_admin_action`. schema lands it.

## Dependencies

- COMM-009, COMM-152.
