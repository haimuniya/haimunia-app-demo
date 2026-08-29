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
  owning Phase 1 ticket. All of them shipped in 202608280014 through
  202608280018, see "Phase 1 schema notes" below.

## Phase 1 schema notes

Landed by schema in 202608280014 through 202608280018. Five small
migrations, one per concern, closing the list Phase 0 deferred. Read these
before writing against any of the tables below.

- The comments table is `public.post_comments`. Tickets call it `comments`,
  the same way they call `workout_posts` `posts`. It was not renamed, for
  the same reason.
- Comment reply depth is capped at 2 by the `post_comments_depth` trigger,
  not by a CHECK, because a CHECK cannot see another row. The trigger closes
  both directions. A reply cannot be given a parent that already has a
  parent, and a comment that already has replies cannot itself become a
  reply. Without the second rule a depth-3 thread is one UPDATE away.
- `post_comments.parent_comment_id` is `on delete set null`, not cascade. A
  hard delete of a parent flattens its replies to top level rather than
  destroying other members' content. The intended removal path is the soft
  one, `status` plus `deleted_at`.
- The comment body limit widened from 280 to 1000, matching the post body
  limit and what COMM-121 and COMM-122 both specify. Widening only ever
  accepts more rows, so nothing already stored was invalidated.
- A removed or soft-deleted comment is not readable by anyone but its author
  and a `community.comment.moderate` holder. The "comment removed"
  placeholder does not need the row: a reply carries `parent_comment_id`, so
  a client holding a reply whose parent is absent from the same page knows
  to render the placeholder. No removed text crosses the wire.
- A posting restriction is applied to post creation and comment creation
  only. It is deliberately not folded into `is_community_member()`, which
  also gates challenge joins, event RSVPs, reactions, and post_media. A
  restriction is a speech sanction, not an expulsion.
- `posting_restrictions` and `pins` have a select policy and no write grant
  at all. Every write goes through a security definer function that checks
  the permission and calls `log_admin_action()` in the same transaction.
  That is what makes the COMM-153 and COMM-155 audit requirement a property
  of the schema rather than of whichever client made the call.
- The `pins` cap of 3 is a `slot` column bounded to 0 through 2 with a
  unique `(club_id, slot)`, not a counting trigger. COMM-155 says trigger.
  This is the version of that intent that survives concurrency, the same
  reasoning `post_media` used for its 0 through 3 position cap. `slot`
  doubles as the display order of the pinned strip.
- `pins.target_id` has no foreign key, because it points at one of four
  tables. Existence and pinnability are checked on write by
  `enforce_pin_target()`, and eight `unpin_target()` triggers do the job a
  cascade would have done plus the soft-delete and status cases a foreign
  key cannot see.
- `notification_batches` holds counters only. It is not a second
  notification stream. Own-row read, no write grant, so a member cannot set
  their own `next_flush_at` to now and turn the batched channel back into a
  stream of pings.
- `hidden_posts` and `saved_posts` are strictly own-row on all verbs. There
  is no count and no aggregate anywhere. Knowing who muted you is exactly
  the signal a hide feature must never leak back to the author.
- Open point for identity-privacy: `hidden_posts_self_insert` carries
  `is_community_member()`, so an account that has not set a recovery method
  cannot mute a post even though the row it would write is invisible to
  everyone but itself. The gate is there because the standing rule says
  member write paths keep it. If muting should be available earlier,
  dropping the predicate from that one policy is a one-line later migration
  and changes no other boundary.

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

- Not a function. Superseded by a direct RLS write in 202608280014.
- Purpose: hide a post from the caller's feed only.
- Path: insert `{user_id: <self>, post_id}` into `hidden_posts`, delete the
  same row to unhide. Primary key `(user_id, post_id)` makes a repeat hide
  a conflict rather than a duplicate.
- Auth: own-row select, insert, and delete. Insert also requires
  `is_community_member()` and `post_visible_to_viewer(post_id)`, so a member
  cannot seed a row for a post they were never allowed to see and use it as
  an existence oracle. No update grant, since the only meaningful edit is
  deleting the row.
- Side effects: feed_page filters these out, COMM-110.

### post_save(post_id uuid) returns boolean

- Not a function. Superseded by a direct RLS write in 202608280014.
- Purpose: toggle a personal bookmark.
- Path: insert or delete a `saved_posts` row, same shape and same policy set
  as `hidden_posts`. The client owns the toggle, the table has no state
  beyond the row existing.

### pr_share(record_id uuid, note text, media jsonb) returns uuid

