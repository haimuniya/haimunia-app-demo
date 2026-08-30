# COMM-228 Member, event, and challenge search

Phase: 2
Agent: platform
Status: todo
Attendance-blocked: no

## User outcome

Typing a query finds matching members, events, and challenges in one place,
instead of only members.

## Acceptance criteria

- [ ] `community_search(query)` returns members, events, and challenges in
  one call, each grouped and capped (10 each).
- [ ] Members: the same shape and visibility `searchPeople` already provides
  (matched on handle or display name), unchanged for the existing caller.
- [ ] Events: matches `title`, published only unless the caller is the
  creator or holds `community.event.manage`, exactly what `events_read`
  already allows; the function does not see more than the caller could
  already see one row at a time.
- [ ] Challenges: matches `title` under the same rule as `challenges_read`.
- [ ] A query under 2 characters returns all three groups empty without a
  network call, matching the existing `searchPeople` threshold.
- [ ] No full-text or historical post search is added; this stays limited to
  members, events, and challenges per platform.md's explicit V1 exclusion.
- [ ] Results are grouped with a clear section per type in the UI, not
  interleaved.

## Frontend states

- Empty: fewer than 2 characters typed shows no results and no request.
- Loading: "מחפש...".
- Error: the search silently clears results rather than showing a broken
  state, matching `searchPeople`'s existing failure behavior.
- Populated: three grouped sections, any of which may be empty.

## Client calls and contracts

- `community_search(p_query text, p_limit int default 10) returns jsonb`.
  See "Needs from schema, platform (Phase 2)" in
  `docs/community/contracts.md`.

## Validation rules and limits

- `p_query` sanitized the same way `searchPeople` already strips
  `%_,()` before use.

## Migration outline

- `community_search`. See "Needs from schema, platform (Phase 2)". schema
  lands it.

## Dependencies

- COMM-006, COMM-007, existing `searchPeople`.
