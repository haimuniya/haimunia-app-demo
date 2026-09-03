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
migrations against a real Postgres with no error. Schema is validated.
Phase 1 proceeds.

Note (2026-09-02, re-verified as part of COMM-332): the paragraph above is
Phase-0-era and stale on one point — it is kept as historical record, not
updated in place, but this note corrects it. `.github/workflows/test.yml`'s
`migration-check` job has never actually carried `continue-on-error` on the
`supabase test db` step; it is a hard gate today, same as always. A prior
same-day audit pass reported 68/1995 pgTAP failures, but that run was
against a Supabase stack that was already up rather than a fresh
`supabase start`/`db reset`, by its own admission. Re-run clean (`supabase
db reset` against all 76 current migrations, then `supabase test db`):
`Files=56, Tests=1995 ... Result: PASS`, zero failures. The gate is green;
treat the 68-failure count as a stale-environment artifact, not a real
regression to chase.

Note (2026-09-03): the "Phase 1 Community V1" heading above is stale in the
same way the paragraph below it already was — kept as historical record,
not rewritten. Phases 1, 2, and 3 are all filed and largely shipped (see
their own sections below); Phase 4, Registration & invite management, is
now also filed, from a direct product-owner ask rather than a spec
section. See "## Phase 4 tickets, Registration & invite management" below.

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
is not built here. The one open item there, that a `post_comments` trigger
cannot see the client-only mention list, is closed by 202608280021: the
four-argument `add_post_comment` writes `comment_mentions` and the mention
notification hangs off an AFTER INSERT trigger on that table, not on
`post_comments`.

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

ID range COMM-201 to COMM-234. Ticket files are in
`docs/community/tickets/`. Build order per
`2026-08-28-community-module-plan.md`: challenges, then events, then
announcement priority/recap/onboarding, then the coach dashboard, then
realtime, then search/following/directory, then web push, then analytics,
then the QA sweep. Every ticket in this phase respects the three
2026-08-30 resolutions: attendance stays out (COMM-205, COMM-210, COMM-232
are explicitly non-attendance and stay that way until their named Phase 3
successor), no "Message" affordance exists anywhere (COMM-224, COMM-230,
COMM-231, COMM-229 each say so explicitly), and web push (COMM-229)
proceeds with the iOS installed-PWA-only limitation accepted as scope, not
logged as a blocker.

### challenges

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-201 | Challenge model generalization from the weekly challenge | challenges | done |
| COMM-202 | Individual target and individual performance challenges | challenges | done |
| COMM-203 | Cooperative challenge with club aggregate and contributors | challenges | done |
| COMM-204 | Team challenge with per-team totals | challenges | done |
| COMM-205 | Consistency challenge on non-attendance metrics | challenges | done |
| COMM-206 | Coach custom-rules challenge | challenges | done |
| COMM-207 | Challenge list, detail, join and leave | challenges | done |

COMM-201 to COMM-207 build on `challenges`, `challenge_teams`,
`challenge_participants`, `challenge_progress` from 202608280009 (COMM-006),
whose direct RLS grants already cover create, edit, join, and leave.
Everything schema owed this cluster shipped in 202608290003 through
202608290006: the `challenge_progress_view` composite type and `chal_progress`
body, the `challenge_progress_apply` trigger (running-total sync plus the
cooperative milestone post), the `chal_record_progress` coach-entry RPC, and
the `ending_soon_notified_at` column plus `chal_notify_ending_soon()` and its
two join/complete notification triggers (COMM-208). See "## Challenges" in
`docs/community/contracts.md` for every signature, and "Phase 2 schema
handoff for qa" below for the boundary table. No feature agent is blocked on
schema for this cluster.

### events

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-213 | Events tables consumption, list and detail | events | done |
| COMM-214 | Event RSVP and capacity | events | done |
| COMM-215 | Event types and add to calendar | events | done |
| COMM-216 | Event comments | events | done |
| COMM-217 | Upcoming event card in the feed top area | events | done |

`events` and `event_attendees`, `event_rsvp`, and the capacity/deadline
trigger already shipped in 202608280010 (COMM-007). COMM-216 is a design
decision, not a schema change: event comments ride a companion `POST_EVENT`
post created at publish time, reusing `post_comments` end to end rather than
adding a polymorphic comment target. COMM-214's `notif_on_event_cancelled`
trigger shipped in 202608290009 with `supabase/tests/0029_event_cancelled_notification_test.sql`,
so no events ticket is schema-blocked; see "## Events" in
`docs/community/contracts.md`.

All five landed client-side in `cloud.js` against that shipped schema, no
migration: Upcoming/Past list and a create/edit form gated on
`community.event.manage` (COMM-213), RSVP through `event_rsvp()` with the
capacity/deadline errors surfaced on the detail dialog and the feed
top-area quick actions (COMM-214), nine typed badges plus a client-built
`.ics` download (COMM-215), the companion `POST_EVENT` post created at
first-publish via `post_create` and then promoted from its default
POST_TEXT shape by one own-row `posts_update_self` update - not a schema
change, see `ensureEventCompanionPost()`'s comment in `cloud.js` - with its
`post_comments` thread reusing `renderComments()`/`add_post_comment`
untouched (COMM-216), and the feed top-area card reading the same
`state.events` the Boards list loads (COMM-217). Also fixed as part of this
cluster: `resolveNotifTarget`'s `/feed` branch was shadowing `q.event`
before it could ever be checked, so an `event_cancelled` notification's
`/community/feed?event=<id>` link opened plain feed instead of the event -
the precedence now matches the existing `q.announcement` guard. The
COMM-228 search result's `open-event` action, previously a tracking-only
stub, now opens the real event detail. `test/community-events.test.mjs`
(20 tests) and one added assertion in `test/helpers/mockSupabase.mjs`'s
`event_rsvp` mock RPC (a faithful stand-in for the real function plus the
`enforce_event_capacity` trigger, needed for the capacity-race and
deadline tests) are the executing coverage; a real Add to Calendar click
degrades to the documented error message under jsdom's missing
Blob/URL.createObjectURL, so `buildEventIcs()` is tested directly and is
exported on `window` for that reason, same pattern as
`window.renderPostCard`.

### announcements and recaps

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-218 | Announcement priority levels and expiry | admin-moderation | done |
| COMM-219 | Announcement notification toggle and urgent path | notifications | done |
| COMM-220 | Weekly member recap Edge Function | recaps | done |
| COMM-221 | Weekly recap surface and share | recaps | done |
| COMM-222 | New member onboarding sequence, non-attendance steps | recaps | done |

COMM-218 replaces the Phase 1 `important` boolean with a three-tier
`priority` and an `expires_at` column; `important` stays as a generated
mirror so no other Phase 1 trigger needs an edit beyond
`notif_is_operational`, which COMM-219 widens. See "Needs from schema,
admin-moderation (Phase 2)" and "Needs from schema, notifications (Phase 2)".
COMM-220 needs a new `weekly_recaps` table, COMM-222 a new
`onboarding_progress` table, both own-row RLS, see "Needs from schema,
recaps". COMM-222's steps tied to first and third class attendance are not
built, carrying a TODO to COMM-P07 and COMM-316.

### coach-tools

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-223 | Coach dashboard shell with Celebrate | coach-tools | done |
| COMM-224 | Coach Welcome section | coach-tools | done |
| COMM-225 | One-tap congratulate action | coach-tools | done |
| COMM-226 | Coach Engage section scaffold, hidden | coach-tools | done |

COMM-223 needs a new staff-only `coach_celebrate_feed` function. COMM-224
needs `profiles.assigned_coach_id` and a new `member_contact_log` table.
See "Needs from schema, coach-tools". COMM-226 ships the Engage section
hidden behind a default-off flag; `coach_engagement_flags` (COMM-011) stays
empty, unchanged from Phase 1, until COMM-304.

### realtime and search

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-209 | Challenge realtime progress | platform | done |
| COMM-227 | Realtime for comments and reaction counts | platform | done |
| COMM-228 | Member, event, and challenge search | platform | done |
| COMM-210 | Consistency leaderboard mode, non-attendance | feed | done |
| COMM-211 | Progress leaderboard mode | feed | done |
| COMM-212 | Friends leaderboard mode and hide-my-result | feed | done |
| COMM-230 | Following system surface and states | engagement | done |
| COMM-231 | Members directory screen | engagement | done |
| COMM-232 | People you train with suggestions, non-attendance fallback | feed | done |

