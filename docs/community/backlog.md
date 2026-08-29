# Community backlog and phase board

Single source of truth for what each agent works next. planner owns this file.
Agents work only tickets assigned to them in the current phase. Full ticket
files live in `docs/community/tickets/`.

## Legend

- Status: `todo`, `in-progress`, `review`, `done`, `parked`
- `parked` means blocked on the attendance data-source decision
- `partial` in a ticket file means part of the scope ships now, part is parked

## Current phase

Phase 1 Community V1.

Phase 0 status: pushed on branch `community/phase-0`, commit 3977b85. CI:
node-tests pass, browser-checks pass, migration-check applied all 13
migrations against a real Postgres with no error. The `supabase test db`
pgTAP step failed and is now `continue-on-error` until the suite is
debugged, tracked as COMM-020, non-blocking. Schema is validated. Phase 1
proceeds.

## Phase 0 tickets

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-000 | Convert spec P0 and P1 sections into tickets with acceptance criteria | planner | done |
| COMM-001 | Migration: post_type enum and posts columns (source_type, source_id, visibility, status, metadata) | schema | review |
| COMM-002 | Migration: post_media table, up to 4 rows per post, alt text column | schema | review |
| COMM-003 | Migration: feed_impressions and feed_interactions tables with RLS | schema | review |
| COMM-004 | Migration: achievement_definitions and member_achievements with RLS | schema | review |
| COMM-005 | Migration: notifications, notification_preferences, push_subscriptions | schema | review |
| COMM-006 | Migration: challenges, challenge_participants, challenge_progress, challenge_teams | schema | review |
| COMM-007 | Migration: events and event_attendees | schema | review |
| COMM-008 | Migration: roles, permissions, role_permissions, seed permission strings | schema | review |
| COMM-009 | Migration: admin_actions audit table | schema | review |
| COMM-010 | Migration: profile privacy columns and defaults | schema | review |
| COMM-011 | Migration: empty coach_engagement_flags table with RLS | schema | review |
| COMM-012 | Product event bus module and typed event list | platform | review |
| COMM-013 | Analytics event helper, analytics_events table, WCAM definition | platform | review |
| COMM-014 | Supabase Realtime harness and subscription helper | platform | review |
| COMM-015 | Client-side image resize and compress before upload | platform | review |
| COMM-016 | Required recovery method at invite redemption | identity-privacy | review |
| COMM-017 | Actor-level invite throttle outside the anonymous user ID | identity-privacy | review |
| COMM-018 | Privacy toggle model and RLS enforcement | identity-privacy | review |
| COMM-019 | One RLS test per new table (static assertion form) | qa | review |
| COMM-020 | pgTAP RLS enforcement suite, run by migration-check CI | qa | review |

Phase 0 exit: all three CI jobs green, no user-facing change until the bundle
deploys with COMM-016. Identity decision resolved, see the resolved questions
below.

COMM-012 to COMM-015 note: platform shipped four classic scripts under
`src/`, loaded by `index.html` before `cloud.js` and `app.js`, precached in
`sw.js`, and loaded in the same order by `test/helpers/boot.mjs`. Contracts
are in `docs/community/contracts.md` under "Client platform helpers". Phase
0 wires no producer, no consumer, no subscription and no upload to any of
them, so there is no user-facing change. Both follow-ups are closed by
COMM-170: it is the first `HaimuniaAnalytics.configure()` call, and it moved
the WCAM definition out of the `src/analytics.js` comment into
`docs/community/metrics.md`, which now also carries the event-to-surface
table. The module keeps a one-line pointer at the doc.

COMM-019 note: qa delivered static assertions that pin each policy, trigger,
and constraint so a widening edit fails CI. The JS mock cannot run Postgres,
so no boundary is observed denying a real cross-user query. COMM-020 adds that:
a pgTAP suite under `supabase/tests/` impersonating two auth users, run by the
existing `supabase start` CI job with one added `supabase test db` step.
Estimated one day. Recommended before the V1 release, since privacy and
moderation are RLS-enforced release criteria. Decision pending from the user
on whether it blocks Phase 0 exit or moves to a pre-V1 hardening slot.
qa consolidated the 22 per-table tests into one file, flagged for planner.

