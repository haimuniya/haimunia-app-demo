# COMM-004 Migration: achievement_definitions and member_achievements

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

Achievements are data, not hardcoded, and each member's unlocks are recorded
once with a share state.

## Acceptance criteria

- [ ] `achievement_definitions`: `id` uuid pk, `club_id` uuid null, `code`
  text unique, `name` text, `description` text, `category` text (consistency,
  performance, progress, community, challenge, club), `trigger_type` text,
  `threshold` numeric null, `repeatable` boolean default false, `visibility`
  text default club, `icon` text, `enabled` boolean default true, `config`
  jsonb default `{}`.
- [ ] `member_achievements`: `id` uuid pk, `user_id` uuid not null,
  `achievement_id` uuid fk, `source_id` uuid null, `unlocked_at` timestamptz
  default now, `shared_at` timestamptz null, `visibility` text default club.
- [ ] Unique on (`user_id`, `achievement_id`) when the definition is not
  repeatable.
- [ ] RLS: definitions readable by any club member, writable by admin only.
  member_achievements readable by the owner and by club members when
  visibility is club, writable by service role only.
- [ ] Attendance-triggered definition rows are allowed but ship with `enabled`
  false.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- `ach_evaluate(user_id, trigger, payload)` inserts member_achievements.
- `ach_share(member_achievement_id, caption, media)` sets shared_at and
  creates a POST_ACHIEVEMENT.

## Validation rules and limits

- `category` restricted by a check constraint.
- `code` is lower snake case, enforced by a check.

## Migration outline

- Two `create table` statements.
- Partial unique index for non-repeatable definitions.
- RLS policies as described.

## Dependencies

- COMM-001.