COMM-209, COMM-227 and COMM-228 are complete, both halves. Schema shipped in
202608290007 and 202608290008: `challenge_progress`,
`challenge_participants`, `post_comments`, `reactions`, and `notifications`
are in the `supabase_realtime` publication, and
`community_search(p_query, p_limit)` exists. The client half then landed in
`cloud.js`: five channels through `HaimuniaRealtime` (`chal-progress-<id>`,
`chal-participants-<id>`, `feed-comments`, `feed-reactions`, `notif-<uid>`),
each handler re-fetching through the surface's existing load path on a
400 ms debounce, torn down by `setCommunityTab`, `closeChallengeView` and
sign-out; plus the grouped members/events/challenges search UI on the
Account tab. The own-row notification subscription COMM-140 shipped as a
documented no-op is live, closing that gap. See "## Realtime and search" in
`docs/community/contracts.md` (moved there from "Needs from schema,
platform (Phase 2)", now closed) for both the schema and the client channel
inventory, the "Phase 2 schema handoff for qa" table below for boundaries,
and `test/community-realtime-and-search.test.mjs` for the executing
coverage. One gap this cluster deliberately left, for a follow-up ticket:
an event search result had nowhere to navigate until COMM-213 built the
event detail surface, so it recorded `EVENT_VIEWED` and rendered title,
start and status only - closed by the events cluster, whose `open-event`
action now opens the real detail dialog from that same search row.
COMM-210, COMM-211, COMM-212 and COMM-232 are now complete, both halves.
Schema shipped in 202608290015 (`leaderboard_row`, `feed_leaderboard`,
`people_suggestions`, `consistency_week_streaks`); the client half landed in
`cloud.js` as one fetch path and one row renderer shared by every board. See
"### Leaderboard and suggestions client contract" in
`docs/community/contracts.md` and
`test/community-leaderboards-and-suggestions.test.mjs` for the executing
coverage. Three decisions worth carrying forward:

- COMM-210's board replaced the old `community_streaks` strip on the Boards
  sub-tab rather than sitting beside it. Same figure, but ranked, tie-broken
  and privacy-filtered server-side, with the caller's own row always present.
  `loadStreaks()` / `state.streaks` stay, still read by the coach Welcome
  surface.
- COMM-211 swapped COMM-207's existing challenge-detail leaderboard panel off
  `chal_progress()`'s own `leaderboard` key and onto
  `feed_leaderboard(mode='progress', limit=20)`, which is what the ticket asked
  for and also closes a real gap: the old key applies neither `in_leaderboards`
  nor a stable tie-break. "The full board at 50" is the same panel re-asking,
  not a second screen. `chal_progress`'s key is untouched; the client just no
  longer reads it.
- COMM-232's strip was temporarily mounted on the Account sub-tab until the
  members directory existed to hold it. COMM-231 closes this: both
  `TODO(COMM-231)` markers left by this cluster are picked up -
  `renderPeopleSuggestions()` now renders only on the Directory sub-tab (moved,
  not duplicated), and COMM-212's friends-scope empty state now routes to the
  directory instead of the Account tab's bare search box.

COMM-230 and COMM-231 are now complete, both agreed to need no new contract
(no schema, no new RPC) and both delivered as such - a direct RLS read on
`follows` and a direct RLS cursor-paginated read on `profiles`. See
`test/community-following-surface.test.mjs` and
`test/community-members-directory.test.mjs` for the executing coverage. Two
decisions worth carrying forward:

- COMM-230's follower/following expand is only offered on the caller's own
  profile. `follows_visible` (202608260001) is `follower_id = auth.uid() or
  followed_id = auth.uid()` - a direct RLS read of another member's follower
  list would silently narrow to "the one edge that happens to also touch the
  caller", which is not that member's real follower list. Rather than render
  a list that is quietly wrong, another member's profile keeps the plain
  count (unchanged from pre-COMM-230) with no expand control. Enumerating a
  third party's real follower list would need a new definer RPC, out of this
  ticket's stated no-new-contract scope.
- COMM-231's directory reuses `community_search` (COMM-228) at its own
  2-character floor and falls back to a client-side filter over the
  already-loaded page below that, per the ticket's own "use your judgment"
  clause - documented at `directorySearch()` in `cloud.js`.

### web push, analytics, qa

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-229 | Web push subscription and service worker handler, behind a flag | notifications | done |
| COMM-233 | Phase 2 analytics events | platform | done |
| COMM-234 | Phase 2 QA sweep and browser scenarios | qa | done |

COMM-229 wires subscription storage (the `push_subscriptions` table already
shipped in 202608280008, no schema change) and the `sw.js` client handler.
Actually sending a push needs a `notif_push_send` service-role Edge Function
or scheduled job, not built by this ticket, the same "storage exists,
delivery scheduler does not" gap already logged for the Phase 1 batch
flusher. COMM-233 lands last, once every surface it tracks exists. COMM-234
is the phase's merge gate, dependent on every other Phase 2 ticket.

COMM-229's client half landed behind `state.featureFlags.notifPush`, the
same localStorage-backed pattern `featureFlags.coachEngage` (COMM-226) set:
default off, so `NOTIF_PUSH_ENABLED`'s "off in production" requirement holds
without a separate constant to keep in sync. A device has exactly one
PushSubscription regardless of how many notification types route through
it, so subscribing happens once (the first type switched to Push) and every
later type switched to Push just upserts its own `notification_preferences`
row without re-prompting - verified in
`test/community-web-push.test.mjs`. A real VAPID keypair was generated for
this ticket (Node's `crypto.generateKeyPair('ec', {namedCurve:
'prime256v1'})`, no `web-push` dependency added); the public half lives in
`cloud-config.js` as `notifPushVapidPublicKey` since a VAPID public key is
meant to be exposed to the browser, and the private half was discarded
rather than committed anywhere - whoever builds `notif_push_send` needs a
real one provisioned as a Supabase Edge Function secret at that time, not
this demo one. An OS-level permission revoke (outside the app) can't be
detected from a live `PushSubscription` object - the browser simply
discards it, with no API to recover the dead endpoint - so the client also
keeps its own last-known endpoint in `localStorage` and reconciles
`revoked_at` against it the next time the device's push status is
checked; this is best-effort by nature (a device that never reopens the
app after a revoke leaves its row unrevoked until `notif_push_send`
eventually gets a real send failure back from the push service and can
mark it itself - not built here, out of scope per the ticket). The
`notificationclick` cold-start path (`sw.js` opening a fresh window, no
existing one to focus) round-trips through a `?notif=` query param
app.js captures at boot and hands to the community layer once its own
session is ready - not strictly required by the ticket's own wording, but
built anyway so "opens one at the deep link" is true end-to-end rather
than only for the already-open-window case.

COMM-233 found the three bridged names it was asked to confirm
(`challenge_joined`, `challenge_completed`, `event_rsvp`) already firing end
to end from COMM-207's and COMM-214's producers, with no wiring to add: the
Phase 1 bridge and its agreed prop shape were what those producers emitted
into, which is the payoff of `BUS_EVENT_MAP` having been settled before the
surfaces existed. Two naming decisions worth carrying: the ticket's
`recap_viewed` / `recap_shared` were wired as the already-reserved
`weekly_recap_opened` / `weekly_recap_shared` rather than minted as second
spellings, since a rename would split every recap query and the reserved
names had never fired; and the props allow-list discipline `BUS_PROP_KEYS`
gave bridged events now exists for hand-tracked ones too, as
`HAND_PROP_KEYS`, applied inside `track()`. It covers the Phase 2 names
only - retro-fitting it onto Phase 1 events would silently narrow rows
already in the table, which is what `SCHEMA_VERSION` exists to make visible.
WCAM was reviewed name by name rather than by default: viewing (leaderboard,
recap, search, roster) does not count, `coach_congratulate_sent` counts for
the coach because the row's `user_id` is the actor, and `push_opt_in` is
account configuration, not participation. One pre-existing mislabel went
with it: the Boards list cards carried no `data-source`, so every challenge
or event opened from the Boards sub-tab recorded `source: "post_card"` - a
source split across that fix is not comparable, noted in metrics.md rather
than backfilled.

**COMM-234, the Phase 2 QA sweep and merge gate, DONE.** Cross-referenced
every Phase 2 ticket's acceptance criteria against the existing suite,
closed the real gaps found, and re-verified all three CI jobs independently
rather than trusting any earlier agent's own report. `npm test`: 764 -> 769
(768 pass, 1 skip, 0 fail). `npx supabase test db`: 884 -> 940 assertions
across 2 new files, verified from a clean `supabase db reset` (all 43
migrations apply) exactly like `migration-check` runs it - this session had
a working local Docker Supabase stack, unlike earlier Phase 2 sessions.
`scripts/browser-check`: 10 -> 17 scripts, all green, including 7 new
Community scenarios.

Also found: the challenges cluster's own backlog rows (COMM-201-207) had
been sitting at `todo` this whole phase, never bumped to `review` when the
schema and client commits landed - a bookkeeping gap, not a build gap (the
tests were real and passing throughout). Promoted straight to `done` here
along with every other Phase 2 ticket this sweep confirms.

Real bug found and fixed, not just flagged: `renderConfirmDialog()`
concatenated `renderConfirmSheet()` FIRST, before `renderChallengeViewOverlay()`,
`renderEventViewOverlay()`, and `renderPostComposer()`. Every one of those
overlays shares the same `.modal-overlay` class and the same fixed
`z-index:50` (index.html), so two open at once stack by DOM order, not by
which one is logically on top - and `askConfirm()` is always a
modal-on-modal nested inside whatever triggered it (leave-challenge fires it
with challengeView still open, event-cancel with eventView still open,
composer-discard with the post composer still open). In a real browser the
confirm button was rendered but visually unreachable, pointer-events
intercepted by the still-open parent dialog. No existing test caught this in
over 700 prior tests because jsdom's programmatic `.click()` has no
hit-testing - a real Chromium `scripts/browser-check/community-challenge-lifecycle.mjs`
run (built for this sweep) is what surfaced it. Fixed by moving
`renderConfirmSheet()` to the end of the concatenation; pinned two ways, a
source-order change-detector and a real render-path DOM-position assertion,
both in `test/community-confirm-flow.test.mjs`.

Browser scenario coverage: `scripts/browser-check/lib/mockCloud.mjs` is a
new harness that boots the real `index.html`/`cloud.js` in real Chromium
against the same `test/helpers/mockSupabase.mjs` every node integration test
already uses - `vendor/supabase.js`'s network request is intercepted and
replaced with a no-op script, and an `addInitScript` defines
`window.supabase.createClient()` to return the mock client before any page
script runs, plus a defensive `page.route(/supabase\.co/, abort)` net. This
was necessary, not optional: `cloud-config.js` points at the real, live
production Supabase project (see the module's own build notes), there is no
local-only demo backend, and running unattended CI browser scenarios that
write real challenges/events/follows/coach actions against that project was
never going to be acceptable. Seven scenarios, one file each:
`community-challenge-lifecycle.mjs` (create/join/leave), `community-event-rsvp.mjs`
(RSVP + the capacity figure updating immediately after the write - see that
file's own header for why genuine cross-device Postgres realtime push still
cannot be simulated this way, the same class of gap already logged for
Phase 0's local pgTAP situation), `community-notification-center.mjs`,
`community-search.mjs`, `community-directory-follow.mjs`, `community-recap.mjs`,
`community-coach-congratulate.mjs`.

Dialog keyboard/focus coverage: `challengeView`, `eventView`, and
`recapView` are real new Phase 2 modal dialogs wired into the exact same
`CLOUD_DIALOGS` shared-contract registry every Phase 1 dialog uses, but had
never had the opener-stored/first-control-focused/Tab-trap/Escape/restore
contract pinned - closed in `test/community-dialog-focus.test.mjs`, 3 new
tests, following COMM-190's established pattern exactly.

**A real mismatch, flagged rather than papered over**: COMM-234's own
acceptance criteria name five dialogs needing this same keyboard contract -
"challenge create/edit, event create/edit, directory filter panel, push
permission prompt, coach Congratulate confirm." None of the five exist as
an actual `.modal-overlay` dialog in the shipped client. Challenge and event
create/edit (`renderChallengeForm`/`renderEventForm`) are inline
`<form class="chart-card admin-card">` cards in the normal document flow,
never overlays. There is no directory filter panel anywhere in COMM-231's
shipped Directory screen - a search box plus a staff/members split, nothing
else. The "push permission prompt" is the native
`Notification.requestPermission()` browser chrome COMM-229's
`enableNotifPush()` calls - entirely outside the DOM, no app markup to trap
focus inside. Congratulate (COMM-225) is deliberately one-tap-is-confirmation
by design, no confirm dialog at all - `congratulateCelebrateItem()`'s own
comment in cloud.js says so, and `test/community-coach-tools.test.mjs`
already covers the disabled-after-send/no-second-send/failed-retry shape
that design implies. This is a wording mismatch between COMM-234's own
acceptance criteria and what those five earlier tickets actually shipped as
- not a gap this sweep could close by writing tests against markup that
does not exist. Documented in `test/community-dialog-focus.test.mjs`'s own
comment so a future sweep does not miscount it as untested.

Spec-ambiguity pinning, per COMM-234's own acceptance criteria: COMM-208
(joined/completed notification routing - batched to every OTHER active
participant, never the actor, never immediate) is now pinned twice, once at
the DB layer (`supabase/tests/0035_challenge_progress_notifications_test.sql`,
new this sweep) and once implicitly at the client layer (the notification
center just renders whatever rows exist, so the DB layer is the only place
this behavior can actually be pinned). COMM-216 (companion `POST_EVENT` +
reused `post_comments`, not a polymorphic comment target) and COMM-224
(Welcome as a public `add_post_comment` on the member's own card, not a
private message - consistent with the phase's "no Message affordance
anywhere" resolution) were both already pinned as executing tests before
this sweep, in `test/community-events.test.mjs` and
`test/community-coach-tools.test.mjs` respectively - confirmed, not
re-added.

Confirmed, not re-tested: the COMM-228 search-result-to-event-detail wiring
this cluster's own note above already says COMM-213 closed
(`test/community-events.test.mjs`, "a search result's open-event action
opens the real event detail"). The `follows_visible` RLS scope limit
(another member's profile shows a plain follower count, no expand) is
intentional by design and already pinned as such in
`test/community-following-surface.test.mjs` ("offers no expand affordance") -
confirmed this is not a silently-missing feature, no change needed. The
COMM-228 caret-preservation flake logged in the analytics cluster's commit
(a boot-time welcome-modal focus timer racing a test's own focus call) has
its 150ms settle delay already inherited by every new `activeElement`-
asserting test added this sweep, via the shared `openCommunity()` helper in
`test/community-dialog-focus.test.mjs`; re-ran that file three times back to
back with no flake observed.

No schema boundary bug was found by any of this sweep's new RLS/runtime
coverage - every new assertion passed on first real run against the
existing shipped SQL, so no COMM-019/020-style follow-up migration was
needed this time.

## Phase 3 tickets, Intelligence (spec V2)

ID range COMM-300 to COMM-317. Ticket files are in `docs/community/tickets/`.
COMM-300 is a new ticket number, not one of the 17 titles this phase started
with: it is the attendance-logging mechanism itself — the thing the
2026-08-30 resolution settled the *source* of ("self-reported, a
workout/session log entry standing in for a class check-in, not Arbox, not a
dedicated check-in flow") but never built. It did not fit as a subsection of
any of the 17 existing titles without hiding a real, separately-testable
piece of schema work inside an unrelated ticket, so it gets its own number,
consistent with the existing COMM-3xx convention, immediately before
COMM-301.

**Build order: COMM-300 first, ahead of every other Phase 3 schema work.**
It is the critical path for six of the seventeen numbered tickets
(COMM-302, COMM-304, COMM-305, COMM-306, COMM-307, COMM-316) and closes all
seven items in the parked bucket below (COMM-P06 and COMM-P07 both fold into
COMM-316). Recommended order after that: feed (COMM-301 for the extraction,
then COMM-302 since it is now unblocked, then COMM-306, COMM-307, COMM-303
last since it builds on 301/302), achievements (COMM-305), coach-tools
(COMM-304, then COMM-315), recaps (COMM-309, then COMM-316), challenges
(COMM-308, unblocked from the start, no ordering constraint), admin-moderation
(COMM-310 through COMM-313, in that order — each later one in that cluster
reads the one before it; **corrected while building: the 312/313 pair is the
other way round, see the admin-moderation section below**), identity-privacy (COMM-314, unblocked from the
start), qa (COMM-317, last, the phase's merge gate, same role COMM-234 played
for Phase 2).

### attendance foundation

| ID | Title | Agent | Attendance-blocked | Status |
|---|---|---|---|---|
| COMM-300 | Attendance-log mechanism and the ATTENDANCE_RECORDED source | schema | no — this is the unblock | review |

The Phase 3 tables started without the `Status` column every earlier phase's
table carries, because nothing in the phase had been built yet. This one
gains it now that a ticket has actually landed; the other Phase 3 tables
below pick it up as each cluster ships, rather than being pre-filled with
`todo` in a bulk edit that would touch every other agent's rows.

**COMM-300 is in review, and the six tickets it gated are unblocked.**
Shipped as `202608310001_attendance_log.sql`, with
`supabase/tests/0037_attendance_log_test.sql` (54 assertions) and
`test/community-attendance-log-rls.test.mjs` (22). See "Phase 3 schema
handoff for qa" below for the per-boundary detail and the three places the
built thing differs from this ticket's own migration outline. COMM-302,
COMM-304, COMM-305, COMM-306, COMM-307 and COMM-316 may all start.

Ships first. New `attendance_log` table, one row per `(user_id,
occurred_on)`, populated by a trigger on the existing `private_records`
table (the offline training log's own sync store, 202608260001) — not a new
check-in screen. No client insert/update/delete grant on the table at all;
the trigger is the only writer. Gives `ATTENDANCE_RECORDED` (defined with
zero producers since COMM-012) its first real client-side emit and its
first analytics event. Builds nothing that *reads* attendance yet — every
downstream ticket below does that. See COMM-300's own "Note on what
'verified' means here": every later ticket titled "verified attendance"
means "derived server-side from the member's own private training log," the
same trust boundary `private_records` already has today, not a physical or
staff-confirmed check-in.

### feed

| ID | Title | Agent | Attendance-blocked | Status |
|---|---|---|---|---|
| COMM-301 | Relationship score from interaction history | feed | no | review |
| COMM-302 | Recurring classmate score once attendance lands | feed | was — unblocked by COMM-300 | review |
| COMM-303 | Personalized feed ranking and per-user weights | feed | no | review — **storage and reader only; the derivation is NOT built** |
| COMM-306 | Consistency leaderboard on verified attendance | feed | was — unblocked by COMM-300 | review |
| COMM-307 | Post-class trained-with-you card | feed | was — unblocked by COMM-300 | review — **both halves in; the client half landed too** |

**COMM-301 is in review.** Shipped as `202608310002_relationship_score.sql`,
with `supabase/tests/0038_relationship_score_test.sql` (26 assertions) and no
client change at all — no new call, no changed signature, so no node-side
test moved. A pure extraction: `feed_page`'s body is byte-identical to
202608280019 apart from the two edits this ticket names, and the ranked order
and `feed_score` values for a fixture set were captured from the pre-refactor
function and are asserted against the post-refactor one to six decimal
places. COMM-303 can now read `relationship_score()`'s output as a component
it reweights without knowing its internals. `people_suggestions` (COMM-232)
was left untouched, per COMM-301's own scope boundary, and 0038 asserts that
too.

**COMM-302 is in review, and it closes the parked COMM-P01.** Shipped as
`202608310003_classmate_signal.sql`, with
`supabase/tests/0039_classmate_signal_test.sql` (37 assertions) and no client
change at all — both functions keep their exact signatures and
`people_suggestions`' returned shape only gains a key, so nothing on the node
side moved (791/790/1/0, unchanged). `feed_page`'s `v_class_connection` is no
longer a hard 0: it is `least(1.0, shared_days / 8.0)` over a trailing 60-day
window, multiplied by the `v_w_class = 6` that was reserved for it in
202608280019. `people_suggestions` gained the fourth branch its own migration
comment promised, and its priority order is now challenge, classmate,
interaction, event. One function beyond the ticket's outline:
`classmate_day_counts()`, internal and ungranted, so the window, the overlap
count and the `show_attendance` gate exist once rather than twice — see the
handoff section below.

**COMM-306 is in review, and it closes the parked COMM-P02.** Shipped as
`202608310004_consistency_on_attendance.sql`, with
`supabase/tests/0040_consistency_on_attendance_test.sql` (31 assertions) and
no client change at all — `feed_leaderboard` and `community_profile` keep
their exact signatures and their exact shapes, so nothing on the node side
moved (791/790/1/0, unchanged). `consistency_week_streaks()`'s body is the
same arithmetic over `attendance_log.occurred_on` instead of
`workout_posts`, which is precisely the one-function change its own
202608290015 comment named; `community_profile`'s inline second copy moved
with it in the same migration, so the standing "the two cannot drift"
assertion in 0034 is re-run against the new source rather than retired, and
0040 widens it from the caller to every member on the board. Consistency mode
now also gates on `can_view_profile_field(member, 'show_attendance')` —
absent from the ranked set, not ranked at 0. One thing beyond the ticket's
outline: `community_profile`'s `current_streak` key is gated on that toggle
too, because the number is attendance-derived now — see the handoff section
below. `training_frequency` and `recent_workouts` are untouched.

**COMM-307 is in review — BOTH HALVES — and it closes the parked COMM-P05.**
The schema half shipped as
`202608310005_attendance_classmates_today.sql`, with
`supabase/tests/0041_attendance_classmates_today_test.sql` (35 assertions).
One new function, `attendance_classmates_today(p_limit int default 6)`, and
nothing else: no new table, no re-created function, no changed signature. It joins
`attendance_log` to itself on `occurred_on = current_date` and returns
`{user_id, display_name, handle, avatar_url}` for every other member who
trained today, gated per candidate by
`can_view_profile_field(candidate, 'show_attendance')` — the identical call
`classmate_day_counts()` makes, which carries block edges in both directions,
deleted profiles and `visible_to_club` with it. Two decisions the ticket left
open and this half settled, both in the handoff section below: the **caller's
own** `show_attendance` is enforced inside the function (empty set, never a
raise) rather than left to the client, and `p_limit` clamps 1..20 defaulting
to 6.

**The client half has now landed too**, in `cloud.js`, `src/analytics.js` and
`docs/community/metrics.md`, with `test/community-classmates-today.test.mjs`
(11 tests). The node suite moves 791/790/1/0 → **802/801/1/0**. What is in it:

- The card in COMM-115's feed top area, above the feed list, in the same
  `chart-card` shell and the same "renders nothing at all" omission style as
  the upcoming-event card (COMM-217) that shares the slot. One
  `attendance_classmates_today({ p_limit: 6 })` per feed session, issued from
  `afterRenderCommunity()` on the Feed sub-tab — the lazy pattern the
  consistency board and the directory already use, **not** `refreshSession()`'s
  boot batch, because the caller's own row for today is written by the
  `private_records` trigger behind `flushOutbox()`, which runs *after* that
  batch. Rendered in the order returned; never re-sorted.
- **Four ways to get no card, one behaviour.** Empty set, caller did not train,
  caller's own `show_attendance` off, failed fetch — all render nothing at all.
  No heading, no empty state, no retry, and no skeleton either: the slot's
  other occupant has none, and `show_attendance` defaults to false, so a
  placeholder would be the thing most members actually see. The client makes no
  attempt to tell the three server-side empties apart; it cannot, by design.
- **The Follow control is rendered on every row**, unlike `memberRowHtml()` and
  `followListRowHtml()`, which guard on `allow_follows`. The RPC returns four
  keys and `allow_follows` is not one of them, on purpose (contracts.md: "this
  is not a follow strip"), so there is nothing to guard on;
  `follows_insert_self` refuses the insert server-side and the existing
  `follow()` error path reports it exactly as it does everywhere else. No new
  follow mechanism and no client pre-filter that would leak another member's
  setting into the card.
- No Message affordance, per the standing no-messaging resolution — asserted,
  not just absent.
- `classmates_card_viewed` (`rows`, `source`), once per load of the card and
  never per re-render, fired from the render hook rather than the fetch because
  a fetch that answered is not yet a view. **Not** in `ACTIVE_MEMBER_EVENTS`:
  viewing a card is not participation (`leaderboard_viewed`'s reasoning), and
  the training behind it is already counted once as `attendance_recorded`.

One thing a reviewer should look at rather than skim: **the ticket's "Loading:
the feed top area's existing skeleton pattern (COMM-115)" was read as "the
pattern that slot actually has", which is no skeleton.** See the comment in
`renderClassmatesTodayCard()`. Nothing else in Phase 3 is waiting on either
half.

**COMM-303 is in review, and it closes the feed cluster — but read what it
does and does not contain before treating personalization as shipped.**
Shipped as `202608310006_personalized_feed_weights.sql`, with
`supabase/tests/0042_personalized_feed_weights_test.sql` (61 assertions) and
**no client change at all** — the ticket says so itself ("No new UI —
personalization is invisible ranking, not a setting"), `feed_page` keeps its
exact signature and returned columns, and the node suite is unchanged at
802/801/1/0.

**WHAT IS NOT BUILT, flagged here so it is not mistaken for a completed
feature: the weight-derivation algorithm.** Nothing in this ticket ever
writes a `member_feed_weights` row, and nothing derives a multiplier from a
member's `feed_interactions` history. `recompute_feed_weights(p_limit)` ships
as a real, granted, service-role-only function whose body is empty and always
returns 0. **So today every member has no row, and therefore every member
gets the fixed defaults and the feed order this module has always
produced.** That is the intended end state of COMM-303, not a gap in it — the
ticket puts the derivation out of scope explicitly, in the same "storage
exists, computation/delivery does not" bucket as the notification batch
flusher (202608280028: `notification_batches` written, nothing scheduled to
flush them) and `recap_weekly`'s own cron gap. What ships is the **storage**
and the **reader**: the table, its boundary, the redistribution arithmetic,
and `feed_page` falling back correctly.

What did land: `member_feed_weights` (own-row select, no client write grant of
any kind, service-role writer only, the `weekly_recaps` shape);
`feed_weights_resolve(p_user, p_defaults)`, internal and ungranted, holding
the clamp and the redistribution; and `feed_page` re-created a third time so
its eight weights are resolved per caller instead of being `constant`. Two
things a reviewer should look at rather than skim, both in the handoff section
below: **the sum invariant is a bounded proportional rescale, not a clamp**
(a naive clamp-and-use does not sum to anything fixed, and a naive rescale
breaks the clamp — both are shown with a worked counterexample), and **the
"positive weights sum to 104" comment was stale by 6 and is corrected to 110
without moving a single weight**.

COMM-301 extracts `feed_page`'s already-inline relationship arithmetic
(202608280019) into a reusable `relationship_score()` helper with no ranking
change — a prerequisite for COMM-303's per-user weighting, not for anything
attendance-related. COMM-307 closes COMM-P05, a new
feed-top-area card (`attendance_classmates_today()`) distinct from COMM-302's
suggestions-strip signal — "who trained today", not "who to follow". COMM-303
landed last in this cluster: it personalizes the weights COMM-301 extracted
and reads COMM-302's class-connection component as one of the things it can
reweight, with `v_w_class` deliberately not special-cased as immovable.

### achievements

| ID | Title | Agent | Attendance-blocked | Status |
|---|---|---|---|---|
| COMM-305 | Attendance milestone posts and achievements activation | achievements | was — unblocked by COMM-300 | review |

**COMM-305 is in review, and it closes the parked COMM-P03.** Shipped as
`202608310007_attendance_achievements.sql`, with
`supabase/tests/0043_attendance_achievements_test.sql` (50 assertions) and no
client change at all — no new call, no changed signature, and the metadata
shape the trigger writes is the one `renderAttendanceMilestonePostCard` has
read since Phase 1, so nothing on the node side moved (802/801/1/0,
unchanged). The four `ATTENDANCE_RECORDED` definitions are `enabled = true`;
an AFTER INSERT trigger on `attendance_log` mints the unlocks and, for the 25
and 100 milestones only, one authorless club-visible
`POST_ATTENDANCE_MILESTONE` per crossing gated on the member's own
`show_attendance`. `POST_ATTENDANCE_MILESTONE` has a producer for the first
time since COMM-001 added the enum label. Two things beyond the ticket's
outline, both in the handoff section below: a helper function
`attendance_week_streak(uuid, date)` so the streak arithmetic is not a second
copy of COMM-306's rule that could drift, and the count milestones testing
state rather than a just-crossed delta (a delta silently awards nothing on any
multi-row insert). `ach_claim` is untouched and still refuses all four codes;
the generic `ach_evaluate` consumer is still not built and this ticket
deliberately does not build it.

Closes COMM-P03. Flips the four seeded `ATTENDANCE_RECORDED`
`achievement_definitions` rows (202608280007) to `enabled = true` and gives
`POST_ATTENDANCE_MILESTONE` (a post_type enum label and client card contract
since Phase 1, never produced) its first real producer. Evaluated directly
off `attendance_log` by a table trigger, the same "no generic event-bus
consumer exists in this codebase, a table trigger does the job instead"
precedent `challenge_progress_apply`'s milestone post already set — this
ticket does not build the still-missing generic `ach_evaluate` path either.
Never client-claimable: `ach_claim` already refuses any
`trigger_type = 'ATTENDANCE_RECORDED'` code (202608280020) and this ticket
does not touch that refusal.

### coach-tools

| ID | Title | Agent | Attendance-blocked | Status |
|---|---|---|---|---|
| COMM-304 | Coach Engage activation and attendance-decline detection | coach-tools | was — unblocked by COMM-300 | review — both halves in |
| COMM-315 | Member of the week rotation across recognition categories | coach-tools | no | review — both halves in |

**COMM-304 is in review — BOTH HALVES — and it closes the parked COMM-P04.**
`coach_engagement_flags` has shipped empty since Phase 0 (202608280011) with
a comment naming this exact ticket; COMM-226 already built the Engage
section as a flag-gated hidden shell reading it — the schema half
(`1f8069d`) gives the table its first producer,
`coach_detect_engagement_decline()`, a service_role-only scheduled job that
compares an 8-week baseline to a 2-week recent window per member off
`attendance_log` and buckets into mild/significant/inactive via named
tuning constants; the client half (`c03eca7`) flips COMM-226's flag to
default-on and adds a translated level badge (never the raw enum or the
underlying session figures), review/dismiss (a direct RLS update, no
migration needed — verified against 202608280011's staff policy), and a
"reach out" one-tap action modeled on COMM-225's congratulate pattern. The
single most important existing rule, `user_id <> auth.uid()` on every
policy, is untouched by this ticket and gets extra qa scrutiny in COMM-317
now that the table has real rows for the first time. Two real gaps found
and left open: the ticket's empty-state copy doesn't match what COMM-226
actually shipped (went with the ticket's literal text), and
`profiles_read_authenticated` only bypasses `visible_to_club=false` for
`is_admin()`, not `is_staff()` — a non-admin coach resolving a flagged
member with a hidden profile gets a generic fallback label rather than a
name; the client degrades safely, but the policy gap itself is unfixed.
COMM-315 had no forward reference anywhere in this repo's docs and was
flagged as an open question in its own ticket file — the category set and
rotation order proposed there (consistency streak, PRs, challenge
completion, coach's pick) was the planner's best-effort reading of the
title, not settled spec text. **The user confirmed that proposal as-is on
2026-08-31, and both halves are now in review** (schema `202609010001`,
client `79664bf`). The
rotation index is whole weeks since the epoch Monday 2026-01-05 modulo 4,
not the ISO week number — an ISO year has 52 or 53 weeks, so the mod-4 form
of the week number repeats a category two weeks running at every 53-week
year (2026 is one), which a "stated, auditable, repeatable" order cannot
afford. Three of the four categories compute a suggestion from existing
data and none of them auto-publishes; every candidate passes the subject's
own toggle (`in_leaderboards` for streak and challenge, `show_prs` for PRs,
the same rule `coach_celebrate_feed` follows) **and the same toggles read
from the raw `profiles` columns**, which is the one place this went past the
Celebrate pattern. `can_view_profile_field()` short-circuits to true for an
admin before it reads any toggle, so through the helper alone an admin would
have been offered — and could have published — a "most PRs this week"
celebration of a member who keeps their PRs private. Celebrate shows a coach
a private dashboard row; this shows a caller a row they are about to
broadcast, so an admin's rank must not override a member's own choice. The
helper call is kept alongside the columns because it is the only thing that
settles block edges, and both halves are mutation-tested separately in 0045. Publishing writes an authorless
`POST_ANNOUNCEMENT` — the first producer that post type has ever had —
rather than reusing COMM-225's comment-on-a-card pattern, because three of
the four categories have no source post to comment on. Three real gaps left
open and not papered over: the consistency category reads
`feed_leaderboard`, which reports the streak **as of now** and takes no
as-of date, so publishing a months-old week under that category credits a
present-day streak; `show_attendance` and `show_prs` both default **false**,
so in a club where nobody has opted in, two of the four categories will
legitimately show the empty state most weeks; and nothing notifies the
member they were chosen, which the ticket does not ask for and which would
be a `notif_create` fan-out or a follow-up. The client half builds one
staff-only Coach Dashboard section (`renderCoachMemberOfWeekSection`) on
top of both functions: a single publish path serves both a computed
candidate's one-tap Publish and the free-form coach's-pick (the server, not
the client, decides which category the row records, so the client never
sends one and always re-fetches after a successful publish), all five real
Postgres error messages the schema half raises are mapped to short Hebrew,
and the frontend states match the ticket literally — candidates and the
coach's-pick form render together whenever the category has candidates, not
one-or-the-other.

### recaps

| ID | Title | Agent | Attendance-blocked | Status |
|---|---|---|---|---|
| COMM-309 | Monthly club recap Edge Function with admin preview | recaps | no | review — both halves in |
| COMM-316 | Monthly recap classmates and onboarding class steps, attendance | recaps | was — unblocked by COMM-300 | review — both halves in |

**COMM-309 is in review — BOTH HALVES.** Not attendance-blocked in the
gating sense — it could be built any time after COMM-300 exists in the
schema, since one of its aggregate figures (`sessions_logged`) reads
`attendance_log`, but every other figure does not depend on it. It is also
the first ticket to give aggregate, club-wide attendance figures any club
visibility, and stays aggregate-only forever — enforced by the table's own
shape (no `user_id`, no jsonb, no text column) rather than by convention,
unlike COMM-316's per-recap classmates line. Generation shipped as a
service-role-only Postgres function (`recap_monthly_generate`, schema
`f0482fc`) rather than an Edge Function like `recap_weekly` — no scheduler
built yet, matching every other periodic job in this module; a draft only
exists once someone invokes it by hand. The client half (`053ff8f`) adds a
Coach Dashboard preview with a publish control gated on
`community.analytics.view` or `is_admin()` (deliberately narrower than the
staff read policy — a coach can preview a draft but not publish it, per
the schema's own documented asymmetry) and a member-facing card on the
Account tab beside the existing weekly-recap entry that renders nothing at
all until a month is actually published.

**COMM-316 is in review — BOTH HALVES — and closes both COMM-P06 and
COMM-P07 in one ticket.** `weekly_recaps` gains a named classmates line (an
own-row surface, so naming individuals is fine, unlike COMM-309's club-wide
one) via `recap_weekly_classmates(p_user, p_week_start, p_limit)`
(schema `cdde05c`) and `onboarding_progress` gains the two class-attendance
steps COMM-222 explicitly deferred here by name. The real find: this
function runs as service_role with no session, so `can_view_profile_field()`
— every other Phase 3 reader's privacy resolution point — would resolve its
viewer from a null `auth.uid()` and return false for every candidate,
forever, silently. Verified directly against a service-role session before
writing the fix. The gate is instead written out term-for-term against an
explicit `p_user` parameter, deliberately omitting the helper's `is_admin()`
short-circuit — a weekly recap is a persisted, shareable artifact (COMM-221's
Share Recap), not a live view, so a member's own toggle outranks the
subject's rank, the same reasoning COMM-315 already established. The
feature half (`b3747d2`) wires `recap_weekly` (the Edge Function) to call
the new RPC once per member per week and renders the line in `cloud.js`;
the two onboarding steps rank after all three existing COMM-222 steps
rather than between them, a documented judgment call that keeps "these two
steps don't reorder the existing three" a structural guarantee. Flagged,
not fixed: `recap_weekly/index.ts` has no executing test coverage
anywhere in this repo (no Deno/Node harness exists for Edge Functions at
all) — same position every other helper in that file was already in.

### challenges

| ID | Title | Agent | Attendance-blocked | Status |
|---|---|---|---|---|
| COMM-308 | Advanced challenge team management | challenges | no | review — both halves in |

**COMM-308 is in review — BOTH HALVES.** Not attendance-blocked, no
ordering constraint against the rest of the phase. Coach-driven team CRUD,
member reassignment, and a captain label on top of COMM-204's existing team
challenge shape — no forward reference existed for this one either, but the
delta from COMM-204's shipped scope is concrete enough that this ticket
does not carry the same "open question" flag COMM-311/312/313/315 do. The
real find: the ticket's own acceptance criteria stated as fact that a plain
member's `challenge_participants_update_self` policy already refuses
setting `team_id` to a value they didn't pick at join — it doesn't; the
policy has no column restriction at all. Verified against the shipped
policy before writing the fix (schema `7e2f908`): a new trigger makes one
pick from null allowed (the only team write COMM-204's shipped client ever
makes) and refuses any later change by a non-holder. `captain_id` gets the
same "policy already allows the write, pin the column to the function
anyway" treatment `protect_is_admin()` established for
`recovery_verified_at`/`assigned_coach_id`, so every captain change is
audited even though the existing team UPDATE policy is technically wide
enough to set it directly. Team deletion with active members is refused by
a real trigger, not just client discipline — with a documented cascade
escape hatch so deleting a whole team challenge still works. The client
half (`f601dd4`) adds a staff-only management card below COMM-204's
unchanged member-facing team columns (verified byte-identical for a plain
member) with rename/delete/create, a captain picker, and a per-member team
reassignment picker; the captain badge itself is staff-only in this
ticket's reading of the frontend-states text, flagged as a real ambiguity
worth a second look if the intent was actually club-wide visibility.

### admin-moderation

| ID | Title | Agent | Attendance-blocked | Status |
|---|---|---|---|---|
| COMM-310 | Admin community analytics dashboard, full metric set | admin-moderation | no | review — both halves in |
| COMM-311 | Member engagement segmentation | admin-moderation | no | review — both halves in |
| COMM-312 | Community health score, internal only | admin-moderation | no | review — both halves in |
| COMM-313 | Retention correlation views | admin-moderation | no | review — both halves in |

**The whole admin-moderation cluster is in review — all four tickets, both
halves each.** Built in real dependency order (310 → 311 → 313 → 312, not
the ticket numbering order — see the ordering-correction note above)
rather than the numbering order, since COMM-312 genuinely reads COMM-313's
retention signal and COMM-313 does not read COMM-312 despite the ticket
text listing it as a dependency. COMM-310 shipped the shared foundation
every other ticket in the cluster reuses: `analytics_wcam_events()` (the
one server-side WCAM definition, mirroring `ACTIVE_MEMBER_EVENTS` in
`src/analytics.js`) and, client-side, the admin analytics dashboard shell
and period selector. COMM-311's segments and COMM-310's own metrics share
that one shell, gated on `has_perm('community.analytics.view') or
is_admin()`; COMM-312 and COMM-313 both instead gate on real `is_admin()`
alone — narrower on purpose, since a retention curve or an interpretive
composite score travels worse out of context than a raw count — and both
render as their own standalone sections rather than nested inside the
broader-gated shell, so the boundary stays visible at each section's own
call site instead of being buried inside a container whose header belongs
to a wider audience. None of these four are attendance-blocked, but COMM-313's onboarding-step
correlation reads COMM-316's two new columns, so it is ordered after the
recaps cluster above despite not being attendance-blocked itself. COMM-310
is the one ticket in this cluster with real grounding: `docs/community/
metrics.md`'s existing "Core metrics" and "Additional metrics" sections are
its whole scope, no new metric invented. COMM-311, COMM-312, and COMM-313
have no forward reference anywhere in this repo's docs — each ticket file
flags this explicitly and proposes a conservative, best-effort shape rather
than inventing spec text this planner never had.

**Ordering correction, made while building COMM-313.** The cluster does not
run strictly 310 → 311 → 312 → 313. COMM-310 → COMM-311 → COMM-313 does hold
(each reads `analytics_wcam_events()` from 310, and 313 is the more aggregate
sibling of 311), but **COMM-313 does not read COMM-312 at all** — its
acceptance criteria and client contracts never mention
`community_health_scores` or any COMM-312 function, and the only thing it
borrows from that ticket is the *wording* of the permission gate. **COMM-312
does read COMM-313**: its score names "a retention signal (COMM-313, once it
exists)" as one of four weighted inputs. So the real order is **310 → 311 →
313 → 312**, which is the order taken. COMM-313's schema half shipped in
`202609010008` (`retention_cohorts`, `retention_onboarding_correlation`,
`retention_welcome_correlation`, plus a private `retention_member_weeks()`
granted to no role and a `retention_min_cohort_size()` constant) with pgTAP
`0052`; its client half is still open. COMM-312 now has its retention input
available and should call one of those rather than re-derive a curve.

**COMM-312's schema half then shipped in `202609010009`** with pgTAP `0053`
(101 assertions; the suite went 1854 → 1955): the `community_health_scores`
table with a single `is_admin()` select policy and no client write grant at
all, `community_health_generate(p_week_start)` (service-role only, idempotent
per week, no scheduler — the same open infra item five other functions carry),
`community_health_history(p_weeks)` and a private
`community_health_component()`. Its client half is still open. It **did** read
COMM-313, as predicted — its retention component is the pooled week-4 retained
share out of the private `retention_member_weeks(6)`, which is the only one of
that migration's functions a service-role job can call, since the other three
raise on a null `auth.uid()`. That same `auth.uid()` fact is why nothing in
COMM-312 calls `analytics_dashboard()` either; WCAM share and engagement per
post are recomputed from `analytics_wcam_events()` and COMM-310's own
denominator. **One new open item came out of it, against COMM-313 rather than
COMM-312**: `retention_member_weeks()` is anchored on `now()` and takes no
as-of parameter, so a health score's retention component is measured as of the
run and not as of the scored week — harmless on a weekly schedule, misleading
in a backfill. Full reasoning, including the weight split and the two
normalisation constants, is in `docs/community/contracts.md` under "Needs from
schema, community health score (COMM-312, Phase 3)".

**With that, all four admin-moderation schema halves are shipped** (COMM-310
`202609010006`, COMM-311 `202609010007`, COMM-313 `202609010008`, COMM-312
`202609010009`). Four client halves remain open in this cluster.

### identity-privacy

| ID | Title | Agent | Attendance-blocked | Status |
|---|---|---|---|---|
| COMM-314 | Versioned abandoned-profile purge Edge Function and runbook | identity-privacy | no | review — no client surface (scheduled job only) |

Not the same job as the already-shipped `purge_due_accounts()`
(202608260001, a member's own *explicit* deletion request, purged 30 days
after they ask). This is a different, new category: an anonymous
`auth.users` account that never redeemed an invite and never verified
recovery, sitting abandoned. COMM-314 shipped: `202609010004`
(`public.purge_abandoned_profiles(p_retention_days)`, 30-day window
confirmed 2026-08-31) plus
`supabase/functions/purge_abandoned_profiles/index.ts` and
`docs/community/abandoned-profile-purge-runbook.md`. The Edge Function
calls the Postgres function over RPC rather than reading `auth.users`
directly — see `docs/community/contracts.md`'s "purge_abandoned_profiles —
SHIPPED" entry for why.

### qa

| ID | Title | Agent | Attendance-blocked | Status |
|---|---|---|---|---|
| COMM-317 | Phase 3 QA sweep | qa | no | done — see summary below |

Last, the phase's merge gate, same role COMM-234 played for Phase 2.
Depends on every other Phase 3 ticket.

**COMM-317, the Phase 3 QA sweep and merge gate, DONE.** Cross-referenced
every Phase 3 ticket's (COMM-300 through COMM-316) acceptance criteria
against the existing suite, closed the real gaps found, and re-verified all
three CI jobs independently from a genuinely fresh state (a local Docker
Supabase stack, `supabase db reset --local` then `supabase test db`, and a
clean `npm test`) rather than trusting any earlier agent's own report — the
same discipline COMM-234 held for Phase 2.

**A real bug found and fixed, not just flagged.**
`renderConsistencyLeaderboardSection()`'s own footer note on the "טבלת
עקביות" board — `"רצף שבועות רצופים עם אימון מתועד. נתוני נוכחות מאומתים
יתווספו בהמשך"` ("...verified attendance data will be added later") — dated
back to COMM-210 (Phase 2), when the board still ranked
`workout_posts`-derived streaks and the line was an honest "coming later"
promise. COMM-306 (Phase 3) replaced `consistency_week_streaks()`'s body
with `attendance_log` without anyone updating this copy, so the shipped
client told every member the exact feature already running under their feet
was still pending — the one place this sweep found the shipped copy
actually contradicting COMM-300's own "verified means self-reported, not
physically verified" framing (see below), rather than merely under- or
over-stating it. Corrected in `cloud.js` to `"הרצף מבוסס על אימונים שתועדו
ביומן האימונים האישי, לא על פרסום בפיד"` ("...based on sessions logged in
the personal training log, not on a feed post"), and pinned against
regression in `test/community-leaderboards-and-suggestions.test.mjs`.

**COMM-300's "self-reported, not physically verified" framing**, the one
item this phase's tickets flagged as still open at build time: confirmed
accurate everywhere else it appears. The migration's own "Note on what
'verified' means here" (202608310001) states it in exactly those terms, the
`attendance_log` pgTAP file proves at runtime that a member's own device is
the only path a row is ever written through (see below), and every later
ticket's client-facing copy this sweep audited (the classmates card, the
recap classmates line, the achievement unlock copy) describes a training
log entry, never a physical check-in or staff confirmation. The one
contradiction found is the stale consistency-board footer note above, now
fixed.

