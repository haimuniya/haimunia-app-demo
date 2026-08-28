# COMM-011 Migration: empty coach_engagement_flags table

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

The coach Engage feature has a table ready, so wiring attendance later is a
data change, not a schema change.

## Acceptance criteria

- [ ] `coach_engagement_flags`: `id` uuid pk, `user_id` uuid not null,
  `level` text (mild, significant, inactive), `baseline_sessions_per_week`
  numeric null, `recent_sessions_per_week` numeric null, `flagged_at`
  timestamptz default now, `reviewed_by` uuid null, `reviewed_at` timestamptz
  null, `status` text (open, reviewed, dismissed) default open.
- [ ] RLS: readable and writable by `community.member.restrict` holders and
  coaches, never readable by the flagged member.
- [ ] Table ships empty. No producer writes to it until the attendance
  ticket lands.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- None in Phase 0. `coach-tools` reads it in Phase 3.

## Validation rules and limits

- `level` and `status` restricted by check constraints.

## Migration outline

- One `create table` statement.
- RLS policies keyed to `has_perm` and coach role, with an explicit deny for
  the subject member.

## Dependencies

- COMM-008 for `has_perm`.
- Unblocks COMM-P04 when an attendance source exists.
