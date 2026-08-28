# Function and RPC contracts

Every Postgres function, RPC, and Edge Function the client calls is recorded
here before it is built. planner owns this file. schema updates signatures as
migrations land. Read this before adding any function. Do not call an
undocumented function.

## Conventions

- Postgres functions are `security definer` only when they must cross an RLS
  boundary, and they check the caller with `auth.uid()` first.
- RPC names are snake_case and prefixed by area: `feed_`, `post_`, `ach_`,
  `chal_`, `event_`, `mod_`, `notif_`, `pin_`.
- Edge Functions live in `supabase/functions/<name>/` and are invoked with the
  vendored client `functions.invoke`.
- Every function lists: purpose, params, returns, auth rule, side effects.
- A "direct RLS write" note means the client writes the table itself under an
  own-row policy, no function.

## Phase 0 schema notes

Landed by schema in 202608280001 through 202608280013. Read these before
writing against any of the tables below.

- The posts table is `public.workout_posts`. Tickets and this file call it
  `posts`. It was not renamed: `cloud.js` writes it by name and the reports
  query embeds it as a PostgREST related resource, which resolves through a
  real foreign key and would not survive a rename plus a compatibility view.
  Everything COMM-001 asked for is on that table.
- `post_visibility` now has five labels. `club`, `friends`, and `only_me` are
  the model going forward. `public` and `followers` are kept because the
  current client still writes them, and are read as an alias of `club` and as
  the legacy one-way follower scope. Existing rows were not remapped, so this
  migration neither widened nor narrowed anything a member already posted.
  New writes should use the three new labels. The column default is now
  `club`.
- `friends` means a mutual follow edge, resolved by `are_friends()`. There is
  no friend table.
- `post_visible_to_viewer(p_post_id uuid)` is the one place that says what
  each visibility label means. The `posts_feed_select` policy repeats the
  same rule inline and cannot call the function: the function selects from
  the same table, so a policy on it would recurse.
- Every new table carries a `club_id uuid` defaulting to
  `default_club_id()`. Nothing filters on it. It exists so a second club is a
  data migration rather than a schema rewrite.
- Community writes require `is_community_member()`, which requires
  `profiles.recovery_verified_at`. Existing email plus password accounts were
  backfilled as verified in 202608280003. Anonymous accounts were not, so
  they can read the community but cannot post, comment, react, or join until
  they set a recovery method through `mark_recovery_verified()`.
- Tables Phase 1 still needs and Phase 0 deliberately does not create:
  `hidden_posts`, `saved_posts`, `pins`, `posting_restrictions`,
  `notification_batches`, and the `parent_comment_id` plus `edited_at`
  columns on comments. Each lands as a small migration at the start of its
  owning Phase 1 ticket.

## Feed

### feed_page(cursor timestamptz, limit int, scope text) returns setof feed_item plus next_cursor

- Purpose: ranked and diversified feed page for the calling user.
- Params: `cursor` opaque token or null for the top. `limit` 1 to 40, default
  20. `scope` one of for_you, following, achievements, coach, my_classes.
- Returns: feed rows in final order, each with post fields, author, media,
  counts, plus a `next_cursor`.
- Auth: caller must have a profile and an invite redemption.
- Side effects: none. Impression writes come from the client after render.
- Notes: class-connection score is 0 until attendance lands, see COMM-P01.
  Diversity rules from COMM-112 run inside this function. Block edges from
  COMM-125 are joined here. `my_classes` scope is parked.

### feed_record_impressions(p_rows jsonb) returns void

- Shipped in 202608280006.
- Purpose: bulk insert feed_impressions for posts shown in one feed session.
- Params: `p_rows` is an array of {post_id, position, feed_session_id,
  shown_at}. Capped at 50. Rows missing post_id or feed_session_id are
  skipped rather than rejected.
- Auth: security definer, raises when auth.uid() is null. Every row is
  written with the caller's own user_id, never a value from the payload.
- Side effects: idempotent. A repeated batch collides on (user_id,
  feed_session_id, post_id) and does nothing.

### feed_record_interaction(p_post_id uuid, p_kind text) returns void

- Shipped in 202608280006.
- Purpose: record one feed interaction and flip `opened` or `engaged` on the
  matching impression.
- Params: `p_kind` one of open, react, comment, share, hide, save,
  profile_open.