COMM-020 note: qa added `supabase/tests/`, a pgTAP suite the `migration-check`
job now runs with `supabase test db` after `supabase start`. One
`NNNN_slug_test.sql` per Phase 0 migration, plus `rls_helpers.sql` with the
fixture members, coach, admin, owner, a no-recovery member, and a
`set_auth(uuid)` shim that switches `role` and `request.jwt.claims` so
`auth.uid()` and `auth.role()` resolve to the chosen member for the rest of
the transaction.

Boundaries now under true two-user runtime enforcement, allow and deny both
asserted:

- 0001 clubs, roles, permissions, role_permissions: member reads, member
  writes denied, owner writes allowed. has_perm, is_staff, is_admin resolved
  per role.
- 0002 admin_actions: analytics-holder reads, member and coach denied, no
  client insert, update, or delete, log_admin_action not callable.
- 0003 profiles: self update cannot move is_admin, club_id, or
  recovery_verified_at, insert cannot stamp it, mark_recovery_verified
  refuses an unverified account. visible_to_club hides from other members
  not self or admin. allow_follows and block edges gate the follows insert.
  can_view_profile_field flips per toggle, raises on an unknown field, and a
  block edge short-circuits it. self is always true.
- 0004 workout_posts columns: default_post_type derivation, status default,
  widened source_type, recovery-gated insert.
- 0005 post visibility and media: full viewer matrix over club, friends,
  only_me, hidden, for author, mutual follow, one-way follower, stranger,
  blocked, and real admin. post_media position bound, uniqueness, author-uid
  path trigger, parent-visibility read, non-author and removed-post insert
  denial. add_post_comment and toggle_reaction recovery gate, with
  reaction-remove still working.
- 0006 feed telemetry: own-row read and insert on both tables, cross-member
  and admin read denied, no update path, feed_record_impressions 20 ok,
  51 raises, repeated batch de-duped.
- 0007 achievements: member reads definitions, admin writes, four attendance
  seeds present and disabled. member_achievements own-read, club-visible
  read gated by show_achievements and block edge, no self-award, second
  non-repeatable row hits the partial unique index.
- 0008 notifications: own-row read, no client insert, update reaches
  read_at only. notification_preferences and push_subscriptions own-row.
- 0009 challenges: draft visibility, member cannot create, teams read with
  parent and write by permission, participant self-join only on an active
  challenge with recovery, no editing another participant, progress append
  only for an active participant.
- 0010 events: draft visibility, member cannot create, RSVP self and
  published and recovery, capacity trigger on the direct upsert with
  going to going still allowed, show_in_attendee_lists hides an attendee
  from members but not self or an event manager.
- 0011 coach_engagement_flags: the flagged member never reads their own row
  as a plain member, as a coach, or as an admin. Staff read and write rows
  about others. A plain non-staff member reads nothing.
- 0012 analytics_events: own or null insert, cross-member insert denied,
  the writer cannot read back, non-holder denied, analytics-holder reads,
  4 KB props trigger, no update or delete.
- 0013 invite_attempts: table unreachable, bump not callable, throttle
  survives a session swap keyed on actor_key, a fresh actor is not
  pre-limited, same answer and increment for a new versus a guessing actor,
  an already-redeemed caller gets their role back and the function never
  raises.

Still static-assertion only, kept in test/community-rls-boundaries.test.mjs
as change-detectors, since they are facts about the SQL text rather than a
runtime boundary: exact grant and revoke lists, "no policy exists" phrased
as catalog absence, trigger binding names, the profiles protect trigger
living in 202608270003, seed row contents beyond counts,
coach_engagement_flags shipping empty (no producer), and the storage.objects
post-photo policies, which the pgTAP suite does not exercise because it
creates no storage objects.

Local validation: not possible. Docker is not on the authoring machine, so
`supabase test db` could not run. SQL was checked by hand and for balanced
quoting and structure only. CI is the first real run.

## Phase 1 tickets, Community V1

ID range COMM-101 to COMM-191.

### posts

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-101 | Post type render dispatch | posts | todo |
| COMM-102 | Composer: text post with visibility | posts | todo |
| COMM-103 | Composer: photo attach up to four with alt text | posts | todo |
| COMM-104 | Workout post card | posts | todo |
| COMM-105 | PR post card and PR share prompt | posts | todo |
| COMM-106 | Achievement post card | posts | todo |
| COMM-107 | New member and system post rendering | posts | todo |
| COMM-108 | Post action menu (save, hide, edit, visibility, delete) | posts | todo |
| COMM-180 | Member profile community section | posts | todo |