- Purpose: create a POST_PR from a detected personal record.
- Auth: the record owner. Side effects: inserts a POST_PR, improvement is
  recomputed server-side from the record, not trusted from the client.

### community_profile(user_id uuid) returns community_profile_view

- Purpose: the profile community section, with each field filtered by
  `can_view_profile_field` against the caller.
- Auth: any member. A fully private target returns name, role, member since
  only.
- Client shape consumed by COMM-180 `renderCommunityProfileOverlay`. Every key
  is optional and an absent key means the field is hidden, so the client omits
  it rather than rendering a blank. Read keys: `first_name`, `last_name`,
  `display_name`, `handle`, `role`, `member_since`, `allow_follows`,
  `follower_count`, `following_count`, `training_frequency`, `current_streak`,
  `active_challenge` (`{title}` or a string), `recent_achievement` (`{title}`
  or a string), `recent_workouts` (`[{title|name, date|occurred_on}]`), `prs`
  (`[{movement|title, result|value}]`, a missing key hides the Progress tab,
  an empty array shows the no-PRs state), `achievements`
  (`[{title, badge_icon}]`, same missing versus empty rule), `posts` (an array
  of the card contract below).

## Client card contract (renderPostCard)

`window.renderPostCard(post)` is owned by posts (COMM-101) and consumed by
feed (COMM-110) and engagement (COMM-120 to 125). It returns an HTML string
for one feed card and never throws. `window.renderPostCardSkeleton()` returns
the loading placeholder.

Each `post` row the feed passes in carries:

- `id` text, `post_type` one of the twelve labels, `author_id` uuid or null
  for authorless system, new member, announcement and coach club posts.
- `author` `{display_name, handle, avatar_url}` when known. The legacy flat
  `display_name` and `handle` on the row are read as a fallback.
- `created_at` or `published_at` for the timestamp. `body` the caption or
  text, capped at 1000 on render. `visibility` one of club, friends,
  only_me, with public and followers read as legacy aliases.
- `media` `[{url | storage_path, alt_text, decorative, position, width,
  height}]`, up to 4. A `storage_path` with no `url` is resolved through the
  existing signed-url cache.
- `reaction_count` and `comment_count` integers. `reaction_count` falls back
  to the legacy `cheer_count`.
- `metadata` a per-type object. POST_WORKOUT: `workout_name`, `workout_date`,
  `result_text`, `score_type`, `effort` (rx, scaled, level), `level`,
  `is_pr`, `source_type`, `source_id`. POST_PR: `movement`, `new_result`,
  `previous_result`, `improvement`, `achieved_on`. POST_ACHIEVEMENT:
  `title`, `badge_icon`, `earned_on`, `explanation`. POST_CHALLENGE:
  `challenge_title`, `challenge_id`. POST_EVENT: `event_title`, `event_id`,
  `starts_at`. POST_ANNOUNCEMENT: `title`. POST_NEW_MEMBER: `member_id`,
  `member_name`, `joined_on`. POST_ATTENDANCE_MILESTONE: `milestone_label`,
  `count` (parked, never produced yet).

Markup feed and engagement can rely on:

- Root is `<article class="chart-card post-card" data-post-type="..."
  data-post-id="...">`. An unknown type adds `data-post-unknown="1"` and a
  failed render is `<article class="chart-card post-card"
  data-post-error="1">`.
- The engagement bar is `<div class="chip-row post-actions">` with
  `data-community-action="cheer"` and `data-community-action="toggle-comments"`
  each carrying `data-id="<post id>"`. POST_SYSTEM omits the bar entirely.
- The comment thread slot is the existing `renderComments(post)` output,
  appended inside the article, keyed on `state.openComments[post.id]`.
- The action menu trigger is `data-community-action="toggle-post-menu"` in the
  card head. Own post items: `post-edit-caption`, `post-change-visibility`,
  `post-delete`. Other: `post-save`, `post-hide`, `report`, `block`. `report`
  and `post-*` carry the post id, `block` carries the author id.
- `post_hide` and `post_save` are direct RLS writes to `hidden_posts` and
  `saved_posts` with the row shape `{user_id, post_id}`, toggled by presence.

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

### ach_claim(p_codes text[]) returns setof ach_claim_row

- Status: needed from schema, not built yet. See "Needs from schema,
  achievements" below. The client (COMM-130) is built against this signature
  and the mock registers it so tests pass.
- Purpose: record client-detected non-attendance milestones for the calling
  member. The offline app already computes session counts, summed PR counts,
  week streaks, first Rx, and membership tenure from data on the device. The
  browser cannot call `ach_evaluate` (service role only) and never emits a
  server event for a privately logged lift, so this is how those crossings
  reach `member_achievements`.