- Auth: security definer, own-row via auth.uid(). Rejects a post the caller
  cannot see. Rate limited at 300 per 10 minutes.
- Side effects: feed_impressions has no UPDATE grant or policy, so this
  function is the only thing that can flip those two flags.

## Posts

### post_create(body text, visibility post_visibility, media jsonb, links jsonb) returns uuid

- Purpose: create a POST_TEXT or POST_PHOTO post with optional media and
  source links, one consistent write path.
- Params: `body` up to 1000 chars. `media` up to 4 {storage_path, alt_text,
  position, width, height}. `links` optional {workout_id, achievement_id,
  event_id}.
- Returns: the new post id.
- Auth: caller has `community.post.create` and no active posting restriction.
- Side effects: inserts posts and post_media, emits POST_CREATED.

### post_set_visibility(post_id uuid, visibility post_visibility) returns void

- Auth: author only. Side effects: updates visibility, re-evaluates who can
  see it.

### post_edit_caption(post_id uuid, body text) returns void

- Auth: author only. Updates `body` only. `body` up to 1000 chars.

### post_delete(post_id uuid) returns void

- Auth: author or `community.post.delete_any`. Sets `deleted_at`, status
  removed. Writes admin_actions when done by a moderator.

### post_hide(post_id uuid) returns void

- Purpose: hide a post from the caller's feed only.
- Auth: any member. Side effects: inserts into `hidden_posts`. feed_page
  filters these out.

### post_save(post_id uuid) returns boolean

- Purpose: toggle a personal bookmark. Returns the new saved state.
- Auth: any member. Side effects: inserts or deletes a `saved_posts` row.

### pr_share(record_id uuid, note text, media jsonb) returns uuid

- Purpose: create a POST_PR from a detected personal record.
- Auth: the record owner. Side effects: inserts a POST_PR, improvement is
  recomputed server-side from the record, not trusted from the client.

### community_profile(user_id uuid) returns community_profile_view

- Purpose: the profile community section, with each field filtered by
  `can_view_profile_field` against the caller.
- Auth: any member. A fully private target returns name, role, member since
  only.

## Achievements

### ach_evaluate(user_id uuid, trigger text, payload jsonb) returns setof text

- Purpose: return achievement codes newly unlocked by an event.
- Triggers handled: WORKOUT_COMPLETED, PR_CREATED, MEMBER_JOINED,
  COMMENT_CREATED, REACTION_CREATED, CHALLENGE_COMPLETED. ATTENDANCE_RECORDED
  is accepted and is a no-op until COMM-P03.
- Auth: service role only, called by event-bus consumers.
- Side effects: inserts member_achievements once per non-repeatable
  definition, emits ACHIEVEMENT_UNLOCKED. Idempotent on repeat.

### ach_share(member_achievement_id uuid, caption text, media jsonb) returns uuid

- Purpose: create a POST_ACHIEVEMENT and set `shared_at`.
- Auth: the achievement owner. Rejects a private-visibility achievement.

## Challenges

### chal_progress(challenge_id uuid) returns challenge_progress_view

- Purpose: personal, team, and club progress for one challenge.
- Auth: caller must be a club member. Team split visible to participants.

### event_rsvp(p_event_id uuid, p_response text) returns void

- Shipped in 202608280010.
- Purpose: set the caller's RSVP with capacity and deadline checks.
- Params: `p_response` one of going, interested, not_going.
- Auth: security definer. Requires `is_community_member()`. Rejects an event
  that is not published.
- Side effects: upserts one event_attendees row. Capacity and deadline are
  enforced by the `event_attendees_capacity` trigger rather than by this
  function, so a direct RLS upsert hits the same checks. It raises
  `event_full` or `registration_closed`.

## Engagement

### comment_edit(comment_id uuid, body text) returns void

- Auth: author only. Sets `edited_at`. `body` up to 1000 chars.
- Note: comment create and delete keep the existing `addComment` and
  `deleteComment` client functions, `addComment` gains an optional
  `parentCommentId`. Reply depth cap 2 is enforced by a check.

## Notifications

### notif_list(p_cursor timestamptz, p_limit integer) returns setof notifications

- Shipped in 202608280008.
- Purpose: the caller's notification stream, newest first, grouped client-side
  by category. `p_limit` clamped to 1 to 40, default 20.
