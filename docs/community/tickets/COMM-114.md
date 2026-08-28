# COMM-114 Feed impression and interaction tracking

Phase: 1
Agent: feed
Status: todo
Attendance-blocked: no

## User outcome

The team can measure which feed items are seen and acted on, so feed quality
can be judged with data.

## Acceptance criteria

- [ ] Each feed render assigns one `feed_session_id`.
- [ ] A post counts as an impression when its card is at least half visible
  for at least one second.
- [ ] Impressions are batched and flushed once per feed session, or on view
  change, whichever comes first.
- [ ] Opening a post writes a `feed_interactions` row with kind open and sets
  `opened` on the impression.
- [ ] React, comment, share, hide, save, and profile-open each write an
  interaction and set `engaged`.
- [ ] No tracking call blocks rendering.

## Frontend states

Not applicable. Background tracking.

## Client calls and contracts

- `feed_record_impressions(rows jsonb)`.
- `feed_record_interaction(post_id uuid, kind text)`.

## Validation rules and limits

- Batch capped at 50 rows.
- Duplicate impressions for the same post in one session are collapsed.

## Migration outline

- None. Uses COMM-003.

## Dependencies

- COMM-003, COMM-110.