- Params: `p_codes` up to 50 `achievement_definitions.code` values. A null or
  empty array is a no-op that returns nothing. Over 50 raises.
- Returns: one `ach_claim_row(code text, member_achievement_id uuid,
  visibility text)` per row this call newly wrote, so the client celebrates
  only genuine new unlocks and stays silent on replay. A code that was
  already held (non-repeatable) or that did not qualify is simply absent from
  the result, never an error.
- Auth: security definer. Raises when `auth.uid()` is null. Requires
  `is_community_member()`. Every row is written with the caller's own
  `user_id`, never a value from the payload.
- Accepts a code only when its definition is `enabled`, its `trigger_type` is
  not `ATTENDANCE_RECORDED`, and its `config->>'client_claimable'` is
  `'true'`. Every other code in the array is ignored, not rejected. This is
  what keeps `community`, `challenge`, and `club` unlocks, which are gameable
  from the client, on the `ach_evaluate` event-bus path where the server owns
  the count.
- Side effects: inserts one `member_achievements` row per accepted, newly
  qualifying code, copying `visibility` from the definition. The partial
  unique index `member_achievements_once_idx` enforces once-per-non-repeatable
  under concurrency, so a lost race is swallowed, not surfaced. A repeatable
  definition writes a fresh row each call. Emits `ACHIEVEMENT_UNLOCKED`
  server-side per inserted row. Idempotent for non-repeatable codes.

## Needs from schema, achievements

Functions and data the achievements cluster (COMM-130 to COMM-134) calls or
relies on and that schema still owns. No migration is written here.

- `ach_claim(p_codes text[]) returns setof ach_claim_row` and the
  `ach_claim_row(code text, member_achievement_id uuid, visibility text)`
  composite type. Full behaviour above. Grant execute to `authenticated`.
  `ach_evaluate` and `ach_share` stay as already documented.
- The non-attendance seed rows for `achievement_definitions`. Content is in
  `docs/community/achievement-seed.md` as an `on conflict (code) do update`
  block. Every client-claimable row carries `config` key
  `client_claimable: true`. The four attendance rows from 202608280007 stay
  seeded and `enabled = false`, untouched.
- `ach_evaluate` should emit `ACHIEVEMENT_UNLOCKED` on the same server bus
  `ach_claim` uses, so the notifications consumer sees one shape regardless of
  which path unlocked the row.

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

### comment_edit(p_comment_id uuid, p_body text) returns void

- Shipped in 202608280016.
- Purpose: the only edit path for a comment body. `post_comments` has no
  UPDATE grant, which is what makes it the only one.
- Params: `p_body` trimmed to 1000 chars. An all-whitespace body raises.
- Auth: security definer, author only. It also re-checks
  `is_community_member()` and `is_posting_restricted()`, because otherwise
  rewriting an old comment into new content is the obvious way around a
  COMM-153 restriction. Rate limited at 30 per 10 minutes under the
  `comment_edit` action key.
- Side effects: always stamps `edited_at`, so an edit can never be silent.
  Refuses a comment that is already removed or soft-deleted.

### add_post_comment(p_post_id uuid, p_body text, p_parent_comment_id uuid) returns uuid

- Shipped in 202608280016. Three-argument form.
- Purpose: create a top-level comment or a reply, one write path.
- Params: `p_body` trimmed to 1000 chars, up from 280. A null
  `p_parent_comment_id` is a top-level comment.
- Auth: security definer. Requires `is_community_member()`, then refuses a
  member with an active posting restriction, then the existing rate limit of
  20 per 10 minutes, then `post_visible_to_viewer()`. The restriction check
  runs before the rate limit so a restricted member burns no budget and gets
  the accurate reason.
- Raises: `posting_restricted`, `rate_limited`, `reply depth is capped at
  2`, `parent comment is on another post`, `parent comment is no longer
  available`.
- Side effects: one `post_comments` row. Depth is checked here and again by
  the `post_comments_depth` trigger, so a future write path cannot skip it.

### add_post_comment(p_post_id uuid, p_body text) returns uuid

- Shipped in 202608270010, rewritten in 202608280005 and again in
  202608280016 as a wrapper passing a null parent. Kept so the current
  client keeps working while engagement wires the parent argument through
  COMM-121. It is a separate two-argument function rather than a default
  parameter on the three-argument one: a default would make the client's
  existing two-argument call ambiguous and fail at call time. Same pattern
  `redeem_invite_code` used in 202608280013.

