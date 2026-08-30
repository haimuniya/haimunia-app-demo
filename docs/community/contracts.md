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

## Phase 1 schema notes, continued

Landed by schema in 202608280020 through 202608280022, the RPCs the Phase 1
client was already built against.

- `ach_claim` is the only client-reachable way to write
  `member_achievements`, and what keeps it honest is the definition row, not
  the caller. Anything gameable from a browser is seeded
  `client_claimable: false` and stays on the `ach_evaluate` path — except
  tenure, which is seeded `client_claimable: true` but independently
  reverified server-side (202608290002) because it is derivable from
  `invite_redemptions.redeemed_at` rather than genuinely client-only. See
  `ach_claim` below.
- `comment_mentions` is a select-only table for the mentioned member and the
  comment author. A third member cannot enumerate who was tagged in a
  thread. Only the four-argument `add_post_comment` writes it.
- The mention marker in a comment body, `@[Display Name](uuid)`, is never
  parsed server-side. Parsing it would make the mention list editable
  through `comment_edit`, which is exactly the "rewrite an old comment into
  a new ping" path the posting restriction closes elsewhere.
- `post_comments.deleted_by` is what lets self-delete and moderator removal
  coexist on the same two columns. `comment_delete` stamps the author,
  `comment_moderate` will stamp the moderator, and neither overwrites the
  other because both return early on an already-removed comment.
- `post_media.decorative` plus the `post_media_normalize_alt` trigger make
  "decorative" and "has alt text" impossible to disagree in one row. A
  decorative item stores a null `alt_text`, and a whitespace-only alt text
  is stored as null so "no alt on a non-decorative image" is one queryable
  state.
- `feed_page` still builds its media objects without `decorative`. Nothing
  renders differently, because the client blanks `alt_text` for a decorative
  photo before it is stored, so the alt attribute is empty either way. The
  key is added the next time that function is re-created.

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

## Needs from schema, feed (Phase 2)

Functions the Phase 2 feed cluster (COMM-210 to COMM-212, COMM-232) needs and
that schema still owns.

- `feed_leaderboard(p_mode text, p_challenge_id uuid, p_scope text, p_limit
  int) returns setof leaderboard_row` where `leaderboard_row` is `(user_id
  uuid, display_name text, handle text, avatar_url text, rank integer, value
  numeric, is_self boolean)`. `p_mode` is `consistency` or `progress`.
  `consistency` ranks club members by the same current-streak computation
  `community_profile` already exposes (consecutive ISO weeks with a logged
  session), club-wide, `p_challenge_id` ignored. `progress` ranks
  `challenge_participants.progress_value` for one `p_challenge_id`, which is
  required for that mode and raises when missing. `p_scope` is `club` or
  `friends`; `friends` restricts the ranked set to `are_friends()` edges with
  the caller, always including the caller's own row. Every ranked member must
  pass `can_view_profile_field(member, 'in_leaderboards')` and
  `can_view_profile_field(member, 'visible_to_club')`; a block edge in either
  direction excludes the row. The caller's own row is always returned even
  when it falls outside `p_limit` (capped at 100), appended last with its
  real `rank`, so "where do I stand" never needs a second call. "Hide my
  result" (COMM-212) is a client-only render choice, not a query parameter:
  the function always returns the caller's row, the client chooses not to
  draw it.
- `people_suggestions(p_limit int default 10) returns setof jsonb` (COMM-232).
  Ranks candidate members by, in order: shared active challenge
  participation, `feed_interactions` on the same posts (comment or react),
  shared `event_attendees` with response `going` on the same event, over a
  trailing 60-day window. Excludes existing follow edges (either direction),
  block edges (either direction), and the caller. Each candidate must pass
  `can_view_profile_field(candidate, 'visible_to_club')` and
  `can_view_profile_field(candidate, 'allow_follows')`. This is the
  non-attendance fallback: COMM-302 and COMM-307 (Phase 3) add a
  recurring-classmate score from verified attendance to the same ranking,
  behind the same function name, so the client slot does not change.

## Posts

### post_create(body text, visibility post_visibility, media jsonb, links jsonb) returns uuid

- Shipped in 202608280023. The client (COMM-102, COMM-103) calls it with all
  four params by name (`body`, `visibility`, `media`, `links`), so the
  signature has no defaults.
- Purpose: create a POST_TEXT or POST_PHOTO post with optional media and
  source links, one consistent write path.
- Params: `body` control chars stripped (tab and newline kept), trimmed, then
  capped at 1000. `visibility` a `post_visibility` label, defaulting to `club`
  when null. `media` up to 4 {storage_path, alt_text, decorative, position,
  width, height}; over 4 raises, an item with no `storage_path` raises.
  `decorative` is passed straight through to `post_media.decorative`
  (202608280022); the `post_media_normalize_alt` trigger owns the alt-text
  rule, so the function does not reconcile a decorative item that still
  carries alt text, and `position` defaults to the array index. `links`
  optional {workout_id, achievement_id, event_id}; the present keys are merged
  into `metadata` as top-level ids.
- `post_type` is `POST_PHOTO` only when there is media and no text, otherwise
  `POST_TEXT`, matching the client's optimistic rule.
- Returns: the new post id.
- Auth: security definer. Raises `not authorized` for a null caller or one
  without `community.post.create`, `recovery method required` when not
  `is_community_member()`, `posting_restricted` under an active restriction,
  `rate_limited` past 20 calls per 10 minutes under the `post_create` key.
  Empty body with no media raises.
- Side effects: one `workout_posts` row plus one `post_media` row per media
  item, in one transaction. `POST_CREATED` is emitted by the client after this
  returns (there is no server event bus), the same way `COMMENT_CREATED` and
  `REACTION_CREATED` are.

### post_set_visibility(post_id uuid, visibility post_visibility) returns void

- Auth: author only. Side effects: updates visibility, re-evaluates who can
  see it.

### post_edit_caption(post_id uuid, body text) returns void

- Auth: author only. Updates `body` only. `body` up to 1000 chars.

### post_delete(post_id uuid) returns void

- Shipped in 202608280025. The client's own-post menu (COMM-108) and
  `mod_review`'s `remove` decision both call it.
- Auth: security definer. The author always. A moderator when they hold
  `community.post.delete_any` OR `community.comment.moderate` OR real
  `is_admin`. The `community.comment.moderate` branch is wider than the
  original "author or `community.post.delete_any`" line, on purpose: every
  queue action routes through `mod_review`, so a coach who can see a reported
  post has to be able to remove it.
- Side effects: sets `deleted_at` and status `removed`. Idempotent on an
  already-removed post. A moderator removal writes one `content_delete`
  `admin_actions` row; an author removing their own post writes none.

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

### community_profile(user_id uuid) returns jsonb

- Shipped in 202608280022. A function, not a view: it has to answer per
  caller. The argument is named `user_id`, not `p_user_id`, because
  PostgREST matches RPC arguments by name and the client already calls
  `rpc("community_profile", { user_id })`.
- Purpose: the profile community section in one call, with each field
  filtered by `can_view_profile_field` against the caller.
- Auth: security definer, raises `not authorized` when `auth.uid()` is null
  and when a block edge sits in either direction, raises `profile not found`
  for a deleted or unknown target. Definer buys exactly one thing: a target
  with `visible_to_club` off is not selectable through
  `profiles_read_authenticated`, and the contract still says a fully private
  member returns name, role, and member since.
- Returns one jsonb object. Every key past the header is optional and an
  absent key means the field is hidden, so the client omits it rather than
  rendering a blank.
- Always present: `id`, `display_name`, `handle`, `avatar_url`, `role`,
  `member_since`, `allow_follows`. `role` and `member_since` come from the
  first `invite_redemptions` row, falling back to `profiles.created_at`.
  `allow_follows` is false on your own profile so the overlay does not offer
  a Follow button pointed at yourself. `first_name` and `last_name` stay in
  the client contract but are never returned: `profiles` has no such
  columns, and the client already falls back to `display_name` then
  `handle`.
- Present only when `visible_to_club` passes: `follower_count`,
  `following_count`, `active_challenge` (`{id, title, ends_at}`, omitted
  when there is none), `posts`.
- Present only when `show_workout_results` passes: `training_frequency` (a
  display string, sessions per week over the last 28 days, omitted at zero),
  `current_streak` (consecutive ISO weeks with a logged session, counted the
  same way the consistency achievements count it, and a week not yet trained
  does not break it), `recent_workouts` (`[{title, date}]`, up to 5).
- Present only when `show_prs` passes: `prs` (`[{movement, result,
  achieved_on}]`, up to 20). A missing key hides the Progress tab, an empty
  array shows the no-PRs state.
- Present only when `show_achievements` passes: `achievements`
  (`[{title, badge_icon, code, unlocked_at}]`, up to 24) and
  `recent_achievement` (`{title, badge_icon}`, omitted when the list is
  empty). The per-unlock `visibility` column is applied on top of the
  toggle, the same three-way rule `member_achievements_read` spells out.
- `posts` is up to 10 card-contract rows for the target, each still passing
  `post_visible_to_viewer`, so an only_me or friends post never reaches a
  viewer the author did not choose. `result_text` and the numeric
  `metadata` keys are stripped when `show_workout_results` is off, the same
  way `feed_page` strips them.
- Every number is derived from posts the member published, not from
  attendance, which has no source yet (COMM-P03). A member who trains and
  never posts reads as zero here.

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

- Shipped in 202608280020, with the composite type
  `public.ach_claim_row(code text, member_achievement_id uuid, visibility
  text)`. Execute granted to `authenticated`.
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
  `user_id`, never a value from the payload. Rate limited at 30 calls per 10
  minutes under the `ach_claim` action key, which raises `rate_limited`. The
  limit exists because a repeatable client-claimable definition would
  otherwise be an unbounded insert loop.
