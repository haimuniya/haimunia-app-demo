# COMM-336 Extend PRIVACY.md to disclose photos, comments, follows, and admin-visible data

Phase: Design sync & audit remediation (2026-09-02)
Agent: identity-privacy
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

PRIVACY.md describes only workout history, auto-backup, the shared result
"snapshot," and sign-in method — it never mentions post photos, comments, the
follow/follower graph, the full profile-visibility toggle set actually stored
per user (bio, avatar, show_workout_results, show_prs, allow_follows, etc.),
or that admins can view a directory of every member's handle, display name,
synthetic login email, role, and join date. These are all real, currently-
shipped data categories.

## Acceptance criteria

- [ ] PRIVACY.md discloses post photos (Storage bucket), comments, the
  follow/follower social graph, and the full set of profile-visibility toggles a
  user can set.
- [ ] PRIVACY.md discloses that admins can view a member directory including handle,
  display name, synthetic login email, role, and join date.
- [ ] Every data field actually written to Supabase (per `cloud.js`'s
  post/comment/follow/profile code and `admin_user_directory`) has a
  corresponding disclosure.

## Location / evidence

- `PRIVACY.md:5-20`
- `cloud.js:2115-2188` (post photos), `:2503-2629` (comments), `:3122-3141`
  (follows), `:573` (profile visibility columns)
- `COMMUNITY_SETUP.md:251-256` (admin user directory)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
