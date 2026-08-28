# COMM-151 Report flow with reasons

Phase: 1
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

A member can report a post or comment, pick why, and add detail, then get a
plain acknowledgement.

## Acceptance criteria

- [ ] Report opens a sheet with reasons: harassment, spam, inappropriate
  content, privacy concern, unsafe training advice, other.
- [ ] An optional free-text field, capped.
- [ ] Submit shows "Report received." and nothing about consequences.
- [ ] A report targets a post or a comment and records reporter, reason,
  text, and time.
- [ ] Duplicate reports by the same member on the same target are collapsed,
  the reporter count still increments once per unique reporter.
- [ ] Reporting writes a `feed_interactions` row where the target is a post.

## Frontend states

- Sheet: reason list and optional text.
- Loading: Submit shows a spinner.
- Error: "Could not send the report. Try again." with the input kept.
- Done: "Report received." then the sheet closes.

## Client calls and contracts

- Existing `report(postId)` extended to `report(target_type, target_id,
  reason, note)`.

## Validation rules and limits

- Note max 500 characters.
- Reason in the allowed set.

## Migration outline

- `reports` gains `target_type`, `reason`, `note`, and a unique
  (`reporter_id`, `target_type`, `target_id`) constraint. schema lands it.
  Migration 202608270009 already added moderation visibility, extend it.

## Dependencies

- None hard. Pairs with COMM-152.
