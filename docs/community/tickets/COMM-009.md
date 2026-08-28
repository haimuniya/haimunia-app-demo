# COMM-009 Migration: admin_actions audit table

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

Every sensitive staff action is recorded with who, what, and the before and
after state.

## Acceptance criteria

- [ ] `admin_actions`: `id` uuid pk, `admin_id` uuid not null, `action_type`
  text not null, `target_type` text not null, `target_id` uuid null,
  `before_data` jsonb null, `after_data` jsonb null, `created_at` timestamptz
  default now.
- [ ] `action_type` covers content_delete, content_hide, member_restrict,
  member_unrestrict, role_change, challenge_edit, achievement_edit,
  privacy_config, content_pin, content_unpin, report_review.
- [ ] RLS: readable by `community.analytics.view` holders, insert by service
  role and `security definer` functions only, never updatable or deletable.
- [ ] A helper `log_admin_action(action_type, target_type, target_id, before,
  after)` exists for other functions to call.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- Read through the admin analytics and moderation views.
- Written only by server functions via `log_admin_action`.

## Validation rules and limits

- `action_type` and `target_type` restricted by check constraints.
- No update or delete policy exists, by design.

## Migration outline

- One `create table` statement.
- `log_admin_action` helper function.
- Read-only RLS for analytics holders.

## Dependencies

- COMM-008 for `has_perm`.