### feed

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-110 | Ranked feed consumption | feed | todo |
| COMM-111 | Feed filters (My Classes parked) | feed | todo |
| COMM-112 | Feed diversity rules | feed | todo |
| COMM-113 | Cursor pagination | feed | todo |
| COMM-114 | Feed impression and interaction tracking | feed | todo |
| COMM-115 | Feed top area | feed | todo |

### engagement

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-120 | Reaction display and toggle | engagement | todo |
| COMM-121 | Comment replies, two-level threads | engagement | todo |
| COMM-122 | Comment edit and delete own | engagement | todo |
| COMM-123 | Member mentions | engagement | todo |
| COMM-124 | Coach comment visual priority | engagement | todo |
| COMM-125 | Block member effects | engagement | todo |

### achievements

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-130 | Achievement engine, non-attendance triggers | achievements | todo |
| COMM-131 | Achievement definitions seed, non-attendance | achievements | todo |
| COMM-132 | PR detection hook | achievements | todo |
| COMM-133 | PR share prompt UI | achievements | todo |
| COMM-134 | Achievement unlock celebration and optional share | achievements | todo |

### notifications

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-140 | Notification center | notifications | review |
| COMM-141 | Notification model read and mark-read wiring | notifications | review |
| COMM-142 | Immediate versus batched routing | notifications | review |
| COMM-143 | Phase 1 notifications wired | notifications | partial |
| COMM-144 | Notification preferences per type | notifications | review |

COMM-143 is `partial`: the client renders every Phase 1 type with the
right icon, category, copy and deep link, and the mock produces the rows.
The server trigger set that creates them is documented in
`docs/community/contracts.md` under "Needs from schema, notifications" and
is not built here. One open item there: a `post_comments` trigger cannot
see the client-only mention list, so `add_post_comment` needs a
`p_mentions uuid[]` argument (or a mentions column) before the mention
notification is wired end to end.

### admin-moderation

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-150 | RBAC permission strings in the client | admin-moderation | todo |
| COMM-151 | Report flow with reasons | admin-moderation | todo |
| COMM-152 | Admin moderation queue | admin-moderation | todo |
| COMM-153 | Moderation queue actions | admin-moderation | todo |
| COMM-154 | Admin action audit writes | admin-moderation | todo |
| COMM-155 | Pinned content | admin-moderation | todo |
| COMM-156 | Expose the HEAD_COACH role | admin-moderation | todo |

### coach-tools, platform, qa

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-160 | Coach identity across the community | coach-tools | todo |
| COMM-170 | Analytics events for Phase 1 surfaces | platform | todo |
| COMM-190 | Phase 1 dialog keyboard and focus tests | qa | todo |
| COMM-191 | Phase 1 coverage sweep and CI gate | qa | todo |

Phase 1 release maps to spec section 94. Gate is COMM-191.

## Phase 2 tickets, Engagement (spec V1.5)

Ticket files not written yet. Titles and owners only.

| ID | Title | Agent |
|---|---|---|
| COMM-201 | Challenge model generalization from the weekly challenge | challenges |
| COMM-202 | Individual target and individual performance challenges | challenges |
| COMM-203 | Cooperative challenge with club aggregate and contributors | challenges |
| COMM-204 | Team challenge with per-team totals | challenges |
| COMM-205 | Consistency challenge on non-attendance metrics | challenges |
| COMM-206 | Coach custom-rules challenge | challenges |
| COMM-207 | Challenge list, detail, join and leave | challenges |
| COMM-208 | Challenge notifications (ending soon, joined, completed) | notifications |
| COMM-209 | Challenge realtime progress | platform |
| COMM-210 | Consistency leaderboard mode, non-attendance | feed |
| COMM-211 | Progress leaderboard mode | feed |
| COMM-212 | Friends leaderboard mode and hide-my-result | feed |
| COMM-213 | Events tables consumption, list and detail | events |
| COMM-214 | Event RSVP and capacity | events |
| COMM-215 | Event types and add to calendar | events |
| COMM-216 | Event comments | events |
| COMM-217 | Upcoming event card in the feed top area | events |
| COMM-218 | Announcement priority levels and expiry | admin-moderation |
| COMM-219 | Announcement notification toggle and urgent path | notifications |
| COMM-220 | Weekly member recap Edge Function | recaps |
| COMM-221 | Weekly recap surface and share | recaps |
| COMM-222 | New member onboarding sequence, non-attendance steps | recaps |
| COMM-223 | Coach dashboard shell with Celebrate | coach-tools |
| COMM-224 | Coach Welcome section | coach-tools |
| COMM-225 | One-tap congratulate action | coach-tools |
| COMM-226 | Coach Engage section scaffold, hidden | coach-tools |
| COMM-227 | Realtime for comments and reaction counts | platform |
| COMM-228 | Member, event, and challenge search | platform |
| COMM-229 | Web push subscription and service worker handler, behind a flag | notifications |
| COMM-230 | Following system surface and states | engagement |
| COMM-231 | Members directory screen | engagement |
| COMM-232 | People you train with suggestions, non-attendance fallback | feed |
| COMM-233 | Phase 2 analytics events | platform |
| COMM-234 | Phase 2 QA sweep and browser scenarios | qa |