- Accepts a code only when its definition is `enabled`, its `trigger_type` is
  not `ATTENDANCE_RECORDED`, and its `config->>'client_claimable'` is
  `'true'`. Every other code in the array is ignored, not rejected. This is
  what keeps `community` and `challenge` unlocks, and most `club` unlocks,
  which are gameable from the client, on the `ach_evaluate` event-bus path
  where the server owns the count.
- Tenure verification (202608290002): the four club-category
  `anniversary_year_*` rows are the one exception, seeded
  `client_claimable: true` and `config->>'metric' = 'tenure_days'` because,
  unlike session count, PR count, week streak, or Rx count, membership
  tenure is not something only the device can see — it is a pure function of
  `public.invite_redemptions.redeemed_at`, a server-set timestamp
  (`default now()` at redemption, never client-writable). For any accepted
  code whose `config->>'metric' = 'tenure_days'`, `ach_claim` independently
  requires `invite_redemptions.redeemed_at <= now() - (threshold || '
  days')::interval` for the calling user before it is accepted; a claim
  short of the threshold is silently absent from the result, same as any
  other refused code, never an error. The boundary is inclusive: a
  redemption exactly `threshold` days old already qualifies. This check is
  keyed on `config->>'metric'`, not on the code, so any future
  `tenure_days`-metered definition is covered automatically with no further
  migration. Every other `client_claimable` metric is unaffected — the added
  condition is an `or` that short-circuits true when `metric` is not
  `'tenure_days'`.
- Side effects: inserts one `member_achievements` row per accepted, newly
  qualifying code, copying `visibility` from the definition. The partial
  unique index `member_achievements_once_idx` enforces once-per-non-repeatable
  under concurrency, so a lost race is swallowed, not surfaced. A repeatable
  definition writes a fresh row each call. Idempotent for non-repeatable
  codes.
- It does not emit `ACHIEVEMENT_UNLOCKED` itself. Both unlock paths write one
  `member_achievements` row, so the single place that sees every unlock is an
  AFTER INSERT trigger on that table. See "Needs from schema, achievements".

### achievement_definitions seed

- Shipped in 202608280020. The 27 non-attendance rows from
  `docs/community/achievement-seed.md`, inserted as `on conflict (code) do
  update` so a re-run converges. Every client-claimable row carries `config`
  key `client_claimable: true`. The four attendance rows from 202608280007
  are not repeated and stay `enabled = false` until COMM-P03.

## Needs from schema, achievements

Functions the achievements cluster (COMM-130 to COMM-134) relies on and that
schema still owns. No migration is written here.

- `ach_evaluate(user_id uuid, trigger text, payload jsonb)`, the service-role
  event-bus path. Not built. Everything community, challenge, and club shaped
  in the seed is `client_claimable: false` and unlocks only through it, so
  those rows cannot be earned at all until it lands.
- The `ACHIEVEMENT_UNLOCKED` consumer is an AFTER INSERT trigger on
  `public.member_achievements`, not a per-function emit. That way `ach_claim`
  and `ach_evaluate` produce one shape and neither can forget to fire. It
  needs `notif_create`, which notifications still owns, so it lands with that
  function. See "Needs from schema, notifications".

## Challenges

Landed by schema in 202608290003 through 202608290006, closing "Needs from
schema, challenges" below for COMM-201 to COMM-208. `challenges`,
`challenge_teams`, `challenge_participants`, and `challenge_progress`
themselves, and their direct-RLS create/edit/join/leave paths, still date to
202608280009 (COMM-006) - nothing here changes that grant shape. What
follows is the read shape and the write paths RLS could not express as a
plain own-row policy.

### challenge_progress_view composite type

Shipped in 202608290003. `(challenge_id uuid, challenge_type text, title
text, ends_at timestamptz, my_progress numeric, my_status text, target_value
numeric, participant_count integer, club_total numeric, team_totals jsonb,
leaderboard jsonb)`. A field that does not apply to the challenge's type is
null, never zeroed, so the client can tell "not applicable" from "genuinely
zero" (an empty cooperative pool is `club_total = 0`; a non-cooperative
challenge is `club_total = null`).

- `club_total` populated only for `cooperative`: the sum of every
  `challenge_progress.delta` row on the challenge, not `challenge_participants
  .progress_value`, so a departed member's earlier contributions stay in the
  aggregate (COMM-203).
- `team_totals` populated only for `team`: `[{team_id, name, total}]`, one
  entry per `challenge_teams` row, `total` summed from
  `challenge_progress.delta` grouped by `challenge_progress.team_id` - see
  the new column below, not from the live `challenge_participants.team_id`,
  for the same "a departed member's history should not vanish" reason
  COMM-204 states explicitly for team totals. Sorted by team name.
- `leaderboard` populated only for `individual_performance` and `coach`: top
  20 `challenge_participants` by `progress_value` descending, each entry
  filtered by `can_view_profile_field(member, 'in_leaderboards')` and a block
  edge in either direction with the caller, same privacy predicate the
  Phase 2 feed leaderboard is specified to use. Shape assumption, flagged
  because `feed_leaderboard` (COMM-210/211/212) is not built yet at the time
  this landed, still listed under "Needs from schema, feed (Phase 2)": each
  element is `{user_id, name, handle, avatar_url, value}` rather than
  `feed_leaderboard`'s richer `leaderboard_row` (which also carries `rank`
  and `is_self`). `name` falls back display_name -> handle, same as the feed
  card contract. If/when `feed_leaderboard` lands this can widen to match it
  without breaking a client reading the fields already here.
- `my_progress` / `my_status` are null, not zero/`'active'`, when the caller
  has no `challenge_participants` row for this challenge - a non-participant
  can still read every other field.
- `participant_count` counts `challenge_participants` rows with
  `status <> 'withdrawn'`.

### chal_progress(challenge_id uuid) returns challenge_progress_view

- Shipped in 202608290003. The documented-but-never-built Phase 1 stub, now
  real.
- Purpose: personal, team, and club progress for one challenge, one shape
  for every `challenge_type`, so COMM-207's detail view calls one function
  regardless of type.
- Auth: security definer, raises `not authorized` for a null caller and for
  a caller with no live role (`my_role_code() is null`) - this is the
  "club member" gate, deliberately looser than `is_community_member()`
  because this is a read and read paths are not gated behind the recovery
  write requirement. A `draft` challenge raises `challenge not found` for
  anyone but its creator or a `community.challenge.create` holder, matching
  `challenges_read`.
- Side effects: none.

### challenge_progress new columns (202608290003, 202608290005)

- `team_id uuid references challenge_teams(id) on delete set null`: snapshot
  of the contributor's `challenge_participants.team_id` at insert time,
  written by a BEFORE INSERT trigger (`challenge_progress_stamp_team`), not
  by the client. `challenge_progress` had no team_id of its own and
  `challenge_participants` rows are deleted on leave (COMM-006's existing
  leave policy), so without a snapshot a departed member's historical
  contributions would have no team to be attributed to once their
  participant row was gone. Once stamped it never changes, even if the
  member later switches teams while still active - append-only, same as
  every other column on this table.
- `note text`, capped at 500 chars, and `entered_by uuid references
  profiles(id) on delete set null`: COMM-206's coach entry form attaches a
  short note to a logged delta, and needs to say who logged it (the coach)
  separately from who it is for (`user_id`, the participant). A self-insert
  under `challenge_progress_insert_self` must leave `entered_by` null - that
  policy (drop-and-recreate of the 202608280009 one) now checks
  `entered_by is null` in addition to its original three predicates, so only
  `chal_record_progress` (below), which runs past this policy entirely, can
  ever set it. Without that check a self-insert could otherwise forge
  `entered_by` to any uuid and the column would stop reliably meaning
  "a coach logged this on my behalf."

### challenge_progress_apply trigger (AFTER INSERT on challenge_progress)

- Shipped in 202608290004.
- Purpose: the client's insert grant on `challenge_progress` (COMM-006) is
  append-only and never touches `challenge_participants.progress_value` -
  the running total is server-derived, not client-summed. This trigger adds
  `NEW.delta` to the matching participant row's `progress_value` and, for
  `individual_target` and `individual_performance` challenges only, flips
  `status` to `completed` and stamps `completed_at` the first time the new
  total reaches `target_value`. It never lowers a completed status back to
  active on a later negative correction: the flip only ever fires from a
  not-yet-completed row, so once set, status is left exactly as it was on
  every later insert, matching the append-only "correct with a compensating
  delta" model 202608280009 already documents for the table. `consistency`
  and `team` are not in the auto-complete list - COMM-205's week-tracking
  and COMM-204's per-team totals do not ask for it, and my_status there stays
  whatever the participant row already carries.
- Auth: security definer (bypasses `challenge_participants_update_self` and
  `posts_insert_self`, both on purpose - see the milestone post below).
- Side effects, cooperative only: recomputes `club_total`
  (`sum(challenge_progress.delta)` for the challenge) and, for each of
  25/50/75/100 whose percentage of `target_value` the new total newly
  reaches, posts one authorless milestone update the first time - see next.
  A single contribution that jumps past more than one threshold at once
  (for example 20% -> 80%) posts once for every newly-crossed threshold in
  that same transaction, not just the highest. A `select ... for update` on
  the `challenges` row at the top of the trigger serializes concurrent
  progress inserts on the same challenge, so two contributions landing at
  the same instant cannot both decide "not posted yet" and double-post.
