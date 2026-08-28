# COMM-008 Migration: roles, permissions, role_permissions, seed strings

Phase: 0
Agent: schema
Status: todo
Attendance-blocked: no

## User outcome

Access is decided by explicit permission strings held by roles, not by
hardcoded role checks, so new roles are a data change.

## Acceptance criteria

- [ ] `roles`: `code` text pk (member, coach, head_coach, staff, admin,
  owner), `label` text, `rank` smallint.
- [ ] `permissions`: `code` text pk, `description` text.
- [ ] `role_permissions`: (`role_code`, `permission_code`) primary key.
- [ ] Seeded permission codes: `community.post.create`,
  `community.post.delete_any`, `community.comment.moderate`,
  `community.challenge.create`, `community.event.manage`,
  `community.analytics.view`, `community.member.restrict`,
  `community.announcement.publish`, `community.content.pin`.
- [ ] Seeded role to permission mapping matches spec section 57.
- [ ] `has_perm(permission text) returns boolean` reads the caller's club
  membership role and the mapping, and treats `owner` as holding every
  permission.
- [ ] Existing `is_staff` and `is_admin` helpers keep working, reimplemented
  on top of the new tables.
- [ ] RLS: all three tables readable by any authenticated user, writable by
  `owner` only.
- [ ] `supabase start` applies the migration clean.

## Frontend states

Not applicable. Migration only.

## Client calls and contracts

- `has_perm(permission text) returns boolean`.

## Validation rules and limits

- Role codes and permission codes are lower dotted or snake case.

## Migration outline

- Three `create table` statements with seed inserts.
- `has_perm` function.
- Rewrite `is_staff` and `is_admin` as thin wrappers over `has_perm` or role
  rank.

## Dependencies

- None. Other Phase 0 schema tickets depend on this.
