# COMM-302 Recurring classmate score once attendance lands

Phase: 3
Agent: feed
Status: todo
Attendance-blocked: was — unblocked by COMM-300

This is the ticket named against the parked COMM-P01 ("Feed class-connection
score") in `docs/community/backlog.md`, and the one two forward-references in
`docs/community/contracts.md` already named before it existed: `feed_page`'s
hard-coded `v_class_connection := 0` (202608280019) and `people_suggestions`'s
comment that a fourth signal branch is exactly one UNION ALL, one counter, and
one `signals` key away (202608290015).

## User outcome

A member's feed and their "people you might know" strip both notice, for the
first time, that they keep training on the same days as someone else — not
because they follow each other or reacted to the same post, but because they
actually show up around the same time.

## Acceptance criteria

- [ ] `feed_page`'s `v_class_connection` component stops being hard-0'd.
  Computed as the count of `attendance_log` days the viewer and the post's
  author share within a trailing window (COMM-306's leaderboard window is
  the model to match: recent, not lifetime), normalized 0..1 the same way
  every other component is before `v_w_class` (already reserved at weight
  6) applies. Zero shared days is 0, not an error, not omitted.
- [ ] `people_suggestions` (COMM-232) gains its fourth signal, `classmate`:
  count of overlapping `attendance_log.occurred_on` days with the caller in
  the same trailing window the other time-stamped signals already use (60
  days). Per COMM-232's own priority-order design, this signal's rank
  position among the existing three (challenge, interaction, event) is a
  product decision this ticket states explicitly rather than silently
  picking: recurring in-person overlap outranks a shared reaction or a
  shared "going" RSVP but not a shared live challenge, so the order becomes
  challenge, classmate, interaction, event.
- [ ] `signals` in the returned jsonb gains `shared_classmate_days`
  alongside the three existing counts. No existing key is renamed or
  removed — this is exactly the additive shape the COMM-232 migration's own
  comment already promised.
- [ ] `reason` can now be `'classmate'`, chosen the same way the other three
  already are (the strongest signal's label).
- [ ] Both computations respect `can_view_profile_field(candidate,
  'show_attendance')` — attendance is its own privacy toggle
  (202608280003), separate from `visible_to_club`, and a member with
  `show_attendance` off contributes no classmate signal to anyone, in
  either function, even though their `attendance_log` rows still exist and
  still count toward their own achievements and their own leaderboard rank.
  A block edge in either direction still excludes the pair entirely, as
  every other signal already does.
- [ ] No client change beyond the score now moving: `feed_page` and
  `people_suggestions` keep their existing signatures and return shapes.

## Frontend states

No new state. `people_suggestions`' existing "no signal, no card" empty
behaviour is unchanged — a member with zero overlap on every one of the four
signals still gets no card, not a padded one.

## Client calls and contracts

- `feed_page(cursor, limit, scope)` — unchanged signature, COMM-110.
- `people_suggestions(p_limit)` — unchanged signature, COMM-232. See
  "people_suggestions" in `docs/community/contracts.md`, which already
  documents this ticket's shape as a forward reference.

## Validation rules and limits

- The classmate window is 60 days, matching `people_suggestions`'s existing
  two time-stamped signals, not `attendance_log`'s full history — a
  training partnership from eight months ago should not outrank someone the
  member trained beside twice last week.
- `show_attendance` gates the signal per-candidate, independent of every
  other toggle already checked.

## Migration outline

- `create or replace function public.feed_page(...)` — same signature,
  `v_class_connection` computed from `attendance_log` instead of hard-coded,
  gated by `show_attendance`.
- `create or replace function public.people_suggestions(p_limit int)` —
  same signature, one more UNION ALL branch, one more `scored` column, one
  more `signals` key, `reason` priority updated.
- No new table. Depends on `attendance_log` (COMM-300).

## Dependencies

- COMM-300 (the source), COMM-110, COMM-112, COMM-125, COMM-232.