- Auth: security invoker, so the own-row select policy is what scopes it.

### notif_mark_read(p_ids uuid[]) returns void

- Shipped in 202608280008.
- Auth: security definer, own-row. Up to 100 ids per call. A null or empty
  array is a no-op.

### notif_unread_count() returns integer

- Shipped in 202608280008.
- Auth: security invoker, own-row.

- Note: notifications are created only server-side, by triggers and event-bus
  consumers. There is no insert policy and no insert grant on the table.
  Batching state lives in `notification_batches`, which is a Phase 1
  migration under COMM-142. `notification_preferences` is a direct RLS
  upsert, and a missing row means in_app.
- Note: the own-row UPDATE policy exists for `read_at`. A
  `notifications_protect_content` trigger pins every other column on an
  authenticated request, so a member cannot rewrite the body of a
  notification the server sent them.

## Identity and privacy

### redeem_invite_code(p_code text, p_actor_key text) returns text

- Shipped in 202608280013.
- Purpose: redeem an invite, rate limited by a stable actor signal, not only
  the Auth user id.
- Params: `p_actor_key` opaque, up to 128 chars. It is sha256 hashed before
  it reaches a column, so the raw key is never stored or logged with the
  code. A null, empty, or over-long key falls back to the uid key alone.
- Returns: the granted role on success, `invalid`, or `rate_limited`. It
  never raises, so a caller cannot tell the three apart by error shape.
- Auth: authenticated caller. Five attempts per fifteen minutes, counted
  against the uid key AND the actor key, whichever is higher. Same generic
  answer and the same increment regardless of whether the actor is new.
- Side effects: on success, writes the redemption and the role.

### redeem_invite_code(p_code text) returns text

- Shipped in 202608270006, rewritten in 202608280013 as a wrapper that
  passes a null actor key. Kept so the current client keeps working while
  identity-privacy wires the actor key through COMM-017. Behaviour with no
  actor key is the uid-keyed throttle, exactly as before.

### can_view_profile_field(p_target uuid, p_field text) returns boolean

- Shipped in 202608280003.
- Purpose: resolve the caller against the target's privacy toggles and block
  edges for one field. Feed, profile, leaderboard, and search all route
  through this so they cannot drift apart.
- Params: `p_field` one of visible_to_club, show_workout_results,
  show_attendance, show_upcoming_booking, show_prs, show_achievements,
  in_leaderboards, allow_follows, allow_mentions, allow_messages,
  show_in_attendee_lists. An unknown name raises. There is no `show_birthday`
  and there is no birth date column, per the 2026-08-28 decision.
- Auth: security definer, raises nothing for a null caller and returns false.
  It reads the target's row, which the caller may not be able to select once
  `visible_to_club` is off, and only ever answers about the caller's own view.
- Notes: self always true. A block edge in either direction returns false
  before any toggle is read. A real admin passes. `show_in_attendee_lists`
  is ANDed with the club-wide `clubs.attendee_lists_enabled` override, which
  can only ever subtract from the member's own choice.

### mark_recovery_verified() returns timestamptz

- Shipped in 202608280003.
- Purpose: stamp `profiles.recovery_verified_at`, which is what
  `is_community_member()` requires. This is the only client-reachable way to
  set it.
- Auth: security definer. It refuses unless auth.users says the caller really
  has an email, a password, and a confirmed email, so the gate cannot be
  self-certified. The column is pinned on both the profiles update trigger
  and the insert policy, so no direct write can set it.
- Side effects: idempotent. An already-verified profile keeps its original
  timestamp.

### is_community_member() returns boolean

- Shipped in 202608280003.
- Purpose: the community access predicate. True when the caller has a live
  profile, a non-null `recovery_verified_at`, and an invite redemption.
- Used by: post insert, comment create, reaction create, challenge join,
  challenge progress, event RSVP, and post_media insert. Read paths are
  deliberately not gated, so an account still setting up its recovery method
  can look around but cannot contribute.

### are_friends(p_other uuid) returns boolean

- Shipped in 202608280003.
- Purpose: the one definition of "friends" in the schema, a mutual follow
  edge between the caller and `p_other`. There is no friend table.
- Auth: security invoker. Both follows rows are readable to the caller under
  the existing `follows_visible` policy.

## Permissions

### has_perm(p_permission text) returns boolean