- Note: comment create and delete keep the existing `addComment` and
  `deleteComment` client functions, `addComment` gains an optional
  `parentCommentId`. Reply depth cap 2 is enforced by the
  `post_comments_depth` trigger, not by a CHECK. `deleteComment` still hard
  deletes under the author-only `post_comments_delete_self` policy, which
  flattens replies to top level. Switching it to the soft path,
  `status = 'removed'` plus `deleted_at`, is COMM-122 client work and needs
  no further migration.

### Engagement client contract (renderComments and react), COMM-120 to 125

Finalised by engagement. Owned here, consumed by the posts card shell, which
appends `renderComments(post)` inside the article and exposes
`data-community-action="cheer"` and `"toggle-comments"` on `.post-actions`.

- `react(postId)` toggles the single `SUPPORT` reaction. The database keeps
  `reactions.kind = 'cheer'` and `toggle_reaction(p_post_id)` unchanged. The
  UI is optimistic: the reactor avatar strip and the count move before the
  server answers and roll back with a message on failure. On a successful
  add it emits `REACTION_CREATED` with `{ post_id }`. A removal emits
  nothing. The `react` feed interaction is still recorded by the card click,
  not by this function.
- `renderComments(post)` returns the reactor strip plus, when the thread is
  open, the comment list and composer. The strip is
  `<div class="reaction-strip">` with up to 5 `.avatar-badge` nodes and the
  total. It renders whenever `reaction_count > 0` or the thread is open, so
  the card markup itself is never touched. A closed thread returns the strip
  alone, or an empty string when there is nothing to show.
- A coach or head_coach comment carries `<span class="coach-badge">` with
  the role label, the wrapper class `comment-coach`, and a tinted
  inline-start border. The role is read from `invite_redemptions.role` for
  each author, never guessed.
- Replies render one indent level under a `data-community-action=
  "toggle-replies"` control. A reply carries no reply affordance. A reply
  whose `parent_comment_id` is absent from the returned page renders a
  "comment removed" placeholder parent. A blocked author's comment renders a
  neutral "comment hidden" placeholder, and a blocked reactor is dropped
  from the strip. Block state is `state.blockedIds`, loaded on session start
  from `blocks` in both directions.
- Comment drafts live in `state.commentDrafts` keyed by
  `postId` or `postId:parentCommentId` and are cleared only after the server
  confirms the write. A failed create or edit keeps the draft and shows a
  `data-community-action="comment-retry"` control.
- Mentions: an `@` in the composer opens a member picker. A pick inserts the
  marker `@[Display Name](uuid)` into the draft. On send, each mention is
  checked with `can_view_profile_field(target, 'allow_mentions')`, which is
  also false across a block edge. A mention that fails the check is rewritten
  to plain `@Name` text before the write. The surviving mentions ride
  `COMMENT_CREATED` as `mentions: [{ user_id, name }]` (max 10), alongside
  `{ post_id, comment_id, parent_comment_id, author_id }`. There is no
  `comment_mentions` table in V1 and no client-reachable notification
  enqueue, so this event is the whole mention signal. notifications consumes
  `COMMENT_CREATED` and routes the immediate mention notification per
  COMM-142.

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

### notification_batch_window() returns interval

- Shipped in 202608280018. Immutable, returns 6 hours.
- Purpose: the batching window in one place, so the column default and a
  test assert against the same value and neither can drift. COMM-142 fixes
  it at 6 hours.
- Auth: security invoker, granted to authenticated so a test can read it.

### notif_queue_batched(p_user uuid, p_category text, p_type text, p_source_id uuid) returns void

- Shipped in 202608280018. `p_source_id` defaults to null.
- Purpose: add one item to a member's open batch for a category. Upserts on
  `(user_id, category)`, increments `pending_count`, and increments the
  per-type counter inside `pending`.
- Auth: security definer with no grant to anon or authenticated, so it is
  callable only from inside another server function or by the service role.
  It does not check `auth.uid()`, deliberately: it always acts on a member
  other than the actor, so a caller identity test would assert nothing. The
  missing grant is the boundary here.
- Side effects: an empty batch starts a fresh window. A batch that already
  holds something keeps its original `next_flush_at`, so a steady trickle
  cannot push the flush out forever.
- Raises: on an unknown category or a type that does not match the same
  pattern `notifications.type` uses.

### notif_batch_flushed(p_user uuid, p_category text) returns void

- Shipped in 202608280018.
- Purpose: called by the flusher after it has written the rolled-up
  `notifications` row. Zeroes the counters, stamps `last_flushed_at`, and
  arms the next window.
