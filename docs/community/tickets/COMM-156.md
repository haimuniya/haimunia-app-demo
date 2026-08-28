# COMM-156 Expose the HEAD_COACH role

Phase: 1
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

A head coach has the wider coaching powers the spec grants, without a full
admin grant.

## Acceptance criteria

- [ ] HEAD_COACH is selectable in admin member management alongside the
  existing coach grant.
- [ ] HEAD_COACH holds coach permissions plus `community.challenge.create`
  for selected challenge types, `community.announcement.publish`, and
  `community.event.manage`.
- [ ] Granting or revoking HEAD_COACH goes through the existing service-role
  path used for coach promotion, and writes `admin_actions`.
- [ ] STAFF and OWNER remain modelled but not exposed in the UI until Phase
  2.
- [ ] The coach badge shows "head coach" wording for this role.

## Frontend states

- In member management: a role selector with member, coach, head coach.
- Error: "Could not change the role." with no partial change.
- Populated: the member row shows the new role.

## Client calls and contracts

- Existing coach-promotion function extended to accept `head_coach`.

## Validation rules and limits

- Only OWNER or ADMIN can grant HEAD_COACH.

## Migration outline

- Seed the HEAD_COACH to permission mapping. Extend the promotion function.
  schema lands it with COMM-008.

## Dependencies

- COMM-008.