## Phase 3 tickets, Intelligence (spec V2)

Ticket files not written yet. Titles and owners only.

| ID | Title | Agent |
|---|---|---|
| COMM-301 | Relationship score from interaction history | feed |
| COMM-302 | Recurring classmate score once attendance lands | feed |
| COMM-303 | Personalized feed ranking and per-user weights | feed |
| COMM-304 | Coach Engage activation and attendance-decline detection | coach-tools |
| COMM-305 | Attendance milestone posts and achievements activation | achievements |
| COMM-306 | Consistency leaderboard on verified attendance | feed |
| COMM-307 | Post-class trained-with-you card | feed |
| COMM-308 | Advanced challenge team management | challenges |
| COMM-309 | Monthly club recap Edge Function with admin preview | recaps |
| COMM-310 | Admin community analytics dashboard, full metric set | admin-moderation |
| COMM-311 | Member engagement segmentation | admin-moderation |
| COMM-312 | Community health score, internal only | admin-moderation |
| COMM-313 | Retention correlation views | admin-moderation |
| COMM-314 | Versioned abandoned-profile purge Edge Function and runbook | identity-privacy |
| COMM-315 | Member of the week rotation across recognition categories | coach-tools |
| COMM-316 | Monthly recap classmates and onboarding class steps, attendance | recaps |
| COMM-317 | Phase 3 QA sweep | qa |

## Parked, attendance-blocked

| ID | Title | Unblocks with | Related phase-3 ticket |
|---|---|---|---|
| COMM-P01 | Feed class-connection score | attendance source | COMM-302 |
| COMM-P02 | Consistency leaderboard on verified attendance | attendance source | COMM-306 |
| COMM-P03 | Attendance-milestone posts and achievements | attendance source | COMM-305 |
| COMM-P04 | Coach Engage section and decline detection | attendance source | COMM-304 |
| COMM-P05 | Post-class trained-with-you card | attendance source | COMM-307 |
| COMM-P06 | Weekly recap classmates line | attendance source | COMM-316 |
| COMM-P07 | Onboarding first and third class steps | attendance source | COMM-316 |

## Phase 0 schema handoff for qa (COMM-019)

Migrations 202608280001 through 202608280013. One line per new table saying
the boundary a test has to assert. Every table below has RLS enabled and at
least one policy. A table reachable with no policy is a test failure.

Read `docs/community/contracts.md`, section "Phase 0 schema notes", first.
Two things there change what a test should expect: the posts table is
`public.workout_posts`, and community writes now require
`profiles.recovery_verified_at`, so a fixture member with a null
`recovery_verified_at` must fail every write listed as gated.

### Clubs and RBAC (202608280001)

| Table | Boundary to assert |
|---|---|
| clubs | Any authenticated member reads the one row. Only a caller whose role resolves to owner may insert, update, or delete. |
| roles | Any authenticated member reads. Only owner writes. A member cannot grant themselves a higher-ranked row. |
| permissions | Any authenticated member reads. Only owner writes. |
| role_permissions | Any authenticated member reads. Only owner writes, so a member cannot attach a permission to their own role. |

Also worth a test each, since every other policy is keyed to them:
`has_perm()` returns false for a caller with no redemption, true for the
seeded member permission. `is_staff()` and `is_admin()` still answer the same
way they did before 202608280001 for an admin, a coach, and a plain member.

### Audit log (202608280002)

