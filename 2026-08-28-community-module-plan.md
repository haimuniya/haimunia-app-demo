# Community module execution plan

Version 1.0. Date 2026-08-28. Repo `haimunia-app-demo-publish`, evolving into
the production Community module.

## Decisions

- This repo becomes the production Community module. Reuse `cloud.js`, the
  Supabase migrations, the test suite, and CI. Retarget storage names and the
  Supabase project from demo to production across the phases.
- Attendance and class-connection features are parked until a data source is
  chosen (Arbox, in-app check-in, or self-reported).
- Zero build step on the client stays. Vanilla JS, no framework, no bundler.
  Ranking, recaps, and the achievement engine run as Postgres functions and
  Deno Edge Functions.
- Full per-section agent roster. Fifteen agents.

## Reframe

The repo already ships a partial Community V1: feed, profiles, follows, blocks,
one reaction, comments, coach announcements, a weekly challenge with a
leaderboard, a moderation queue, admin member management, an invite gate,
username and password plus anonymous auth, private cloud sync, 266 tests, and
CI. This plan is gap-closure against the product spec, not a greenfield build.

## Parked bucket (needs an attendance source)

- Feed class-connection score
- Consistency leaderboard on verified attendance
- Attendance-milestone posts and achievements
- Coach Engage section and attendance-decline detection
- Post-class "trained with you" card
- Weekly recap classmates line
- Onboarding steps tied to first and third class

Feature agents build the seams now: stubbed scores, seeded and disabled
achievement definitions, an empty flag table. Wiring attendance later is a
small change.

## Agent roster

Definitions live in `.claude/agents/`. Each agent has a mission, owned files,
and a definition of done. Summary:

| Agent | Owns | Core deliverable |
|---|---|---|
| planner | docs/community/ | COMM-xxx tickets, phase board, function contracts |
| schema | supabase/migrations/ | tables, RLS, Postgres functions, migration CI green |
| feed | feed code in cloud.js | ranking function, diversity, cursor pagination, impressions |
| posts | post render and compose | post_type model, per-type cards, composer |
| engagement | reaction and comment code | reactions, 2-level replies, mentions, coach priority |
| achievements | engine function, PR wiring | achievement_definitions, unlock events, share prompts |
| challenges | challenge code | six types, cooperative and team, progress |
| events | events module | events and RSVP end to end |
| notifications | notification code, sw.js push | center, preferences, immediate versus batched, push |
| recaps | recap Edge Functions | weekly and monthly recap, onboarding sequence |
| coach-tools | coach dashboard | Celebrate, Welcome, one-tap congratulate |
| admin-moderation | role and permission code | RBAC strings, moderation queue, audit log, analytics |
| identity-privacy | auth and privacy code | identity recovery, actor throttle, privacy toggles |
| platform | event bus, realtime, search | product events, Supabase Realtime, analytics, search |
| qa | test/, scripts/browser-check/ | a test per ticket, three CI jobs green |

## Coordination

- planner runs first, produces the backlog and the contract stubs.
- schema leads each phase. Tables and RLS land before feature agents wire them.
- platform delivers the event bus and shared utilities early in Phase 0.
- Feature agents build against ticket acceptance criteria and the recorded
  function contracts.
- qa is the merge gate for every ticket.
- `docs/community/contracts.md` holds every function signature. planner owns
  it. schema updates it.

## Phases

### Phase 0 Foundations

Deploy constraint: the Phase 0 migrations add an RLS predicate requiring
`profiles.recovery_verified_at` for posting, commenting, reacting, and joining.
Email and password accounts are backfilled. Anonymous accounts are not, so they
lose those actions until they verify. Do not apply these migrations to the live
Supabase project until COMM-016 ships the verify flow. The CI migration-check
job on a throwaway stack is unaffected. Phase 0 merges and deploys as one unit.

- planner: full P0 and P1 backlog, parked items tagged
- schema: migrations for post_type, post_media, feed_impressions,
  feed_interactions, achievement_definitions, member_achievements,
  notifications, notification_preferences, push_subscriptions, the challenges
  set, the events set, roles and permissions, admin_actions, privacy fields,
  an empty coach_engagement_flags
- platform: event bus skeleton, analytics helper, realtime harness, image
  resize utility
- identity-privacy: identity decision and recovery or pre-redemption warning,
  actor-level invite throttle, privacy toggle model
- qa: one RLS test per new table
- Exit: CI green on all three jobs, no user-facing change

### Phase 1 Community V1

posts, feed with the class score stubbed, engagement, achievements on
non-attendance categories, notifications in-app, admin-moderation report and
queue upgrade with the audit log. qa adds keyboard and focus tests for new
dialogs. Release matches spec section 94.

### Phase 2 Engagement (spec V1.5)

challenges, feed friends and progress leaderboard modes, events, announcements
priority and pin, recaps with the classmates line deferred, coach-tools
Celebrate and Welcome, platform realtime and search, notifications web push
behind a flag.

### Phase 3 Intelligence (spec V2)

feed personalization, coach-tools Engage and decline detection once attendance
lands, advanced team management, monthly club recap with admin preview, full
analytics dashboard and engagement segmentation, versioned abandoned-profile
cleanup.

## Defaults in effect

- Reaction UI keeps its current wording until a club-specific name is chosen.
- Roles: all three modelled in Phase 0. HEAD_COACH exposed in Phase 1. STAFF
  and OWNER in Phase 2.
- UI stays Hebrew RTL. Tickets and code comments in English.
- Web push in Phase 2. In-app notifications only for V1.
- Agent models: schema, feed, and platform on opus. The rest inherit.

## Decisions locked 2026-08-28 (planner open questions)

- Identity: recoverable and required. Every member sets a verified recovery
  method (email plus password) before or right after invite redemption.
  Community RLS requires `profiles.recovery_verified_at`. Disposable identity
  is off the table. See COMM-016.
- The 8 tables Phase 1 needs but Phase 0 omits land as small migrations at the
  start of each owning Phase 1 ticket, not as a Phase 0 widening.
- Single club. Tables keep a `club_id` column defaulting to one club row. No
  multi-tenant code.
- Friends means mutual follows. No separate friend object. Leaderboard and
  visibility scoping use mutual follow edges.
- No birth date field. Coach Celebrate keeps anniversary from member-since,
  drops birthday.
- Still open, not blocking: attendance source, reaction label, web push VAPID
  provisioning, recap scheduling on a paused free project.

## Operator checklist

- Production Supabase "Confirm email" is OFF. Confirmed by the user
  2026-08-28. The recovery-verify gate and the existing username login both
  depend on it. If it is ever turned on, new anonymous signups cannot pass
  the community gate.
- Do not apply the Phase 0 migrations to the live project until the Phase 0
  bundle deploys with the COMM-016 verify UI. See the Phase 0 deploy
  constraint.
- Web push (Phase 2) needs VAPID keys provisioned.

## Release criteria for V1 (spec section 89)

Posts, workout sharing, comments, reactions, privacy, moderation,
notifications, analytics, and coach identity all work. Feed stays usable with
200 members. Member content is deletable. Admin actions are logged.
