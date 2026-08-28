# COMM-154 Admin action audit writes

Phase: 1
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

Every sensitive staff action leaves a record that a later review can trust.

## Acceptance criteria

- [ ] These actions write an `admin_actions` row via `log_admin_action`:
  content removal, content hide, member restriction and lift, role change,
  challenge edit, achievement definition edit, privacy config change, content
  pin and unpin, report review.
- [ ] Each row has `before_data` and `after_data` as compact JSON.
- [ ] The write happens inside the same function as the action, before it
  returns, so a failed log fails the action.
- [ ] Rows are never updatable or deletable.
- [ ] An admin log view lists recent actions for holders of the analytics
  permission, filterable by action type and admin.

## Frontend states

- Log view empty: "No admin actions recorded yet."
- Loading: skeleton rows.
- Error: "Could not load the log."
- Populated: rows with actor, action, target, time.

## Client calls and contracts

- Reads a `admin_actions_page(cursor, limit, filters)` function.
- Writes happen server-side only via `log_admin_action`.

## Validation rules and limits

- `before_data` and `after_data` capped at 8 KB each.

## Migration outline

- `admin_actions_page` function. schema lands it. `log_admin_action` from
  COMM-009 is called by every relevant function.

## Dependencies

- COMM-009.
