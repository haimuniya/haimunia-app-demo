# COMM-006 Migration: challenges, challenge_participants, challenge_progress, challenge_teams

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

The database can hold the six challenge types, participants, progress, and
teams, so the challenges feature has a home in Phase 2.

## Acceptance criteria

- [ ] `challenges`: `id` uuid pk, `club_id` uuid, `title` text, `description`
  text, `challenge_type` text (individual_target,
  individual_performance, cooperative, team, consistency, coach),
  `metric_type` text, `target_value` numeric null, `start_at` timestamptz,
  `end_at` timestamptz, `join_mode` text, `visibility` text, `status` text
  (draft, active, completed, archived), `created_by` uuid, `config` jsonb
  default `{}`.
- [ ] `challenge_participants`: (`challenge_id`, `user_id`) primary key,
  `team_id` uuid null, `joined_at` timestamptz, `status` text,
  `progress_value` numeric default 0, `completed_at` timestamptz null.
- [ ] `challenge_progress`: append-only log of contributions: `id` uuid pk,
  `challenge_id` uuid, `user_id` uuid, `delta` numeric, `source_type` text,
  `source_id` uuid, `created_at` timestamptz default now.
- [ ] `challenge_teams`: `id` uuid pk, `challenge_id` uuid, `name` text,
  `created_at` timestamptz default now.
- [ ] RLS: read by club members, create and edit by `community.challenge.create`
  holders, participants write only their own participation and progress.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- `chal_progress(challenge_id)` returns personal, team, and club progress.

## Validation rules and limits

- `challenge_type`, `status`, `join_mode` restricted by check constraints.
- `end_at` must be after `start_at`.

## Migration outline

- Four `create table` statements.
- RLS policies keyed to `has_perm` and participation.

## Dependencies

- COMM-008 for `has_perm`.