- Auth: same as `notif_queue_batched`, no grant to anon or authenticated.
- Side effects: idempotent. A second call on an already-empty batch changes
  nothing but `last_flushed_at`.

- Note: notifications are created only server-side, by triggers and event-bus
  consumers. There is no insert policy and no insert grant on the table.
  Batching state lives in `notification_batches`, shipped in 202608280018
  under COMM-142. It holds counters only, never notification content, has an
  own-row select policy and no write grant, and the flush routing itself is
  notifications agent work. `notification_preferences` is a direct RLS
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
- Side effects: sets content status, calls `mod_restrict_member` for a
  `restrict_temp` or `restrict_permanent` decision, calls `log_admin_action`
  with before and after.
- Note: `posting_restrictions` has no write grant, so `mod_review` cannot
  insert into it directly. It calls `mod_restrict_member` below, which
  writes its own audit row.

### mod_restrict_member(p_user uuid, p_type text, p_expires_at timestamptz, p_reason text, p_report_id uuid) returns uuid

- Shipped in 202608280015. `p_expires_at`, `p_reason`, and `p_report_id`
  default to null, empty string, and null.
- Purpose: the only way to create a posting restriction. Returns the new
  restriction id.
- Params: `p_type` is temporary or permanent. A temporary restriction needs
  `p_expires_at` in the future. A permanent one ignores any expiry passed
  rather than rejecting it, so a UI that always sends its date picker value
  cannot create a row the CHECK refuses. `p_reason` capped at 500 chars.
- Auth: security definer. Requires `community.member.restrict`. Refuses a
  self-restriction and a member with no live profile.
- Side effects: one `posting_restrictions` row plus one `admin_actions` row
  of type `member_restrict`, in the same transaction, so a failed log fails
  the restriction.

### mod_lift_restriction(p_restriction_id uuid, p_reason text) returns void

- Shipped in 202608280015. `p_reason` defaults to an empty string.
- Purpose: end a restriction early. Sets `lifted_at`, `lifted_by`, and
  `lift_reason` rather than deleting the row.
- Auth: security definer. Requires `community.member.restrict`.
- Side effects: one `admin_actions` row of type `member_unrestrict`.
  Idempotent, an already-lifted restriction returns without a second audit
  row.

### is_posting_restricted(p_user uuid) returns boolean

- Shipped in 202608280015. `p_user` defaults to null, which means the
  caller.
- Purpose: the predicate the post insert policy and `add_post_comment` are
  keyed to. True when the member has a restriction that is not lifted and
  either has no expiry or has not expired.
- Auth: security definer, false for a null caller. A caller asking about
  anybody but themselves is refused unless they hold
  `community.member.restrict` or `community.comment.moderate`, so this
  cannot become an "is member X in trouble" oracle for the whole club.
- Notes: expiry is evaluated at read time, not by a scheduled job, so a
  temporary restriction ends on its own with no cron and no backfill.

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

### pin_set(p_target_type text, p_target_id uuid, p_note text) returns void

- Shipped in 202608280017. `p_note` defaults to an empty string, capped at
  200 chars.
- Purpose: pin an item to the club home. `p_target_type` is announcement,
  challenge, event, or post.
- Auth: security definer. Requires `community.content.pin`.
- Raises: `pin_limit_reached` when all three slots are taken, and `pin
  target not found or not pinnable` when the target does not exist, is
  deleted, is a removed post, a cancelled event, or an archived challenge.
- Side effects: one `pins` row in the lowest free slot, plus one
  `admin_actions` row of type `content_pin`. Idempotent, pinning something
  already pinned returns without a second row or a second audit entry.
- Notes: the cap is the unique `(club_id, slot)` with `slot` bounded to 0
  through 2, so it holds under concurrency. `pin_set` takes a transaction
  advisory lock while choosing a slot only so a race surfaces
  `pin_limit_reached` instead of a raw unique violation.

### pin_clear(p_target_type text, p_target_id uuid) returns void

- Shipped in 202608280017.
- Auth: security definer. Requires `community.content.pin`.
- Side effects: deletes the `pins` row and writes an `admin_actions` row of
  type `content_unpin`. Unpinning something already unpinned is a no-op, not
  an error.
- Notes: a target that is deleted, removed, cancelled, or archived is
  unpinned automatically by the `unpin_target()` triggers on
  `workout_posts`, `announcements`, `events`, and `challenges`. Those
  deletes are not audited, because the action that caused them is already in
  the log.

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