- Shipped in 202608280001.
- Purpose: does the caller's club role hold this permission string.
- Auth: security definer, returns false for a null caller. Definer because
  it reads `role_permissions`, and the write policies on the RBAC tables call
  into this chain, which an invoker-rights version would make recursive.
- Notes: `owner` short-circuits to true, so a permission string added by a
  later migration is held by owner with no matching seed row.

### my_permissions() returns setof text

- Shipped in 202608280001.
- Purpose: the caller's full permission set, for the client session cache.
- Auth: security definer, returns an empty set for a caller with no role.

### my_role_code() returns text

- Shipped in 202608280001.
- Purpose: the caller's single effective role code, the highest ranked of
  their `invite_redemptions.role` and the legacy `profiles.is_admin` flag.
- Returns: null when the caller has no live profile or no role at all. Null
  is the correct "not a member" answer and every helper treats it as false.
- Auth: security definer. It takes no user id argument on purpose, so the
  only row it can ever resolve is auth.uid()'s.

### role_rank(p_code text) returns smallint

- Shipped in 202608280001. member 10, coach 20, head_coach 30, staff 40,
  admin 50, owner 60.

### is_staff() returns boolean

- Shipped in 202608270006, reimplemented in 202608280001 as
  `role_rank(my_role_code()) >= 20`. Same signature, so the announcements and
  weekly_challenges policies bound to it stay valid. Same meaning, coach rank
  or above, with one tightening: a soft-deleted profile is no longer staff.

### is_admin() returns boolean

- Shipped in 202608280001. `role_rank(my_role_code()) >= 50`.
- Note: `review_report`, `posts_select_admin_review`, and the four
  `admin_*` RPCs still check the `profiles.is_admin` column inline. Migrating
  those to this function is COMM-150, not a Phase 0 change.

### default_club_id() returns uuid

- Shipped in 202608280001. The seeded single club id, used as the column
  default behind every `club_id`. No table filters on `club_id` today.

## Moderation and admin

### report(target_type text, target_id uuid, reason text, note text) returns void

- Purpose: file a report on a post or comment.
- Params: `target_type` post or comment. `reason` one of harassment, spam,
  inappropriate, privacy, unsafe_advice, other. `note` up to 500 chars.
- Auth: any member. Duplicate reports by the same member on the same target
  collapse, reporter count increments once per unique reporter.

### mod_queue(status text, cursor timestamptz, limit int) returns setof mod_queue_item

- Purpose: the moderation review queue.
- Params: `status` open, reviewing, action_taken, dismissed, or all.
- Auth: `community.comment.moderate` or real `is_admin`. `limit` capped at
  50. Reporter identities visible to the reviewer only.

### mod_review(report_id uuid, decision text, note text) returns void

- Purpose: record a trusted status transition and apply the decision.
- Params: `decision` one of remove, warn, restrict_temp, restrict_permanent,
  dismiss. `note` up to 500 chars.
- Auth: real `is_admin`. Writes reviewer id and timestamp.
- Side effects: sets content status, writes `posting_restrictions` for a
  restriction, calls `log_admin_action` with before and after.

### log_admin_action(p_action_type text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb) returns void

- Shipped in 202608280002. `p_target_id`, `p_before`, and `p_after` default
  to null.
- Purpose: append one audit row. Called inside the acting function, before it
  returns, so a failed log fails the action.
- Auth: security definer with no grant to anon or authenticated, so it is
  callable only from inside another server function. `admin_id` is taken from
  auth.uid() and never from a parameter, so an audit row cannot be forged for
  someone else.
- Side effects: inserts `admin_actions`. The table has no insert, update, or
  delete policy and no write grant, which is what makes it append-only for
  every client including an admin. `p_before` and `p_after` are capped at
  8 KB each inside this function rather than by a CHECK, because
  `pg_column_size()` is STABLE and Postgres refuses a non-IMMUTABLE function
  in a check constraint.

### admin_actions_page(p_cursor timestamptz, p_limit integer, p_filters jsonb) returns setof admin_actions

- Shipped in 202608280002.
- Purpose: the admin log view.
- Params: `p_filters` optional {action_type, admin_id}. `p_limit` clamped to
  1 to 100, default 25.
- Auth: `community.analytics.view`, checked inside the function and again by
  the table's own select policy.

