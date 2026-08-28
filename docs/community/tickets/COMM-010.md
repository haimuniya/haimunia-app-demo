# COMM-010 Migration: profile privacy columns and defaults

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

Each member controls what other members see, and the defaults favor
reasonable privacy.

## Acceptance criteria

- [ ] `profiles` gains boolean columns: `visible_to_club`,
  `show_workout_results`, `show_attendance`, `show_upcoming_booking`,
  `show_prs`, `show_achievements`, `in_leaderboards`, `allow_follows`,
  `allow_mentions`, `allow_messages`, `show_birthday`,
  `show_in_attendee_lists`.
- [ ] Defaults: `visible_to_club` true, `allow_follows` true,
  `allow_mentions` true, `in_leaderboards` true, `show_achievements` true,
  `show_in_attendee_lists` true. `show_workout_results` false,
  `show_upcoming_booking` false, `show_prs` false, `show_birthday` false,
  `allow_messages` false.
- [ ] `can_view_profile_field(target uuid, field text) returns boolean`
  resolves the viewer against the target's toggles and block edges.
- [ ] Existing profile select policy is rewritten to respect
  `visible_to_club`.
- [ ] A club-wide admin override for `show_in_attendee_lists` exists as a club
  setting row.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- `can_view_profile_field(target uuid, field text) returns boolean`.

## Validation rules and limits

- `field` restricted to the known toggle names by a check inside the
  function.

## Migration outline

- `alter table profiles add column ...` for each toggle with defaults.
- `can_view_profile_field` function.
- Rewrite the profiles select policy.
- Club settings row for the attendee-list override.

## Dependencies

- Coordinates with COMM-018. COMM-018 owns the UI and the enforcement tests.
