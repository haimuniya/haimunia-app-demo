# COMM-020 pgTAP RLS enforcement suite, run by migration-check CI

Phase: 0
Agent: qa
Status: todo
Attendance-blocked: no

## User outcome

Every RLS boundary from COMM-019's static assertions is also proven under
real two-user runtime enforcement, so a policy that only looks correct in
the SQL text but actually fails to deny a cross-user query is caught in CI
before it ships.

## Acceptance criteria

- [ ] `supabase/tests/` holds one `NNNN_slug_test.sql` pgTAP file per Phase 0
  migration, plus `rls_helpers.sql` with fixture members, a coach, an admin,
  an owner, a no-recovery member, and a `set_auth(uuid)` shim that switches
  `role` and `request.jwt.claims` so `auth.uid()` and `auth.role()` resolve
  to the chosen member for the rest of the transaction.
- [ ] The `migration-check` GitHub Actions job runs `supabase start` then a
  new `supabase test db` step against that stack.
- [ ] Both allow and deny are asserted per boundary, at minimum:
  - 0001 clubs/roles/permissions/role_permissions: member reads, member
    writes denied, owner writes allowed; `has_perm`, `is_staff`, `is_admin`
    resolved per role.
  - 0002 admin_actions: analytics-holder reads, member and coach denied, no
    client insert/update/delete, `log_admin_action` not callable.
  - 0003 profiles: self-update cannot move `is_admin`, `club_id`, or
    `recovery_verified_at`; insert cannot stamp it; `mark_recovery_verified`
    refuses an unverified account; `visible_to_club` hides from other
    members but not self or admin; `allow_follows` and block edges gate the
    follows insert; `can_view_profile_field` flips per toggle, raises on an
    unknown field, and a block edge short-circuits it; self is always true.
  - 0004 workout_posts columns: `default_post_type` derivation, status
    default, widened `source_type`, recovery-gated insert.
  - 0005 post visibility and media: full viewer matrix over club, friends,
    only_me, hidden, for author, mutual follow, one-way follower, stranger,
    blocked, and real admin; `post_media` position bound, uniqueness,
    author-uid path trigger, parent-visibility read, non-author and
    removed-post insert denial; `add_post_comment` and `toggle_reaction`
    recovery-gate, with reaction-remove still working.
  - 0006 feed telemetry: own-row read and insert on both tables, cross-member
    and admin read denied, no update path, `feed_record_impressions` 20 ok
    / 51 raises, repeated batch de-duped.
  - 0007 achievements: member reads definitions, admin writes, four
    attendance seeds present and disabled; `member_achievements` own-read,
    club-visible read gated by `show_achievements` and block edge, no
    self-award, second non-repeatable row hits the partial unique index.
  - 0008 notifications: own-row read, no client insert, update reaches
    `read_at` only; `notification_preferences` and `push_subscriptions`
    own-row.
  - 0009 challenges: draft visibility, member cannot create, teams read with
    parent and write by permission, participant self-join only on an active
    challenge with recovery, no editing another participant, progress append
    only for an active participant.
  - 0010 events: draft visibility, member cannot create, RSVP self and
    published and recovery, capacity trigger on the direct upsert with
    going-to-going still allowed, `show_in_attendee_lists` hides an attendee
    from members but not self or an event manager.
  - 0011 coach_engagement_flags: the flagged member never reads their own
    row as a plain member, as a coach, or as an admin; staff read and write
    rows about others; a plain non-staff member reads nothing.
  - 0012 analytics_events: own or null insert, cross-member insert denied,
    the writer cannot read back, non-holder denied, analytics-holder reads,
    4 KB props trigger, no update or delete.
  - 0013 invite_attempts: table unreachable, bump not callable, throttle
    survives a session swap keyed on `actor_key`, a fresh actor is not
    pre-limited, same answer and increment for a new versus a guessing
    actor, an already-redeemed caller gets their role back and the function
    never raises.
- [ ] Facts that are about the SQL text rather than a runtime boundary stay
  in `test/community-rls-boundaries.test.mjs` as static change-detectors,
  not duplicated in pgTAP: exact grant and revoke lists, "no policy exists"
  phrased as catalog absence, trigger binding names, the profiles protect
  trigger living in `202608270003`, seed row contents beyond counts,
  `coach_engagement_flags` shipping empty (no producer), and the
  `storage.objects` post-photo policies, which this suite does not exercise
  because it creates no storage objects.
- [ ] `npm test` stays green. The `migration-check` job stays green.

## Frontend states

Not applicable. Test suite.

## Client calls and contracts

- Exercises the contracts from COMM-001 through COMM-013 under real
  Postgres RLS rather than the JS mock.

## Validation rules and limits

- A boundary with no pgTAP allow-and-deny pair is a gap, not a pass.
- Local validation was not possible when this suite was authored — Docker
  was not available on the authoring machine, so `supabase test db` could
  not run there. SQL was checked by hand for balanced quoting and structure
  only. CI is the first real run.

## Migration outline

- None. Adds `supabase/tests/*.sql` and a CI step, no schema change.

## Dependencies

- COMM-001 through COMM-013, and COMM-019 (the static-assertion form this
  suite complements with runtime enforcement).

## Notes

- Estimated one day. Recommended before the V1 release, since privacy and
  moderation are RLS-enforced release criteria.
- See `docs/community/backlog.md`'s "COMM-020 note" entries and COMM-332
  (2026-09-02) for the live status: the suite has since shipped, was
  re-verified clean (`Files=56, Tests=1995 ... Result: PASS`) against a
  fresh `supabase db reset`, and `migration-check` is confirmed to be a
  hard, non-`continue-on-error` gate.
