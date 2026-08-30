# COMM-229 Web push subscription and service worker handler, behind a flag

Phase: 2
Agent: notifications
Status: todo
Attendance-blocked: no

## User outcome

A member who opts in gets a push notification even when the app is closed,
on a browser that supports it.

## Acceptance criteria

- [ ] `NOTIF_PUSH_ENABLED` gains a real implementation behind the flag; it
  stays default off in production until VAPID keys are provisioned (per the
  plan's operator checklist), and this ticket does not flip the production
  default itself.
- [ ] Setting a `notification_preferences.channel` to `push` for any type
  triggers the browser permission prompt; on grant, the client registers a
  `PushSubscription` and writes `{endpoint, keys}` to `push_subscriptions`
  under the existing own-row RLS (table already shipped in 202608280008, no
  schema change).
- [ ] `sw.js` gains a `push` event handler that renders a notification from
  the payload's title, body, and deep link, and a `notificationclick`
  handler that focuses an open app window or opens one at the deep link.
- [ ] Revoking browser permission or unsubscribing sets `revoked_at` on the
  row rather than deleting it, matching the existing partial index
  `where revoked_at is null`.
- [ ] On iOS Safari without an installed PWA, the push option is disabled
  with an explanatory message rather than a silent failed prompt; installed
  Safari 16.4+ is accepted product scope, not flagged as a blocker, per the
  2026-08-30 decision.
- [ ] Actually sending a push (the server-side Web Push protocol call using
  VAPID keys) is out of this ticket's scope: it needs `notif_push_send`, a
  service-role Edge Function or scheduled job not built here, the same
  "storage exists, delivery scheduler does not" pattern already logged for
  the Phase 1 batch flusher. This ticket ships the subscription and the
  client handler so the send path has something to call once it exists.

## Frontend states

- Empty: push never opted into, the preference row shows "כבוי" the same as
  any other channel.
- Loading: the permission prompt itself is the loading state; no custom UI
  spinner needed.
- Error: permission denied shows "לא אושרה הרשאת התראות" and reverts the
  toggle to In-app.
- Populated: an active subscription shows "פעיל" next to the push option.

## Client calls and contracts

- Direct RLS insert/update/delete on `push_subscriptions` (existing table
  and policies).
- Direct RLS upsert on `notification_preferences` (existing, COMM-144).

## Validation rules and limits

- `endpoint` unique per row, matching the existing table constraint.
- No new server-side rate limit; subscription writes are infrequent by
  nature.

## Migration outline

- None for storage. `notif_push_send` (the actual send path) is a separate
  infra item, see "Needs from schema, notifications (Phase 2)" in
  `docs/community/contracts.md`, not built by this ticket.

## Dependencies

- COMM-005, COMM-140, COMM-144.

## Note

No "Message" affordance is added by this ticket. Direct messaging was
removed from scope entirely on 2026-08-30; this ticket is unrelated to it but
is recorded here since it is the notifications-area ticket most likely to be
confused with a messaging feature.
