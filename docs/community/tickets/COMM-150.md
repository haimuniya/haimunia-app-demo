# COMM-150 RBAC permission strings in the client

Phase: 1
Agent: admin-moderation
Status: todo
Attendance-blocked: no

## User outcome

What a member can do in the community is driven by named permissions, so a new
role never needs a code change on the client.

## Acceptance criteria

- [ ] `cloud.js` gates every staff action on `has_perm('community.x.y')`, not
  on `is_admin` or `role === 'coach'` literals.
- [ ] The client loads the caller's permission set once per session and
  caches it.
- [ ] `isStaff` and `isAdmin` helpers stay as thin conveniences over the
  permission set and role rank, with a comment that the server is the
  authority.
- [ ] Every gated UI control has a matching server policy. No client-only
  gate.
- [ ] A permission the caller lacks hides the control and, if forced, the
  server rejects the call.

## Frontend states

- A member without a permission does not see the control at all.

## Client calls and contracts

- `has_perm(permission text) returns boolean`.
- A `my_permissions() returns setof text` convenience for the session cache.

## Validation rules and limits

- The cache is dropped on role change events and on sign-out.

## Migration outline

- `my_permissions` function. schema lands it with COMM-008.

## Dependencies

- COMM-008.