**`attendance_log`'s "only path" boundary (COMM-300), now proven twice at
runtime, not only read off `pg_catalog`.**
`supabase/tests/0037_attendance_log_test.sql` already had a member and an
admin attempt a direct insert and get refused (`throws_ok`, genuinely
executed) — that half was already real. Added: the same for the writer
function itself. As `authenticated` (a member, then an admin), calling
`public.attendance_log_from_record()` directly — not merely inserting into
`attendance_log` — is refused at runtime with a real permission error,
before Postgres even asks whether this is a trigger context. And as the
bootstrap superuser, who bypasses every grant this file's fixtures rely on
to build with RLS out of the way, the call is *still* refused — genuinely
executed and caught — because the function is declared `returns trigger`
and Postgres itself will not run one outside trigger context. So the
boundary holds twice over: nobody is granted execute, and even a grant
would not be enough. Three new pgTAP assertions.

**Re-verified rather than assumed, against real producer output, not empty-
table shape or planted rows:**
- `coach_engagement_flags`'s "the flagged member can never read their own
  row, even as staff or admin" — `supabase/tests/0044_coach_engagement_
  decline_test.sql` runs `coach_detect_engagement_decline()` for real, nine
  times, flags a real coach and a real admin, and then re-asserts both
  cannot read their own row through the table's own RLS. Already real
  before this sweep touched it; confirmed rather than re-added.
- The four `ATTENDANCE_RECORDED` achievements are not reachable through
  `ach_claim` now that they are `enabled` — `supabase/tests/0043_attendance_
  achievements_test.sql` has a real caller who has genuinely earned all four
  crossings attempt to claim them through `ach_claim(array[...])` and get
  refused on `trigger_type`, with a textual pin that the refusal line itself
  is untouched by COMM-305.
- `consistency_week_streaks()` and `community_profile`'s inline copy still
  agree — `supabase/tests/0040_consistency_on_attendance_test.sql` re-runs
  the "two copies cannot drift" pattern `0034` established, now against the
  attendance-based body and widened from one fixture member to every member
  on the board at once, with a non-vacuous check that the board is not all
  zeros.
- Every function crossing a privacy toggle this phase — `show_attendance` in
  `feed_page`'s classmate component, `people_suggestions`'s classmate signal
  (COMM-302), `attendance_classmates_today()` (COMM-307), the consistency
  board (COMM-306), the weekly recap classmates line (COMM-316); and
  `in_leaderboards`/`show_prs` in `member_of_week_candidates()` (COMM-315) —
  already has a real allow/deny pair per function, each with a positive
  control (the same data, toggle flipped, now included) and a block-edge
  case in both directions. Audited across `0039`, `0040`, `0041`, `0045` and
  `0047`; no gap found.

**Five new `scripts/browser-check` scenarios**, real Chromium against the
same in-page mocked backend (`lib/mockCloud.mjs`) COMM-234's sweep built,
never the real production Supabase project:
`community-classmates-card.mjs` (COMM-307 — drives the real
`window.queueSyncRecord()`/`flushOutbox()` client path to prove the
`ATTENDANCE_RECORDED` bus emit and its analytics row are real, then the
card, its Follow control and its `classmates_card_viewed` event off
`attendance_log` rows standing in for what the Postgres trigger this repo
has no local server to run would have produced);
`community-recap-classmates.mjs` (COMM-316 — the recap dialog's classmates
line, real names not a count, real profile links, the quiet-week empty
line, and that it survives `recap-older`/`recap-newer` navigation);
`community-coach-engage.mjs` (COMM-304 — the Engage section with two real
flagged members for the first time, the one-tap reach-out through a real
`post_create` + `POST_COACH` update, review, and dismiss); `community-
monthly-recap-publish.mjs` (COMM-309 — two-part: a coach previewing a
draft gets no publish control at all, matching the ticket's own explicit
"the preview boundary is WIDER than the publish boundary" warning, then an
admin publishing it for real, plus the server-side "already published"
refusal on a second call); and `community-member-of-week-publish.mjs`
(COMM-315 — the week's real rotation category and its computed candidate,
translated detail text, and a real one-click publish). 24 browser-check
scripts total (19 -> 24), all green.

**Scheduled-job gaps, consolidated in one place, matching how COMM-234
consolidated the notification-batch-flusher gap:** every "infra not built
here" note this phase's tickets and migrations logged individually, in one
list rather than scattered across five files:

| Function | Ticket | What runs it today |
|---|---|---|
| `recompute_feed_weights(p_limit)` | COMM-303 | Nothing. Ships as a granted, service-role-only, no-op stub returning 0 — deliberately not built (202608310006). `member_feed_weights` stays empty, so every member reads the fixed default weights. |
| `coach_detect_engagement_decline()` | COMM-304 | Nothing. Service-role-only, no `auth.uid()` check by design (202608310008) — the grant is the gate, same as the others here. |
| `recap_monthly_generate(p_month_start)` | COMM-309 | Nothing. Shipped as a service-role-only **Postgres function**, not a `supabase/functions/recap_monthly` Edge Function (a deliberate implementation-note deviation from the ticket's own outline, recorded in the migration header and contracts.md) — either shape still needs a caller. |
| `community_health_generate(p_week_start)` | COMM-312 | Nothing. Found this session, not named in COMM-312's own ticket text: its migration's own comment (202609010009) already lists itself alongside the other four in this table as sharing the same open item. |
| `purge_abandoned_profiles` Edge Function | COMM-314 | Nothing scheduled; runnable by hand (curl with a real service-role key, or `select public.purge_abandoned_profiles();` directly) — see `docs/community/abandoned-profile-purge-runbook.md`, which already documents this gap in its own "Nothing schedules this yet" section. |

All five carry the same shape every prior scheduler gap in this repo
already does (`recap_weekly`, `notif_batch_flush_due()`,
`chal_notify_ending_soon()`): a real function, service-role-only, no
`auth.uid()` check by design, waiting on a `pg_cron` entry or an external
scheduler this repo's CI does not provision. None of the five block Phase 3
being done — every one of them ships correctly with an empty/stub result
until a scheduler exists, which is the explicit, stated scope of every
ticket that logged one.

**Full WCAM (Weekly Community Active Members) re-review, playing COMM-233's
role for Phase 2.** Every event Phase 3 adds, checked against
`ACTIVE_MEMBER_EVENTS` explicitly:
- `attendance_recorded` (COMM-300) — **counts.** "Attending" is named
  outright in the WCAM definition (metrics.md section 78), and it is the
  one qualifying activity that can be true for a member who never opened
  the Community tab at all.
- `classmates_card_viewed` (COMM-307) — **does not count**, on the same
  reasoning `leaderboard_viewed` already uses: viewing a card is not
  participation, and the training that produced the card is already counted
  once, as `attendance_recorded`. Double-counting it would also make a
  member active off another member's session.
- COMM-304, COMM-309 and COMM-315 add **no new tracked events** — none of
  their own acceptance criteria call for one (COMM-307 and COMM-300 are the
  only two Phase 3 tickets that do), and independently checking `cloud.js`
  confirms no `analyticsTrack`/`track(A....)` call site exists for the
  Engage section, the monthly recap surfaces, or the member-of-week
  surfaces. Nothing to include or exclude because nothing was added — not
  defaulted, checked.

Both reasoning calls above are already written out in `src/analytics.js`'s
own comments (not merely asserted here), and independently re-derived
rather than trusted: `ACTIVE_MEMBER_EVENTS` (client, `src/analytics.js`),
`analytics_wcam_events()` (server, COMM-310's `202609010006`) and
`docs/community/metrics.md`'s own published SQL all carry the **identical
15-name list, in the identical order** — verified byte-for-byte by hand
this sweep, not just by trusting `0050`'s own pgTAP assertion that already
compares the first two. **No drift found; nothing to fix.**

**Every open question this phase's tickets flagged, checked against what
actually shipped, not trusted from the ticket text alone:** COMM-311's six
buckets (`new`/`declining`/`highly_active`/`steady`/`occasional`/`dormant`,
in that precedence) and COMM-312's four weights (0.40/0.25/0.25/0.10,
independently re-read from `202609010009`'s own constants) both match their
tickets' "Resolved 2026-08-31" sections exactly. COMM-315's rotation
(`member_of_week_category()`, `202609010001`) is `consistency_streak`,
`most_prs`, `challenge_completion`, `coachs_pick` in that order, exactly as
proposed. COMM-314's retention window is 30 days in both the SQL function's
default and the Edge Function's own `RETENTION_DAYS` constant
(`supabase/functions/purge_abandoned_profiles/index.ts`), matching the
runbook. No silent narrowing or widening found anywhere in this set.

**Final counts, from a genuinely fresh state:** `npm test` 907 -> 914 (913
pass, 1 skip, 0 fail — this sweep's own contribution is +1 test, pinning the
stale-copy fix above; the remaining +6 is a concurrent, out-of-scope commit
observed landing on this branch mid-sweep, see note below). `supabase test
db` (a local Docker Supabase stack, `supabase db reset --local` then
`supabase test db`, all 54 migrations applying clean): 1955 -> 1958
assertions across the same 54 files (this sweep's own +3, the
`attendance_log_from_record()` runtime boundary above; no new pgTAP file
needed since no schema gap was found). `scripts/browser-check`: 19 -> 24
scripts, all green.

**A note on scope, not a finding about this ticket:** a second, concurrent
commit (`96157a8`, "Member avatar photo, storage half (COMM-318)") landed on
this branch while this sweep was in progress, from what the session's own
memory record names as the queued next-phase work. COMM-318 is not one of
COMM-300 through COMM-316 and this sweep did not review it — flagged here
only so the `npm test`/pgTAP deltas above are not misread as this sweep's
own regression. `test/community-avatar-photo.test.mjs` (6 tests) is that
commit's own addition, not this one's.

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

The attendance *source* was resolved 2026-08-30 (self-reported, see below),
but the *mechanism* — the actual table and write path — did not exist until
this planning pass named it COMM-300. Every row above stays in this table,
unchanged, until its named Phase 3 ticket actually ships and closes it; this
table is a historical record of what was parked and why, not a live todo
list to edit as tickets are written. None of the seven is closed by this
planning session — only unblocked.

Updated 2026-08-31: COMM-300 has now shipped (202608310001), so "attendance
source" in the third column is no longer a future thing — `attendance_log`
exists and is populated. All seven rows are genuinely unblocked and none is
closed, exactly as the paragraph above describes: each stays here until its
named Phase 3 ticket ships. COMM-300 built the source and nothing that reads
it.

Updated 2026-08-31, second pass: **COMM-P01 is closed** by COMM-302
(202608310003). `feed_page`'s class-connection component is a real number
computed from `attendance_log`, and `people_suggestions` carries the same
signal as its second-strongest. The row stays in the table above because this
section is a record of what was parked and why, not a live todo list; the
other six remain open and unblocked.

Updated 2026-08-31, third pass: **COMM-P02 is closed** by COMM-306
(202608310004). The consistency board and every profile's `current_streak`
count weeks a member actually trained, from `attendance_log`, instead of weeks
they posted a workout or a PR. The row stays in the table above for the same
reason; five remain open and unblocked.

Updated 2026-08-31, fourth pass: **COMM-P05 is closed** by COMM-307
(202608310005 plus the client half in `cloud.js`). The post-class
trained-with-you card exists: `attendance_classmates_today()` answers "who else
logged a session today" from `attendance_log`, and the card in COMM-115's feed
top area renders it — or, far more often, renders nothing at all, which is the
whole design. Unlike the three closures above, this one needed both halves;
the schema half alone would not have closed it. The row stays in the table
above for the same reason; four remain open and unblocked.

Updated 2026-08-31, fifth pass: **COMM-P03 is closed** by COMM-305
(202608310007). The four `ATTENDANCE_RECORDED` achievement definitions,
seeded and disabled since Phase 0 with a comment saying enabling them later
would be an `UPDATE` rather than a migration, are enabled and earnable: a
trigger on `attendance_log` unlocks them on a real crossing, and the two count
milestones also produce the club's first ever `POST_ATTENDANCE_MILESTONE`
posts, a post type that has had an enum label and a client renderer and no
producer since COMM-001. Like COMM-306 and unlike COMM-307, this needed only
the schema half — the client renderer was already correct and renders real
data unchanged. The row stays in the table above for the same reason; three
remain open and unblocked (COMM-P04, COMM-P06, COMM-P07).

Updated 2026-09-01, sixth pass: **COMM-P04 is closed** by COMM-304
(202608310008 plus the client half in `cloud.js`). `coach_engagement_flags`
has its first producer — `coach_detect_engagement_decline()`, a scheduled
baseline-vs-recent comparison off `attendance_log` — and COMM-226's
previously flag-gated, hidden, empty Engage section is flipped default-on
with real rows, a review/dismiss write path, and a "reach out" one-tap
action. Like COMM-307 and unlike COMM-306/COMM-305, this needed both
halves. The row stays in the table above for the same reason; two remain
open and unblocked (COMM-P06, COMM-P07).

Updated 2026-09-01, seventh pass: **COMM-P06 and COMM-P07 are both closed**
by COMM-316 (202609010003 plus the Edge Function and client halves,
`cdde05c`/`b3747d2`) — the last two rows in this table. `weekly_recaps`
gains a real classmates line, gated by `recap_weekly_classmates()` written
against an explicit viewer parameter rather than the module's usual
`can_view_profile_field()` helper, since that helper cannot answer for a
service-role caller with no session; and `onboarding_progress` gains the
first- and third-class steps, ranked after the three COMM-222 steps rather
than between them. Like COMM-304/COMM-307, this needed both halves. The
row stays in the table above for the same reason. **All seven rows in the
parked bucket are now closed** — this table is complete as a historical
record.

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

### Achievement claim and seed (202608280020)

One new type, one new function, no new table.

| Function or data | Boundary to assert |
|---|---|
| ach_claim(p_codes text[]) | Writes `user_id` from `auth.uid()` only, never from the payload. A null or empty array returns nothing and raises nothing. 51 codes raises. A code whose definition is disabled, is `ATTENDANCE_RECORDED`, or lacks `config->>'client_claimable' = 'true'` is absent from the result and writes no row, and it is ignored rather than raised alongside a valid code in the same array. A second claim of a non-repeatable code returns nothing the second time. A member with a null `recovery_verified_at` raises `recovery method required`. The 31st call in 10 minutes raises `rate_limited`. **202608290002:** for any accepted code whose `config->>'metric' = 'tenure_days'` (the four `anniversary_year_*` rows), the claim is additionally, independently verified against `invite_redemptions.redeemed_at` — a member short of the day threshold gets no row for that code even though the definition is `client_claimable`, a redemption exactly on the threshold already qualifies, and every non-tenure `client_claimable` metric is unaffected. |
| achievement_definitions seed | 27 non-attendance rows are present and enabled. Every `community` and `challenge` category row, and every `club` category row except the four `anniversary_year_*` rows, has no `client_claimable` key, so `ach_claim` refuses it: this is the assertion that keeps a gameable count off the client path. The four `anniversary_year_*` rows ARE seeded `client_claimable: true`, gated instead by the independent tenure check above. The four attendance rows are still present, still `enabled = false`, and untouched by the seed. Re-running the seed changes no row count. |

### ach_claim tenure verification (202608290002)

No new table. `create or replace` of `ach_claim`, same signature.

| Function | Boundary to assert |
|---|---|
| ach_claim(p_codes text[]) | Closes a gaming gap found while writing 0020's pgTAP coverage: the four club-category `anniversary_year_*` rows are `client_claimable: true` like every other client-detected milestone, but membership tenure, unlike session/PR/streak/Rx counts, is derivable from `invite_redemptions.redeemed_at`, a server-set timestamp the client cannot write. A member whose redemption is younger than the code's `threshold` days gets no row for a `tenure_days`-metered code, even though the definition is client-claimable. A redemption exactly `threshold` days old (the `<=` boundary) already qualifies. The check is keyed on `config->>'metric' = 'tenure_days'`, not on the code, so it covers any future tenure-metered definition automatically. |

### Comment mentions and self-delete (202608280021)

| Table | Boundary to assert |
|---|---|
| comment_mentions | Select is the only grant and the only policy: a direct insert, update, or delete fails for everyone, an author and a moderator included. A member reads a row only when they are the mentioned user or the comment author. A third member who can read the comment still reads no mention rows for it, which is the leak that matters. |

Four behaviour assertions on the four-argument `add_post_comment`. A target
with `allow_mentions` off gets no row while the comment itself still lands.
A target behind a block edge in either direction gets no row. Self-mention
and duplicate ids write nothing extra. Eleven mentions raises. The two- and
three-argument forms must still resolve and behave exactly as before, which
is the regression that would break the current client.

`comment_delete` needs three: a non-author is refused, the author's call
sets `status`, `deleted_at`, and `deleted_by` together, and a second call on
an already-removed comment is a silent no-op that does not overwrite a
moderator's `deleted_by`. One more that matters more than the shape: the
soft-deleted comment drops out of `post_comments_visible` for everyone but
its author and a `community.comment.moderate` holder, and its replies are
still returned with `parent_comment_id` intact.

### Profile view and decorative media (202608280022)

No new table. One new column and one new function.

| Function or column | Boundary to assert |
|---|---|
| community_profile(user_id uuid) | A fully private target (`visible_to_club` off) returns name, role, and member since and nothing else, and specifically no `posts`, `prs`, `achievements`, or counts. A target with `show_prs` off omits the `prs` key entirely rather than returning an empty array, and with it on and no PRs returns `[]`: hidden and empty must stay distinguishable. Same for `achievements`. A block edge in either direction raises `not authorized` rather than returning the header. A deleted target raises `profile not found`. The `posts` array never contains an only_me or friends post the caller cannot see, and `result_text` plus the numeric `metadata` keys are stripped when `show_workout_results` is off. An anonymous or signed-out caller raises. |
| post_media.decorative | Defaults false, so every existing row is unchanged. An insert marked decorative with alt text stores a null `alt_text`, and so does an insert with whitespace-only alt text. Updating a row to decorative clears its alt text in the same statement. |

### Post create (202608280023)

No new table. One new function, `post_create(text, post_visibility, jsonb,
jsonb)`, which closes the composer's end-to-end break.

| Function | Boundary to assert |
|---|---|
| post_create(body, visibility, media, links) | A null caller raises `not authorized`; a caller without `community.post.create` raises `not authorized`; a member with a null `recovery_verified_at` raises `recovery method required`; a member with an active `posting_restrictions` row raises `posting_restricted`, and that check runs before the rate limit so a restricted member burns no budget; the 21st call in 10 minutes raises `rate_limited`. An empty body with empty `media` raises. A `media` array of 5 raises; each item needs a `storage_path`. A media `storage_path` whose first path segment is not the caller's uid is rejected by `enforce_post_media_ownership` and the whole call rolls back, post row included. A decorative item stores a null `alt_text` (the `post_media_normalize_alt` trigger). `post_type` is `POST_PHOTO` only when there is media and no text, else `POST_TEXT`. `visibility` round-trips `club`, `friends`, `only_me`. The row and its `post_media` rows either all land or none do. |

### Reports target and status (202608280024)

No new table. New columns on `reports`, a wider `reason` CHECK, a swapped
unique key, and a new `report_status` label.

| Column or constraint | Boundary to assert |
|---|---|
| reports.target_type, reports.target_id | `target_type` is `post` or `comment`; anything else fails the CHECK. `target_id` is NOT NULL. Every pre-existing row has `target_type = 'post'` and `target_id = post_id`. `post_id` is now nullable and a `comment` report written through `report()` leaves it null, which is what keeps `feed_page`'s reporter self-hide (keyed to `post_id`) from hiding the post a comment sits on. |
| reports unique key | `(reporter_id, target_type, target_id)` is unique; the old `(reporter_id, post_id)` is gone. A second `report()` by the same reporter on the same target updates the row rather than inserting a second one. |
| reports.review_note | Defaults `''`, capped at 500 chars, separate from `details` (the reporter's own note). |
| report_status | `action_taken` is a valid label; `resolved` is still present and no row was remapped. |

### Moderation reshape (202608280025)

One new composite type `mod_queue_item`, and the functions `report`,
`submit_report` (rewritten as a wrapper), `post_delete`, `comment_moderate`,
`mod_queue`, `mod_review`, `admin_grant_coach(uuid, text)`, plus rewrites of
`admin_grant_coach(uuid)` and `admin_revoke_coach`.

| Function | Boundary to assert |
|---|---|
| report(p_target_type, p_target_id, p_reason, p_note) | Requires `is_community_member()`. Unknown `p_target_type` or `p_reason` raises. Rate limited at 10 per 10 minutes. A post target sets `post_id = target_id`; a comment target leaves `post_id` null. A duplicate by the same reporter on the same target refreshes `reason` and `details` and does not add a row or move the distinct-reporter count or reopen `status`. `submit_report(post_id, reason)` still resolves and routes here. |
| post_delete(post_id) | The author always. A non-author only with `community.post.delete_any` OR `community.comment.moderate` OR real `is_admin`; anyone else raises. Sets `deleted_at` and status `removed`, idempotent on a second call. A moderator removal writes one `content_delete` audit row; an author removing their own post writes none. |
| comment_moderate(p_comment_id, p_action) | Requires `community.comment.moderate` OR real `is_admin`. `remove` sets status `removed`, `deleted_at`, and `deleted_by = auth.uid()`; `restore` clears all three. An unknown action raises. Idempotent: a second `remove` returns before touching `deleted_by`, so it never overwrites a self-delete stamp and a self-delete never overwrites it. Each call writes one `content_delete` audit row, target_type `comment`. |
| mod_queue(p_status, p_cursor, p_limit) | Requires `community.comment.moderate` OR real `is_admin`; a plain member raises `not authorized`. One row per `(target_type, target_id)`. `reporter_count` is distinct reporters, `reasons` is the distinct set, `status` is `open` if any report is open then `reviewing` then `dismissed` then `action_taken`. `p_status = 'all'` returns every group; `p_limit` clamps to 1..50. `reporters` jsonb carries `{id, name}` and is only ever returned here. |
| mod_review(p_report_id, p_decision, p_note, p_expires_at) | Requires `community.comment.moderate` OR real `is_admin`. `remove` on a post routes through `post_delete`, on a comment through `comment_moderate('remove')`, so a remove leaves two audit rows (`content_delete` + `report_review`). `restrict_temp` / `restrict_permanent` route through `mod_restrict_member` against the content author, which itself needs `community.member.restrict`, so a `comment.moderate`-only caller can pick them and the call then raises. Every decision stamps every `reports` row for the target with `reviewed_by`, `reviewed_at`, `review_note`, sets `status` to `dismissed` for `dismiss` and `action_taken` otherwise, and writes one `report_review` audit row (`before {status}`, `after {status, decision}`). `p_expires_at` is read only for `restrict_temp`. |
| admin_grant_coach(uuid, text) / admin_grant_coach(uuid) / admin_revoke_coach(uuid) | Real `is_admin` inline. The two-argument form takes `p_role` in `coach` or `head_coach` only; `staff`, `owner`, or anything else raises. The one-argument form still resolves (no default on the two-argument `p_role`, so `admin_grant_coach(uuid)` is not ambiguous) and grants `coach`. Every grant and revoke writes one `role_change` audit row, target_type `member`, `before {role: <prior>}`, `after {role: <new>}`. A revoke of someone already `member` writes nothing. |

### Notification create path (202608280026)

No new table. One column `announcements.important`, `notif_create`, and the
helpers `notif_dedupe_window`, `notif_pref_key`, `notif_pref_allows`,
`notif_blocked_between`, `notif_is_operational`. Also re-creates
`notifications_deep_link_check` with a `{0,255}` regex bound (the
`{0,300}` original raised `invalid repetition count(s)` on every insert
with a non-null `deep_link`).

| Function or column | Boundary to assert |
|---|---|
| notif_create(...) | No client can call it: `revoke execute` from public, anon, and authenticated, no grant to anyone, so a PostgREST RPC to `notif_create` fails for a member, a coach, and an admin alike. Its effects are only observable through the trigger set. Returns NULL and writes nothing when recipient == actor (except `achievement_unlocked` / `weekly_recap`), when a block edge sits either way, when the recipient has an `off` preference on the mapped key and the row is not operational, or when an identical `(user_id, type, source_id)` row exists inside `notif_dedupe_window()`. Truncates title to 160 and body to 500. |
| notif_dedupe_window() | Immutable, returns `1 hour`, granted to `authenticated`. |
| announcements.important | Defaults false. Only `is_staff()` can set it (the existing `announcements_insert_admin` / `announcements_update_admin` policies). A member cannot flip it. |
| notifications_deep_link_check | A row with `deep_link = '/community/feed?post=<uuid>&comment=<uuid>'` inserts (via a trigger) without raising; a `deep_link` not starting with `/` still fails the CHECK. |

### Notification trigger set (202608280027)

No new table. Five AFTER INSERT / UPDATE triggers plus
`notif_announcement_fanout`. All trigger functions are `revoke execute`
from every client role.

| Trigger | Boundary to assert |
|---|---|
| notif_on_comment (post_comments) | A first comment by member X on Y's post writes one immediate `comment_on_post` for Y. A second comment by X on the same post writes no `notifications` row and increments `comment_also` in Y's `community` batch in place. A reply writes one `comment_reply` for the parent author (unless that is the replier). X commenting on X's own post writes nothing. A block edge between X and Y suppresses both the immediate row and the batch enqueue. |
| notif_on_mention (comment_mentions) | Fires on `comment_mentions`, never on `post_comments`: a bare comment with an `@name` string in the body but no accepted `comment_mentions` row produces no `mention` notification. One row per accepted mention. `coach_mention` when the comment author holds `coach` or `head_coach`, else `mention`. A target with `mentions` preference `off`, or a block edge, gets nothing. |
| notif_on_reaction (reactions) | Never writes an immediate `notifications` row. Increments `reaction` in the post author's `community` batch when author `<> NEW.user_id`, no block edge, and the author's `reactions` preference is not `off`. A reaction on your own post does nothing. |
| notif_on_announcement (announcements) | A normal announcement writes one immediate `announcement` row for every club member except the author whose `announcements` preference is not `off`. An `important` announcement reaches every member including those with the preference `off`. Flipping `important` false -> true fans out only to members with an explicit `off` row, so no member ever gets two rows for one announcement. The deep link is `/community/feed?announcement=<id>`. |
| notif_on_achievement (member_achievements) | A `member_achievements` insert for member U writes one immediate `achievement_unlocked` for U (recipient == actor is allowed for this type). Each member in a mutual-follow edge with U, with U's `visible_to_club` and `show_achievements` on, `NEW.visibility <> 'only_me'`, no block edge, and `friend_achievements` not `off`, gets a `friend_achievement` entry in their `training` batch. `only_me` visibility fans out to nobody. |

### Notification batch flusher (202608280028)

No new table. `notif_batch_flush_due` and `notif_category_surface`.

| Function | Boundary to assert |
|---|---|
| notif_batch_flush_due(p_limit) | Granted to `service_role` only: no client can call it. Processes only `notification_batches` rows with `next_flush_at <= now()` and `pending_count > 0`. Writes one `notifications` row per key in `pending`, using the batched type key as `notifications.type`, then calls `notif_batch_flushed` so the row's `pending_count` returns to 0. Deep link is `/community/feed?post=<last_source_id>` only when that type is the whole batch and is `reaction` or `comment_also`, otherwise the category surface. Returns the count of rows written. A second call with nothing due returns 0 and writes nothing. NOTE: nothing schedules this yet - a pg_cron entry or scheduled Edge Function is still needed for batched notifications to be delivered. |

## Phase 2 schema handoff for qa

Same rule as every prior handoff: one line per table/function/trigger saying
the boundary a test has to assert.

### Challenges (202608290003 through 202608290006)

No new table - four columns added to `challenge_progress` and `challenges`,
one composite type, one read function, two triggers on `challenge_progress`,
one write RPC, one service-role RPC, two triggers on `challenge_participants`.
Originally verified only locally (`supabase db reset` plus manual psql smoke
tests) when this migration landed, with no committed, CI-running pgTAP file -
a real gap COMM-234's sweep found and closed:
`supabase/tests/0035_challenge_progress_notifications_test.sql` (39
assertions) now runs every boundary below for real on every
`migration-check`, including the COMM-208 routing rows this table exists to
pin. One item below is still genuinely open, not silently claimed: the
`team_id` snapshot's "still counts after leaving" case (a participant
delete plus a re-read) - flagged again for a future run, not attempted here
either.

| Function / trigger / column | Boundary to assert |
|---|---|
| chal_progress(challenge_id) | Raises `not authorized` for a null caller and for a caller with no live role. Raises `challenge not found` for a `draft` challenge read by anyone but its creator or a `community.challenge.create` holder (verified: the creating coach CAN read their own draft). Returns the right non-null fields per `challenge_type` and leaves every non-applicable field null (verified all five types: individual_target, cooperative, team, coach, individual_performance). A non-participant reading a challenge they never joined gets `my_progress`/`my_status` null, not zero/'active', with every other field intact. |
| challenge_progress_apply (AFTER INSERT on challenge_progress) | Sums `delta` into the matching `challenge_participants.progress_value` (verified: 60 then +50 on a target of 100 reaches 110). Flips `individual_target`/`individual_performance` to `completed` with `completed_at` set exactly the first time the total reaches `target_value`, and a later negative correction (verified: -80 after completion) leaves `status = 'completed'` and only lowers `progress_value`. |
| challenge_progress_apply, cooperative milestone | For a `cooperative` challenge, posts one authorless (`author_id is null`) `POST_CHALLENGE` `workout_posts` row the first time `club_total` reaches each of 25/50/75/100 percent of `target_value`, never a repeat post for a threshold already crossed (verified: a later contribution that keeps the total above 50% does not produce a second 50% post), and a single contribution that crosses two thresholds at once (verified: 65% -> 105%) posts both 75% and 100% in the same transaction. |
| challenge_progress.team_id, challenge_progress_stamp_team (BEFORE INSERT) | Snapshots the contributor's current `challenge_participants.team_id` onto the progress row at insert time; `chal_progress`'s `team_totals` sums from this column, not from the live participant row, so a departed member's earlier contributions keep counting for their old team (not independently re-verified this run past the trigger firing correctly - the "still counts after leaving" case needs a participant delete plus a re-read, flagged for qa to cover explicitly). |
| challenge_progress.entered_by / note, challenge_progress_insert_self (re-created) | A self-insert with `entered_by` set to any uuid is rejected by RLS (verified: `entered_by = <coach>` on an m1 self-insert raises "new row violates row-level security policy"). A plain self-insert with no `entered_by` still succeeds. |
| chal_record_progress(p_challenge_id, p_user_id, p_delta, p_note) | Raises `not authorized` for a caller without `community.challenge.create` (verified: m1 targeting m2). Raises `not an active participant` for a target with no active `challenge_participants` row on that challenge (verified: coach targeting m3, who never joined). A holder targeting an active participant writes one `challenge_progress` row with `source_type = 'coach_entry'` and `entered_by` the caller (verified, then confirmed `challenge_progress_apply` applies it exactly like a self-insert). |
| challenges.ending_soon_notified_at, chal_notify_ending_soon() | Granted to `service_role` only (verified: `authenticated` gets "permission denied for function"). Selects only `active` challenges ending within 48 hours with the column still null, `notif_create`s every active participant, stamps the column. A second call after stamping is a no-op (verified: returns 0, writes nothing). |
| notif_on_challenge_join (AFTER INSERT on challenge_participants) | Enqueues batched `challenge_update` for every other active participant on the same challenge, never the joiner, never immediate (verified across 10 joins spanning 5 challenges: exact per-recipient counts matched hand-tallied expectations). |
| notif_on_challenge_complete (AFTER UPDATE OF status on challenge_participants) | Enqueues the same batched fan-out only on a genuine transition into `completed` (guards against the trigger firing on every `challenge_progress_apply` UPDATE, which always touches the `status` column even when unchanged), never to the completer (verified: m1 completing did not add to m1's own batch, only to m2's). |

### Realtime publication and community_search (202608290007, 202608290008)

No new table - a publication membership change plus one new read function.
`test/community-realtime-search-rls.test.mjs` pins the static half (grant
list, security definer shape, the exact predicate mirrored from each source
policy). The runtime half below was originally only verified locally by
hand, with its own text here noting "this is where a pgTAP suite covering
the runtime half belongs next" - COMM-234's sweep added that suite:
`supabase/tests/0036_realtime_and_search_runtime_test.sql` (17 assertions),
run for real by `migration-check` from here on.

| Function / migration | Boundary to assert |
|---|---|
| supabase_realtime publication (202608290007) | `select * from pg_publication_tables where pubname = 'supabase_realtime'` contains exactly `challenge_progress`, `challenge_participants`, `post_comments`, `reactions`, `notifications` (verified: all five present, nothing else added by this migration). |
| community_search(p_query, p_limit) | Granted to `authenticated` only (verified: `anon` role gets "permission denied for function"). Raises `not authorized` for a null caller (verified: `authenticated` role with no `request.jwt.claim.sub` set). |
| community_search, sub-2-char threshold | A 1-character or empty (after `%_,()` stripping) query returns `{members: [], events: [], challenges: []}` with no table read, not an error (verified: `'S'` and `'%_,()'` alone both short-circuit). |
| community_search, sanitization | A query built only from `%`, `_`, `,`, `(`, `)` strips to empty and short-circuits rather than wildcard-matching every row (verified: `'%_,()Zzz'` correctly matches only titles containing `Zzz`, not every row). |
| community_search, members group | Mirrors `profiles_read_authenticated` exactly: excludes the caller's own row (verified), excludes a member with `visible_to_club = false` from a non-admin caller (verified: fixture `SearchHidden Member` invisible to m1), excludes a member on either side of a `blocks` row (verified: m3 blocking m1 hides m1 from m3's search and vice versa). |
| community_search, events group | A `draft` event is invisible to a caller who is neither its creator nor a `community.event.manage` holder (verified: m2 searching does not see m1's draft), visible to its creator (verified: m1 sees its own draft) and to a manage-permission holder who did not create it (verified: coach sees m1's draft). Non-draft statuses (`published`, `cancelled`, `past`) are visible to everyone regardless of creator, matching `events_read`'s actual `status <> 'draft'` predicate rather than a narrower "published only" reading. |
| community_search, challenges group | Same shape as events, verified against `challenges_read`'s `community.challenge.create` permission: a `draft` challenge is invisible to a non-creator without that permission, visible to its creator, and visible to a permission holder who did not create it. |
| community_search, p_limit | Each group is capped independently by the clamped `p_limit` (verified: `p_limit = 1` against two matching challenges returns exactly one). |

### Announcements, recaps, coach-tools, new-member post, and leaderboards (202608290010, 011, 013, 014, 015)

Unlike every table/function above, these five migrations' own pgTAP files
(`supabase/tests/0030` through `0034`) were written and committed alongside
each cluster's schema commit, not left as a follow-up - the note here is
purely that this handoff section itself never listed them, which is a real
documentation gap COMM-234's sweep is closing, not a test gap: `npx supabase
test db` already runs all five, 884 assertions total before this sweep's own
0035/0036 additions. One line per new table, same rule as every other
handoff above.

| Table / function | Boundary asserted (see the named file for the executing detail) |
|---|---|
| announcements.priority / expires_at (202608290010) | `0030_announcement_priority_expiry_test.sql`: only `is_staff()` sets priority or expiry; an expired announcement drops out of `announcements_read` at read time, no cron; the `important` mirror trigger keeps firing off the 3-tier value so the Phase 1 escalation trigger needs no edit. |
| weekly_recaps (202608290011) | `0031_recaps_and_onboarding_test.sql`: own-row read only, zero client write grant of any kind including the owning member - only `service_role` (the Edge Function, bypassing RLS) writes; the `(user_id, week_start)` unique key both rejects a duplicate and carries `recap_weekly`'s upsert idempotency; `week_start` is CHECK'd to a Monday. |
| onboarding_progress (202608290011) | `0031_recaps_and_onboarding_test.sql`: seeded only by the `invite_redemptions` AFTER INSERT trigger, never by a client insert; own-row read and update; a stamp is one-way (a clear or a re-stamp is a silent no-op, not an error); a redemption UPDATE (coach grant) does not re-seed or reset it. |
| coach_celebrate_feed(), coach_assign_coach(), member_contact_log (202608290013) | `0032_coach_tools_test.sql`: `coach_celebrate_feed` and `coach_assign_coach` both require real staff, inline; `member_contact_log` is staff-read-any, staff-write-own-name only (`contacted_by = auth.uid()`), no member-facing read at all, deliberately no `user_id <> auth.uid()` clause since "someone said hello to you" is not the sensitive signal `coach_engagement_flags` protects against. |
| POST_NEW_MEMBER trigger (202608290014) | `0033_new_member_post_test.sql`: fires on `invite_redemptions` INSERT alongside `seed_onboarding_progress` (both triggers on the same table fire together), authorless, honestly omits `member_name` when no profile exists yet at trigger time rather than placeholder-filling it. |
| leaderboard_row, feed_leaderboard(), people_suggestions() (202608290015) | `0034_feed_leaderboard_and_suggestions_test.sql`: every ranked/suggested member passes `can_view_profile_field` for the relevant toggle (which also settles block edges); `consistency_week_streaks()` is pinned to agree with `community_profile`'s own inline streak arithmetic so the two cannot drift; ties are fully broken so `rank` is a real position; the caller's own row always returns even when it fell outside `p_limit`. |

## Phase 3 schema handoff for qa

Same rule as every prior handoff: one line per table/function/trigger saying
the boundary a test has to assert. Unlike the Phase 2 sections above, every
line here is already covered by a committed, CI-running pgTAP file written
alongside the migration, not left as a follow-up — the convention 0030-0034
set and COMM-234's sweep argued for.

### Attendance log (202608310001, COMM-300)

One new table, two helper functions, one trigger on the existing
`private_records` table, and a one-time backfill.
`supabase/tests/0037_attendance_log_test.sql` (54 assertions) runs every
boundary below on `migration-check`, including the three the ticket named
explicitly for qa. `test/community-attendance-log-rls.test.mjs` (22 tests)
pins the static SQL shape and executes the client half in jsdom.

Three things differ from COMM-300's own migration outline, all deliberate,
none of them narrowing what the ticket promised:

1. **Two helper functions the outline did not name.**
   `attendance_session_record_types()` and `attendance_parse_day()`. The
   first keeps the session-bearing set in one place; the second is the
   null-on-anything-bad payload date parser. A downstream Phase 3 ticket
   should reuse both rather than re-deriving either.
2. **The future-date rule resolved to refuse, never clamp**, with one day of
   slack. Reasoning in the table below.
3. **The migration backfills existing `private_records`.** Not in the
   outline. Without it every member's attendance history would start at zero
   on deploy day and COMM-306's board would read a club that has apparently
   never trained. It is also strictly safer now than later: COMM-305 adds an
   AFTER INSERT trigger on this table that mints achievements and posts
   milestones, and that trigger does not exist yet.

| Table / function / trigger | Boundary to assert |
|---|---|
| attendance_log (table) | One row per `(user_id, occurred_on)`, enforced by a unique constraint rather than a counting trigger. `user_id` cascades from `profiles`. `source_record_type`/`source_record_id` are nullable provenance and deliberately not a foreign key — the `private_records` row they name may be deleted later without touching the attendance day, so nothing may join on them. |
| attendance_log, no client write | `authenticated` has `select` and nothing else; `anon` has nothing. There is no insert, update, or delete policy for any role — not one (asserted by counting `pg_policies` rows with `cmd <> 'SELECT'`, so a later addition fails rather than slipping in). A plain member and an admin both get 42501 inserting their own row, and nobody can delete a day. This is the boundary the whole ticket rests on: COMM-304's flags, COMM-305's achievements and COMM-306's board would all be forgeable if a member could write here. |
| attendance_log, who can read | Own-row for `authenticated` (`attendance_log_self_select`), any row for a `community.analytics.view` holder or `is_staff()` (`attendance_log_staff_select`), verified for real with a coach and an admin reading another member's rows and a plain member seeing only their own. Deliberately **not** gated on `can_view_profile_field(user_id, 'show_attendance')` — that toggle is member-to-member, and every member-facing Phase 3 reader (COMM-302, COMM-306, COMM-307) must apply it in its own body. |
| attendance_session_record_types() | Returns exactly `{strength_entry, wod_entry}`. `bodyweight`, `measurement`, `measure_type`, `movement`, `custom_wod` and `session_note` are not in it, and the pgTAP file syncs one of every one of those with a well-formed `date` to prove none produces a day: the filter is on `record_type`, not on having a date. `session_note` is excluded additionally because nothing in app.js writes it. |
| attendance_parse_day(p_raw) | Accepts exactly `^\d{4}-\d{2}-\d{2}$` plus a successful cast — the same shape `cleanISODate()` in `src/sanitize.js` guarantees. Returns null, never raises, for a missing, null, malformed, or **impossible-but-well-shaped** date (`'2026-13-45'` matches the regex and raises 22008 on a bare cast; a hand-crafted request can send it, since `private_records` takes a direct RLS insert). Nothing on this path may throw: `flushOutbox()` only deletes an outbox row after a successful upsert, so a raise would wedge that record in the member's offline outbox forever. |
| private_records_attendance_log (AFTER INSERT OR UPDATE on private_records) | **The three boundaries COMM-300 named for qa**: two different session types on the same calendar day produce exactly one row (verified, and `on conflict do nothing` keeps the first record's provenance rather than overwriting it); two different days produce two; `bodyweight` and `measurement` produce none. Plus: INSERT **OR UPDATE**, not INSERT-only, because `flushOutbox()` upserts and a record that already exists server-side arrives as an UPDATE — verified by un-deleting a record and watching the day appear. |
| private_records_attendance_log, append-only | A soft-delete of the record that first claimed a day leaves the day standing; soft-deleting every session record a member has still leaves every day. A record that arrives already soft-deleted creates no day (the `deleted_at is null` WHEN clause). The trigger body contains no DELETE and no UPDATE at all. Same "correct forward, not backward" precedent `challenge_progress` set in 202608280009. |
| private_records_attendance_log, future dates | An entry dated 30 days out produces no row — **refused, not clamped**. Clamping to today would have invented a training day the member never claimed, permanently, because the table is append-only. The refusal is of the attendance row, not of the transaction: a member with a broken clock loses the credit for that entry, not the ability to sync. One day of slack is deliberate and load-bearing: `current_date` is the server's UTC day and the client writes a local calendar day, so an Asia/Jerusalem member training at 01:00 legitimately logs "tomorrow" in UTC — zero slack would silently drop those entries every night. Today and today+1 are accepted, today+30 is not. |
| private_records_attendance_log, missing profile | `private_records.user_id` references `auth.users`; `attendance_log.user_id` references `profiles`. A member inside the COMM-016 gate window can legally hold private records with no profile row, so the trigger skips rather than hitting a foreign key violation that would break their sync. Not independently exercised in 0037 (the fixtures all have profiles) — flagged for qa as the one branch covered by reasoning rather than by an executing assertion. |
| attendance_log_from_record(), reachability | Revoked from `public`, `anon` and `authenticated` — reachable as a trigger and nowhere else. `prosecdef` is true. It carries no `auth.uid()` check, the same documented exception `notif_queue_batched()`, `seed_onboarding_progress()` and `post_new_member_on_join()` already record: it acts on the row being inserted, which RLS already pinned to the caller, and an `auth.uid()` gate would break the backfill and any future service-role repair. |
| Backfill (202608310001) | A no-op on a fresh reset (0037 asserts the table starts empty, so every count in that file is about the trigger). Verified by hand against a seeded database with the trigger temporarily disabled: dedupes two records on the same day to one row keyed to the earliest `created_at`, skips soft-deleted rows, skips `bodyweight`, skips an impossible date, skips a future date. |
| ATTENDANCE_RECORDED emit + attendance_recorded analytics | `test/community-attendance-log-rls.test.mjs`, executing in jsdom: `flushOutbox()` emits `{occurred_on}` and nothing else after a successful write; one emit per calendar day across four records spanning two days; nothing for a `bodyweight`, `measurement`, `movement` or soft-delete; nothing when the write fails; nothing for a malformed local date. The bridge writes `attendance_recorded` with `occurred_on` only, dropping a title, a result string and a record id attached by a hypothetical future producer. It counts toward WCAM, and `metrics.md`'s rollup query agrees (pinned by `test/platform-analytics.test.mjs`). **The emit is a courtesy** — the trigger writes the table independently, so a member on an older cached build produces the row with no event, and nothing downstream may depend on it firing. |

### Relationship score (202608310002, COMM-301)

No new table, so no new RLS policy: one new internal function and one
existing function re-created around it.
`supabase/tests/0038_relationship_score_test.sql` (26 assertions) runs every
boundary below on `migration-check`. There is no client half — no new call,
no changed signature, nothing for a `.test.mjs` file to cover, and the node
suite is unchanged at 791/790 pass/1 skip.

**The load-bearing assertion in this file is not about the new function.** It
is the regression pin: three fixture posts, identical in every scored respect
except who wrote them, ranked by `feed_page` with their `feed_score` asserted
to six decimal places against literals captured by running that exact fixture
against the *pre*-refactor function. `now()` is fixed for the transaction and
the posts are published at `now() - 5 hours`, so the recency term is
`40 * 0.5^(5/36)` exactly and every number is reproducible rather than
approximate. Any arithmetic that moved anywhere in the scoring pass moves
those three numbers.

Two things differ from COMM-301's own migration outline, both so the
extraction stays behaviour-preserving, neither of them changing a number:

1. **A third, defaulted `p_as_of timestamptz` parameter.** The outline named
   `relationship_score(p_viewer, p_other)`. The inline version measured its
   30-day window from `feed_page`'s frozen `v_anchor`, not from `now()`, and
   that is the mechanism that makes every page of one feed session score
   identically. A two-argument function reading `now()` internally would put
   the window boundary a few minutes further along on page 2 than on page 1,
   so it would not have been a pure extraction. The default means the
   promised two-argument call form still resolves verbatim.
2. **The mutual-follow test is written out rather than delegated to
   `are_friends()`**, which resolves its viewer from `auth.uid()` and cannot
   answer for an arbitrary `p_viewer`. It is `are_friends()`'s body with
   `auth.uid()` replaced by `p_viewer`. Covered by a drift assertion below.

| Table / function / trigger | Boundary to assert |
|---|---|
| relationship_score(), reachability | Revoked from `public`, `anon` **and** `authenticated`, `prosecdef` false. Internal plumbing, not a second API surface — the same shape `consistency_week_streaks()` (202608290015) established. A real authenticated caller reaching for it gets 42501 from the grant, not from a check inside the body, which is deliberate: the `auth.uid()` gate belongs on the definer entry point that calls it, not on a helper with no caller of its own. The revoke of `public` is asserted separately, because a new function starts with `execute` granted to `PUBLIC` and forgetting that one line is how an internal helper quietly becomes reachable. |
| relationship_score(), the three branches | Mutual follow 1.0, one-way follow 0.55, a reaction or comment by the viewer on the other member's posts inside 30 days adds 0.45, sum capped at 1. Each asserted on its own fixture pair. The interaction signal is deliberately sourced from a post 200 days old — outside `feed_page`'s 90-day candidate window — so the reaction cannot also raise a candidate's engagement component and break the "identical except for the author" property the regression pin rests on. |
| relationship_score(), the cap | 0.55 + 0.45 is exactly 1.00, not 1.00-and-a-bit: a member the viewer follows *and* has reacted to reaches the same ceiling as a mutual follow, and in the feed the two rows tie to the last decimal with the tie falling to `published_at` then `id`. This is the boundary a "capped at 1 before its weight applies" rule actually means, and it is the one an inline-to-function move is most likely to lose. |
| relationship_score() vs are_friends() | **The drift pin for the second copy of the friends rule.** For every fixture member other than the viewer, `are_friends(id)` and `relationship_score(viewer, id) >= 1.0` must agree — asserted as an `is_empty` over the disagreements, with an `isnt_empty` alongside it so a fixture with no mutual follow in it cannot pass vacuously. Includes the self case: a member scored against themselves is 0, because `p_other <> p_viewer` is `are_friends()`'s own self-exclusion, kept. |
| relationship_score(), p_as_of | The window anchor is real, not decoration: a comment 40 days old scores 0 measured from `now()` and 0.45 measured from an anchor 15 days back. This is also the assertion that proves the comment branch is a branch — nothing else in the fixture reaches that member. Null viewer, null other: 0, never null. |
| feed_page, ranked output (regression) | The three fixture rows come back in the same order with the same `feed_score` to six decimal places as they did before the extraction: 54.328735 (mutual), 46.228735 (follow), 44.428735 (interaction only). Captured from the pre-refactor function, asserted against the post-refactor one. For qa: the fixture block at the top of 0038 is self-contained, so the same three numbers can be reproduced against any revision by pasting it into a psql transaction and calling `feed_page` — the literals are not a snapshot only this file can check. |
| feed_page vs relationship_score (drift) | **The "two copies cannot drift" pin**, the same pattern 0034 uses for `consistency_week_streaks()` versus `community_profile`: the gap between two feed rows that differ only in their author is asserted equal to 18 (`v_w_relationship`) times the gap between those two members' `relationship_score()`. Time-independent — the recency, engagement, personal and repetition terms are equal on both sides and cancel exactly — so it holds whenever the suite runs. `feed_page` cannot start scoring relationships differently from the function it calls without this failing. |
| feed_page, COMM-125 block edges | Unchanged and asserted here as well as in 0019: a block in either direction removes that author from the candidate set entirely, however high the relationship score would have been. The extraction must not loosen it, and the fixture deliberately blocks the highest-scoring author to check that the score does not buy a way past the filter. |
| people_suggestions (COMM-232), untouched | Asserted as a boundary rather than left as a comment: `people_suggestions`' body does not mention `relationship_score`, and `feed_page`'s does. Its shipped priority order — challenge, then interaction, then event — is pinned by 0034 and is a different question from "how close is this pair already". If a later ticket decides the two should share arithmetic, this fails and forces that to be a deliberate decision. |

### Classmate signal (202608310003, COMM-302)

No new table, so no new RLS policy: one new internal function and two
existing functions re-created around it.
`supabase/tests/0039_classmate_signal_test.sql` (37 assertions) runs every
boundary below on `migration-check`. There is no client half — `feed_page`
and `people_suggestions` keep their exact signatures, and
`people_suggestions`' returned shape only gains a key — so no `.test.mjs`
file moved and the node suite is unchanged at 791/790/1/0.

**The assertion pattern that matters most here is the toggle flip, not the
count.** For both `show_attendance` boundaries the test does not compare a
member who trained against a member who did not; it flips the toggle on an
*unchanged* set of `attendance_log` rows and watches the same data go from
nothing to a full signal and back. That is the difference between "no data"
and "private data", and it is the only form of the assertion that can catch a
gate being dropped.

One thing differs from COMM-302's own migration outline, which named only the
two `create or replace`s:

1. **A third function, `classmate_day_counts()`.** Both re-created functions
   need the same 60-day window, the same overlapping-`occurred_on` count and
   the same `show_attendance` gate, and the repo already knows what two copies
   cost — `community_profile`'s inline streak versus
   `consistency_week_streaks()` needs a standing pgTAP assertion to stop it
   drifting. The privacy gate in particular is the last thing that should
   exist twice: two copies means two chances to forget it. It is
   set-returning rather than scalar because `people_suggestions` builds its
   candidate set *from* its signals union, so a member whose only overlap is
   attendance has to be introduced by that branch or is never a candidate at
   all. It takes no viewer parameter on purpose — see the row below.

| Table / function / trigger | Boundary to assert |
|---|---|
| classmate_day_counts(), reachability | Revoked from `public`, `anon` **and** `authenticated`, `prosecdef` false — the same internal-plumbing shape `relationship_score()` (202608310002) and `consistency_week_streaks()` (202608290015) have. A real authenticated caller reaching for it gets 42501 from the grant, not from a check inside the body: **a member must not be able to ask who trains with whom, only to be ranked by it.** The `public` revoke is asserted separately, because a new function starts with `execute` granted to `PUBLIC`. |
| classmate_day_counts(), no viewer parameter | Deliberate, and the reason is worth checking in review rather than testing: `can_view_profile_field()` resolves *its* viewer from `auth.uid()` and cannot be told to answer for somebody else, so a `p_viewer` argument would be honoured by the overlap count and silently ignored by the privacy gate. That is the trap COMM-301 refused when it declined to hand `are_friends()` a viewer it would ignore. Both callers want the caller's own overlap anyway. |
| classmate_day_counts(), the count | One row per member with **at least one** shared day; a member with no overlap is absent, not a zero row, and both callers read absent as 0. Self is excluded, so a viewer's own posts pick up no class connection. Asserted at 4 days and 1 day against a fixture built directly in `attendance_log` (the trigger end is 0037's job, not this file's). |
| classmate_day_counts(), the 60-day window | A day both members trained **100 days ago** counts for nothing, with `show_attendance` **on** for that member, so nothing but the window can be doing the excluding. Both sides of the pair are filtered by it. The window is stated once, in this function, and is the same 60 days `people_suggestions`' two pre-existing time-stamped signals already use — so all four of that function's signals now share one period. |
| show_attendance, in both functions | **The boundary the whole ticket rests on.** `show_attendance` is attendance's own toggle (202608280003), separate from `visible_to_club`, and it **defaults to false** — so out of the box no member contributes a classmate signal to anyone. Asserted in three places, each by flipping the toggle on rows that do not change: the helper returns nothing then 4; `feed_page` scores that author 36.328735 then 39.328735, identically to a member with the same four days and the toggle on; `people_suggestions` drops a candidate whose only signal was attendance out of the strip entirely — not ranked lower, no card. Alongside each, an assertion that the member's `attendance_log` rows still exist, because those rows still count toward their own achievements (COMM-305) and their own leaderboard rank (COMM-306). For qa: the row count has to be read as the bootstrap superuser — `attendance_log`'s select policy is own-row for a member, so an authenticated count reads 0 for the wrong reason. |
| feed_page, the class component's normalisation | `least(1.0, shared_days / 8.0)` before `v_w_class = 6` — the engagement term's shape (a raw count over a saturation constant, capped), reaching the same 0..1 ceiling every other component does. Pinned three ways on three posts identical in every scored respect except their author's overlap: absolute scores to six decimal places (39.328735 / 37.078735 / 36.328735 on a `40 * 0.5^(5/36)` recency base), and the **gaps** between them, which are time-independent because every other term cancels — 4 of the 8 saturating days is exactly 3.000000 and 1 day is exactly 0.750000. The fixture block is self-contained and reproducible in a psql transaction, like 0038's. |
| feed_page, the cap | 8 shared days and 12 shared days both score exactly 6.000000 above the recency term. Saturating rather than scaling by the window length is deliberate: dividing by 60 would make even a daily training partner worth a rounding error. This is the boundary a "capped at 1 before its weight applies" rule actually means, and the one most easily lost. |
| feed_page, zero overlap | A viewer who has never logged a session still gets **every** row, all scoring the same, because the class component is 0 for all of them. Zero shared days is a zero — never a missing term, never an omitted row, never a raise. |
| feed_page, my_classes still parked | Unchanged and deliberate: COMM-302 wired the class-connection **score**, not the my-classes **scope**. `attendance_log` records days, not classes, so it carries no class identity to filter a post by. The scope still returns empty and the client still renders that chip disabled. Flagged for qa as a thing that looks like an omission and is not. |
| people_suggestions, the new priority order | **challenge, classmate, interaction, event**, asserted as an order across four candidates each carrying a different strongest signal, not as four separate labels. Still lexicographic, not a weighted sum: the fixture's challenge candidate has **one** shared training day and the classmate candidate has **four**, and the challenge candidate still comes first, so no amount of a weaker signal overtakes a stronger one. Position 2 is a product decision COMM-302 states rather than derives. |
| people_suggestions, additive shape | `signals` gains `shared_classmate_days` carrying the real day count (asserted at 4, not as a boolean); `shared_challenges`, `shared_interactions` and `shared_events` keep their names and their meanings — asserted as a whole-object `jsonb` equality, so a rename or a removal fails rather than slipping past a key-by-key check. `reason` gains `'classmate'`. This is exactly the shape 202608290015's own comment promised, and it is why no client changed. |
| Block edges, COMM-125, in both functions | A block in **either** direction, on the pair with the highest overlap in the fixture, so nothing can pass on the strength of its signal: the candidate leaves `people_suggestions`, their post leaves `feed_page` entirely (a block is strictly stronger than the class component, not merely heavier than it), and the helper itself refuses the pair. Not re-implemented anywhere — `can_view_profile_field()` settles a block before it consults any toggle, which is what `people_suggestions` already relied on for its other three signals. |
| The two surfaces cannot drift | The same pin 0034 uses for `consistency_week_streaks()` versus `community_profile` and 0038 uses for `feed_page` versus `relationship_score()`: both function bodies are asserted to mention `classmate_day_counts`, and the `shared_classmate_days` the strip publishes is asserted equal to the number the helper returned. One copy of the window, the overlap count and the privacy gate. |

### Consistency on verified attendance (202608310004, COMM-306)

No new table, so no new RLS policy: three existing functions re-created and
not one new one. `supabase/tests/0040_consistency_on_attendance_test.sql` (31
assertions) runs every boundary below on `migration-check`, and
`supabase/tests/0034_feed_leaderboard_and_suggestions_test.sql` keeps all 53
of its own, re-run against the new source. There is no client half — both
signatures and both returned shapes are unchanged, so no `.test.mjs` file
moved and the node suite is unchanged at 791/790/1/0.

**The 0034 fixture changed and no 0034 assertion did.** That file's streaks
are now `attendance_log` days instead of POST_WORKOUT / POST_PR rows; every
ranking, tie-break, toggle, scope and self-row assertion in it is the one
202608290015 shipped with. Two mechanical consequences worth knowing before
reading the diff: its consistency fixture opts every member into
`show_attendance` (the column defaults false, so a board of members who have
not opted in is a board of one), and its `people_suggestions` section deletes
the attendance rows before building its own fixtures, because since COMM-302 a
shared training day is that function's second-strongest signal and would
otherwise re-rank a section that is not about it.

One thing differs from COMM-306's own migration outline, which named the
`show_attendance` gate only for the leaderboard:

1. **`community_profile`'s `current_streak` key is gated on
   `show_attendance` as well as `show_workout_results`.** The number is
   attendance-derived now, and 202608310001 wrote the rule down: the table's
   staff policy is deliberately not gated on that toggle, and every
   member-facing Phase 3 reader applies it in its own body. Without it the
   function would publish an attendance-derived figure past attendance's own
   toggle, by default, for every member — and would contradict
   `feed_leaderboard`, which excludes that same member from the board.
   Expressed as an absent key, which has meant "hidden" in this function since
   COMM-180 and which the client already renders as no row. Both toggles
   default false, so the pairing only ever narrows. Reverting it is deleting
   one `if`.

| Table / function / trigger | Boundary to assert |
|---|---|
| consistency_week_streaks(), the source | Distinct ISO weeks carrying an `attendance_log.occurred_on` day, anchored on the member's most recent such week, counted back while each week is exactly 7 days before the previous, anchor must be the current week or the previous one. Same arithmetic as 202608290015, one table swapped — asserted behaviourally in **both directions**, which is the assertion that actually proves the swap: a member with three weeks of posted workouts and **no** attendance reads 0, and a member with attendance and **no post of any kind** reads their real streak. Under the old body those two numbers were the other way round, so a fixture built only on attendance could not have caught a revert. Backed by a static pin as well: the body mentions `attendance_log` and no longer mentions `workout_posts` at all. |
| consistency_week_streaks(), reachability | Unchanged and re-asserted, because a `create or replace` starts the grant story over: revoked from `public`, `anon` **and** `authenticated`, `prosecdef` still false. It reads every member's days only by borrowing `feed_leaderboard`'s definer rights past `attendance_log_self_select`. The `public` revoke is asserted separately, as in 0038 and 0039. |
| consistency_week_streaks(), no privacy filter | **Deliberate, and the one place this ticket departs from `classmate_day_counts()`'s shape** (202608310003, which folds `show_attendance` into itself). That helper's callers both want an opted-out member to read as absent; this one's caller must *exclude* them from a ranked set, and a gate inside the helper would produce exactly the coalesced 0 the ticket rules out. So the gate lives in `feed_leaderboard`, where "excluded" can be expressed, and the helper stays pure arithmetic over a table nobody can reach. Worth a reviewer's eye rather than a test: it is a reasoned inconsistency with a sibling function, not an oversight. |
| feed_leaderboard, show_attendance | **The boundary the privacy half of the ticket rests on.** A member with `show_attendance` off is **absent from the consistency board, not ranked at 0** — asserted as both an `is_empty` on their row and a count that goes 6 → 7, on a fixture member holding exactly the same two training weeks as an opted-in member, with the toggle flipped on rows that do not change. That flip is the whole proof: a member zeroed and a member excluded are different claims about them, and on a board where 0 is a real value, ranking an opted-out member at 0 would state something false rather than withhold something true. Alongside it, an assertion that their `attendance_log` rows still exist — read as the bootstrap superuser, since that table's select policy is own-row for a member. |
| feed_leaderboard, self is still always included | The caller gets their own row at their real streak **with their own `show_attendance` off**, and their board is the opted-in members plus themselves. `can_view_profile_field()` answers true for `p_target = auth.uid()` before it reads any toggle, so the new predicate is self-exempt exactly as `in_leaderboards` and `visible_to_club` already are. Opting out removes you from other members' boards, never from your own — the same rule 0034 already pins for `in_leaderboards`. |
| feed_leaderboard, progress mode untouched | The predicate sits inside the consistency branch of `valued`, not in `cand`, so a challenge ranking is not narrowed by a toggle that has no bearing on it. Asserted directly: the member excluded from the consistency board for `show_attendance` **leads** the progress board. |
| feed_leaderboard, zero is real | A member with no `attendance_log` row at all is ranked at 0 rather than dropped — there is no real rank to report from a set the caller was filtered out of, which is why the zeros have to be in it. The same rule on the profile side: `community_profile` returns `current_streak` 0 for such a member and does not raise. This is `feed_leaderboard`'s own pre-existing rule, unchanged, and the reason the exclusion above had to be an exclusion. |
| community_profile, current_streak | Moved onto the same source in the same migration, which is the only reason 0034's standing "the two copies agree" assertion could be re-run rather than retired. Asserted on both fixture directions like the helper (posting member 0, training member 1) and gated on `show_attendance` — the key is **absent**, not zeroed, when the toggle is off, and back at its real value when it is flipped on with no row changed. |
| community_profile, training_frequency and recent_workouts | **The boundary COMM-306 draws by exclusion**, asserted rather than left as a comment: both still read `workout_posts`, both are still under `show_workout_results` alone, and both are **still present on a profile whose `current_streak` the attendance toggle has just removed**. Plus the two halves shown apart: a member whose only activity is posts has `training_frequency` and a 0 streak; a member who trains and never posts has a real streak and no `training_frequency` at all. The two numbers answer different questions and did not merge. A static pin backs it — `community_profile`'s body mentions both tables. |
| The two copies still cannot drift | 0034's original pin (the caller's own board value equals their `community_profile` `current_streak`) is re-run against the new source and kept. 0040 widens it to the whole board at once: an `is_empty` over every ranked member whose value disagrees with the streak their own profile publishes, with an `isnt_empty` beside it so an all-zero fixture cannot pass it vacuously — the shape 0038 established. Readable set-wide only because every fixture member has both profile toggles on. |

### Trained-with-you today (202608310005, COMM-307)

No new table, so no new RLS policy: one new function and not one existing
function re-created. `supabase/tests/0041_attendance_classmates_today_test.sql`
(35 assertions) runs every boundary below on `migration-check`. Unlike
COMM-301, COMM-302 and COMM-306, this ticket does need a client half, and it
now has one: the card, the follow action and the `classmates_card_viewed`
event landed in the same ticket, covered by
`test/community-classmates-today.test.mjs` (11 tests, node suite
791/790/1/0 → 802/801/1/0). The boundaries below are still the schema half's;
the client half's own are the last row of the table.

**Two things the ticket left to this half to decide**, both settled here and
both worth a reviewer's attention rather than a skim:

1. **The caller's own `show_attendance` is enforced inside the function.**
   COMM-307 states the behaviour ("off means the card never renders for them,
   even though their own attendance is still logged and still counts
   elsewhere") without saying where the gate lives, and the client could have
   skipped the call instead. It does not, for three reasons: every boundary in
   this module is enforced server-side rather than by a UI check, and the
   vendored Supabase client makes every RPC callable from a console; it is a
   *reciprocity* rule, and every member on the card has opted into being seen
   training, so a member who declined that must not read the list; and
   202608310001's standing rule already says every member-facing Phase 3
   reader applies this toggle in its own body, which COMM-302 and COMM-306
   both did. It is a **direct `profiles` column read**, not
   `can_view_profile_field(auth.uid(), ...)` — that helper answers true for
   the caller before it reads any toggle, so it could not express the
   question at all. Off yields an **empty set, never a raise**.
2. **`p_limit int default 6`, clamped 1..20.** The forward reference in
   `contracts.md` named a zero-argument function; the parameter is defaulted,
   so that call form still resolves verbatim (the same accommodation COMM-301
   made with `p_as_of`). 6 is card-sized for COMM-115's feed-top slot where
   `people_suggestions`' 10 is a scrolling strip. **The clamp range is the
   server's and is now fixed; the default inside it is the client half's to
   revisit by passing an argument.**

| Table / function / trigger | Boundary to assert |
|---|---|
| attendance_classmates_today(), reachability | The opposite grant story from `classmate_day_counts()`: this one **is** a client entry point. `prosecdef` true, `execute` granted to `authenticated`, revoked from `anon` **and** from `public` (asserted separately, since a new function starts with `execute` granted to `PUBLIC`). Definer for exactly one boundary, the one `people_suggestions` already documents — `attendance_log` is own-row plus staff, so without elevation the function could only ever return the caller's own row, which is the one row it excludes. A null `auth.uid()` **raises** `not authorized` rather than returning empty, checked before anything is read: it is an entry point, not a helper. |
| Today only, both sides | **The boundary that separates this ticket from COMM-302.** `occurred_on = current_date` on both sides of the self-join, no window, no lookback, no count. Asserted in three directions: a pair who both logged today appear for each other; a member who logged **yesterday** with `show_attendance` **on** is absent, so nothing but the day can be excluding them (`classmate_day_counts()` would have counted that pair); and a caller who did not log today gets nothing at all, however many members did — the anchor is the caller's own row and the join enforces that on its own rather than by a separate check. Backed by a static pin: the body reads `current_date` and mentions neither `classmate_day_counts` nor `interval`/`make_interval` anywhere, so "no window arithmetic" is mechanical rather than a comment. |
| The returned shape | Exactly four keys — `user_id`, `display_name`, `handle`, `avatar_url` — asserted as a **whole-object `jsonb` equality**, so an added key fails here rather than slipping past a key-by-key check. No date, no time, no count, no streak, no session detail may leave this function: a caller learns that these members trained today and nothing about any other day. Those four are also exactly the header `community_profile` already returns to any member for any member, so nothing newly reachable is published. |
| show_attendance on a candidate | The same toggle-flip proof style 0039 and 0040 use, and for the same reason: the test does not compare a member who trained against one who did not, it flips the toggle on an **unchanged** `attendance_log` row and watches the same data go from absent to listed and back. Alongside it, an assertion that the row still exists — read as the bootstrap superuser, since `attendance_log`'s select policy is own-row for a member and an authenticated count would read 0 for the wrong reason. The toggle **defaults to false**, so out of the box this card is empty for everybody. |
| **show_attendance on the CALLER** | **The ticket's own product decision, so it is asserted explicitly rather than inferred.** A caller with it off gets an **empty set — the whole card, not a shorter one** — while two opted-in members who trained today were on it a moment before, and their own attendance row for today still exists (checked as the superuser). Empty rather than an error, asserted with a `lives_ok` beside the `is_empty`: the three ways to get no card — did not train, trained alone, opted out — are indistinguishable from outside, so nothing about the caller's setting leaks into the response shape and the client needs no new branch. Flipping their own toggle back on returns the same two members on the same unchanged rows. |
| The admin short-circuit, on one side only | The consequence of the caller-side gate being a direct column read, asserted rather than left as a comment, and the one section in the file deliberately called **as the admin**: an admin who never opted into `show_attendance` gets an **empty card like anybody else**, because the direct read does not carry `can_view_profile_field`'s `is_admin()` short-circuit. Once opted in, that same admin sees every member who trained today **including the ones who opted out** — the short-circuit does apply to the per-candidate gate, the module-wide behaviour of the one resolution point that `feed_leaderboard`'s contract already records. Asserted both as a count and by naming the opted-out member specifically, so the count cannot pass for the wrong reason. |
| Block edges, COMM-125 | A block in **either** direction removes the pair, with an `isnt_empty` beside each `is_empty` confirming the other candidate is still on the card, so it is the edge doing it and not a broken fixture. Not re-implemented anywhere in the function — `can_view_profile_field` settles a block before it consults any toggle, and it carries deleted profiles and `visible_to_club` in the same call, which is why there is no second predicate for either. |
| Self exclusion | The caller never appears in their own results. A member is not their own classmate — the same self-exclusion `classmate_day_counts()` and `relationship_score()` both keep. |
| p_limit, the clamp | Asserted against a pool of **27 eligible candidates** (25 extra opted-in members inserted for this section alone), so the upper clamp is a real cut and not "all of them": default 6, `3` → 3, `null` → 6, `0` → 1, `-5` → 1, `50` → 20. Zero clamping **up** to 1 rather than returning an empty card is deliberate — an empty card would look exactly like a member who trained alone. For qa: the clamp range is fixed server-side now, so the client half can lower the default it passes but cannot widen the range. |
| The order | Most recently recorded first (`attendance_log.recorded_at`), then display name falling back to handle, then id. Asserted across two fixture groups with different `recorded_at` values, so both the recency ordering **and** the alphabetical tie-break inside a tied group are exercised — a fixture that let `recorded_at` default would tie every row, since `now()` is frozen for the transaction, and the documented order would never run. Every member in the set trained today so there is no signal to rank by and the order is a choice: an alphabetical cut would show the same few members every single day in a club bigger than `p_limit`. `recorded_at` is when the row was written, not when the member trained — `attendance_log` records a day, not a time — which is why it is only the first key of a total order and not a claim the card makes. |
| COMM-307's client half | Now built, in `test/community-classmates-today.test.mjs` (11 tests) rather than pgTAP. What qa should re-check by hand rather than trust the test names for: **the omission**, which has four separate paths to the same nothing (empty set, caller did not train today, caller's own `show_attendance` off, failed fetch) and no heading, empty state, retry or skeleton in any of them — a regression here shows up as a stray grey box on the Feed sub-tab for members who never opted in, since `show_attendance` defaults false and the empty card is the common case, not the edge one. **The Follow control**, which is rendered on every row and deliberately does *not* copy the `allow_follows === false ? "" : button` guard the directory and following lists use, because the RPC has no such key and copying it would compare `undefined` to `false` and read as if it were doing something; `follows_insert_self` is the real gate. **No Message affordance**, asserted on the card and on the whole surface. **`classmates_card_viewed`**, once per load and not per re-render, absent entirely when there is no card, carrying a row count and a source and no member identity, and **not** in `ACTIVE_MEMBER_EVENTS`. Also worth a look: the client passes `p_limit: 6` explicitly rather than defaulting, so the card-sized number lives at the card; and there is no client-side date arithmetic anywhere, so "today" is only ever the server's. |

### Personalized feed ranking (202608310006, COMM-303)

One new table, two new functions, and `feed_page` re-created a third time.
`supabase/tests/0042_personalized_feed_weights_test.sql` (61 assertions) runs
every boundary below on `migration-check`, taking the suite 1123 → **1184**.
There is no client half — the ticket says so ("No new UI — personalization is
invisible ranking, not a setting") — so no `.test.mjs` file moved and the node
suite is unchanged at 802/801/1/0.

**READ THIS FIRST: the derivation is not built, and the ticket does not ask
for it.** Nothing writes `member_feed_weights`.
`recompute_feed_weights(p_limit)` is a real service-role-only function with an
empty body that always returns 0, asserted as a no-op in 0042 so it cannot
quietly start writing. Every member therefore has no row and gets the fixed
defaults. What shipped is the **storage** and the **reader**; the "storage
exists, computation does not" shape 202608280028 and 202608290011 already
carry. It is stubbed rather than omitted so `feed_page` is not left reading a
table with no named writer, and empty rather than heuristic because a guessed
derivation ships unreviewed ranking to every member and nobody can see that
their own feed is subtly wrong.

**The load-bearing assertion in this file is the one that proves nothing
happened.** Section D ranks the same fixture posts 0038 used and asserts the
same three `feed_score` literals to six decimal places — numbers captured from
`feed_page` as it stood *before* COMM-301, so they have now survived three
re-creations of that function unchanged. It asserts it five times over: no
stored row, an empty object, an explicit all-1.0 object, every multiplier at
the 2.5 ceiling, and a row of junk. A fourth fixture post scoring on recency
alone was added beyond 0038's three, so one row in the file reads a single
weight directly.

**Three things a reviewer should look at rather than skim:**

1. **The sum invariant is a bounded proportional rescale, not a clamp.** A
   naive per-component clamp-and-use does not sum to anything fixed, which
   would make a boost an inflation; a naive clamp-then-rescale restores the
   sum and pushes components back out of the bounds they were just clamped
   into (worked counterexample on this module's real numbers, in the migration
   header and asserted in 0042: `{recency 2.5, rest 0.4}` scales the seven
   un-boosted components to 0.344× their default, under the floor). The
   water-filling loop pins at a bound and redistributes the remaining budget
   over what is still free, so both invariants hold *by construction* — and
   the result is then summed and bounds-checked anyway before it is used, with
   any violation returning the defaults unchanged.
2. **"The positive weights sum to 104" was stale by 6.** It was correct in
   202608280019, when `v_w_class` was declared at 6 and multiplied by a hard 0
   — seven live weights, 104. COMM-302 turned that component on and left the
   comment. The eight declared weights have summed to **110** since
   202608310003. COMM-303 corrects the comment and **moves no weight**:
   renormalising down to 104 would change every existing feed score on deploy
   day, which is exactly what this ticket must not do. The invariant enforced
   is "a personalized set sums to whatever the default block sums to",
   computed at call time and nowhere hardcoded.
3. **The two numbers COMM-303's open question flagged are now fixed
   server-side.** Clamp bounds 0.40..2.50 of each component's default (the
   ticket's own worked example, adopted as the real value) and a **weekly**
   recomputation cadence. Both are tunable rather than architectural; the
   cadence is expressed in exactly one place, the commented cron line in the
   migration, and nothing in the schema depends on it.

| Table / function / trigger | Boundary to assert |
|---|---|
| member_feed_weights (table) | Three columns: `user_id uuid pk references profiles(id) on delete cascade` (asserted as `confdeltype = 'c'`, so a purged member leaves no orphan), `weights jsonb not null default '{}'`, `computed_at timestamptz not null default now()`. **No `club_id`**, unlike `weekly_recaps` — the row is a private ranking artifact about one member, nothing aggregates it per club, and so this table also needs no `default_club_id()` grant, which is the one thing 202608290011 had to add for its own service-role writer. One addition beyond the ticket's outline: a check constraint `jsonb_typeof(weights) = 'object'`, asserted against both `[1,2,3]` and a bare string. The reader defends against a non-object anyway; a column every reader treats as an object should still not be able to hold one. |
| member_feed_weights, no client write | `authenticated` has `select` and nothing else; `anon` has nothing and gets 42501 rather than an empty result. There is **no insert, update or delete policy for any role** — counted from `pg_policies` with `cmd <> 'SELECT'`, so a later addition fails here rather than slipping in — and a plain member gets 42501 on all three against their **own** row, as does an admin. This is the boundary the whole ticket rests on: a member who could write here would be supplying their own ranking input, which is precisely what COMM-303's contract section refuses when it says the weights are "never passed as a parameter". The `select` grant is deliberate: there is nothing private in a member's own weights and a "why is my feed like this" conversation is easier when they are inspectable. |
| member_feed_weights, the write path | Exercised as a **real `service_role`**, not the bootstrap superuser, which would sail past a missing grant: the insert succeeds and `computed_at` defaults on its own, so a writer that only knows the multipliers still produces a complete row. |
| The stored shape | Multipliers relative to `feed_page`'s defaults, not absolute weights — 1.0 is the default, an absent key is 1.0, unknown keys are ignored by the reader rather than rejected (asserted: `"loudness"` never reaches `feed_page`). Multipliers because the default block has already been retuned twice in this module's life, and absolute weights would silently become wrong the next time a default moves. **`'{}'` is the thin-signal answer and is deliberately indistinguishable from no row at all**, so a job can record "looked on Monday, found nothing" with a fresh `computed_at` without that meaning anything different for the feed — which is COMM-303's "never produces a personalized weight set from zero data" made structural rather than conditional. |
| **feed_page with no stored weights — THE CRITICAL ONE** | Byte-identical ranking and `feed_score` to six decimal places against literals captured from the pre-COMM-301 function, five times over (no row, `'{}'`, all-1.0, all-2.5, junk). The all-2.5 case is worth its own look: **a uniform boost is not a boost** — it cancels in the rescale — which is what "redistributes rather than inflates" means at its limit. The junk case (`"banana"`, a json `null`, an unknown key, a nested object) raises nothing: a malformed row costs a member their personalization, never their feed. |
| feed_weights_resolve(), reachability | Revoked from `public`, `anon` **and** `authenticated`; `prosecdef` false. Internal plumbing, the shape `relationship_score()` and `classmate_day_counts()` established. A real authenticated caller gets 42501 from the grant, not from a check inside the body. The `public` revoke is asserted separately, because a new function starts with `execute` granted to `PUBLIC`. Note it **does** take a user parameter, unlike `classmate_day_counts()` — not the same trap, because it consults no privacy toggle that would silently ignore the argument. |
| feed_weights_resolve(), the sum | Over **seven pathological stored rows**, the resolved set sums to exactly what the default block sums to, and a companion assertion pins that total at 110 today. Plus an anti-vacuity assertion that none of the seven resolved back to the defaults, so neither the sum nor the bounds check passed for the wrong reason. |
| feed_weights_resolve(), the bounds | No component of any of the seven leaves `0.40..2.50` of its **own** default. The `{recency 2.5, rest 0.4}` case is additionally read off value by value — the seven un-boosted components sit exactly **on** the floor (`18*0.4 = 7.2`, `6*0.4 = 2.4`) and recency absorbs the whole remaining budget at 82, which is 2.05× its default and inside the ceiling. That is the case a naive rescale gets wrong, so it is asserted individually rather than only in aggregate. |
| The defaults live in one place | `feed_weights_resolve` takes the defaults as a **parameter** rather than holding a copy, so the eight numbers stay stated once, in `feed_page`'s weight block — the function owns the algorithm, `feed_page` owns the numbers, and there is no pair to drift. 0042 holds a second copy for its own arithmetic and pins it to `feed_page`'s `prosrc` line by line, so retuning a weight fails this file rather than silently testing stale numbers. It is also component-agnostic: it never names `recency` or `class`, so a ninth weight needs no edit there. |
| recompute_feed_weights(), reachability and no-op | `execute` granted to `service_role` only, revoked from `public`, `anon` and `authenticated`; `prosecdef` true, with **no `auth.uid()` check** — the same documented exception `notif_batch_flush_due()`, `notif_queue_batched()`, `seed_onboarding_progress()` and `post_new_member_on_join()` already carry, since `service_role` has no uid and the grant is what stands in for one. Both call forms return **0**, and the table is still empty afterwards — asserted, so a later edit that starts writing rows has to break this line deliberately. `p_limit` is accepted and unused today on purpose, so a scheduler's call site does not change when the body lands. **For qa: nothing schedules it.** The resolved cadence is weekly and lives only in a commented `pg_cron` line. |
| A stored row really moves the score | `{"relationship": 2.5}` widens the gap between two rows differing only in their author to exactly the **resolved** weight times the `relationship_score` gap — closed-form, `18 * 2.5 * 110/137`, independent of when the suite runs, because the recency, engagement, personal and repetition terms are equal on both sides and cancel. Stated as a direction too (`> 8.1`, the default gap), so the exact-value assertion cannot pass with the sign inverted. And the row with no signal but freshness scores **lower**, at exactly its old score times the `110/137` rescale: the budget relationship gained came out of the other seven components. Note that rows which *do* carry relationship go **up** in absolute terms — "everything goes down" would have been the wrong claim. |
| **v_w_class moves like any other weight** | COMM-303 names it explicitly, so it is asserted explicitly rather than assumed to fall out of "all eight". Two fresh members with no follow edge either way, one post each at the same instant, eight shared training days (exactly `v_class_saturation`, so the component is at its 1.0 ceiling): on the defaults the classmate author leads by exactly 6, COMM-302's number unchanged; with `{"class": 2.5}` the gap becomes the resolved `6 * 2.5 * 110/119 = 13.865546`. Alongside it, the block edge is still strictly stronger than any weight personalization can give the component — a blocked author never reaches the scoring pass, however far the member has boosted the thing that would have favoured them. |
| COMM-112 diversity, after scoring and unchanged | Asserted **structurally** — read off `prosrc`, the weight resolution appears before the scoring query and the diversity pass still after it, and the four diversity limits are still `constant` at 2/2/3/2 — and **behaviourally**: on a feed scored with a personalized weight set at the ceiling, `v_max_same_author` still breaks a run at two and displaces the third post by that author with a lower-scoring one from someone else. Personalization changes emphasis inside the ranked set, never the diversity guarantee across it. |
| Where the lookup sits in feed_page | After the `auth.uid()` check and after the parked `my_classes` scope has already returned, before anything is scored: **one lookup per feed request**, never one per candidate row, and fixed for the whole call the way `v_anchor` is — so page 2 of a session scores on the same weights as page 1, the same property COMM-301's `p_as_of` exists to protect. `feed_page` is definer so this reads past `member_feed_weights_self_select`, but only ever for `v_uid`, which is the one row that policy would have granted the caller anyway. |

### Attendance achievements and milestone posts (202608310007, COMM-305)

No new table, so no new RLS policy. One `UPDATE` to four seeded rows, two new
functions, one trigger on `attendance_log`, one partial expression index on
`workout_posts`. `supabase/tests/0043_attendance_achievements_test.sql` (50
assertions) runs every boundary below on `migration-check`, taking the suite
1184 → **1234**. There is no client half — the ticket says so ("No new client
work: `renderPostCard`'s `POST_ATTENDANCE_MILESTONE` branch ... already exist
and render real data unchanged") — so no `.test.mjs` file moved and the node
suite is unchanged at 802/801/1/0.

**Two existing pgTAP assertions were rewritten rather than left to fail**, in
`0007` and `0020`: both said "the four attendance rows are disabled", which is
the state this ticket exists to change. Neither migration was touched, and the
static assertion that 202608280007 *seeds* them disabled still runs unchanged
in `test/community-rls-boundaries.test.mjs`, which reads that migration's text
directly. `0020`'s rewrite makes its neighbouring assertion **stronger**: an
attendance code used to be refused by `ach_claim` twice over (disabled *and*
`ATTENDANCE_RECORDED`) and could have been passing on the wrong one of the
two; only `trigger_type` and the absent `client_claimable` key are left.

**Three things a reviewer should look at rather than skim:**

1. **The count milestones test state; the repeatable streak tests an event.**
   That asymmetry is deliberate. "Have they got this badge already" is a
   state, answerable from the table plus `member_achievements_once_idx`, and a
   just-crossed delta (`count - 1 < threshold`) breaks on any multi-row insert
   because Postgres queues AFTER-FOR-EACH-ROW triggers to the end of the
   statement — all 30 rows of a 30-row insert see a count of 30, and nothing
   is ever the 25th. "Did a fresh streak just start qualifying" cannot be
   answered from state at all, because the member is *meant* to earn it again,
   so it is computed as a genuine before/after crossing. The cost of that,
   stated rather than buried: a multi-row insert awards no streak badge.
2. **The `show_attendance` gate is a write-time gate**, which is the one place
   this toggle behaves differently from every other use of it in the module.
   It is read once, off the member's own `profiles` row, at the moment of the
   unlock, and never re-asked. Turning it on later does not retro-publish a
   milestone crossed while it was off. That is asserted directly, and it is
   also why the proof of the gate needed a shape 0039 and 0040 did not: the
   same member across a flip, plus a second member holding the identical days
   with the opposite setting.
3. **The four assertions that matter were mutation-tested before this file was
   handed over.** Replacing the fresh-crossing test with `streak >= threshold`
   fails five assertions; removing the `show_attendance` gate fails three;
   forcing the already-posted guard false fails one; dropping `threshold > 1`
   so a first class posts fails four. None of the boundaries below passes
   vacuously.

| Table / function / trigger | Boundary to assert |
|---|---|
| achievement_definitions, the four attendance rows | All four `trigger_type = 'ATTENDANCE_RECORDED'` rows are `enabled`, exactly one of them (`attendance_weekly_streak`) is `repeatable`. The `UPDATE` is keyed on `trigger_type`, not on a list of four codes, so a fifth attendance definition is enabled by its own seed row. Thresholds are unchanged (1/25/100/4) and are now load-bearing: the trigger reads every one of them from this table and keeps no second copy, asserted by comparing the post's `count` against `d.threshold` and its `milestone_label` against `d.name` rather than against literals. |
| ach_claim, still refuses all four | Asserted now that only one reason is left. Called as a member who **holds the repeatable code** — if `ach_claim` accepted it the call would write a second row rather than being absorbed by the once-per-code index, which is the strongest form available — and separately as a member who has genuinely reached a milestone, since qualifying is not the question. Both return nothing and write nothing. `ach_claim`'s `<> 'ATTENDANCE_RECORDED'` line is also pinned textually, so a later edit to that function fails here. Attendance is the one category in this schema that is purely server-derived and never client-trusted. |
| attendance_log_milestones (AFTER INSERT on attendance_log) | The trigger exists, is not internal, carries no `WHEN` clause. Its function is `prosecdef`, revoked from `public`, `anon` **and** `authenticated` — reachable as a trigger and nowhere else. No `auth.uid()` check, the same documented exception `attendance_log_from_record()`, `post_new_member_on_join()` and `notif_queue_batched()` carry. It is definer for exactly two boundaries: `member_achievements` has no client insert grant or policy, and an authorless `workout_posts` row is unreachable through `posts_insert_self`. |
| Crossing 1 / 25 / 100, exactly once | One logged day unlocks `attendance_first_class`; twenty-four days do not mint the 25 badge early; the twenty-fifth does; **five further days past the threshold add no second badge and no second post**, which is the only form of the assertion that separates "fires on the crossing" from "fires whenever it qualifies". Same again at 99 → 100. `member_achievements_once_idx` is what actually holds it under concurrency (`insert ... on conflict do nothing returning id`), so a lost race is swallowed, never surfaced. |
| A first class is an achievement and not also a post | Asserted per member (the coach, one day, `show_attendance` **on**, so nothing but the rule can be suppressing it) *and* set-wide (no `POST_ATTENDANCE_MILESTONE` anywhere carries `count = 1`), with an anti-vacuity assertion beside it that milestone posts do exist. The rule is `threshold > 1`, not a two-code allow list, so a future `attendance_250_classes` posts automatically and a future first-anything does not. Matches how every other unlock is celebrated: `ach_claim` writes a row for a first PR and never a post. |
| POST_ATTENDANCE_MILESTONE, the shape | Read off the row, not the migration text: `author_id` null, `visibility = 'club'`, `status = 'active'`, `source_type = 'member'`, `source_id` the member, `metadata` carrying `milestone_label` and `count` (the two keys `renderAttendanceMilestonePostCard` has read since Phase 1) plus `member_id`. `club` is verified as a real target by having **another member** read the row through `post_visible_to_viewer()`, not by trusting the column value. Same authorless shape `post_new_member_on_join` and `challenge_progress_apply`'s cooperative milestone already write. |
| show_attendance suppresses the post, never the achievement | Two-sided. A member with the toggle **off** holding exactly the days a member with it **on** holds earns both achievements and gets no post, while the other gets one — so it is the privacy choice doing it, not the data. Their twenty-five attendance rows all still exist. Then the flip, on rows that do not change: turning it on publishes **nothing retroactively**, and the member's next genuine crossing (the 100th) does post. Achievements have their own toggle (`show_achievements`) and this is not it. `show_attendance` **defaults to false**, so out of the box the trigger unlocks achievements for everyone and posts for nobody. |
| Never double-posted, and the guard is workout_posts itself | A `POST_ATTENDANCE_MILESTONE` row is **planted for a member before they have trained a single day**; their real crossing then unlocks the achievement and adds no second post, and the surviving post is verifiably the planted one. That only passes if "already posted this milestone" is read from `workout_posts` by `(member_id, count)` — the way `challenge_progress_apply` asks the same question — rather than from a second piece of tracking state. Deliberately a guard and not a unique index, the reason 202608290014 spells out: a unique violation would abort a member's training-log sync over a duplicate feed post. Backed by `workout_posts_attendance_milestone_metadata_idx`. |
| attendance_weekly_streak, a FRESH crossing | Week by week, one statement per week, which is what the production writer produces. Three weeks: no badge. The fourth: one badge. **A second day inside a week that already counted: nothing** (excluding that day leaves the week standing, so before = after). **A fifth week: nothing** — this is the case a bare `streak >= 4` would get wrong, re-minting the badge every training day for the rest of the run. Then the break and rebuild: the fourth week of the *second* run fires it **again**, count 2, while the member's non-repeatable first-class badge stayed at 1 across both runs. |
| The crossing is two-sided, not an equality | A member with four stale weeks behind a gap trains three fresh weeks (streak 3, no badge) and then the single week that joins the two runs: the streak goes **3 → 8 in one insert** and fires exactly once. A `streak = 4` equality test would miss it entirely. The same fixture also pins the anchor rule: four consecutive weeks that ended a month ago are worth a streak of 0 and no badge, because a streak has to be live — the same number the member's profile and the consistency board show them. |
| attendance_week_streak(uuid, date) | New, internal, `security invoker`, revoked from `public`, `anon` and `authenticated`. It exists because the repeatable code has to know what the streak was *before* the row that just landed, which `consistency_week_streaks()` is set-wide and zero-argument and cannot answer. **Pinned against it for every member of the fixture at once** (with an anti-vacuity assertion that the set is not all zeros), the same drift-pin shape 0040 uses for `community_profile`'s inline copy — so a future edit to one that is not made to the other fails CI rather than quietly splitting the definition of a streak in two. |
| ACHIEVEMENT_UNLOCKED, no new code | Asserted rather than assumed, because the claim being made is "nothing was needed": `member_achievements_notify` (202608280027) is AFTER INSERT on `member_achievements` with `tgqual is null` — no `WHEN` clause, no filter on how the row got there — and a real `achievement_unlocked` notification row is found joined back to the attendance-sourced `member_achievements` row. An attendance unlock notifies exactly like a claimed one. |
| ach_evaluate is still not built | Asserted as an absence: no `public.ach_evaluate` exists. COMM-305 follows the direct table-trigger precedent `challenge_progress_apply` set and explicitly does not build the generic event-bus consumer. Attendance is now the only trigger type with a real server-side producer; everything community-, challenge- and club-shaped in the seed still cannot be earned at all. |
| No backfill, and what happens instead | The migration awards nothing at migration time — 202608310001's `attendance_log` backfill is finished before this trigger exists, which that migration said in as many words was the reason to backfill there rather than later. **For qa:** because the count branch reads state, a member whose backfilled history already stands at 60 days earns `attendance_first_class` and `attendance_25_classes` on their *next* logged session, once each, spread across the club as members sync rather than as a deploy-day burst. The feed side of that is bounded by `show_attendance` defaulting to false. |

### Member of the week (202609010001, COMM-315)

One new table, four new functions, one widened `CHECK` on
`admin_actions.action_type`, no existing policy touched and no existing
function re-created. `supabase/tests/0045_member_of_week_test.sql` (76
assertions) runs every boundary below on `migration-check`, taking the suite
1292 → **1368**. There is no client half yet — the suggestion card, the
publish control and the coach's-pick form land separately — so no `.test.mjs`
file moved.

**Four things a reviewer should look at rather than skim:**

1. **The rotation index is weeks-since-a-fixed-Monday mod 4, not the ISO week
   number mod 4**, which is what COMM-315 offered as an example. An ISO year
   has 52 or 53 weeks, so the week-number form repeats a category two weeks
   running at every 53-week year — 2026 is one, and the concrete boundary
   (2026-W52, 2026-W53, 2027-W01) is asserted directly rather than argued.
2. **The privacy filter has two halves and needs both.** Every candidate
   passes `can_view_profile_field()` *and* has the relevant toggle true read
   from the raw `profiles` column. The helper short-circuits to true for an
   admin before it reads any toggle, so on its own it filters nothing for
   exactly the caller most likely to be publishing; the columns on their own
   cannot see a block edge. Both halves were mutation-tested separately —
   deleting the column reads fails three admin assertions, deleting the
   helper calls fails the block assertion.
3. **The publish-post choice is an authorless `POST_ANNOUNCEMENT`**, the
   first producer that post type has ever had, not COMM-225's
   comment-on-a-card pattern. That pattern needs a source post, and three of
   the four categories have none.
4. **The category is derived at publish, not passed.** Publishing somebody
   the shortlist did not contain *is* a coach's pick. `admin_actions.after_data`
   keeps both the recorded `category` and the week's `rotation_category`, so
   an auditor can see when the two differed.

**Three gaps left open, not papered over:** the consistency category reads
`feed_leaderboard`, which reports the streak **as of now** and takes no as-of
date, so publishing a months-old week under that category credits a
present-day streak; `show_attendance` and `show_prs` both default **false**,
so in a club where nobody has opted in, two of the four categories will
legitimately show the empty state most weeks and the coach's-pick fallback
will carry the feature; and nothing notifies the chosen member, which the
ticket does not ask for.

| Table / function | Boundary to assert |
|---|---|
| member_of_week_category(date) | `IMMUTABLE`, reads no table. Five consecutive Mondays give the four categories in order and then the first again. The cycle is exactly 28 days wide across 600 Mondays running from 2020 — six years *before* the epoch — which also proves the `((x % 4) + 4) % 4` form really handles a negative offset rather than falling off the `case`. Three consecutive Mondays across the 2026/2027 ISO boundary get three *different* categories, with the fixture dates first verified to really be ISO weeks 52, 53 and 1. |
| member_of_week, no client write | `authenticated` has `select` and nothing else; `anon` has nothing. Exactly one policy on the table and it is a SELECT policy (asserted by reading `pg_policy`, so a later addition fails rather than slipping in). A plain member, a **coach** and an **admin** each get 42501 on insert/update/delete respectively, and the row count is unchanged after all three tried. This is the boundary the whole ticket rests on: the once-per-week rule, the adjacency refusal, the category resolution and the audit row would all be bypassable by a direct insert. |
| member_of_week, club-wide read | A plain member who is the subject of none of the five published weeks reads all five, and reads all five celebratory posts through the ordinary `post_visible_to_viewer()` rule with no special case. Publishing means public. |
| Staff gate on both functions | Both are executable by `authenticated` — the `is_staff()` test is in the body, not in the grant, so a coach who is not an admin can still call them — and a plain member gets P0001 `not authorized` from both. `anon` and PUBLIC hold execute on neither; PUBLIC is asserted separately, since a new function starts with execute granted to PUBLIC. `member_of_week_candidate_set` is revoked from every role including `authenticated`: it carries the privacy filters but no staff gate of its own, because both callers have one. |
| Candidates, consistency_streak | The member with the **longest** streak is absent because `in_leaderboards` is off, and a second member is absent because `show_attendance` is off — the third gate inherited from `feed_leaderboard`, since the ranked value is attendance-derived. What is left is ordered by streak and carries the number. Asserted for a coach and again for an **admin**, where `can_view_profile_field()` filters nothing and only the column reads are doing the work. |
| Candidates, most_prs | The member with **10** PRs that week is absent (`visible_to_club` off) and the member with **5** is absent (`show_prs` off); the answer is the member with 3. Both would have been at the head. The count is 3 and not 7, because four of that member's PRs are in the week before — the window is `coalesce(occurred_on, created_at::date)` in `[week_start, week_start+6]`. Another member counts 1 and not 2 because their second PR that week is `only_me` and `post_visible_to_viewer()` keeps it out. |
| Candidates, challenge_completion | The member with **two** completions that week — the most of anyone — is absent because `in_leaderboards` is off. One candidate counts 1 and not 2 because their second completion is on a **draft** challenge, which would have put them at the head had it counted; another counts 1 and not 3 because one completion is outside the week and one is `withdrawn`. |
| Candidates, blocks | A member stops being suggested the moment they block the calling coach — a block the coach did not make, in the direction they did not make it. This is the half of the filter no column read can do, and it is why `can_view_profile_field()` is kept alongside the columns rather than swapped for them. |
| Candidates, coachs_pick and the empty state | The coach's-pick week returns `free_selection: true` and an empty shortlist — by definition, not by exhaustion. A PR week nobody logged a PR in returns zero candidates **and still names the category**, which is what the `אין מועמדים השבוע לקטגוריה זו` state needs. Two identical calls return an identical envelope: the order is total (value, display name, id). `p_week_start` null means this week, and the envelope's `week_start`, `category` and `rotation_index` are all checked against the current ISO Monday. |
| Candidates writes nothing | `member_of_week` is empty after every read above. This is the draft half of COMM-309's generated-draft/staff-publishes shape; the club sees nothing until a human publishes. |
| No two consecutive weeks | The member published in week N is refused in week N+1 with P0001 `member was recognised last week` — and the refused member was **not on that week's shortlist at all**, so the call could only have arrived as a hand-made coach's pick and is still refused. Then the two-sided proof: the same member is published again two weeks later, because the rule is about **adjacency**, not repetition. The shortlist also drops last week's member before the server would have to refuse them, and the envelope reports them as `previous_week_user_id`. |
| One publish per week | A second call for a published week raises P0001 `week already published` and leaves **nothing** behind — same member on the row, same row count, same post count, same audit count. Not an upsert, deliberately, unlike `weekly_recaps`: the post has already reached the feed. A **mid-week date** (the Friday of that week) collides with the same row rather than opening a parallel week, which is the normalisation working. Underneath, the `unique (week_start)` constraint and the `isodow = 1` CHECK are asserted directly as the superuser — the only caller they can ever have, since there is no client write path. |
| visible_to_club at publish | A member hidden from the club is refused with P0001 even as a free coach's pick and even though the calling coach can see them perfectly well. Read from the column, not `can_view_profile_field()`, for the same reason as the shortlist. |
| Reason handling | Trimmed, control characters stripped (the same `0x01`-`0x08`/`0x0B`-`0x1F` class `post_create` strips, because this text reaches the club feed), **capped** at 500 rather than rejected — asserted in one publish that sends 600 characters, a leading `chr(7)` and surrounding whitespace. Required and only required when the resolved category is `coachs_pick`: a computed category publishes fine with an empty reason, because the category *is* the reason. |
| The category is derived, not passed | Publishing a member who is on the week's shortlist records the rotation category; publishing one who is not records `coachs_pick`, asserted on a consistency week whose chosen member could never be on that shortlist (`show_attendance` off). That is the ticket's "staff can fall back to coach's pick" empty state, expressed as a fact about who was chosen. |
| The celebratory post | Read off the row, not the migration text: `post_type = 'POST_ANNOUNCEMENT'`, `author_id` **null**, `visibility = 'club'`, `status = 'active'`, `source_type = 'announcement'`, `source_id` = the `member_of_week.id`, `occurred_on` = `week_start`, `metadata` carrying `member_id`, `category`, `week_start` and a non-empty `title` (which `renderAnnouncementPostCard` reads *first*), and a body naming the member. `club` is verified as a real target by having another member read all five posts through `post_visible_to_viewer()`. |
| admin_actions | One row per successful publish and none for any of the five refusals, each with `action_type = 'member_of_week_publish'`, `target_type = 'member'`, `target_id` the recognised member, `admin_id` the publishing coach, and `after_data ->> 'category'`. **For qa:** the count has to be read past `admin_actions`'s own policy — it is gated on `community.analytics.view`, which a coach does not hold, so an authenticated count reads 0 for the wrong reason. 0045 uses a `security definer` helper in the `tests` schema for exactly this. The `action_type` CHECK gained its twelfth value here, the first widening since 202608280002; `target_type` was not widened, since `'member'` already fits. |
| member_of_week category CHECK | A closed list of the four rotation categories, asserted as the superuser, so a typo cannot invent a fifth that no rotation week would ever produce. |

## Phase 4 tickets, Registration & invite management

ID range COMM-370 to COMM-381. Ticket files are in
`docs/community/tickets/`. Filed from a direct product-owner ask (not one
of the P0/P1 spec sections a prior phase mapped from): a complete
per-person invite system alongside the existing shared per-role code, plus
an admin/coach management screen covering invite/code management, a member
roster, editable onboarding-step copy, and registration-funnel analytics.

**Build order: schema first, all six of COMM-370 through COMM-375, exactly
the "schema leads each phase" pattern every earlier phase followed** —
every client-facing ticket in this phase calls at least one function from
this cluster. Within schema, COMM-370 and COMM-371 have no ordering
constraint against each other (different tables, different permissions);
COMM-372 depends on COMM-370 (`invites` must exist before
`redeem_invite_code` can read it); COMM-373, COMM-374, and COMM-375 are
each independent of the others but COMM-375 additionally reads the tables
COMM-370/371 create. Recommended concrete order: COMM-370, COMM-371,
COMM-372, COMM-373, COMM-374, COMM-375. After that: admin-moderation's four
screens (COMM-376 through COMM-379, no ordering constraint against each
other), identity-privacy's COMM-380 (small, unblocked once COMM-372 ships),
then qa's COMM-381 last, the phase's merge gate, the same role
COMM-191/234/317/338 played for every earlier phase.

### schema

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-370 | Per-person invite table and admin create/list/revoke RPCs | schema | todo |
| COMM-371 | Shared invite-code admin RPCs | schema | todo |
| COMM-372 | redeem_invite_code accepts a per-person invite | schema | todo |
| COMM-373 | Editable onboarding step content | schema | todo |
| COMM-374 | Paginated member roster RPC | schema | todo |
| COMM-375 | Registration funnel analytics RPC | schema | todo |

Full signatures, return shapes, and RLS for all six are in
`docs/community/contracts.md` under "Needs from schema, registration and
invite management (Phase 4)", written before any of them is built, per
this file's own standing rule.

### admin-moderation

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-376 | Invite and code management admin screen | admin-moderation | todo |
| COMM-377 | Member roster screen | admin-moderation | todo |
| COMM-378 | Onboarding step content editor | admin-moderation | todo |
| COMM-379 | Registration funnel analytics screen | admin-moderation | todo |

All four are client-only, no migration. COMM-378 (onboarding-content
editing) is assigned here rather than to coach-tools: it is admin console
content management in the same shape as this cluster's existing pinned
content and announcement/analytics surfaces, not a member-relationship
action in the shape coach-tools' own tickets (Welcome, Congratulate,
Engage, Member of the week) all are. COMM-377 explicitly reuses the
existing member-search row renderer and the existing
`admin_grant_coach`/`admin_revoke_coach`/`GRANTABLE_ROLES` role-change
machinery rather than rebuilding it — the roster is a new browse entry
point onto member management that already exists, not a second
implementation of it. COMM-379 shares COMM-310's dashboard shell and
period selector rather than adding a second one.

### identity-privacy

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-380 | Signup screen supports per-person invite codes | identity-privacy | todo |

Small on purpose: `redeem_invite_code`'s signature does not change
(COMM-372), so the existing code-entry screen needs no new field and no
new branch. This ticket is the copy review and the end-to-end test for the
new code path, plus confirming the generic "invalid" error copy still
reads honestly now that it also covers a spent per-person invite.

### qa

| ID | Title | Agent | Status |
|---|---|---|---|
| COMM-381 | Phase 4 QA sweep and merge gate | qa | todo |

Last, depends on every other Phase 4 ticket.

### Open questions for this phase

Numbered separately from the running "Open questions for the user" list
below since they are scoped to this phase; each was given a reasonable
default and built against, per this planning session's own instruction to
not block on them, the same posture Phase 3's own open questions (11-14
below) were given.

1. **Should a per-person invite expire by default?** Built with no default
   expiry (`expires_at` nullable, null meaning "never expires") — an admin
   can set one per invite via `admin_invite_create`'s optional parameter,
   but nothing forces it. Confirm whether a standing default (7 days, 30
   days) should apply when the admin does not specify one.
2. **Does revoking a shared code retroactively affect anyone?** No.
   COMM-371 builds it exactly like today's unexposed behavior: deactivating
   a code only stops future redemptions, existing `invite_redemptions` rows
   are untouched. Confirm this is the intended meaning of "revoke" for a
   shared code, since it is a softer action than COMM-370's per-person
   revoke (which can only ever target an *unredeemed* invite in the first
   place).
3. **Should a spent per-person invite give a distinguishable error?**
   Built to return the exact same generic `'invalid'` a wrong guess
   returns (COMM-372), preserving `redeem_invite_code`'s existing
   anti-enumeration property. The alternative — telling a real person
   "this invite was already used, contact your coach" — is friendlier but
   means the function can no longer treat "never existed" and "already
   spent" as the same answer, which is the property the throttle design
   leans on. Confirm the generic-answer default is acceptable, or accept
   the friendlier, distinguishable version as a deliberate trade against
   that property.
4. **Should onboarding-content edits be versioned or audited beyond the
   standing `admin_actions` log?** Built with the same one audit row per
   edit every other staff content change in this schema gets
   (`onboarding_content_updated`, before/after in the audit blobs) — no
   separate version history table, no diff view. Confirm that is enough,
   or that a full edit history is wanted for a screen only staff sees.
5. **Should onboarding steps be literally reorderable?** Not built as
   asked literally — see COMM-373's own note: each of the five steps'
   timing is tied to a real-world trigger (join date, elapsed days,
   attendance count), and `cloud.js` already documents the current fixed
   precedence as a deliberate anti-reorder decision from COMM-222/COMM-316
   ("letting an attendance milestone occupy that slot ahead of welcome
   would be exactly the reorder effect the ticket's own criterion asks
   this file to avoid"). This phase ships copy editing only. Confirm that
   satisfies the ask, or specify what reordering would concretely mean
   given each step's trigger is fixed (for example: a display priority
   used only as a tie-break on the rare day two steps become due at once,
   which the current one-slot design does not currently need since only
   one step is ever "due" at a time by construction).
6. **Who should be allowed to generate a per-person invite?** Built at
   `community.member.invite`, granted coach and above (the same tier
   `community.member.restrict` already uses) — a coach can invite someone
   without needing an admin. Confirm that tier, versus keeping invite
   generation admin-only like the shared-code controls.
7. **`registration_funnel`'s `invites_issued` denominator.** Built to
   count per-person invites only, since a shared code has no "issued"
   event (COMM-375's own note). Confirm this reading, or specify a
   different unified denominator (for example, treating every shared-code
   redemption as also "issued" at the moment of redemption, which would
   make `invites_issued` and `redeemed` for that bucket always equal and
   the funnel's first step less informative for a club that mostly uses
   the shared code).

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

Resolved 2026-08-30:
- Item 1 attendance source: self-reported. Attendance is a member logging
  "I trained today" (a session/workout log entry standing in for a class
  check-in), not an Arbox integration and not a dedicated in-app class
  check-in flow. This unblocks the parked bucket and the seven Phase 3
  tickets gated on it; the actual attendance-log mechanism and the
  `ATTENDANCE_RECORDED` trigger_type's real source still need building
  when Phase 3 gets there, but the *source* question is settled.
- Item 4 reaction label: keep the current generic wording. No club-specific
  Hebrew term. The database value already stays generic either way.
- Item 7 direct messaging: not deferred, removed from scope entirely. No
  "Message" button exists anywhere in the shipped client today (checked —
  it was only ever a spec reference, never built), and none should be
  added. WhatsApp covers private contact between members.
- Item 10 web push: confirmed. VAPID keys will be provisioned when Phase 2
  reaches web push; the iOS installed-PWA-only limitation (Safari 16.4+)
  is accepted.

Resolved 2026-08-31 (planning pass, no code):
- Item 1's mechanism half. The *source* was resolved 2026-08-30
  (self-reported). The *mechanism* — the table and the write path — did not
  exist as a ticket until this pass: it is now COMM-300, a new ticket
  number ahead of COMM-301, not a renumbering of any of the 17 existing
  Phase 3 titles. See "attendance foundation" under Phase 3 tickets above.
  Nothing here is built yet — this closes the planning gap, not the
  engineering one.
- Item 11 (COMM-311/312/313 spec gap): proceed with each ticket's own
  conservative, best-effort proposed shape rather than waiting for real
  spec text. Build against it now; revisit the actual output once it
  exists.
- Item 12 (COMM-315 category rotation): use the proposed rotation as-is —
  consistency, PRs, challenge completion, coach's pick.
- Item 13 (COMM-314 retention window): 30 days, matching the existing
  `purge_due_accounts()` window.
- Item 14 (Phase 3 analytics review): fold into COMM-317. COMM-317's own
  acceptance criteria gain an explicit full WCAM re-review, the same role
  COMM-234 played for Phase 2 — no new ticket number minted.

Still open: item 9 (recap scheduling note — awareness only, not a decision
that blocks anything), and four new ones raised while writing Phase 3
tickets, numbered 11-14 below.

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
11. Member engagement segmentation, community health score, and retention
    correlation views (COMM-311, COMM-312, COMM-313) have no forward
    reference anywhere in this repo's docs, unlike every other Phase 3
    ticket. Each ticket file proposes a conservative, best-effort shape and
    flags it explicitly. Recommendation: confirm the real spec text for
    these three (segment set and thresholds, health-score formula and who
    sees it, cohort window and correlation cuts) before a feature agent
    builds against the proposed shape.
12. Member of the week (COMM-315) has the same gap: no forward reference,
    a proposed category rotation (consistency, PRs, challenge completion,
    coach's pick) this planner invented from the title alone. Confirm or
    correct before build.
13. Abandoned-profile retention window (COMM-314). `purge_abandoned_profiles`
    was already named in `docs/community/contracts.md` as a Phase 3 stub,
    but no number of days for "abandoned" appears anywhere. Recommendation:
    pick a number (30 days, matching the existing `purge_due_accounts()`
    explicit-deletion window, is a reasonable default to confirm or
    override) before COMM-314 is built.
14. Phase 3 has no dedicated analytics ticket the way Phase 2 had COMM-233.
    Every Phase 3 ticket that adds a real surface names its own
    `metrics.md` update inline in its acceptance criteria instead (COMM-300,
    COMM-304, COMM-307, COMM-309, COMM-315), but nothing plays COMM-233's
    role of reviewing the whole set together and re-checking WCAM inclusion
    once every Phase 3 producer exists. Recommendation: either fold that
    review into COMM-317's QA sweep explicitly (COMM-317's own acceptance
    criteria do not currently name a full WCAM re-review), or confirm a new
    ticket number should be minted for it — this planner did not invent one
    on its own, since it was not among the 17 titles given.

## Design sync & audit remediation (2026-09-02)

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md`, a 10-agent cross-repo audit comparing this repo against `crossfit-pwa-Noam` (design reference) for visual-design parity and portable improvements, plus a top-to-bottom review of security, accessibility, performance, architecture, test coverage, and legal/content readiness. Full findings and rationale for every ticket below live in that audit doc. P2/informational findings (50 more) were intentionally left unfiled — see the audit doc's Proposed tickets sections per domain if you want those ticketed too. Two P1 findings (Noam's stale PRIVACY.md/TERMS.md and its unused cloud.js/cloud-config.js carrying live Supabase credentials) are not filed here since they belong to the `crossfit-pwa-Noam` repo, not this one's ticket system — see the audit doc directly.

