# COMM-300 Attendance-log mechanism and the ATTENDANCE_RECORDED source

Phase: 3
Agent: schema
Status: review
Attendance-blocked: no

This ticket IS the thing the parked bucket and COMM-302, 304, 305, 306, 307,
and 316 are all waiting on. It ships first in the Phase 3 build order, ahead
of every other Phase 3 schema work. See the 2026-08-30 resolved question in
`docs/community/backlog.md`: the attendance *source* is a member logging "I
trained today" — a workout/session log entry standing in for a class
check-in — never Arbox, never a dedicated in-app check-in flow. This ticket
is that mechanism.

## User outcome

A member who logs a training session in the (offline-first) training log app,
the way they already do today, has that session count as one day of verified
attendance everywhere Phase 3 reads attendance from — with no new button, no
new screen, and nothing to remember to do differently.

## Acceptance criteria

- [ ] A new `attendance_log` table exists: one row per `(user_id,
  occurred_on)`, unique on that pair, so three lifts logged on the same day
  produce exactly one attendance day, not three.
- [ ] Populated automatically, server-side, from the member's own existing
  session-logging sync path (`private_records`, the table that already
  carries every offline `strength_entry` and `wod_entry` a member logs,
  202608260001) — not from a new "check in" affordance. A trigger on
  `private_records` is the write path, not a new client call, so a member
  using an older cached build still produces attendance rows the moment
  their existing sync runs.
- [ ] `occurred_on` is read from the synced record's own logged date
  (`payload->>'date'` on a `strength_entry`/`wod_entry` row, per app.js's
  existing local entry shape — schema confirms this against a live sample
  row before writing the trigger, since it is reading a client-owned jsonb
  shape this file has never had to parse before). A record with no readable
  date, or a `record_type` outside the session-bearing set, produces no
  attendance row.
- [ ] A `deleted_at`-set (soft-deleted) `private_records` row is not counted
  and does not retroactively remove an attendance day already logged from an
  earlier, non-deleted entry the same day: this is append-only, matching the
  "correct forward, not backward" precedent `challenge_progress` already
  established in this schema (202608280009), not a bug to fix later.
- [ ] `ATTENDANCE_RECORDED`, defined with zero producers since COMM-012
  (Phase 0), gets its first real client-side emit: the sync path that writes
  a session-bearing `private_records` row (`flushOutbox()`) calls
  `HaimuniaEvents.emit(PRODUCT_EVENTS.ATTENDANCE_RECORDED, {occurred_on})`
  after a successful write, so any later client consumer (a future
  challenge auto-progress rule, for one) has the same hook every other
  typed event already offers. This emit is a courtesy for client
  consumers; it is not what writes `attendance_log` and nothing downstream
  may depend on it firing for correctness.
- [ ] An `attendance_recorded` analytics event is added to
  `HaimuniaAnalytics.EVENTS` and wired off the same bus emit
  (`BUS_EVENT_MAP`), with `HAND_PROP_KEYS`/`BUS_PROP_KEYS` carrying
  `occurred_on` only — no workout title, no result text. Added to
  `ACTIVE_MEMBER_EVENTS` (WCAM): training is real participation, the
  strongest one WCAM measures. Documented in `docs/community/metrics.md` in
  the same change, per that file's own standing rule, including a note that
  it closes the "Still not wired: Attendance" line at the bottom of that
  file.
- [ ] No client, admin included, can insert, update, or delete
  `attendance_log` directly. The trigger (security definer) is the only
  writer, the same "no client write, function owns it" shape
  `notification_batches` and `pins` already use.
- [ ] A member can read their own `attendance_log` rows. A
  `community.analytics.view` holder or real staff can read any row, for the
  Phase 3 tickets that read across members (COMM-304, COMM-306). A plain
  member reading another member's row is refused.
- [ ] One pgTAP-testable boundary this ticket's own acceptance criteria
  names explicitly for qa: logging two different session types on the same
  calendar day produces one row; logging on two different days produces
  two; a `bodyweight` or `measurement` record_type produces none.

## Frontend states

Not applicable on its own — this ticket adds no new screen. The emit and
the analytics wiring are silent, background effects of the existing sync
flow.

## Client calls and contracts

- No new RPC. The write path is a trigger on the existing direct-RLS
  `private_records` upsert (`flushOutbox()`, unchanged signature).
- New read: direct RLS select on `attendance_log`, own row. Cross-member
  reads happen only through the definer functions later Phase 3 tickets add
  (COMM-304, COMM-306, COMM-302, COMM-307), not through a direct select any
  client is expected to issue itself.

## Validation rules and limits

- `occurred_on` cannot be in the future relative to `now()` at insert time
  (a malformed local clock producing a future-dated entry should not count
  early); the trigger clamps or rejects rather than silently accepting it —
  schema's call which, consistent with the append-only philosophy above.
- No rate limit: this is a derived, trigger-driven write, not a
  member-initiated RPC call a member could spam.

## Migration outline

- `attendance_log(id uuid pk, user_id uuid not null references profiles(id)
  on delete cascade, club_id uuid not null default default_club_id(),
  occurred_on date not null, source_record_type text, source_record_id
  text, recorded_at timestamptz not null default now(), unique(user_id,
  occurred_on))`.
- RLS: own-row select for `authenticated`; a `community.analytics.view` or
  `is_staff()` select-any policy; no insert, update, or delete grant to any
  client role.
- One AFTER INSERT OR UPDATE trigger on `private_records`, security
  definer, filtering to session-bearing `record_type`s and non-deleted
  rows, upserting into `attendance_log` `on conflict (user_id, occurred_on)
  do nothing`.

## Dependencies

- COMM-011 (empty `coach_engagement_flags`, the seam this unblocks
  downstream), COMM-012 (the `ATTENDANCE_RECORDED` constant), COMM-013
  (analytics helper), the existing `private_records` table
  (202608260001).

## Note on scope

This ticket builds the source and nothing that reads it yet. It does not
flip the four `ATTENDANCE_RECORDED` achievement definitions to `enabled`
(COMM-305), does not populate `coach_engagement_flags` (COMM-304), does not
change `consistency_week_streaks()` (COMM-306), does not touch `feed_page`
or `people_suggestions` (COMM-302, COMM-307), and does not touch recaps or
onboarding (COMM-316). Every one of those reads `attendance_log` once it
exists; none of them needs to know how it got populated.

## Note on what "verified" means here

Every later Phase 3 ticket title that says "verified attendance" means
"derived server-side from the member's own private training log, not
proxied through an optional public post-share" — the same trust boundary
`private_records` already has today (a member's own device, upserted under
their own-row RLS). It is not a physical check-in, not staff-confirmed, and
a determined member could still misdate a local entry before it syncs.
This is the accepted shape of the 2026-08-30 resolution ("self-reported...
not a dedicated check-in flow"), not a gap this ticket leaves open. Worth
confirming with the user that "verified" in the later ticket titles is not
read as stronger than this.
