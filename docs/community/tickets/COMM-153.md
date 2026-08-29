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
- `posting_restrictions` landed in 202608280015 with a select policy and no
  write grant. `mod_review` cannot insert into it directly and should call
  `mod_restrict_member()` or `mod_lift_restriction()`, which check
  `community.member.restrict` and write their own `admin_actions` row.
  Enforcement is live already: `posts_insert_self` and `add_post_comment`
  both refuse a restricted member, and `comment_edit` does too, so an old
  comment cannot be rewritten into new content. `post_comments` gained a
  `status` column in 202608280016 for the remove-content decision.

## Dependencies

- COMM-009, COMM-152.
