# COMM-001 Migration: post_type enum and posts columns

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

The posts table can hold every structured post type the feed renders, with a
source link, visibility, status, and free-form metadata.

## Acceptance criteria

- [ ] A `post_type` enum exists with values POST_TEXT, POST_PHOTO,
  POST_WORKOUT, POST_PR, POST_ACHIEVEMENT, POST_ATTENDANCE_MILESTONE,
  POST_CHALLENGE, POST_EVENT, POST_ANNOUNCEMENT, POST_NEW_MEMBER, POST_COACH,
  POST_SYSTEM.
- [ ] `posts` has columns: `post_type` (enum, not null), `source_type` (text,
  null), `source_id` (uuid, null), `visibility` (enum club, friends, only_me,
  default club), `status` (enum active, hidden, removed, default active),
  `metadata` (jsonb, default `{}`), `published_at` (timestamptz, null),
  `deleted_at` (timestamptz, null), `is_pinned` (boolean, default false).
- [ ] Existing rows backfill to POST_WORKOUT or POST_ACHIEVEMENT based on
  current data, `visibility` club, `status` active.
- [ ] RLS: a reader sees a post when status is active and visibility permits
  (club member for club, follow edge for friends, author for only_me).
- [ ] `author_id` is nullable so POST_SYSTEM and POST_NEW_MEMBER can be
  authorless.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- Consumed later by `feed_page` and the `posts` agent render dispatch.

## Validation rules and limits

- `metadata` is validated by the writing function, not the column.
- `body` length cap 1000 stays enforced at write time, not by the column.

## Migration outline

- New enum types: `post_type`, `post_visibility`, `post_status`.
- `alter table posts add column ...` for each field.
- Backfill update for existing rows.
- Drop and recreate the posts select policy to include visibility.

## Dependencies

- None. First schema ticket.