| ID | Title | Agent | Priority | Status |
|---|---|---|---|---|
| COMM-322 | Restore --shadow-sm design token | cross-cutting (UI/design) | P0 | done |
| COMM-323 | Port Noam's card-based Settings screen redesign | cross-cutting (UI/design) | P0 | todo |
| COMM-324 | Port Noam's two-card WOD Builder layout with pinned footer | cross-cutting (UI/design) | P0 | todo |
| COMM-325 | Finish the .chip-btn.primary / .selected migration for filter and toggle chips | cross-cutting (UI/design) | P0 | done |
| COMM-326 | Fix hardcoded dark popover background in post menu and mention picker | cross-cutting (UI/design) | P0 | done |
| COMM-327 | Decide and align on one navigation pattern across both apps | cross-cutting (UI/design) | P0 | done |
| COMM-328 | Port overlay focus-trap/Escape contract to Community's core training-log dialogs | unassigned (app.js core, outside the 15-agent community roster) | P0 | done |
| COMM-329 | Add heading elements and landmark regions to the app shell | cross-cutting (UI/design) | P0 | partial |
| COMM-330 | Reclassify cloud.js from REQUIRED to OPTIONAL in the service-worker precache list | platform | P0 | done |
| COMM-331 | Defer the community data-load cascade until the Community tab is first opened | platform | P0 | done |
| COMM-332 | Verify and fix migration-check / pgTAP CI status (COMM-020) | qa | P0 | done |
| COMM-333 | Fix browser-check flakiness and stop run-all.mjs aborting on first failure | qa | P0 | done |
| COMM-334 | Confirm CSP status of the real production repo (haimunia-app) and port CSP headers to it | unassigned (separate repo, outside this workspace) | P0 | done |
| COMM-335 | Finish legal essentials in PRIVACY.md / TERMS.md and remove draft language | identity-privacy | P0 | partial |
| COMM-336 | Extend PRIVACY.md to disclose photos, comments, follows, and admin-visible data | identity-privacy | P0 | done |
| COMM-337 | Move hosting off GitHub Pages (or add an edge layer) to enable clickjacking headers | platform | P1 | todo |
| COMM-338 | Run the pgTAP suite in CI and add a multi-role live smoke test before deploy | qa | P1 | partial |
| COMM-339 | Reset confirmClear when the Settings modal closes | unassigned (app.js core, outside the 15-agent community roster) | P1 | todo |
| COMM-340 | Add interactive-widget=resizes-content to the viewport meta | unassigned (app.js core, outside the 15-agent community roster) | P1 | todo |
| COMM-341 | Add a monthly stats summary, legend, and card chrome to the calendar screen | cross-cutting (UI/design) | P1 | todo |
| COMM-342 | Fix reversed prev/next month chevron icons on the calendar | cross-cutting (UI/design) | P1 | todo |
| COMM-343 | Port the chosen/unchosen exercise-select state and stat-hero cards to the Home/log screen | cross-cutting (UI/design) | P1 | todo |
| COMM-344 | Fix onboarding modal subtitle to match the 5 screens now listed | cross-cutting (UI/design) | P1 | todo |
| COMM-345 | Give the notification bell a consistent icon-button class matching the nav-menu button | cross-cutting (UI/design) | P1 | todo |
| COMM-346 | Add a .chip-btn.danger modifier and remove inline destructive-button styling | cross-cutting (UI/design) | P1 | todo |
| COMM-347 | Promote high-traffic classless inline components in cloud.js into real CSS classes | cross-cutting (UI/design) | P1 | todo |
| COMM-348 | Give .post-media-grid an actual grid layout | cross-cutting (UI/design) | P1 | todo |
| COMM-349 | Migrate the remaining 8 dialogs onto Community's dialog registry and narrow the focusable selector | unassigned (app.js core, outside the 15-agent community roster) | P1 | todo |
| COMM-350 | Reconcile active-tab visual language once Community's nav IA is final | cross-cutting (UI/design) | P1 | todo |
| COMM-351 | Reconcile --shadow-card formula across repos | cross-cutting (UI/design) | P1 | todo |
| COMM-352 | Restore the --text-scale token and unify the Large Text magnitude | cross-cutting (UI/design) | P1 | todo |
| COMM-353 | Align .page-title typography treatment | cross-cutting (UI/design) | P1 | todo |
| COMM-354 | Reconcile the --steel token value between repos | cross-cutting (UI/design) | P1 | todo |
| COMM-355 | Preserve the cloud-aware backup staleness threshold when porting the Settings redesign | cross-cutting (UI/design) | P1 | todo |
| COMM-356 | Give the challenge-joined status its own tag style instead of overriding .admin-tag | cross-cutting (UI/design) | P1 | todo |
| COMM-357 | Replace hardcoded rgba tints in announcement badges and coach comment highlight with color-mix() | cross-cutting (UI/design) | P1 | todo |
| COMM-358 | Add roving-tabindex and Arrow-key support to all role="tablist" groups | cross-cutting (UI/design) | P1 | todo |
| COMM-359 | Give the est-1RM trend chart an accessible name or data alternative | cross-cutting (UI/design) | P1 | todo |
| COMM-360 | Default selectedId/selectedWodId to unset with an explicit pick-one empty state | unassigned (app.js core, outside the 15-agent community roster) | P1 | todo |
| COMM-361 | Darken light-theme --brass or add a higher-contrast text variant | cross-cutting (UI/design) | P1 | todo |
| COMM-362 | Add a session-expiry / refresh-failure auth test | qa | P1 | done |
| COMM-363 | Add browser-check scenarios for post composition and report moderation | qa | P1 | done |
| COMM-364 | Add a quota-exceeded regression test for noteStorageError | qa | P1 | done |
| COMM-365 | Namespace cloud.js's flat state object by feature domain | platform | P1 | todo |
| COMM-366 | Spike scoped/keyed rendering as an alternative to cloud.js's full-tree innerHTML rerender | platform | P1 | todo |
| COMM-367 | Remove the duplicate safeText() implementation in cloud.js, use the shared esc() | platform | P1 | todo |
| COMM-368 | Extract shared low-level safety helpers into a package or submodule used by both repos | platform | P1 | todo |
| COMM-369 | Backfill CHANGES.md with the missing 2026-08-28 through 2026-09-01 entries | planner | P1 | done |