### pin_set(target_type text, target_id uuid) returns void

- Purpose: pin an item to the club home. `target_type` announcement,
  challenge, event, post.
- Auth: `community.content.pin`. Hard cap 3 enforced by a trigger. Writes
  `log_admin_action`.

### pin_clear(target_type text, target_id uuid) returns void

- Auth: `community.content.pin`. Writes `log_admin_action`.

## Analytics

### analytics_track(event_name, props)

- Client helper, not an RPC. Direct RLS insert into `analytics_events` with
  own-row insert and analytics-holder read. `event_name` must be one of the
  defined constants. `props` under 4 KB. Adding a prop is additive, removing
  or renaming bumps `schema_version`.
- Shipped in `src/analytics.js` as `window.analyticsTrack`, see the client
  platform helpers section below for the finalised signature.

## Client platform helpers

Shipped by platform in Phase 0, COMM-012 through COMM-015. These are not
RPCs. They are plain classic scripts under `src/`, loaded by `index.html`
before `cloud.js` and `app.js`, precached in `sw.js`, and reached through
`window`. A new file here has to be added to `index.html`, the `sw.js`
`REQUIRED_ASSETS` list, and `test/helpers/boot.mjs` in the same order, or it
is either missing offline or invisible to every test.

### window.HaimuniaEvents, COMM-012

`src/eventbus.js`. The one product event interface. Feature code never
reaches another feature's internals to learn that something happened.

- `EVENTS` frozen map of the eleven typed events. Also aliased as
  `window.PRODUCT_EVENTS`. Each constant's value is its own name.
- `emit(type, payload)` returns the number of handlers invoked, 0 when the
  event was dropped. Synchronous dispatch, no await, no deep clone. A
  producer never waits on a consumer.
- `on(type, handler)` returns an unsubscribe function. Calling it twice is a
  no-op and never removes another handler.
- `reset()` drops every subscription. `handlerCount(type)` for
  introspection.
- Unknown type: throws in development, warns and drops in production.
  Development means `window.HAIMUNIA_DEV === true`, or a localhost origin.
- Payload must be a plain object. Omitting it delivers `{}`.
- Handlers are isolated. One throwing handler does not stop the rest, and a
  rejected promise from an async handler is caught and logged.
- Phase 0 ships zero producers and zero consumers. ATTENDANCE_RECORDED is
  defined and accepted with no producer, so wiring attendance later touches
  no other file.

### window.HaimuniaAnalytics, COMM-013

`src/analytics.js`. The only writer of `analytics_events`.

- `track(eventName, props)`, aliased as `window.analyticsTrack`. Returns a
  promise resolving true when the row was accepted. It never throws and
  never rejects: a dropped analytics row is acceptable, a broken button is
  not. Every call site may ignore the result.
- `EVENTS` frozen map of the 21 tracked names from spec section 77. Also
  aliased as `window.ANALYTICS_EVENTS`. An unknown name is warned and
  dropped, it never reaches the table.
- `props` is trimmed, not rejected. Over `PROPS_BUDGET_BYTES` the largest
  values are dropped first and `_truncated: true` is added. The budget is
  3 KB rather than the server's 4 KB because the trigger measures
  `pg_column_size()` on stored jsonb, which is not the length of the JSON
  text the client sends.
- `SCHEMA_VERSION` is 1. Adding a prop is additive. Removing or renaming a
  prop, or changing what one means, bumps it.
- `configure({ client, userId | getUserId, attachToBus })` hands the helper
  a Supabase client and a way to read the current user id, and attaches the
  bus bridge unless `attachToBus` is false. Nothing calls this in Phase 0,
  so an unconfigured `track()` is an inert no-op that touches no network.
  COMM-170 wires it.
- `BUS_EVENT_MAP` is the one-to-one product-event to analytics-name map:
  POST_CREATED, COMMENT_CREATED, REACTION_CREATED, CHALLENGE_JOINED,
  CHALLENGE_COMPLETED, EVENT_REGISTERED. WORKOUT_COMPLETED, PR_CREATED,
  MEMBER_JOINED, ACHIEVEMENT_UNLOCKED and ATTENDANCE_RECORDED are
  deliberately unmapped: completing a workout is not sharing one, and
  unlocking an achievement is not sharing it.