- Cooperative milestone post, authorless-post pattern: no dedicated insert
  site for `POST_SYSTEM` or `POST_NEW_MEMBER` exists anywhere in the
  migration history to copy - grepping for both turns up only the enum
  labels and the 202608280004 comment saying `workout_posts.author_id` is
  nullable "for the authorless POST_SYSTEM and POST_NEW_MEMBER rows
  COMM-107 renders." COMM-107 was never built as a server insert. The
  nearest real precedent is `post_create` (202608280023): SECURITY DEFINER,
  inserting into `workout_posts` directly past `posts_insert_self` because
  that policy requires `author_id = auth.uid()` and a server-authored row
  has none. This trigger follows the same shape - SECURITY DEFINER, direct
  insert, `author_id = null`, `post_type = 'POST_CHALLENGE'` (already in the
  enum since 202608280004, no add-value-then-use split needed). "Already
  posted this threshold" is answered by querying `workout_posts` itself (a
  `POST_CHALLENGE` row already carrying that `challenge_id` and that
  `milestone` in its `metadata`) rather than a second piece of state that
  could drift from what was actually posted. `metadata` carries
  `challenge_id` and `challenge_title` (the two keys the POST_CHALLENGE
  client card contract already names) plus `milestone`, `club_total`, and
  `target_value`.

### chal_record_progress(p_challenge_id uuid, p_user_id uuid, p_delta numeric, p_note text) returns uuid

- Shipped in 202608290005.
- Purpose: the coach-entry path for a `coach` challenge type (COMM-206) -
  the only write path for progress a member did not log on their own.
  `challenge_progress_insert_self` only ever allows `user_id = auth.uid()`,
  so this is a security definer function, the same reasoning
  `add_post_comment` uses over a plain own-row policy.
- Auth: security definer. Raises `not authorized` for a null caller or one
  without `community.challenge.create`, `challenge and target participant
  are required` for a null id, `delta is required` for a null delta,
  `not an active participant` when `p_user_id` has no `challenge_participants`
  row on `p_challenge_id` with `status = 'active'`. No `check_rate_limit`
  call - matches the other permission-gated staff functions in this history
  (`pin_set`, `mod_restrict_member`, `mod_review`), none of which rate-limit
  on top of their permission check, and `challenge_progress_insert_self`
  itself has never been rate limited either.
- Side effects: one `challenge_progress` row, `source_type = 'coach_entry'`,
  `note` trimmed and capped at 500 chars (empty string stored as null),
  `entered_by` the calling coach. `challenge_progress_apply` and
  `challenge_progress_stamp_team` both still fire on this insert exactly as
  they do on a self-insert.

### challenges.ending_soon_notified_at timestamptz + chal_notify_ending_soon() returns integer

- Shipped in 202608290006.
- Purpose: `challenge_ending_soon`, sent once per challenge (not once per
  participant) to every joined active participant.
- Auth: security definer, same shape as `notif_batch_flush_due`: **grant
  execute to `service_role` only**, revoked from public, anon, and
  authenticated.