COMM-369: CHANGES.md's top entry was stale at 2026-08-27 while `git log`
(reconstructed from `.git/logs/HEAD`, since no live `git` execution was
available in this pass) showed real work through 2026-09-01. Backfilled six
new entries, newest first, covering 2026-08-28 through 2026-09-01: two
2026-09-01 grab-bags (small independent fixes, and the hamburger-nav/
Settings/desktop-sidebar UI restructuring), then one entry each for the
Phase 3, Phase 2, and Phase 1 builds, and a Phase 0 foundations entry. The
Phase 1/2/3 entries are sourced from this backlog file's own narrative
paragraphs for those phases (the authoritative record of what each ticket
actually delivered), not invented; the two 2026-09-01 UI-restructuring
entries, which have no matching narrative here since that track sits outside
the Community ticket system, are sourced from commit messages only and kept
correspondingly shorter. CHANGES.md's top entry now matches the latest
commit prior to this session's own work.

COMM-334: closed by direct verification, not assumption. A local checkout of
`haimunia-app`'s real `origin/main` was available in this workspace after
all, at `crossfit-pwa-Noam` (its `origin` remote points at
`github.com/haimuniya/haimunia-app`, not the Noam design-reference content
its directory name suggests). `git show origin/main:index.html` and a direct
`curl` against the live `https://haimuniya.github.io/haimunia-app/` both
confirm production ships the same kind of meta-tag CSP this demo repo does,
on the same GitHub-Pages-cannot-send-headers limitation — the "production
ships no CSP at all" claim in this repo's own `index.html` comment was
wrong, not verified. That comment is now corrected in place, and this demo's
meta tag gained the `frame-ancestors 'none'` line production already had
(inert in meta form on either app, real fix tracked separately as
COMM-337).

