# COMM-005 Migration: notifications, notification_preferences, push_subscriptions

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

The product can store a per-member notification stream, per-type delivery
preferences, and push endpoints for later use.

## Acceptance criteria

- [ ] `notifications`: `id` uuid pk, `user_id` uuid not null, `type` text not
  null, `category` text not null (community, training, challenges, events,
  club), `title` text, `body` text, `source_type` text null, `source_id` uuid
  null, `deep_link` text null, `read_at` timestamptz null, `created_at`
  timestamptz default now, `push_sent_at` timestamptz null.
- [ ] `notification_preferences`: `user_id` uuid, `type` text, `channel` text
  (push, in_app, off), primary key (`user_id`, `type`). Missing row means
  default on for in_app.
- [ ] `push_subscriptions`: `id` uuid pk, `user_id` uuid not null,
  `endpoint` text unique, `keys` jsonb, `created_at` timestamptz default now,
  `revoked_at` timestamptz null.
- [ ] RLS: all three are own-row read and write for the member. Insert of a
  notification is service role only.
- [ ] Index on `notifications` (`user_id`, `created_at` desc) and a partial
  index on unread.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- `notif_list(cursor, limit)`, `notif_mark_read(ids)`, `notif_unread_count()`.
- Preferences are a direct upsert under own-row RLS.

## Validation rules and limits

- `category` and `channel` restricted by check constraints.
- `deep_link` is an app route string, not an external URL.

## Migration outline

- Three `create table` statements.
- Indexes as listed.
- Own-row RLS, service-role insert policy for notifications.
- Functions `notif_list`, `notif_mark_read`, `notif_unread_count`.

## Dependencies

- None.
