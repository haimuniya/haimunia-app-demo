# COMM-220 Weekly member recap Edge Function

Phase: 2
Agent: recaps
Status: todo
Attendance-blocked: no

## User outcome

Every active member gets a weekly summary of their training and community
activity waiting for them once a week.

## Acceptance criteria

- [ ] `recap_weekly` Edge Function runs weekly and is idempotent per user per
  ISO week: a rerun for a week already generated updates the existing row in
  place rather than duplicating or double-notifying.
- [ ] Recap content: sessions completed, current streak, PRs, achievements
  unlocked, the member's own challenge progress, aggregate club challenge
  progress (no other member's individual data), and one upcoming event.
- [ ] The classmates line is omitted entirely in this ticket, per the parked
  bucket; it lands with COMM-316 once attendance exists.
- [ ] Each generated recap calls `notif_create(user, 'weekly_recap', 'club',
  ...)` once, with a deep link to the recap surface (COMM-221).
- [ ] The function records success and failure counts with no personal
  content in its logs.
- [ ] A member with no activity that week still gets a recap row, an honest
  "quiet week" shape rather than being skipped.

## Frontend states

Not applicable. Scheduled server function. Surfaced through COMM-221.

## Client calls and contracts

- Not client-invoked. Runs as a scheduled Edge Function against
  `weekly_recaps`. See "Needs from schema, recaps" in
  `docs/community/contracts.md`.

## Validation rules and limits

- One row per `(user_id, week_start)`, enforced by a unique constraint.

## Migration outline

- `weekly_recaps` table, own-row select, service-role-only insert and
  update. See "Needs from schema, recaps". schema lands it. The weekly
  schedule itself (pg_cron or an external scheduler) is infra, not built by
  this ticket, same open item as the notification batch flusher's scheduler.

## Dependencies

- COMM-005, COMM-026, COMM-130.
