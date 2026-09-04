# COMM-378 Onboarding step content editor

Phase: 4
Agent: admin-moderation
Status: done
Attendance-blocked: no

Assigned to admin-moderation rather than coach-tools: this is admin console
content management (the same cluster that already owns pinned content and
the announcement/analytics admin surfaces), not a member-relationship
action in the shape coach-tools' existing tickets (Welcome, Congratulate,
Engage, Member of the week) all are.

## User outcome

A staff member with the right permission can edit the title and lead
sentence of any of the five onboarding cards and see the change live,
without a code deploy.

## Acceptance criteria

- [ ] A new admin-only editor lists the five onboarding steps (welcome,
  first_week, first_month, first_class, third_class) each with its current
  title and body, editable inline.
- [ ] Saving a row calls a direct RLS update on `onboarding_step_content`
  (COMM-373); a save the server refuses (permission, or over the character
  cap) surfaces the real reason, not a generic failure.
- [ ] Gated on `has_perm('community.content.manage_onboarding')` or real
  `is_admin()`, matching the server policy — a coach without that
  permission does not see the editor entry point at all.
- [ ] `cloud.js`'s existing `renderOnboardingWelcomeStep()` and its four
  siblings are updated to read `title`/`body` from the loaded
  `onboarding_step_content` state instead of a literal string, with the
  per-step computed lines (the active-challenge sentence in `first_week`,
  the sessions/PRs/achievements summary in `first_month`) left exactly as
  they are today, appended after the editable lead sentence — this ticket
  does not move that computed content into the table.
- [ ] The five cards a member actually sees are unchanged in copy on first
  deploy (COMM-373 seeds the table with today's exact text), so this
  ticket ships with zero visible change until someone edits a row.
- [ ] The step order and eligibility logic (`currentOnboardingStep()`) is
  untouched — this ticket edits copy only, never which step is due.

## Frontend states

- Loading: skeleton rows while `onboarding_step_content` loads.
- Error: "לא ניתן היה לטעון את תוכן ההיכרות." with retry; a failed save
  keeps the unsaved edit in the input rather than discarding it.
- Populated: five editable rows, each with its own save button and a
  per-row "saved" confirmation.
- Empty: not a real case — the table always has exactly five rows by
  construction (no insert/delete grant); not designed for.

## Client calls and contracts

- New read: direct RLS select on `onboarding_step_content` (own-audience,
  COMM-373).
- New write: direct RLS update on `onboarding_step_content`, gated by that
  table's own policy (COMM-373).

## Validation rules and limits

- Client mirrors the server caps (title ≤120 chars, body ≤2000 chars) so a
  rejection is rare, but the server CHECK is still the real limit.

## Migration outline

None. Client-only ticket.

## Dependencies

- COMM-373.