- Selects `challenges` where `status = 'active'`, `ending_soon_notified_at`
  is null, and `end_at` is between now and 48 hours from now. For each,
  calls `notif_create(participant, 'challenge_ending_soon', 'challenges',
  ..., 'challenge', challenge_id, '/community/boards?challenge=<id>')` for
  every `challenge_participants` row with `status = 'active'`, then stamps
  `ending_soon_notified_at`. Returns the count of `notifications` rows
  actually written (some may be suppressed by `notif_create`'s own filters).
  A second call after the column is stamped selects nothing for that
  challenge and writes nothing - this is what keeps the send to "at most
  once per `(challenge_id, user_id)` pair" without a per-user flag, per
  COMM-208's validation rule.
- SCHEDULER is not built here, same open item as the notification batch
  flusher: needs a `pg_cron` entry or a scheduled Edge Function once one
  exists for either. Until then `chal_notify_ending_soon()` has to be called
  by hand or from a one-off script.

### notif_on_challenge_join (AFTER INSERT on challenge_participants)

- Shipped in 202608290006.
- `notif_queue_batched(other, 'challenges', 'challenge_update',
  challenge_id)` for every other `challenge_participants` row on the same
  challenge with `status = 'active'`, guarded by `notif_blocked_between` and
  `notif_pref_allows(..., 'challenge_update')` - the same two checks
  `notif_on_reaction` uses before it enqueues. Never immediate. The joiner
  never receives a row about their own join, because the fan-out query
  excludes `cp.user_id = new.user_id`.

### notif_on_challenge_complete (AFTER UPDATE OF status on challenge_participants)

- Shipped in 202608290006. Same batched `challenge_update` fan-out to every
  other active participant, fired on the transition into `completed`.
- The trigger declaration fires on any UPDATE that includes `status` in its
  SET list, which `challenge_progress_apply`'s UPDATE always does even when
  the value does not actually change - so the function itself re-checks
  `new.status = 'completed' and old.status <> 'completed'` before doing
  anything, rather than relying on the trigger firing only on a real
  transition. The completer is excluded from the fan-out the same way the
  join trigger excludes the joiner (`cp.user_id <> new.user_id`) - they get
  a client-side celebration, never a notification about their own
  completion.

## Needs from schema, challenges

Closed. See "## Challenges" above.

## Events

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

### AFTER UPDATE OF status on public.events - notif_on_event_cancelled()

- Shipped in 202608290009 (COMM-214). Definer, no grant to any client role.
  Trigger name `events_notify_cancelled`.
- Purpose: an event that gets cancelled tells the members who were going.
- Fires on the transition into `cancelled` only. As with
  `notif_on_challenge_complete`, `AFTER UPDATE OF status` fires on any
  UPDATE whose SET list mentions `status`, including one that writes the
  same value back, so the function re-checks `new.status = 'cancelled' and
  old.status <> 'cancelled'` itself and returns early otherwise.
- Recipients: every `event_attendees` row on the event with `response` in
  `going` or `interested`. A `not_going` RSVP is an opt-out and is never
  notified. A draft event needs no special case - it can have no attendees,
  so the loop is empty.
- `notif_create(<attendee>, 'event_cancelled', 'events', 'Event cancelled',
  <events.title>, 'event', <events.id>, '/community/feed?event=<id>')` per
  recipient. Immediate per the routing table, never batched.
- Because delivery goes through `notif_create`, the block edge, the `off`
  preference, the never-notify-the-actor rule, and the dedupe window are
  applied there and are not duplicated in the trigger: the staff member who
  cancelled is the actor and so never notifies themselves even when they
  hold a `going` RSVP; an attendee on either side of a block edge with the
  canceller is skipped; and the dedupe key (recipient, `event_cancelled`,
  event id) makes a cancel -> republish -> cancel inside
  `notif_dedupe_window()` one cancellation rather than two.
- Also in 202608290009: `notif_pref_key` gains one arm, `event_cancelled`
  -> `events`. See its entry below.

## Needs from schema, events

Functions and columns the Phase 2 events cluster (COMM-213 to COMM-217)
needs and that schema still owns. `events` and `event_attendees` themselves,
`event_rsvp`, and the capacity/deadline trigger all shipped in 202608280010
(COMM-007). Creating, editing, and cancelling an event are direct RLS writes
under the existing `community.event.manage`-gated policies, no new function.

- Closed. `notif_on_event_cancelled` shipped in 202608290009 and is
  documented under "## Events" above, with the `notif_pref_key` arm it
  needed. It was the only schema change this cluster asked for; the two
  items below were already "no schema change" and stay that way.
- Event comments (COMM-216) need no new table: publishing an event creates
  one companion `POST_EVENT` `workout_posts` row via `post_create` with
  `links.event_id`, and the event detail's comment thread is that post's
  `post_comments`, reusing `add_post_comment` and every engagement rule
  (COMM-121 to COMM-125) unchanged. This is a client-side design decision by
  the events agent, not a schema change, recorded here so it does not drift:
  `events` gets no `post_id` column, the link travels through
  `workout_posts.metadata->>'event_id'` the same way `post_create`'s `links`
  parameter already stores `event_id` today.
- Add to Calendar (COMM-215) is a client-only `.ics` file built from fields
  already on the `events` row. No schema change.

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

### add_post_comment(p_post_id uuid, p_body text, p_parent_comment_id uuid, p_mentions uuid[]) returns uuid

- Shipped in 202608280021. Four-argument form, the one the mention path uses.
- Purpose: create a comment or reply and record its accepted mentions in the
  same transaction.
- Params: the first three are the three-argument form, unchanged. `p_mentions`
  is up to 10 user ids. Null or empty is the same call as the three-argument
  form. Over 10 raises `at most 10 mentions per comment`, checked before the
  comment row is written, because a comment that mentions 40 members is a
  fan-out, not a mention.
- Auth: security definer. It delegates the whole create path to the
  three-argument function, so the recovery gate, the posting restriction, the
  rate limit, the visibility check, and the depth cap are checked in one
  place and cannot drift between signatures.
- Each target is de-duplicated, the caller's own id is dropped, and each
  remaining id must be a live profile and pass
  `can_view_profile_field(target, 'allow_mentions')`, which is already false
  across a block edge. A target that fails is skipped, not raised: the client
  has already rewritten those to plain text, so a raise would turn "your
  mention did not go through" into "your comment did not go through".
- Side effects: one `post_comments` row plus one `comment_mentions` row per
  accepted target.

### comment_delete(p_comment_id uuid) returns void

- Shipped in 202608280021.
- Purpose: the soft self-delete path. Sets `status = 'removed'`,
  `deleted_at = now()`, and `deleted_by = auth.uid()`.
- Auth: security definer, author only. Deliberately carries no
  `is_community_member()` and no `is_posting_restricted()` gate: removing
  your own words is not a community write, and a restricted or not yet
  verified member must always be able to take their content down. Same
  reasoning `toggle_reaction` uses for removing your own reaction.
- Idempotent, and it does not re-stamp. A comment already removed by a
  moderator returns quietly and keeps its `deleted_by`, so the `admin_actions`
  row still points at a comment that agrees with it.
- It is a function rather than a narrow own-row UPDATE policy because a
  policy sees whole rows, not columns. An own-row UPDATE policy would also
  hand the author a second body-edit path that skips `comment_edit`'s
  restriction check and its mandatory `edited_at` stamp. `post_comments`
  still has no UPDATE grant, so `comment_edit` and `comment_delete` are the
  complete list of ways a comment can change.
- The hard-delete policy `post_comments_delete_self` is untouched, so the
  current `deleteComment` keeps working until the client switches over.

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
  flattens replies to top level. The soft path now exists server-side as
  `comment_delete(p_comment_id)`, shipped in 202608280021, so switching
  `deleteComment` to call it is client work and needs no further migration.

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
  `{ post_id, comment_id, parent_comment_id, author_id }`, and drive the
  client-side celebration and draft handling only.
- Superseded in part by 202608280021: the surviving mention ids are also
  sent as `p_mentions` on the four-argument `add_post_comment`, which
  re-checks each one with `can_view_profile_field(target, 'allow_mentions')`
  and writes a `comment_mentions` row per accepted target. That table, not
  the client event, is what the notification trigger reads, so the mention
  notification does not depend on the browser telling the truth. The bus
  event stays as it is and remains client-only.

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

### notif_create(p_user uuid, p_type text, p_category text, p_title text, p_body text, p_source_type text, p_source_id uuid, p_deep_link text) returns uuid

- Shipped in 202608280026. The one immediate-notification insert path into
  `public.notifications`, which has no insert grant. Called only from a
  trigger, another definer function, or the service role.
- Auth: security definer. **Grant execute to nothing** - revoked from
  public, anon, and authenticated. It reads `auth.uid()` only to identify
  the actor for the self-notify and block-edge filters, never as an
  identity gate, exactly as `notif_queue_batched` does: it always acts on a
  member other than the caller, so a caller check would assert nothing and
  the missing grant is the boundary. A null `auth.uid()` (service role,
  cron) skips both filters.
- Returns the new row id, or `NULL` when the row was suppressed by any of:
  - recipient equals the actor, except the self-directed types
    `achievement_unlocked` and `weekly_recap` whose whole purpose is the
    actor's own stream
  - a block edge in either direction between recipient and actor
  - the recipient has a `notification_preferences.channel = 'off'` row for
    the type's preference key AND the row is not operational
  - an identical `(user_id, type, source_id)` row already exists inside
    `notif_dedupe_window()` (COMM-143 "no duplicate notification for the
    same event"); the source id passed by the trigger set is the specific
    event row (a comment id, a member_achievement id), so this only ever
    absorbs one event fired twice, never two real events
- Truncates title to 160 and body to 500 to match the column CHECKs.
- Side effects: at most one `notifications` row. `club_id` defaults through
  `default_club_id()`.
- Also in 202608280026: re-creates `notifications_deep_link_check` from
  202608280008 with a `{0,255}` regex bound instead of `{0,300}`. A
  Postgres regex repetition bound may not exceed 255, so the original
  constraint raised `invalid repetition count(s)` on every insert with a
  non-null `deep_link`. Nothing had ever written one before this run.

### notif_dedupe_window() returns interval

- Shipped in 202608280026. Immutable, returns `1 hour`. Granted to
  `authenticated` so a test asserts the same value the function uses.

### notif_pref_key / notif_pref_allows / notif_blocked_between / notif_is_operational

- Shipped in 202608280026 as internal helpers for `notif_create` and the
  trigger set. No grant to any client role.
- `notif_pref_key(p_type text) returns text` - maps a fine-grained
  `notifications.type` to the coarse `notification_preferences.type` key a
  settings screen shows. The mapping: `comment_reply` and `comment_on_post`
  and `comment_also` -> `comment_reply` / `comment_on_post` /
  `comment_on_post`; `mention` and `coach_mention` -> `mentions`;
  `reaction` -> `reactions`; `announcement` -> `announcements`;
  `friend_achievement` -> `friend_achievements`; `achievement_unlocked` ->
  `achievement_unlocked`; and, added in 202608290009, `event_cancelled` ->
  `events`. Anything else maps to itself.
- KNOWN DRIFT, do not treat this map as agreeing with the client yet. The
  client's preferences panel (`NOTIF_PREF_TYPES` in cloud.js) writes the
  coarse keys `comments`, `replies`, `mentions`, `reactions`,
  `achievements`, `friend_achievements`, `challenges`, `events`,
  `announcements`, `weekly_recap`. Only `mentions`, `reactions`,
  `friend_achievements`, `announcements`, and (since 202608290009) `events`
  line up. `comment_reply` maps to `comment_reply` where the client writes
  `replies`; `comment_on_post` / `comment_also` map to `comment_on_post`
  where the client writes `comments`; `achievement_unlocked` maps to itself
  where the client writes `achievements`; `challenge_ending_soon` and
  `challenge_update` fall through to themselves where the client writes
  `challenges`. For those five types an `off` toggle in the panel does not
  actually suppress delivery. 202608290009 fixed only `event_cancelled`,
  because that type had never been emitted before, so adding its arm could
  not change any shipped behaviour; re-keying the others changes live
  delivery for members who already set those toggles and belongs to the
  notifications cluster (COMM-218/219), with the matching client change.
- `notif_pref_allows(p_user uuid, p_type text) returns boolean` - false
  only when the user has an explicit `off` row on the mapped key. A missing
  row is `in_app`, i.e. allowed. The batched path checks this before
  `notif_queue_batched`, which reads no preferences itself.
- `notif_blocked_between(p_a uuid, p_b uuid) returns boolean` - a block
  edge in either direction; a null on either side is "no edge".
- `notif_is_operational(p_type text, p_source_id uuid) returns boolean` -
  true only for `announcement`, and, since 202608290010 (COMM-218/219), only
  when `announcements.priority in ('important', 'urgent')`. It read
  `announcements.important` up to that migration; because `important` is now
  kept as an exact mirror of `priority <> 'normal'`, the swap changed no
  existing row's answer. This is how an operational row overrides an `off`
  preference without adding a ninth parameter to `notif_create`.

### AFTER INSERT on public.post_comments - notif_on_comment()

- Shipped in 202608280027. Definer, no grant.
- Reply (`NEW.parent_comment_id` set, parent author `<> NEW.author_id`):
  `notif_create` for the parent author, type `comment_reply`, category
  `community`, deep link
  `/community/feed?post=<NEW.post_id>&comment=<NEW.parent_comment_id>`,
  source `comment` / `NEW.id`.
- Post author (when `<> NEW.author_id` and, on a reply, `<>` the parent
  author): `comment_on_post` immediate the first time that same commenter
  (`NEW.author_id`) comments on the post, otherwise
  `notif_queue_batched(post_author, 'community', 'comment_also',
  NEW.post_id)` guarded by `notif_blocked_between` and
  `notif_pref_allows(..., 'comment_also')`.
- Mentions are NOT handled here; see `notif_on_mention`.

### AFTER INSERT on public.comment_mentions - notif_on_mention()

- Shipped in 202608280027. Definer, no grant. One `notif_create` per row.
- Fires on `comment_mentions`, whose rows are written only by the
  four-argument `add_post_comment` after its own
  `can_view_profile_field(target, 'allow_mentions')` recheck. The client
  `COMMENT_CREATED` mention array is never read by any server path.
- Type `coach_mention` when the comment author holds `coach` or
  `head_coach` in `invite_redemptions.role`, else `mention`. Category
  `community`, deep link
  `/community/feed?post=<post_id>&comment=<comment_id>`. `notif_create`
  then applies the target's `mentions` preference and the block-edge
  filter.

### AFTER INSERT on public.reactions - notif_on_reaction()

- Shipped in 202608280027. Definer, no grant. Built from the row:
  `REACTION_CREATED` carries only `{ post_id }`.
- When the post `author_id <> NEW.user_id` and no block edge and the
  author's `reactions` preference is not `off`:
  `notif_queue_batched(author, 'community', 'reaction', NEW.post_id)`.
  Never immediate.

### AFTER INSERT / AFTER UPDATE OF priority, important on public.announcements - notif_on_announcement()

- Shipped in 202608280027 (`AFTER UPDATE OF important`), widened in
  202608290010 to `AFTER UPDATE OF priority, important` (COMM-218/219). Both
  columns are named, not just `priority`: `UPDATE OF <col>` matches the
  columns in the statement's SET clause, not the values a BEFORE trigger
  writes, so a legacy `update announcements set important = true` would
  never fire an `of priority` trigger even though
  `announcements_priority_sync` has just moved the row up a tier. The
  trigger body decides on `priority` either way.
- INSERT: `notif_announcement_fanout(NEW.id, false)` - loops every club
  member (a profile with an `invite_redemptions` row, not deleted, not the
  author) and calls `notif_create` with type `announcement`, category
  `club`, deep link `/community/feed?announcement=<id>`. A `normal`
  announcement reaches members whose `announcements` preference is not
  `off`; an `important` or `urgent` one is operational and reaches everyone
  because `notif_is_operational` returns true.
- UPDATE: fans out when `announcement_priority_rank(NEW.priority) >
  announcement_priority_rank(OLD.priority)`, i.e. on any upward move on
  `normal < important < urgent`, via `notif_announcement_fanout(NEW.id,
  true)`. A downgrade fans out to nobody. `normal -> important` and `normal
  -> urgent` (skipping the middle tier) both reach the members the INSERT
  pass deliberately skipped; `important -> urgent` reaches nobody, because
  at `important` the row was already operational and every member holds a
  row. Up to 202608290010 this branch was the single boolean flip `important
  false -> true`.
- `notif_announcement_fanout(p_id uuid, p_off_only boolean) returns void`
  is an internal definer helper, no grant; the signature is unchanged since
  202608280027. `p_off_only` targets ONLY members with an explicit
  `announcements = off` row. Since 202608290010 the loop also skips any
  member who already holds a `notification` row for this announcement
  (`type = 'announcement'`, matching `source_id`), whatever their
  preference, so "one row per member per announcement, however many times
  priority moves" (COMM-219) holds structurally rather than depending on
  `notif_dedupe_window()`; and it returns without notifying anyone when the
  announcement is already past its `expires_at`, since the deep link would
  open onto a row the read policy hides. On the INSERT pass the
  already-notified filter matches nothing, so first fan-out behaviour is
  unchanged. The whole-club loop is the fan-out cost the routing table
  flags; Phase 1 is one small club.

### BEFORE INSERT OR UPDATE on public.announcements - announcements_priority_sync()

- Shipped in 202608290010 (COMM-218). Internal trigger function, no grant to
  any client role, not security definer (it touches no table).
- Keeps `announcements.important` an exact mirror of `priority <> 'normal'`,
  in both directions, so the Phase 1 boolean stays readable AND writable and
  no other Phase 1 trigger, policy, or client build needs an edit. The
  contract allowed a generated column; a trigger mirror was chosen instead
  because `GENERATED ALWAYS` would turn every existing `insert into
  announcements (..., important)` and `update ... set important = true` into
  a hard error, and both spellings are live in the shipped pgTAP suite.
- Resolution, stated once: on INSERT a non-`normal` `priority` wins, else a
  true `important` is read as the `important` tier, else normal/false. On
  UPDATE, if `priority` changed it wins and `important` is recomputed from
  it; else if `important` changed, `priority` follows it (true ->
  `important`, false -> `normal`); else the pair is re-normalised, a no-op
  on a consistent row. `important = (priority <> 'normal')` is therefore an
  invariant of the table.

### announcement_priority_rank(p_priority text) returns integer

- Shipped in 202608290010. Purpose: the one definition of "upward" on the
  three tiers - `urgent` 2, `important` 1, anything else (including null) 0.
- Auth: pure, immutable, reads nothing. `revoke` from `public` and `anon`,
  `grant execute to authenticated`, so a client can order a badge list by
  the same rule the escalation trigger uses.
- Side effects: none.

### AFTER INSERT on public.member_achievements - notif_on_achievement()

- Shipped in 202608280027. Definer, no grant.
- DEVIATION from the brief's "server bus consumer" wording: run 2
  confirmed there is no server-side product-event bus in the repo
  (`ACHIEVEMENT_UNLOCKED`, like `POST_CREATED`, is a client-only emit). Per
  the brief's own fallback instruction, this is wired off an AFTER INSERT
  trigger on `member_achievements`, the same shape as `notif_on_reaction`.
  Both `ach_claim` and a future `ach_evaluate` write that row.
- Unlocker: `notif_create(NEW.user_id, 'achievement_unlocked', 'training',
  ...)`, deep link `/community/account/achievements?ma=<NEW.id>`.
  `achievement_unlocked` is a self-directed type so `notif_create` allows
  recipient == actor for it.
- Friend fan-out, only when the unlocker's profile has `visible_to_club`
  and `show_achievements` on and `NEW.visibility <> 'only_me'`: for each
  member in a mutual-follow edge with the unlocker (the `are_friends`
  definition, computed directly rather than via the caller-relative
  helper), with no block edge and `friend_achievements` not `off`:
  `notif_queue_batched(friend, 'training', 'friend_achievement', NEW.id)`.

### notif_batch_flush_due(p_limit integer default 500) returns integer

- Shipped in 202608280028. The batch flusher. Security definer, granted to
  `service_role` only (the `purge_due_accounts` pattern).
- Selects `notification_batches` where `next_flush_at <= now() and
  pending_count > 0`, ordered by `next_flush_at`, up to `p_limit` rows. For
  each, writes one `notifications` row per type in `pending`, keeping the
  batched type key as `notifications.type` so the client folds it as a
  batched group, then calls `notif_batch_flushed(user_id, category)`.
  Returns the count of `notifications` rows written.
- Title and body are composed from the per-type `count`. Deep link is
  `/community/feed?post=<last_source_id>` when that type is the only thing
  in the batch (`count = pending_count`) and it is `reaction` or
  `comment_also`; otherwise the category surface from
  `notif_category_surface`.
- This is the SECOND server-side insert path into `notifications`. It does
  NOT re-run the preference, block-edge, or de-dupe filters: every item was
  already filtered at enqueue time by the trigger that called
  `notif_queue_batched`, and a rolled-up row is by definition not a
  duplicate.
- SCHEDULER is infra, deliberately not built: pg_cron is not guaranteed in
  the CI stack. Wire it as a `cron.schedule('notif-batch-flush', '*/15 * *
  * *', $$select public.notif_batch_flush_due()$$)` entry once the
  extension is enabled, or a scheduled Edge Function calling it with the
  service role. Until then batched notifications accumulate in
  `notification_batches` undelivered.

### notif_category_surface(p_category text) returns text

- Shipped in 202608280028. Internal, no grant. Maps a `notifications`
  category to an in-app surface: `community` and `events` and `club` ->
  `/community/feed`, `training` -> `/community/account/achievements`,
  `challenges` -> `/community/boards`.

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

- Client contract, COMM-140 to 144. The client reads with `notif_list`,
  marks read with `notif_mark_read`, and reads the badge from
  `notif_unread_count`. It never selects `notifications` directly. It
  refreshes the badge on centre open, on app focus, and on a realtime
  own-row event on `notifications` filtered to `user_id=eq.<self>`
  (replication for that table is COMM-227, so the subscription is a no-op
  until then). `notification_preferences` is a direct own-row RLS upsert on
  `(user_id, type)` with `channel` in `push`, `in_app`, `off`; a missing
  row is `in_app`. `push` is disabled in the V1 client (`NOTIF_PUSH_ENABLED
  = false`) and a stored `push` is read as `in_app`. The client renders an
  immediate notification as its own row and folds a run of same-type
  batched rows into one collapsed group. It resolves `deep_link` (or
  `source_type`/`source_id` as a fallback) to a screen and item with the
  route convention below.

- Deep link route convention (client `resolveNotifTarget`). All routes are
  `^/[A-Za-z0-9_/?=&.%-]{0,300}$`, matching the `deep_link` CHECK:
  - `/community/feed?post=<post_id>&comment=<comment_id>` - a comment,
    reply, mention, or reaction. `comment` is optional.
  - `/community/account/achievements?ma=<member_achievement_id>` - an
    achievement unlock.
  - `/community/feed?announcement=<announcement_id>` - an announcement.
  - `/community/boards?challenge=<challenge_id>` - a challenge item.
  - `/community/account/profile?user=<user_id>` - a friend's achievement.
  - `/community/feed?event=<event_id>` - an event cancellation.
  A row with no `deep_link` falls back to `source_type` in `post`,
  `comment`, `achievement`, `announcement`, `challenge`, `event`,
  `profile` with `source_id`.

## Needs from schema, notifications

Shipped by schema in 202608280026 through 202608280028. The notifications
server side (COMM-140 to 144) is now fully backed: `notif_create`, the
`notif_dedupe_window` / `notif_pref_key` / `notif_pref_allows` /
`notif_blocked_between` / `notif_is_operational` helpers, the AFTER INSERT
trigger set (`notif_on_comment`, `notif_on_mention`, `notif_on_reaction`,
`notif_on_announcement` + `notif_announcement_fanout`,
`notif_on_achievement`), the `announcements.important` column (joined in
202608290010 by `announcements.priority`, which is now the source of truth
behind it), and the
batch flusher (`notif_batch_flush_due` + `notif_category_surface`) are all
documented under "## Notifications" above. `notif_list`, `notif_mark_read`,
`notif_unread_count`, `notif_queue_batched`, `notif_batch_flushed` and
`notification_batch_window` were already shipped (202608280008 /
202608280018). The routing table and the later-phase type list stay here
as reference.

Deviations from the run-3 brief, all reflected above:
- The `ACHIEVEMENT_UNLOCKED` path is an AFTER INSERT trigger on
  `member_achievements`, not a server-bus consumer, because run 2
  confirmed no server-side product-event bus exists. This is the fallback
  the brief itself specifies for that case.
- 202608280026 also re-creates `notifications_deep_link_check` (from
  202608280008) with a `{0,255}` regex bound: a Postgres repetition bound
  cannot exceed 255, so the original `{0,300}` raised `invalid repetition
  count(s)` on the first insert with a non-null `deep_link` - which this
  run is.
- Announcement escalation (normal -> important) notifies only the members
  with an explicit `announcements = off` row, so there is no double-notify
  window: the members who already got the row on insert are never in the
  escalation loop, and the `notif_dedupe_window` guard is a second line
  rather than the mechanism.
- The batch flusher SCHEDULER (pg_cron / Edge Function) is infra and is
  not built or enabled here; see the note on `notif_batch_flush_due`.

### The immediate / batched / never routing table

The single split, so the trigger set and the client `notifRoute()` agree.
`notification_batch_window()` is 6 hours.

- Immediate (its own `notifications` row, written now): `comment_reply`,
  `comment_on_post`, `mention`, `coach_mention`, `achievement_unlocked`,
  `announcement` (operational, always), `challenge_ending_soon` (joined
  participants only), `event_cancelled`.
- Batched (`notif_queue_batched`, rolled up by the flusher into one row per
  type per window): `reaction`, `comment_also`, `friend_achievement`,
  `challenge_update`, `feed_activity`, `weekly_recap`.
- Never generated: a notification per post, per workout, per leaderboard
  movement. No type exists for these and no trigger enqueues them.
- A `notification_preferences.channel = 'off'` row suppresses both the
  immediate insert and the batch enqueue, except `announcement` when the
  announcement is operational. A missing preference row is `in_app`.
- Every recipient is filtered by a block edge in either direction. The
  recipient is never the actor.

### Later-phase types, named for completeness

- `challenge_ending_soon` (immediate, joined participants only) and
  `challenge_update` (batched): COMM-208, Phase 2.
- `event_cancelled` (immediate): COMM-214, shipped in 202608290009. The
  only type whose `notif_pref_key` arm matches the client's panel key
  (`events`) on the server side today.
- `weekly_recap` (batched): the `recap_weekly` Edge Function (COMM-220)
  calls `notif_create(U, 'weekly_recap', 'club', ...)` once per user per
  week, deep link to the recap surface.
- `feed_activity` (batched): a catch-all, only ever enqueued, never
  immediate, never per-post.

## Needs from schema, notifications (Phase 2)

Trigger set and columns the Phase 2 notifications cluster (COMM-208,
COMM-214/215, COMM-218/219, COMM-229) needs and that schema still owns. The
Phase 1 trigger set (`notif_on_comment`, `notif_on_mention`,
`notif_on_reaction`, `notif_on_announcement`, `notif_on_achievement`) and
`notif_create` itself need no signature change; every item below is either a
new trigger of the same shape or a small predicate change inside an existing
one.

The challenges-specific part of this list (COMM-208) shipped in 202608290006:
`notif_on_challenge_join`, `notif_on_challenge_complete`, and
`chal_notify_ending_soon()` plus `challenges.ending_soon_notified_at` are
documented under "## Challenges" above, not here.

- `notif_on_event_cancelled`: immediate `event_cancelled`. Shipped in
  202608290009 along with the `event_cancelled` -> `events` arm of
  `notif_pref_key`; documented under "## Events" above, not here.
- `notif_is_operational` widening to `announcements.priority in
  ('important', 'urgent')`, the widened AFTER UPDATE trigger, and the
  three-tier re-fan-out logic (COMM-218, COMM-219) all shipped in
  202608290010 and are documented under "## Notifications" above, not here:
  see `notif_pref_key / notif_pref_allows / notif_blocked_between /
  notif_is_operational`, `AFTER INSERT / AFTER UPDATE OF priority, important
  on public.announcements`, `BEFORE INSERT OR UPDATE on
  public.announcements`, and `announcement_priority_rank`. One deviation
  from the wording of this list, deliberate and covered there: the trigger's
  column list is `OF priority, important`, both columns rather than
  `priority` alone, because `UPDATE OF` matches the statement's SET clause
  and a legacy `set important = true` would otherwise stop firing. See
  "Needs from schema, admin-moderation (Phase 2)" for the column migration.
- COMM-219 needed no `notification_preferences` change and none was made:
  the ticket is explicit that the coarse `announcements` key from COMM-144
  is the only preference row involved, that the urgent path routes through
  the same `notif_create` immediate path rather than a second mechanism, and
  that the preferences panel gains no new row. The urgent "bypass" of a
  member's `off` row is `notif_is_operational` answering true, which is the
  Phase 1 mechanism unchanged.
- `notif_push_send`: NOT built here. The actual Web Push send (calling the
  Web Push protocol with VAPID keys against every unrevoked
  `push_subscriptions` row for a notification's recipient) is a service-role
  Edge Function or scheduled job, the same "storage exists, delivery
  scheduler does not" gap already logged for `notif_batch_flush_due`.
  COMM-229 wires subscription storage (existing table, no change) and the
  `sw.js` client handler only; sending a real push waits on VAPID key
  provisioning, confirmed but not yet available at authoring time.

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

### report(p_target_type text, p_target_id uuid, p_reason text, p_note text) returns void

- Shipped in 202608280025. Supersedes `submit_report(p_post_id, p_reason)`,
  which stays as a thin wrapper. The client calls this by name with all four
  params, so the signature has no defaults.
- Purpose: file a report on a post or comment.
- Params: `p_target_type` `post` or `comment`, an unknown value raises.
  `p_reason` one of harassment, spam, inappropriate, privacy, unsafe_advice,
  other, an unknown value raises. `p_note` trimmed to 500 chars, may be empty,
  stored in `reports.details`.
- Auth: security definer, requires `is_community_member()`. Rate limited at 10
  per 10 minutes under the `report` key. Grant execute to `authenticated`.
- Side effects: one `reports` row. For a `post` target `post_id` is set equal
  to `target_id`; a `comment` target leaves `post_id` null. A duplicate by the
  same reporter on the same target collapses on the unique
  `(reporter_id, target_type, target_id)`, refreshing `reason` and `details`
  without moving the distinct-reporter count and without reopening `status`.
- The client also records `feed_record_interaction(p_target_id, 'hide')` when
  the target is a post (COMM-151). A comment records nothing.

### mod_queue(p_status text, p_cursor timestamptz, p_limit int) returns setof mod_queue_item

- Shipped in 202608280025, with the composite type `public.mod_queue_item`
  (`report_id uuid, target_type text, target_id uuid, content_excerpt text,
  content_author_id uuid, content_author_name text, reporter_count integer,
  reasons text[], latest_reason text, note text, status text, created_at
  timestamptz, reporters jsonb`).
- Purpose: the moderation review queue, one row per reported item, grouped by
  `(target_type, target_id)`.
- Params: `p_status` open, reviewing, action_taken, dismissed, or all.
  `p_limit` clamped to 1..50. `p_cursor` pages by the group's earliest
  `created_at`.
- `report_id` is the earliest report in the group, a stable id for it.
  `status` is the group status: open if any report is open, else reviewing,
  else dismissed, else action_taken. `note` is the most recent non-empty
  reporter note. `content_excerpt` is the post or comment body, first 240
  chars, empty when the content is gone. `reporters` is `[{id, name}]`.
- Auth: security definer, requires `has_perm('community.comment.moderate')` OR
  real `is_admin`. Grant execute to `authenticated`; the permission check
  inside is the gate. Reporter identities are only ever returned here.

### mod_review(p_report_id uuid, p_decision text, p_note text, p_expires_at timestamptz default null) returns void

- Shipped in 202608280025. Four-argument. `p_expires_at` is read only for
  `p_decision = 'restrict_temp'`; every other decision ignores it. The client
  sends it only for `restrict_temp`.
- Purpose: record a trusted status transition and apply the decision.
- Params: `p_decision` one of remove, warn, restrict_temp, restrict_permanent,
  dismiss. `p_note` up to 500 chars.
- Auth: security definer, `has_perm('community.comment.moderate')` OR real
  `is_admin`, matching `mod_queue`. Grant execute to `authenticated`.
- Side effects, per decision:
  - `remove`: a post target calls `post_delete(target_id)`, a comment target
    calls `comment_moderate(target_id, 'remove')`. Each writes its own
    `content_delete` `admin_actions` row, so a remove leaves two audit rows.
  - `restrict_temp` / `restrict_permanent`: calls
    `mod_restrict_member(content_author_id, 'temporary' | 'permanent',
    p_expires_at | null, p_note, p_report_id)`, which writes its own
    `member_restrict` row. Raises if the content author is gone. Note the
    restrict decisions need `community.member.restrict`, which a
    `community.comment.moderate`-only role does not hold, so a coach can pick
    them but the call raises.
  - `warn`, `dismiss`: no content or member change.
- Every decision stamps every `reports` row for `(target_type, target_id)`
  with `reviewed_by`, `reviewed_at`, `review_note = left(p_note, 500)`, sets
  `status` to `dismissed` for `dismiss` and `action_taken` otherwise, and
  writes one `report_review` `admin_actions` row with `before_data` `{status}`
  and `after_data` `{status, decision}`.

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

## Needs from schema, admin-moderation

Shipped by schema in 202608280024 and 202608280025. The admin-moderation
cluster (COMM-150 to COMM-156) is now fully backed. `has_perm`,
`my_permissions`, `my_role_code`, `log_admin_action`, `admin_actions_page`,
`mod_restrict_member`, `mod_lift_restriction`, `is_posting_restricted`,
`pin_set` and `pin_clear` were already shipped and are used as documented
above. `report`, `mod_queue`, `mod_review`, `post_delete` and
`comment_moderate` are documented under "Moderation and admin" and "Posts";
this section records the table and enum changes and the two remaining notes.

### reports table changes (202608280024)

- `target_type text not null default 'post'` with a CHECK of `post`,
  `comment`, and `target_id uuid not null` (backfilled from `post_id` for the
  existing rows). `post_id` loses its NOT NULL and stays populated for a
  `post` target (equal to `target_id`); a `comment` target leaves it null.
- The `reason` CHECK gains `unsafe_advice`.
- Unique `(reporter_id, target_type, target_id)` replaces the old
  `(reporter_id, post_id)`.
- `review_note text not null default ''` (<= 500 chars) for the reviewer note
  `mod_review` writes. It is separate from `details`, which is the reporter's
  own note that `report()` writes.
- `report_status` gains `action_taken`. `resolved` stays in the enum for the
  older `review_report` path and no row was remapped.
- The `posts_feed_select` policy edit in the old draft does not apply: that
  policy carries no reports predicate (it was rebuilt without one in
  202608280005). The reporter self-hide lives in `feed_page` (202608280019)
  and the two legacy feed views, all keyed to `reports.post_id`, and because
  `post_id` stays populated for a post report and null for a comment report,
  they keep working with no change - a comment report correctly does not hide
  the post it sits on.

### submit_report(p_post_id uuid, p_reason text default 'inappropriate') returns void

- Rewritten in 202608280025 as a thin wrapper that calls
  `report('post', p_post_id, p_reason, '')`, so the old two-argument shape
  keeps resolving. `cloud.js` no longer calls it.

### comment_moderate(p_comment_id uuid, p_action text) returns void

- Shipped in 202608280025. The comment equivalent of a moderator
  `post_delete`. `post_comments` has no UPDATE grant, so this is the only
  moderator path to a comment's `status`.
- `p_action` one of `remove`, `restore`, an unknown value raises.
- Auth: security definer. `has_perm('community.comment.moderate')` OR real
  `is_admin`. Grant execute to `authenticated`.
- Side effects: `remove` sets `status = 'removed'`, `deleted_at = now()`, and
  `deleted_by = auth.uid()` (the mirror of `comment_delete` stamping the
  author); `restore` clears all three. Each writes one `content_delete`
  `admin_actions` row (target_type `comment`) with before and after status.
  Idempotent: an already-removed comment returns before touching `deleted_by`,
  so a moderator removal is never overwritten by a later restore-then-remove
  race, and vice versa.
- In Phase 1 the client calls this only through `mod_review`'s `remove`
  decision on a comment target, never directly.

### admin_grant_coach(p_user_id uuid, p_role text) returns void

- Shipped in 202608280025. `p_role` carries no default: a default would make
  `admin_grant_coach(uuid)` ambiguous against the one-argument overload and
  every one-argument call would fail. The one-argument
  `admin_grant_coach(p_user_id)` from 202608270011 stays as the "grant coach"
  shorthand and now delegates here, so it audits too. The two-argument form
  accepts `p_role` in `coach` and `head_coach` only; `staff`, `owner`, and any
  other value raise.
- Auth unchanged: real `is_admin` inline, not `is_staff()`.
- Side effect (COMM-154): one `role_change` `admin_actions` row, target_type
  `member`, `before_data` `{role: <prior invite_redemptions.role>}`,
  `after_data` `{role: <granted>}`. `admin_revoke_coach` was rewritten the
  same way, `after_data` `{role: 'member'}`, and returns without an audit row
  when the target was already `member` or had no redemption.
- The `head_coach` -> permission mapping is already in 202608280001
  `role_permissions` (coach set plus `community.post.delete_any`,
  `community.member.restrict`, `community.content.pin`). Nothing to add.

### my_permissions() returns setof text

- Shipped in 202608280001, no change. The client calls it once per session
  into a cached set (`state.permissions`), reads it through `hasPerm()`, and
  drops it on sign-out. It is reloaded on the auth-state-change path so a
  role change takes effect without a reload.

## Needs from schema, admin-moderation (Phase 2)

Schema the Phase 2 admin-moderation ticket (COMM-218) needs. Shipped by
schema in 202608290010, together with the COMM-219 half under "Needs from
schema, notifications (Phase 2)".

### announcements priority and expiry (202608290010)

- `announcements.priority text not null default 'normal' check (priority in
  ('normal', 'important', 'urgent'))`, the client-facing replacement for the
  boolean `important` added in 202608280026. Existing rows with `important`
  set were backfilled to `important` tier in the same migration.
- `announcements.important` was NOT dropped. It stays a real, writable
  boolean kept as an exact mirror of `priority <> 'normal'` by the
  `announcements_priority_sync` BEFORE trigger (documented under "##
  Notifications"), which is the "equivalent trigger-maintained mirror" this
  list allowed. A generated column was rejected: it would make `insert into
  announcements (..., important)` and `update ... set important = true` hard
  errors, and both are live in the shipped pgTAP suite and in any client
  build predating the priority field. Every Phase 1 trigger and policy that
  reads `important` is unchanged.
- `announcements.expires_at timestamptz`, nullable, plus a partial index on
  the rows that carry one. `now()` is not immutable, so "not yet expired"
  cannot be a partial index predicate and is not one.
- Expiry is enforced at read time in RLS, not in a page function: members
  read `announcements` directly, so `announcements_read` became `deleted_at
  is null and (expires_at is null or expires_at > now() or
  public.is_staff())`. That is what drops an expired announcement out of the
  feed top area and the pinned strip with no cron and no backfill, the same
  shape `is_posting_restricted` uses for a timed-out restriction. Staff keep
  reading expired rows, so an admin audit read still shows the record;
  expiry hides an announcement from members, not from the record. This is
  the only policy change in the migration and it is strictly narrower - no
  policy was widened.
- The write gate is untouched. `announcements_insert_admin` /
  `announcements_update_admin` are whole-row `public.is_staff()` policies,
  so both new columns are staff-only to write from the moment they exist.
- Pins are untouched (COMM-155). `pins_unpin_dead_announcement` still fires
  only on `deleted_at`, so an expired-but-pinned announcement stays pinned
  until a staff member explicitly unpins it; it simply stops being readable
  by members, which is what empties it out of the strip.
- Also in this migration, for the fan-out's already-notified test and
  `notif_create`'s own de-dupe probe: `notifications_source_idx` on
  `notifications(source_id, user_id) where source_id is not null`.

## Needs from schema, coach-tools

Schema the Phase 2 coach dashboard (COMM-223 to COMM-226) needs. Nothing
here touches `coach_engagement_flags` (COMM-011): it ships empty in Phase 2
too, per COMM-226, and is out of scope until COMM-304.

- `coach_celebrate_feed(p_days int default 7) returns setof jsonb`
  (COMM-223, COMM-225). Staff-only (`is_staff()` inline, raises otherwise).
  One call for the whole Celebrate list: recent PRs (from `workout_posts`
  where `post_type = 'POST_PR'` and `created_at` within `p_days`),
  anniversaries (a member whose `invite_redemptions.redeemed_at` hits a
  year multiple within `p_days`, reusing the same tenure arithmetic
  `ach_claim`'s `anniversary_year_*` check already established), and
  challenge completions (`challenge_participants.completed_at` within
  `p_days`). Each row is included only when it would already be visible to
  the calling coach under the normal per-field privacy toggle for its kind
  (`show_prs` for a PR) — Celebrate does not bypass a member's own privacy
  choice, it surfaces what a coach could already see. No birthday source: no
  birth date column exists, per the 2026-08-28 decision, so Celebrate never
  queries for one.
- `profiles.assigned_coach_id uuid references profiles(id) on delete set
  null`, nullable, staff-writable only (COMM-224 "Assign coach optional").
  No policy change needed beyond an update grant already open to
  `authenticated`; the write is gated the same way every other
  member-affecting toggle is, by checking `is_staff()` in the client path,
  and a narrower update policy can be added later without changing this
  column's shape.
- `member_contact_log` table (COMM-224 "Mark contacted"): `id uuid, user_id
  uuid, contacted_by uuid, contacted_at timestamptz default now(), note text
  default ''`. Staff read and write about any member. Unlike
  `coach_engagement_flags` this carries no `user_id <> auth.uid()`
  requirement — being welcomed is not a sensitive signal the way a decline
  flag is — but it is also not surfaced to the member in this ticket's
  scope, since coach-tools.md does not ask for that and it is simpler to add
  visibility later than to remove it.

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
- `configure({ client, userId | getUserId, attachToBus, debug })` hands the
  helper a Supabase client and a way to read the current user id, and
  attaches the bus bridge unless `attachToBus` is false. An unconfigured
  `track()` is an inert no-op that touches no network, which is why COMM-170
  calls it at the head of the session-ready path in `cloud.js`
  (`refreshSession` and `onAuthStateChange`) rather than the tail. `getUserId`
  is a getter over `state.user`, so one call covers every later sign-out and
  sign-in.
- The dev switch: `window.HAIMUNIA_ANALYTICS_DEBUG = true`, or
  `configure({ debug: true })`. Every event is logged to the console and
  nothing is written. The global wins over the configure option so it can be
  flipped on a device that is already running. `isDebug()` reports the state.
- `BUS_EVENT_MAP` is the one-to-one product-event to analytics-name map:
  POST_CREATED, COMMENT_CREATED, REACTION_CREATED, CHALLENGE_JOINED,
  CHALLENGE_COMPLETED, EVENT_REGISTERED. WORKOUT_COMPLETED, PR_CREATED,
  MEMBER_JOINED, ACHIEVEMENT_UNLOCKED and ATTENDANCE_RECORDED are
  deliberately unmapped: completing a workout is not sharing one, and
  unlocking an achievement is not sharing it.
- `BUS_PROP_KEYS` is the per-event prop allow-list the bridge projects each
  payload through, with `projectBusPayload(productEvent, payload)` doing the
  work. A bus payload is built for its consumers, not for this table, so a
  key that is not on the list is dropped and an array prop is stored as its
  length (`mentions` becomes `mention_count`). That is what keeps the props
  shape a stable contract and keeps member-authored text out of analytics.
  A feature agent never hand-tracks one of the six bridged names: the bridge
  already wrote the row, and a second call would double count.
- `ACTIVE_MEMBER_EVENTS` and `isActiveMemberEvent(name)` are the qualifying
  subset for Weekly Community Active Members, spec section 78.
- `docs/community/metrics.md` is the metrics contract: the WCAM definition,
  every tracked event with its trigger surface and props, the core and
  additional metrics, and what is deliberately unwired. A feature agent that
  adds a surface adds its row there in the same change.

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

## Realtime and search

### Realtime publication membership (COMM-209, COMM-227)

- Shipped in 202608290007.
- `alter publication supabase_realtime add table public.<name>;`, one
  statement per table, for `challenge_progress`, `challenge_participants`
  (COMM-209), and `post_comments`, `reactions`, `notifications` (COMM-227).
  `HaimuniaRealtime` (COMM-014) has subscribed to all five since Phase 1
  with zero replication enabled; this migration is the one-line-per-table
  flip that turns each of those existing no-op subscriptions live, with no
  RLS or grant change of its own - `postgres_changes` payloads are still
  filtered per-subscriber by each table's existing row level security, the
  same as any other read. `notifications` closes the specific gap COMM-140
  already logged ("no-op until COMM-227").
- `ALTER PUBLICATION ... ADD TABLE` is transactional DDL (unlike `CREATE
  INDEX CONCURRENTLY` or `ALTER TYPE ... ADD VALUE`), so it runs inside the
  usual `begin; ... commit;` migration block with no special handling.
  Confirmed via `supabase db reset` plus `select * from
  pg_publication_tables where pubname = 'supabase_realtime'` returning all
  five rows afterward.

### Client channel inventory (COMM-209, COMM-227)

- The client half, in `cloud.js`, on top of 202608290007. Correcting one
  line above: only the own-row `notifications` channel existed before this
  cluster (COMM-140 wired it early); the other four channels are new here.
  Every one of them is opened through `HaimuniaRealtime.subscribe()` and
  never by reaching past the harness to the client, so one `teardownAll()`
  closes all of them.
- Channels, all `postgres_changes`:
  - `chal-progress-<id>`: `challenge_progress` INSERT,
    `challenge_id=eq.<id>`. Open only while a challenge detail is open.
  - `chal-participants-<id>`: `challenge_participants` UPDATE, same filter.
  - `feed-comments`: `post_comments` INSERT, unfiltered.
  - `feed-reactions`: `reactions` `*`, unfiltered.
  - `notif-<uid>`: `notifications` `*`, `user_id=eq.<uid>`.
- The two feed channels are shared per feed session rather than one per
  card: `postgres_changes` filters are `eq`-only, a feed page is twenty
  posts, and `MAX_SUBSCRIPTIONS` is 10. Incoming rows are filtered client
  side against the currently rendered post ids (`findFeedPost`), so an
  event for a post that is not on screen costs nothing.
- Every handler re-fetches through the surface's existing load path
  (`chal_progress`, `loadCommentsFor`, `loadReactionsFor`) instead of
  applying the payload row. A `postgres_changes` payload is one raw table
  row: no profile join, no block filtering, no server-side aggregation.
  Applying it directly would render something a manual refresh of the same
  screen would not.
- Every re-fetch is debounced (400 ms, keyed per challenge or per post), so
  a burst of rows costs one query rather than one per row. Pending timers
  are cancelled by the same teardown that closes the channels, so a timer
  cannot fire into a view that is gone.
- Teardown points: `setCommunityTab` (which also closes an open challenge
  detail, since the detail belongs to the view that opened it),
  `closeChallengeView`, and sign-out. Arming is idempotent and happens in
  `afterRenderCommunity`, which checks the registry rather than a local
  flag, so a channel closed by a teardown re-opens on the next render of a
  view that still wants it.
- With no configured client, or with the channel unreachable, `subscribe()`
  returns a working no-op and every surface stays on its existing
  poll-on-open behavior. No surface shows an error for a missing channel.
- Not realtime in V1, deliberately: new feed cards (the feed refreshes on
  open, pull and paginate), and urgent announcements, whose broadcast path
  is still COMM-219.

### community_search(p_query text, p_limit int default 10) returns jsonb

- Shipped in 202608290008.
- Purpose: one round trip returning `{members: [...], events: [...],
  challenges: [...]}` for a grouped search UI (COMM-228), instead of three.
- Auth: security definer, `set search_path = ''`, revoked from `public,
  anon`, granted only to `authenticated`. Raises `not authorized` for a
  null caller before any table is touched. Definer buys exactly one thing:
  crossing the RLS boundary on purpose to union three already-existing
  readable sets server-side (events, challenges) rather than widening what
  any single caller could see one row at a time.
- Sanitization: `p_query` is stripped of `%`, `_`, `,`, `(`, `)` and
  trimmed - the exact same characters `searchPeople` (cloud.js) already
  strips client-side - before it is ever wrapped in an `ilike` pattern.
  Necessary here specifically because this function receives the raw
  string over RPC, not the client's pre-sanitized copy. A stripped query
  under 2 characters returns `{members: [], events: [], challenges: []}`
  immediately, no table read, matching `searchPeople`'s existing
  client-side threshold. `p_limit` is clamped to between 1 and 50
  (`default 10`) and applied per group, not to the total.
- `members`: the exact same shape and visibility `searchPeople` already
  provides - `id, handle, display_name, bio, avatar_url, allow_follows`,
  matched by `ilike` on `handle` or `display_name`, excluding the caller's
  own row, mirroring `profiles_read_authenticated` (202608280003)
  literally: `deleted_at is null`, no `blocks` row between caller and
  target in either direction, and (`visible_to_club` or `is_admin()`).
- `events`: matches `title` `ilike`, mirroring `events_read` (202608280010)
  literally: `status <> 'draft'`, or the caller is `created_by`, or the
  caller holds `community.event.manage`. This is the actual policy
  predicate (any non-draft status, not literally "published only") - the
  function does not invent a looser or stricter rule than the policy it
  mirrors.
- `challenges`: matches `title` `ilike`, mirroring `challenges_read`
  (202608280009) literally: `status <> 'draft'`, or the caller is
  `created_by`, or the caller holds `community.challenge.create`
  (challenges has no separate `.manage` permission - `.create` is the one
  permission that already gates every challenges write and read-widening).
- No full-text search and no post search - members, events, and challenges
  only, per platform.md's explicit V1 exclusion.
- Verified locally via `supabase db reset` plus manual psql smoke tests
  impersonating fixture members through `tests.set_auth()`: a draft
  event/challenge is invisible to a non-creator without the manage/create
  permission and visible to its creator and to a permission holder; a
  club-hidden member (`visible_to_club = false`) and a blocked member are
  both excluded from the members group; a query under 2 characters returns
  all three groups empty with no table read; a query built entirely from
  `%_,()` characters strips to empty rather than wildcard-matching
  everything; `p_limit` caps each group independently. See "Phase 2 schema
  handoff for qa" in `docs/community/backlog.md` for the full boundary
  table, and `test/community-realtime-search-rls.test.mjs` for the static
  assertions.

### Search UI (COMM-228)

- One box (`#communityPeopleSearch`, Account tab), one call per keystroke,
  three labeled groups rendered in a fixed order - members, events,
  challenges - never interleaved: a member row and an event row are not
  comparable, and mixing them would need a cross-type relevance order the
  function deliberately does not compute. Each group carries
  `data-search-group="<members|events|challenges>"`.
- `searchPeople(query)` is kept as the input handler's name and now
  delegates to `communitySearch(query)`. `state.people` still holds the
  members group with the same row shape and the same follow/block/profile
  controls, so the existing caller is unchanged.
- The client strips `%_,()` and trims before checking the 2-character
  threshold, so a query of only those characters is empty results with no
  request. The RPC re-applies both, since it receives the raw string.
- States: under 2 characters is a hint and no request; in flight is
  "מחפש..."; a failed call clears the three groups rather than showing an
  error, matching the members-only search's previous failure behavior. A
  response is dropped if a later keystroke already fired.
- A challenge result opens the real challenge detail
  (`CHALLENGE_VIEWED` with `source: "search"`). An event result records
  `EVENT_VIEWED` with the same source and shows title, start and status
  only - there is no event detail surface until COMM-213, and the row does
  not pretend to navigate to one.

## Needs from schema, platform (Phase 2)

Closed. See "## Realtime and search" above.

## Needs from schema, recaps

Schema the Phase 2 recaps cluster (COMM-220 to COMM-222) needs.

- `weekly_recaps` table: `id uuid, user_id uuid, club_id uuid default
  default_club_id(), week_start date, sessions_completed integer, streak
  integer, prs jsonb, achievements jsonb, challenge_progress jsonb,
  club_challenge_progress jsonb, upcoming_event jsonb, generated_at
  timestamptz default now()`. Unique `(user_id, week_start)`, which is what
  makes `recap_weekly` idempotent per user per week — a rerun for a week
  already generated hits the conflict and updates in place rather than
  duplicating. Own-row select, no client insert or update grant: only the
  `recap_weekly` Edge Function, running as service role, writes it.
- `onboarding_progress` table (COMM-222): `user_id uuid primary key,
  welcomed_at timestamptz, first_week_shown_at timestamptz,
  first_month_shown_at timestamptz`. Own-row select and update (the update
  is the client marking a step seen), no insert grant beyond a row seeded at
  `MEMBER_JOINED` time by a trigger on `invite_redemptions` or `profiles`,
  so a member cannot invent a fresh row to re-see a step. The two steps tied
  to first and third class attendance are not columns here yet; they land
  with COMM-316.

## Edge Functions

### recap_weekly

- Schedule: weekly. Idempotent per user per week via the unique `(user_id,
  week_start)` key on `weekly_recaps` (see "Needs from schema, recaps").
  Phase 2, COMM-220.
- Output: one `weekly_recaps` row per active user, plus one `notif_create(U,
  'weekly_recap', 'club', ...)` call per user with a deep link to the recap
  surface (COMM-221), matching the routing table entry above.
- Records success and failure counts with no personal content.

### recap_monthly_club

- Schedule: monthly. Admin preview before publish. Phase 3, COMM-309.
- Output: aggregate club figures. No member names in public sections.

### purge_abandoned_profiles

- Schedule: daily. Versioned. Idempotent. Phase 3, COMM-314.
- Purpose: remove abandoned anonymous profiles per the retention rule.
- Records success and failure counts with no personal content.
