# COMM-233 Phase 2 analytics events

Phase: 2
Agent: platform
Status: todo
Attendance-blocked: no

## User outcome

Product analytics captures every new Phase 2 surface with the same
discipline Phase 1 established, so nothing shipped this phase is invisible
to the metrics that already exist.

## Acceptance criteria

- [ ] `challenge_joined` (bridged from `CHALLENGE_JOINED`, already in
  `BUS_EVENT_MAP`), `challenge_completed` (bridged from
  `CHALLENGE_COMPLETED`, already mapped), `event_registered` (bridged from
  `EVENT_REGISTERED`, already mapped) fire with no new wiring beyond
  confirming the bridge is exercised by the new Phase 2 producers
  (COMM-207, COMM-214).
- [ ] New hand-tracked events added to `HaimuniaAnalytics.EVENTS`:
  `challenge_viewed`, `event_viewed`, `leaderboard_viewed`, `recap_viewed`,
  `recap_shared`, `search_performed`, `push_opt_in`,
  `coach_congratulate_sent`, `directory_opened`.
- [ ] Every new event gets its row in `docs/community/metrics.md`'s event
  table (trigger surface, props) in the same change that wires it, per the
  file's own standing rule.
- [ ] `ACTIVE_MEMBER_EVENTS` (WCAM) is reviewed for the new list and updated
  explicitly, not left to default inclusion: `challenge_joined`,
  `challenge_completed`, and `event_registered` count (they were already
  qualifying activity types under the spec 78 definition);
  `leaderboard_viewed`, `recap_viewed`, `search_performed`, and
  `directory_opened` do not count, since viewing is not the same bar as
  posting, commenting, reacting, joining, or attending set by the existing
  definition; `coach_congratulate_sent` counts for the coach, not the
  celebrated member.
- [ ] No new event carries challenge rules text, recap figures beyond
  counts, search query text, or any other free-text content, matching the
  existing props discipline (`BUS_PROP_KEYS` allow-list for bridged events,
  hand-written allow-lists for the rest).

## Frontend states

Not applicable. Analytics wiring, verified through the existing test harness
for `src/analytics.js`.

## Client calls and contracts

- `window.analyticsTrack(name, props)` / `HaimuniaAnalytics.track`, unchanged
  signature from COMM-013.

## Validation rules and limits

- Same 3 KB client-side props budget and 4 KB server-side trigger cap as
  every existing event.

## Migration outline

- None. Uses `analytics_events` from 202608280012.

## Dependencies

- COMM-013, COMM-170, every Phase 2 feature ticket. This ticket lands last
  in the Phase 2 build order, once the surfaces it tracks exist.
