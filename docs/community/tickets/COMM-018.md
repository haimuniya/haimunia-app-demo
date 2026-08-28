# COMM-018 Privacy toggle model and RLS enforcement

Phase: 0
Agent: identity-privacy
Status: todo
Attendance-blocked: no

## User outcome

Every privacy toggle a member sets is enforced by the database, not just
hidden in the interface.

## Acceptance criteria

- [ ] The toggle set from COMM-010 is exposed in Account as a Privacy panel,
  Hebrew RTL, with clear labels, no reliance on color alone.
- [ ] Each toggle round-trips: set it, reload, another member's view reflects
  it, proven by a test that queries as the other member.
- [ ] Feed, profile, leaderboard, and search paths all call
  `can_view_profile_field` or an equivalent policy. No client-only hiding.
- [ ] Defaults on first load match COMM-010 defaults.
- [ ] `allow_mentions` false suppresses mention notifications. `allow_follows`
  false hides the follow button and rejects follow inserts at the policy.
- [ ] `in_leaderboards` false removes the member from every leaderboard
  result, with a "hide my result" affordance on the leaderboard too.

## Frontend states

- Loading: the panel shows skeleton rows.
- Error: "Could not save this setting" with the toggle reverted.
- Populated: toggles reflect stored values.

## Client calls and contracts

- Direct upsert into `profiles` privacy columns under own-row RLS.
- `can_view_profile_field(target uuid, field text) returns boolean`.

## Validation rules and limits

- Unknown toggle names are rejected by the function check.

## Migration outline

- None here. COMM-010 owns the columns and the function.

## Dependencies

- COMM-010.