COMM-335 is `partial`: PRIVACY.md and TERMS.md were rewritten end to end
into structurally complete policies — every section a launch-ready policy
needs (operator identity, information collected, automatic-backup versus
community-sharing scope, sharing and subprocessor disclosure, legal basis,
retention, data-subject rights, children's privacy, security, international
transfers, acceptable use, content license, moderation, disclaimers,
termination) — in ordinary finished prose, with every "this is a draft" /
"requires legal review" / unfinished-checklist line removed. What remains
is not missing structure but missing facts nobody in this workspace can
supply: the operator's legal name and registered address, a real contact
email, the governing-law/jurisdiction, the hosting/data-processing region,
the backup and log retention windows (beyond the already-fixed 30-day
account-deletion window), and the minimum-age requirement. Each is marked
inline with a bracketed placeholder (`[Operator legal name]`, `[Operator
registered address]`, `[Contact email]`, `[Jurisdiction / governing law]`,
`[Hosting region]`, `[Backup retention period, in days]`, `[Log retention
period, in days]`, `[Minimum age requirement]`) at the exact point each
fact belongs, so a founder/legal pass can find and fill every one without
re-reading the whole document. Supabase and GitHub Pages are named as the
actual subprocessors (real facts from `cloud.js`/the tickets, not
placeholders); lawful-basis language uses a standard contract/consent/
legitimate-interest/legal-obligation mapping since that follows from how
the app already works, not from an unknown fact. COMM-336's disclosures
(photos, comments, follows, and the admin-visible member directory plus the
attendance admin-override) are preserved and folded into the rewrite, not
dropped. This ticket cannot move to `done` until a founder or legal pass
resolves the bracketed facts above — that sign-off, and updating the
in-app links at `app.js:2844` to be considered launch-ready, is out of
scope for this pass and tracked by this ticket's own acceptance criteria.