- `ACTIVE_MEMBER_EVENTS` and `isActiveMemberEvent(name)` are the qualifying
  subset for Weekly Community Active Members, spec section 78. The full
  definition is documented at the top of `src/analytics.js`: a unique
  member who in a calendar week posted, commented, reacted, joined a
  challenge, participated in an event, shared an achievement, or interacted
  with a coach or a community item. Passive views do not count.
  `docs/community/metrics.md` is still to be written by planner and should
  copy that definition rather than restate it.

### window.HaimuniaRealtime, COMM-014

`src/realtime.js`. One subscription helper and one registry. Feature code
never calls `client.channel()` directly.

- `configure({ client })` hands it the Supabase client.
- `subscribe(channelName, opts, handler)` returns an unsubscribe function,
  always, so a caller never needs a null check. `opts` is
  `{ table, event, schema, filter }` for postgres_changes, or
  `{ broadcast }` or `{ presence }`. Defaults are every event on the public
  schema.
- `unsubscribe(name)`, `teardownAll()` which returns how many were closed,
  `count()` and `list()`.
- One channel per name. A repeat subscribe under the same name replaces the
  binding rather than stacking a second one.
- Handlers are bound before `subscribe()` is called, which is what makes
  reconnect safe. Nothing re-binds on a status callback, so a rejoin after a
  dropped socket cannot duplicate handlers. A terminal CLOSED drops the
  registry slot.
- `MAX_SUBSCRIPTIONS` is 10. The eleventh warns and closes the oldest.
- `cloud.js` calls `teardownAll()` from `setCommunityTab` on a real tab
  change. That is the only cloud.js line COMM-014 touches.
- With no configured client, subscribe is a working no-op. Phase 0 opens
  zero subscriptions. Realtime replication per table is a Phase 2 schema
  change under COMM-227 and COMM-209.

### window.HaimuniaImage, COMM-015

`src/image.js`. Everything that reaches Storage goes through this first.

- `prepareImage(file, opts)` resolves to
  `{ type, source, render, thumbnail, thumbnails }`. `render` is capped at
  1600 px on the long edge, `thumbnails` are 400 px and 200 px, and
  `thumbnail` is the 400 px entry. Each is drawn from the one decoded
  bitmap, so a thumbnail is never a re-compression of the render.
- Rejects with an `Error` carrying `.code`: `not_an_image`,
  `file_too_large`, `decode_failed`, `encode_failed`, `image_too_large`.
  The composer maps `not_an_image` to "This file is not an image" and
  everything else to "This image could not be processed".
- Input over 25 MB is refused before any decode. Output targets 400 KB at
  quality 0.8, steps down by 0.1 to a floor of 0.5, and past the 1 MB hard
  cap drops to 0.4 once and then rejects.
- Output type is WebP where supported, otherwise JPEG. Both are inside the
  `post-photos` bucket allow-list, which also caps one object at 5 MB
  (migration 202608270004).
- EXIF orientation is applied on decode with
  `createImageBitmap(file, { imageOrientation: "from-image" })`. The canvas
  re-encode is what strips every other tag, GPS included. That is a privacy
  property, so the helper never passes the original File through untouched
  even when it is already small enough.
- `checkByteBudget({ usedBytes, addedBytes, budgetBytes })` is the
  aggregate per-account check for the photo quota work. It answers
  `{ ok, remainingBytes, overBy, ... }` and reads its numbers from the
  caller: the quota is object-count based today (202608270006) and a
  byte-budget column is a later schema ticket.
- `opts.backend` swaps the decode, canvas and encode seam. It is how the
  tests run without a canvas, and how a later ticket would move the work
  into a worker without rewriting `prepareImage`.
- Nothing is wired to it in Phase 0. posts consumes it in COMM-103.

## Edge Functions

### recap_weekly

- Schedule: weekly. Idempotent per user per week. Phase 2, COMM-220.
- Output: one weekly recap row per active user. No classmates line yet.
- Records success and failure counts with no personal content.

### recap_monthly_club

- Schedule: monthly. Admin preview before publish. Phase 3, COMM-309.
- Output: aggregate club figures. No member names in public sections.

### purge_abandoned_profiles

- Schedule: daily. Versioned. Idempotent. Phase 3, COMM-314.
- Purpose: remove abandoned anonymous profiles per the retention rule.
- Records success and failure counts with no personal content.
