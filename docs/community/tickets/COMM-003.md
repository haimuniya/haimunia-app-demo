# COMM-003 Migration: feed_impressions and feed_interactions

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

The product can measure feed quality: what was shown, in what position, and
what the member did with it.

## Acceptance criteria

- [ ] `feed_impressions`: `id` uuid pk, `user_id` uuid not null, `post_id`
  uuid not null, `position` smallint not null, `feed_session_id` uuid not
  null, `shown_at` timestamptz not null, `opened` boolean default false,
  `engaged` boolean default false.
- [ ] `feed_interactions`: `id` uuid pk, `user_id` uuid not null, `post_id`
  uuid not null, `kind` text not null (open, react, comment, share, hide,
  save, profile_open), `created_at` timestamptz default now.
- [ ] Index on (`user_id`, `shown_at`) and (`post_id`).
- [ ] RLS: a member reads and writes only rows where `user_id` is
  `auth.uid()`.
- [ ] Bulk insert of 20 impression rows in one call succeeds.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- `feed_record_impressions(rows jsonb)` writes impressions.
- `feed_record_interaction(post_id uuid, kind text)` writes one interaction.

## Validation rules and limits

- `kind` restricted to the listed set by a check constraint.
- Impression batch capped at 50 rows per call.

## Migration outline

- Two `create table` statements.
- Indexes as listed.
- Own-row RLS policies.
- Functions `feed_record_impressions` and `feed_record_interaction`.

## Dependencies

- COMM-001.