COMM-338 is `partial`: two of its three acceptance criteria were already
true, not newly shipped here — confirmed again by re-reading
`.github/workflows/test.yml`'s `migration-check` job (unchanged since
COMM-332 re-verified it) rather than re-running the full docker-based
`supabase test db` stack a second time in one day. The pgTAP suite
(`supabase/tests/`, 56 files) runs on every push against a disposable,
migration-only database, and that step has no `continue-on-error` — a red
RLS test fails the build. What did not exist before this pass is the
multi-role live smoke test: `scripts/smoke-test-multi-role.mjs`, following
the exact convention `scripts/smoke-test-anon-key.mjs` already established
(deliberately outside `npm test` and outside CI, run by hand against a real
project's Auth/REST endpoints over the network) — but generalized to five
real signed-in roles (anonymous, member, coach, admin, and a
posting-restricted "blocked" member), each asserting its own real
permission boundary (own-row reads, `admin_grant_coach` refused for
everyone but an admin, a restricted member's `post_create` refused, an
admin's `mod_queue` reachable). The real gap: there is no separate staging
project distinct from production (see `docs/community/` "supabase-live-
project" memory) and no test accounts are provisioned anywhere yet, so this
session did not execute the script against a live project — doing so
without staging risks writing test data into the one real project this app
has. Each of the four credentialed roles is skipped, not failed, when its
`SMOKE_<ROLE>_EMAIL`/`_PASSWORD` env vars are unset, so the script is honest
about never having been run for real rather than reporting a false pass.
Provisioning five throwaway accounts (one per role) on a real or staging
project and actually running this once before the next go-live is the
remaining work, and is a decision (and a credential-handling step) for the
project owner, not something this pass could complete unattended.

COMM-362, COMM-363 and COMM-364 are `done`. COMM-362:
`test/community-session-expiry.test.mjs` adds two tests exercising both
halves this ticket asked for. The sync/write path: `post_create` returning
the 401/"JWT expired" shape a real unrefreshable expired token produces
keeps the composer open with the existing retryable error
(`publishComposer()`'s own `if (error || !data)` branch), never a silently
dropped post. The realtime-subscribe path: a session dying mid-session from
a refresh failure — not a user clicking sign out — still closes every open
realtime channel (the COMM-141 own-row notification channel) and drops the
app back to the signed-out gate, through the exact same
`onAuthStateChange(SIGNED_OUT)` handler every sign-out test already
exercises via the UI button. `test/helpers/mockSupabase.mjs` gained one
small addition for this, `expireSession()` — fires the identical
`SIGNED_OUT` event `signOut()` does (real gotrue-js makes no distinction
between the two triggers either), named separately purely so a reader does
not mistake a dying session for a user action. COMM-363:
`scripts/browser-check/community-post-composition.mjs` composes and
publishes a post through the real composer UI end to end (real `fill`/
`selectOption`/`click`, not synthetic events), and
`community-report-moderation.mjs` reports a post as one member, switches to
a head-coach session, and reviews and removes it through the real
moderation queue — both against real Chromium, bringing the suite from 24
scenarios to 26 (`run-all.mjs`: 26/26 passed). The "report" control turned
out to live inside the post's "⋯" overflow menu, not directly on the card —
worth noting since it is easy to seed a post and never find the button.
COMM-364: `test/storage-quota-exceeded.test.mjs` mocks `dbPut()` rejecting
with a real `QuotaExceededError` and asserts `noteStorageError()` surfaces
the dedicated out-of-storage Hebrew message (not the generic one), that a
genuinely different failure gets the generic message instead (no
mislabeling), that the failure is still logged, and that a later successful
save clears the error state — all through `saveSet()`'s real save path,
never throwing past it. Not ported to `crossfit-pwa-Noam` in this pass — that
is a separate repo outside this workspace, per this ticket's own optional
"if kept in sync" wording, and not something this session touched.
`npm test`: 946 tests, 942 passing before and after this pass's own 9 new
tests (5 in the two files above, plus the pre-existing 3 unrelated failures
below); browser-check: 26/26. The 3 pre-existing `npm test` failures
(`community-engagement-ui.test.mjs`, a photo-upload test, and
`community-inline-compare.test.mjs`, all asserting the exact literal
`safeText(...)` template string cloud.js used to use) are unrelated to
these four tickets — they are mid-flight fallout from another concurrent
session's uncommitted COMM-367/COMM-368 `esc`/`safeText` consolidation
(`src/shared/safe-helpers.js`), caught here rather than papered over, and
belong to that work to fix, not this one.