| Table | Boundary to assert |
|---|---|
| admin_actions | Readable only by a `community.analytics.view` holder. No client can insert, update, or delete, admin included: there is no policy and no grant for any of the three. `log_admin_action` is not executable by `authenticated` at all. |

### Profile privacy and recovery (202608280003)

| Table | Boundary to assert |
|---|---|
| profiles (new columns) | A member updating their own row cannot change `is_admin`, `recovery_verified_at`, or `club_id`, and cannot set `recovery_verified_at` on insert either. A member with `visible_to_club` false is invisible to another member's select and still visible to themselves and to a real admin. A follow insert targeting a member with `allow_follows` false is rejected by the policy, not by the client. |

`can_view_profile_field` deserves its own test per toggle: set it as member A,
read as member B, assert the answer flips. An unknown field name must raise.
A block edge in either direction must return false before any toggle is read.

### Posts and media (202608280004, 202608280005)

| Table | Boundary to assert |
|---|---|
| workout_posts (new columns) | A `only_me` post is invisible to every member but the author. A `friends` post is visible only across a mutual follow edge, and a one-way follower must not see it. A `hidden` or `removed` status hides the post from everyone but its author and a real admin. A member with no `recovery_verified_at` cannot insert at all. |
| post_media | A fifth media row on one post fails, because `position` is bounded to 0 through 3 and (post_id, position) is unique. Read follows the parent post exactly, so a media row on an `only_me` post is invisible to a second member. Insert and update only by the post author, and only while the post is not removed. A storage path whose first segment is not the author's uid is rejected by the trigger. |

Two more assertions belong here: `add_post_comment` and `toggle_reaction`
both raise for a member without `recovery_verified_at`, and removing a
reaction you already left still works for that member.

### Feed telemetry (202608280006)

| Table | Boundary to assert |
|---|---|
| feed_impressions | Strictly own-row read and insert. A member cannot read another member's impression stream, and nobody can, admin included. No client can UPDATE, so `opened` and `engaged` cannot be rewritten after the fact. |
| feed_interactions | Strictly own-row read and insert. A batch of 20 impressions in one `feed_record_impressions` call succeeds, 51 raises, and a repeated batch does not double-count. |

### Achievements (202608280007)

| Table | Boundary to assert |
|---|---|
| achievement_definitions | Any member reads. Only a real admin inserts, updates, or deletes, so a member cannot invent or enable an achievement. The four seeded attendance definitions are present with `enabled` false. |
| member_achievements | Owner always reads their own. Another member reads a club-visible unlock only when the owner's `show_achievements` is on and no block edge sits between them. No client can insert, update, or delete: a member cannot award themselves. A second row for a non-repeatable definition fails on the partial unique index. |

### Notifications (202608280008)

| Table | Boundary to assert |
|---|---|
| notifications | Own-row read only. No client can insert, so a member cannot plant a notification in someone else's stream. The own-row update reaches `read_at` and nothing else: an attempt to change `title`, `body`, or `deep_link` silently keeps the old value. |
| notification_preferences | Own-row read and write. A missing row must behave as in_app. |
| push_subscriptions | Own-row read and write. A member cannot read another member's endpoint or keys. |

### Challenges (202608280009)

| Table | Boundary to assert |
|---|---|
| challenges | A draft is readable only by its creator and by a `community.challenge.create` holder. Create, edit, and delete require that permission, so a plain member cannot make one. |
| challenge_teams | Readable with the parent challenge. Written only by a `community.challenge.create` holder. |
| challenge_participants | Anyone reads who joined. A member inserts only their own row, only on an active challenge, and only with `recovery_verified_at` set. A member cannot join on someone else's behalf or edit another participant's row. |
| challenge_progress | Append only. Insert only your own row and only while you are an active participant. No client can update or delete, so a contribution is corrected by a compensating negative delta. |

### Events (202608280010)

| Table | Boundary to assert |
|---|---|
| events | A draft is readable only by its creator and by a `community.event.manage` holder. Create, edit, and delete require that permission. |
| event_attendees | RSVP only for yourself, only on a published event, only with `recovery_verified_at` set. An attendee who turned `show_in_attendee_lists` off is invisible to other members and still visible to themselves and to an event manager. Capacity and deadline are enforced on the direct RLS upsert as well as through `event_rsvp`, and a `going` to `going` update on a full event must still succeed. |

### Coach engagement (202608280011)

