# COMM-316 Monthly recap classmates and onboarding class steps, attendance

Phase: 3
Agent: recaps
Status: todo
Attendance-blocked: was — unblocked by COMM-300

Closes both parked COMM-P06 (weekly recap classmates line) and COMM-P07
(onboarding first and third class steps). Two forward references already
name this exact ticket: `weekly_recaps`'s own comment ("naming who else
trained would leak exactly the attendance data COMM-316 has not been
cleared to expose") and `onboarding_progress`'s ("The two steps tied to
first and third class attendance are not columns here; they land with
COMM-316"), plus COMM-222's own acceptance criteria, which explicitly
deferred these two steps to this ticket by name.

## User outcome

A member's weekly recap tells them, honestly for the first time, who else
they trained alongside that week — and a brand-new member gets a
first-class and a third-class onboarding nudge instead of the sequence
stopping after the first month.

## Acceptance criteria

- [ ] `recap_weekly` gains a classmates line: up to a small number of
  members the recap's own member shared an `attendance_log.occurred_on` day
  with that week, each gated by that candidate's own `show_attendance`
  toggle — a candidate with it off never appears in anyone else's recap,
  the same rule COMM-302 and COMM-307 already apply. The recap's own
  member's `show_attendance` toggle gates whether the line appears at all
  for them, not just whether their name appears in someone else's.
- [ ] The classmates line lists names, not just a count — this is the
  ticket `weekly_recaps.club_challenge_progress`'s own comment named as
  "not cleared to expose" until now: a recap is a private, own-row surface
  (`weekly_recaps` RLS, own-row select only), so naming individual
  classmates here does not leak the way it would in the club-wide monthly
  recap (COMM-309), which stays aggregate-only forever.
- [ ] `onboarding_progress` gains the two attendance-tied steps: a step
  shown after the member's first `attendance_log` row (their first
  logged class), and a step shown after their third distinct
  `attendance_log.occurred_on` day. Both follow the exact one-way-stamp,
  idempotent-across-devices shape the three existing steps
  (`welcomed_at`, `first_week_shown_at`, `first_month_shown_at`) already
  use — same `onboarding_progress_pin` trigger behaviour, extended to the
  two new columns.
- [ ] These two steps do not block or reorder the three already-shipped
  steps (COMM-222): a member's Day 1 welcome, first-week challenge nudge,
  and first-month summary appear on their existing schedule regardless of
  when the member's first or third class lands relative to those.
- [ ] `weekly_recaps`'s existing "quiet week" shape is unaffected: a member
  with zero attendance overlap that week gets an honest empty classmates
  line (omitted or a "אין חברים משותפים השבוע" line, recaps agent's call),
  not an error.

## Frontend states

- Empty (recap classmates line): no overlapping classmate that week — line
  omitted or shows a quiet-week message, recaps agent's call, consistent
  with the rest of the recap's existing quiet-week rendering.
- Loading: existing recap skeleton (COMM-221), unchanged.
- Error: existing recap error state, unchanged.
- Populated: classmates line with up to a small number of names, each
  linking to the member's profile.
- Onboarding steps: same four states COMM-222 already established
  (loading skeleton, silent-retry error, populated card with Dismiss),
  extended to the two new steps.

## Client calls and contracts

- `recap_weekly` Edge Function — same schedule and idempotency shape
  (COMM-220), output gains `classmates: [{user_id, display_name, handle,
  avatar_url}]` in the `weekly_recaps` row.
- Direct RLS select/update on `onboarding_progress`, own row — unchanged
  shape, two more nullable columns to read and stamp (COMM-222).

## Validation rules and limits

- Classmates line capped at a small fixed number (matching
  `people_suggestions`'s and COMM-307's own cap shape), ordered by number
  of shared days that week, ties broken by display name.
- The two new onboarding steps are one-way stamps, same as the existing
  three: clearing or re-stamping is a silent no-op, never an error.

## Migration outline

- `weekly_recaps` gains `classmates jsonb not null default '[]'`, written
  only by `recap_weekly` (service role), same grant shape every other
  column on that table already has.
- `onboarding_progress` gains `first_class_shown_at timestamptz` and
  `third_class_shown_at timestamptz`, both nullable, both covered by the
  existing `onboarding_progress_pin` trigger.

## Dependencies

- COMM-220, COMM-221, COMM-222, COMM-300.
