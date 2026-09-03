# COMM-373 Editable onboarding step content

Phase: 4
Agent: schema
Status: review — schema shipped (see docs/community/backlog.md Phase 4 section and contracts.md for final signatures)
Attendance-blocked: no

The five onboarding cards (`welcome`, `first_week`, `first_month`,
`first_class`, `third_class`) are hardcoded Hebrew strings inside
`renderOnboardingWelcomeStep()` and its four siblings in `cloud.js`. This
ticket moves the title and body of each card into a table a staff member
can edit from the app, with no code deploy. It does not change which step
is due when (`currentOnboardingStep()`'s fixed precedence order,
documented in that function's own comment as a deliberate anti-reorder
decision from COMM-222/COMM-316, is untouched) — see "Open questions" in
the backlog for why literal reordering is out of scope here.

## User outcome

A staff member can fix a typo or reword a welcome message without asking
for a code change, and every member still sees exactly one onboarding card
at a time, in the same order as today.

## Acceptance criteria

- [ ] A new `onboarding_step_content` table holds exactly five rows, one
  per step name, each with a title and a body.
- [ ] Seeded on migration with the current live Hebrew copy from `cloud.js`
  (all five cards), byte-for-byte, so the first deploy of this ticket
  changes nothing a member sees.
- [ ] Any authenticated member can read all five rows — the same audience
  the cards themselves already have, no privacy dimension (this is static
  club copy, not member data).
- [ ] Only `has_perm('community.content.manage_onboarding')` or real
  `is_admin()` can update a row. No client can insert or delete a row —
  the step set is exactly five and changing it is a migration, not an app
  action.
- [ ] Editing a row's title or body writes one `admin_actions` row
  (`onboarding_content_updated`, target_type `onboarding_step`, the step
  name and before/after title+body in the audit blobs) — the module's
  standing rule that a staff write to shared content is audited.
- [ ] `updated_by` cannot be forged by the client: it is pinned to
  `auth.uid()` server-side on every update, the same "trigger pins the
  column, the policy stays permissive" shape `protect_is_admin()` already
  uses.
- [ ] `dynamic content missing` cannot happen: the five rows always exist
  (no delete grant, no insert grant), so a reader that expects five rows
  never gets four.

## Frontend states

Not applicable on the schema side. See COMM-378 for the editor screen and
the one small change to `renderOnboardingStep()`'s existing render path
(reading title/body from state instead of a literal string).

## Client calls and contracts

- New: direct RLS select on `onboarding_step_content` (own-audience read,
  no function needed). Direct RLS update on the same table, gated by the
  policy above (also no function needed for the write itself — the audit
  trigger does the logging).

## Validation rules and limits

- `title` capped at 120 characters, `body` capped at 2000 characters —
  generous for a short onboarding card, tight enough to keep a staff typo
  from turning into a wall of text on a small screen.
- No new rate limit: a staff-only, low-frequency content edit.

## Migration outline

- `onboarding_step_content(step text primary key check (step in
  ('welcome','first_week','first_month','first_class','third_class')),
  title text not null check (char_length(title) <= 120), body text not
  null check (char_length(body) <= 2000), updated_by uuid references
  auth.users(id), updated_at timestamptz not null default now())`.
- Seed insert, five rows, current live copy from `cloud.js`'s
  `renderOnboardingWelcomeStep`/`renderOnboardingFirstWeekStep`/
  `renderOnboardingFirstMonthStep`/`renderOnboardingFirstClassStep`/
  `renderOnboardingThirdClassStep` (the static text only — `first_week`'s
  active-challenge line and `first_month`'s summary line are computed at
  render time from other state and are NOT part of this table; only the
  card's fixed title and lead sentence move here, see COMM-378's own note
  on where the split falls).
- RLS: `grant select to authenticated`, policy `using (true)`. `grant
  update to authenticated`, policy `using (has_perm
  ('community.content.manage_onboarding') or is_admin()) with check
  (same)`. No insert or delete grant to any client role.
- `onboarding_step_content_pin_updated_by` BEFORE UPDATE trigger: sets
  `new.updated_by = auth.uid()`, `new.updated_at = now()` regardless of
  what the client sent.
- `onboarding_step_content_audit` AFTER UPDATE trigger: calls
  `log_admin_action('onboarding_content_updated', 'onboarding_step', null,
  jsonb_build_object('step', old.step, 'title', old.title, 'body',
  old.body), jsonb_build_object('step', new.step, 'title', new.title,
  'body', new.body))`.
- New permission `community.content.manage_onboarding`, seeded to the same
  list `community.announcement.publish` already has (`coach`, `head_coach`,
  `staff`, `admin`, `owner`) — onboarding copy is club-wide messaging in
  the same spirit as an announcement.
- `admin_actions.action_type` CHECK widened to add
  `onboarding_content_updated`. `admin_actions.target_type` CHECK widened
  to add `onboarding_step`.

## Dependencies

- None on other Phase 4 tickets. COMM-378 (admin UI) and a small edit to
  `cloud.js`'s existing `renderOnboardingStep()` read path depend on this.

## Open question this ticket does not resolve

"Reorder" was named as part of the product ask, but the five steps'
precedence is tied to a real-world trigger each (join date, elapsed days,
attendance count) that a copy edit cannot change, and `cloud.js` already
documents the current fixed order as a deliberate decision against letting
a later-triggered step preempt an earlier one. This ticket ships copy
editing only. See backlog "Open questions" item on this.