| Table | Boundary to assert |
|---|---|
| coach_engagement_flags | The single most important assertion in this list: the flagged member can never read their own row, even when that member is themselves a coach or an admin. Every policy carries `user_id <> auth.uid()` for exactly that reason. Staff read and write rows about other members. The table ships empty. |

### Analytics (202608280012)

| Table | Boundary to assert |
|---|---|
| analytics_events | Insert own-row or a null user_id. Read only by a `community.analytics.view` holder, and specifically NOT by the member who wrote the row. A `props` payload over 4 KB is rejected by the trigger. |

### Invite throttle (202608280013)

| Table | Boundary to assert |
|---|---|
| invite_attempts | Still unreachable by any client: no grant and no policy for anon or authenticated. The behaviour test is the one that matters: five wrong codes, then discard the session and sign in anonymously again with the same `actor_key`, and the sixth attempt still returns `rate_limited`. A wrong code returns the same answer and increments the same way whether the actor is new or not. |

## Phase 1 schema handoff for qa

Migrations 202608280014 through 202608280018, the five tables and two
columns Phase 0 deferred. Same rule as the Phase 0 handoff: one line per new
table saying the boundary a test has to assert, every table has RLS enabled
and at least one policy, and a table reachable with no policy is a test
failure.

Read `docs/community/contracts.md`, section "Phase 1 schema notes", first.
Three things there change what a test should expect. The comments table is
`public.post_comments`. The comment body limit is now 1000, not 280.
`posting_restrictions` and `pins` have no write grant at all, so the correct
assertion is that a direct PostgREST insert fails for everyone including an
admin, and the permission check lives in the function.

### Hidden and saved posts (202608280014)

| Table | Boundary to assert |
|---|---|
| hidden_posts | Strictly own-row on select, insert, and delete. Member B can never read, count, or infer member A's hides, so a hide is invisible to the post author. There is no UPDATE grant and no update policy. An insert naming another member's user_id fails, and an insert for a post the caller cannot see fails on `post_visible_to_viewer`, which is what stops it being an existence oracle for an `only_me` post. A member with a null `recovery_verified_at` cannot insert. |
| saved_posts | Same four assertions as hidden_posts. Additionally, a repeat save collides on the `(user_id, post_id)` primary key rather than creating a second row. |

### Posting restrictions (202608280015)

| Table | Boundary to assert |
|---|---|
| posting_restrictions | No client can insert, update, or delete, a `community.member.restrict` holder included: there is no policy and no grant for any of the three. A member reads their own restrictions and nobody else's unless they hold `community.member.restrict` or `community.comment.moderate`. A temporary row with a null `expires_at` fails the CHECK, and so does a permanent row with one. |

Four behaviour assertions belong here and matter more than the table shape.
A restricted member's `workout_posts` insert is refused by
`posts_insert_self`. Their `add_post_comment` raises `posting_restricted`.
Their `comment_edit` raises the same, so an old comment cannot be rewritten
into new content. A restriction whose `expires_at` has passed stops
applying with no cron run and no backfill, because expiry is evaluated at
read time. One more: `is_posting_restricted(<someone else>)` must raise for
a plain member and answer for a moderator.

`mod_restrict_member` and `mod_lift_restriction` each need a test that the
matching `admin_actions` row exists after the call, since that is the whole
reason the table has no write grant.

### Comment threads (202608280016)

| Table | Boundary to assert |
|---|---|
| post_comments (new columns) | Reply depth is capped at 2 in both directions. A reply to a reply fails. Giving a parent to a comment that already has replies fails, which is the UPDATE path that would otherwise create depth 3. A reply whose parent sits on another post fails. A removed or soft-deleted comment is invisible to every member but its author and a `community.comment.moderate` holder, and the reply that pointed at it is still returned with its `parent_comment_id` intact so the client can render the placeholder. A 1000-character body is accepted and a 1001-character one is truncated by the function, not rejected. There is still no INSERT and no UPDATE grant, so a direct `.insert()` or `.update()` on the table fails for everyone. |

`comment_edit` needs its own three: a non-author is refused, the author's
edit always stamps `edited_at`, and an all-whitespace body raises. The
two-argument `add_post_comment` must still resolve and still behave exactly
as it did, which is the regression that would break the current client.

### Pins (202608280017)

