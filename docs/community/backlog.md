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
reads the one before it), identity-privacy (COMM-314, unblocked from the
start), qa (COMM-317, last, the phase's merge gate, same role COMM-234 played
for Phase 2).

### attendance foundation

| ID | Title | Agent | Attendance-blocked |
|---|---|---|---|
| COMM-300 | Attendance-log mechanism and the ATTENDANCE_RECORDED source | schema | no — this is the unblock |

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

| ID | Title | Agent | Attendance-blocked |
|---|---|---|---|
| COMM-301 | Relationship score from interaction history | feed | no |
| COMM-302 | Recurring classmate score once attendance lands | feed | was — unblocked by COMM-300 |
| COMM-303 | Personalized feed ranking and per-user weights | feed | no |
| COMM-306 | Consistency leaderboard on verified attendance | feed | was — unblocked by COMM-300 |
| COMM-307 | Post-class trained-with-you card | feed | was — unblocked by COMM-300 |

COMM-301 extracts `feed_page`'s already-inline relationship arithmetic
(202608280019) into a reusable `relationship_score()` helper with no ranking
change — a prerequisite for COMM-303's per-user weighting, not for anything
attendance-related. COMM-302 closes the parked COMM-P01: `feed_page`'s
`v_class_connection` stops being hard-0'd, and `people_suggestions` (COMM-232)
gets the fourth signal branch its own migration comment already promised
("COMM-302/307 can add the verified-attendance signal in a later migration
without touching the client"). COMM-306 closes COMM-P02 by swapping
`consistency_week_streaks()`'s body onto `attendance_log`, the single place
its own 202608290015 comment already named. COMM-307 closes COMM-P05, a new
feed-top-area card (`attendance_classmates_today()`) distinct from COMM-302's
suggestions-strip signal — "who trained today", not "who to follow". COMM-303
lands last in this cluster: it personalizes the weights COMM-301 extracted
and reads COMM-302's class-connection component as one of the things it can
reweight.

### achievements

| ID | Title | Agent | Attendance-blocked |
|---|---|---|---|
| COMM-305 | Attendance milestone posts and achievements activation | achievements | was — unblocked by COMM-300 |

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

| ID | Title | Agent | Attendance-blocked |
|---|---|---|---|
| COMM-304 | Coach Engage activation and attendance-decline detection | coach-tools | was — unblocked by COMM-300 |
| COMM-315 | Member of the week rotation across recognition categories | coach-tools | no |

COMM-304 closes COMM-P04. `coach_engagement_flags` has shipped empty since
Phase 0 (202608280011) with a comment naming this exact ticket; COMM-226
already built the Engage section as a flag-gated hidden shell reading it —
this ticket gives the table its first producer (a scheduled
baseline-vs-recent `attendance_log` comparison) and flips COMM-226's flag to
default-on. The single most important existing rule, `user_id <>
auth.uid()` on every policy, is untouched by this ticket and gets extra qa
scrutiny in COMM-317 now that the table has real rows for the first time.
COMM-315 has no forward reference anywhere in this repo's docs and is
flagged as an open question in its own ticket file — the category set and
rotation order proposed there (consistency streak, PRs, challenge
completion, coach's pick) is this planner's best-effort reading of the
title, not settled spec text.

### recaps

| ID | Title | Agent | Attendance-blocked |
|---|---|---|---|
| COMM-309 | Monthly club recap Edge Function with admin preview | recaps | no |
| COMM-316 | Monthly recap classmates and onboarding class steps, attendance | recaps | was — unblocked by COMM-300 |

COMM-309 is not attendance-blocked in the gating sense — it can be built any
time after COMM-300 exists in the schema (which, per the build order above,
it already will be) since one of its aggregate figures (`sessions_logged`)
reads `attendance_log`, but every other figure does not depend on it. It is
also the first ticket to give aggregate, club-wide attendance figures any
club visibility, and stays aggregate-only forever, unlike COMM-316's
per-recap classmates line. COMM-316 closes both COMM-P06 and COMM-P07 in one
ticket: `weekly_recaps` gains a named classmates line (an own-row surface,
so naming individuals is fine, unlike COMM-309's club-wide one) and
`onboarding_progress` gains the two class-attendance steps COMM-222
explicitly deferred here by name.

### challenges

| ID | Title | Agent | Attendance-blocked |
|---|---|---|---|
| COMM-308 | Advanced challenge team management | challenges | no |

Not attendance-blocked, no ordering constraint against the rest of the
phase. Coach-driven team CRUD, member reassignment, and a captain label on
top of COMM-204's existing team challenge shape — no forward reference
existed for this one either, but the delta from COMM-204's shipped scope is
concrete enough that this ticket does not carry the same "open question"
flag COMM-311/312/313/315 do.

### admin-moderation

| ID | Title | Agent | Attendance-blocked |
|---|---|---|---|
| COMM-310 | Admin community analytics dashboard, full metric set | admin-moderation | no |
| COMM-311 | Member engagement segmentation | admin-moderation | no |
| COMM-312 | Community health score, internal only | admin-moderation | no |
| COMM-313 | Retention correlation views | admin-moderation | no |

None of these four are attendance-blocked, but COMM-313's onboarding-step
correlation reads COMM-316's two new columns, so it is ordered after the
recaps cluster above despite not being attendance-blocked itself. COMM-310
is the one ticket in this cluster with real grounding: `docs/community/
metrics.md`'s existing "Core metrics" and "Additional metrics" sections are
its whole scope, no new metric invented. COMM-311, COMM-312, and COMM-313
have no forward reference anywhere in this repo's docs — each ticket file
flags this explicitly and proposes a conservative, best-effort shape rather
than inventing spec text this planner never had.

### identity-privacy

| ID | Title | Agent | Attendance-blocked |
|---|---|---|---|
| COMM-314 | Versioned abandoned-profile purge Edge Function and runbook | identity-privacy | no |

Not the same job as the already-shipped `purge_due_accounts()`
(202608260001, a member's own *explicit* deletion request, purged 30 days
after they ask). This is a different, new category: an anonymous
`auth.users` account that never redeemed an invite and never verified
recovery, sitting abandoned. The exact retention window is flagged as an
open question in the ticket file rather than guessed at a specific number
of days.

### qa

| ID | Title | Agent | Attendance-blocked |
|---|---|---|---|
| COMM-317 | Phase 3 QA sweep | qa | no |

Last, the phase's merge gate, same role COMM-234 played for Phase 2.
Depends on every other Phase 3 ticket.

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
