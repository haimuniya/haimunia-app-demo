# COMM-002 Migration: post_media table

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

A post can carry up to four photos, each with its own alt text.

## Acceptance criteria

- [ ] `post_media` table: `id` uuid pk, `post_id` uuid fk to posts on delete
  cascade, `storage_path` text not null, `alt_text` text null, `position`
  smallint not null (0 to 3), `width` int null, `height` int null,
  `created_at` timestamptz default now.
- [ ] Unique constraint on (`post_id`, `position`).
- [ ] A check or trigger caps rows per post at 4.
- [ ] RLS: read follows the parent post visibility. Insert and delete only by
  the post author, and only while the post is not removed.
- [ ] Storage path ownership is verified against the post author, matching the
  existing post-photo trigger from migration 202608270006.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- Read through `feed_page` join and the post detail read.
- Written by the composer path in the `posts` agent.

## Validation rules and limits

- Max 4 media rows per post.
- `alt_text` max 200 characters, enforced at write time.

## Migration outline

- `create table post_media ...`.
- Row-count trigger `post_media_max_four`.
- RLS policies mirroring the posts visibility helper.

## Dependencies

- COMM-001.