| Table | Boundary to assert |
|---|---|
| pins | Any signed-in member reads. No client can insert, update, or delete, a `community.content.pin` holder included: select is the only policy and the only grant. A fourth `pin_set` raises `pin_limit_reached`. `pin_set` and `pin_clear` both refuse a caller without `community.content.pin` and both write an `admin_actions` row. Pinning a deleted post, a removed post, a cancelled event, or an archived challenge raises. Soft-deleting or removing a pinned target auto-unpins it and frees the slot, and that auto-unpin writes no audit row. |

The concurrency assertion is worth one test even though it is awkward: two
`pin_set` calls racing for the last slot must produce one success and one
`pin_limit_reached`, never two rows in the same slot.

### Notification batches (202608280018)

| Table | Boundary to assert |
|---|---|
| notification_batches | Own-row read only. No client can insert, update, or delete, which is the assertion that matters: a member who could write here would set their own `next_flush_at` to now and turn the batched channel back into a stream of pings. A second `notif_queue_batched` for the same member, category, and type increments the counter in place rather than adding a row, and does not move `next_flush_at`. A queue call on an empty batch does start a fresh window. `notification_batch_window()` returns 6 hours and matches the column default. |

## Open questions for the user

Logged by planner while writing tickets.

Resolved 2026-08-28:
- Item 2 identity: recoverable and required. Verified email plus password
  before or right after invite redemption. RLS requires
  `profiles.recovery_verified_at`. See COMM-016.
- Item 3 missing tables: approved. Land as small migrations per owning Phase 1
  ticket, no Phase 0 widening. `recovery_codes` is dropped, COMM-016 uses a
  `recovery_verified_at` column instead.
- Item 5 club model: approved. Keep `club_id`, one club row, no multi-tenant.
- Item 6 friends: approved. Friends means mutual follows.
- Item 8 birthday: approved. No birth date field. Celebrate keeps anniversary
  only.

Still open, not blocking Phase 0: items 1 (attendance source), 4 (reaction
label), 7 (direct messaging stays deferred), 9 (recap scheduling note), 10
(web push VAPID provisioning, Phase 2).

1. Attendance data source. Still unpicked. It gates the whole parked bucket
   and seven Phase 3 tickets. Options: pull from Arbox, an in-app class
   check-in, or self-reported "I trained today".
2. Disposable versus recoverable community identity. COMM-016 needs this to
   finish Phase 0 for identity-privacy. Recoverable means adding account
   linking through a verified method. Disposable means a clear loss notice
   before invite redemption.
3. Phase 0 schema list is missing tables that Phase 1 tickets need:
   `hidden_posts` and `saved_posts` (COMM-108), a `parent_comment_id` and
   `edited_at` column on `comments` (COMM-121, COMM-122), `pins` (COMM-155),
   `posting_restrictions` (COMM-153), `notification_batches` (COMM-142),
   `invite_attempts` for the actor throttle (COMM-017), and `recovery_codes`
   if identity is recoverable (COMM-016). Recommendation: schema lands these
   as small Phase 1 migrations at the start of each owning ticket, rather
   than widening Phase 0. Confirm that approach.
4. Reaction label. The spec wants a club-specific term in the style of a
   fist bump. Current plan keeps the existing wording. Give a Hebrew term or
   confirm keep as is.
5. Club model. Spec tables carry a `club_id`. This product is one club.
   Recommendation: keep `club_id` columns, default them to a single club
   row, do not build multi-tenant. Confirm.
6. Friends versus following. Spec uses both words. The repo has one-way
   follows and blocks, no mutual-friend object. Recommendation: "friends"
   maps to mutual follows for leaderboard and visibility scoping. Confirm.
7. Direct messaging. Spec section 92 defers full messaging, section 20 marks
   the Message button P2. Plan does not schedule it in Phase 2 or 3.
   Recommendation: keep deferred, WhatsApp covers private chat. Confirm.
8. Birthday in the coach Celebrate section needs a birth date on the
   profile, which the app does not collect. Options: add an optional birth
   date field with `show_birthday` privacy, or drop birthday from Celebrate
   and keep anniversary, which uses member-since.
9. Weekly recap scheduling. A Supabase free project pauses after a week
   idle. A live club stays active so this is low risk, noted for awareness.
10. Web push provider. Phase 2 web push needs VAPID keys and a push service,
    and iOS support is installed-PWA only on Safari 16.4 or newer. Confirm
    the team will provision VAPID keys and that iOS coverage limit is
    acceptable.
