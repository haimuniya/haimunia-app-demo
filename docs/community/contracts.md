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
- Notes: diversity rules from COMM-112 run inside this function. Block edges
  from COMM-125 are joined here. `my_classes` scope is still parked, and
  COMM-302 did **not** unpark it — see the last bullet below.
- Re-created in 202608310002 (COMM-301) with the same signature and the same
  output. Its relationship component is now one call to
  `relationship_score()` instead of an inline CTE; the four `v_rel_*`
  constants left its weight block and the weight `v_w_relationship = 18`
  stayed. Nothing else in the body changed, and
  `supabase/tests/0038_relationship_score_test.sql` pins the ranked order and
  the `feed_score` values to six decimal places against numbers captured from
  the pre-refactor function.
- Re-created again in 202608310003 (COMM-302, closing COMM-P01) with the same
  signature and the same returned columns. **The class-connection component
  is no longer 0.** `v_class_connection constant numeric := 0` left the
  declare block; the value now comes from
  `classmate_day_counts()`, left-joined once per distinct author in the same
  `author_facts` CTE that resolves `relationship_score()`, and is normalised
  as `least(1.0, shared_days / 8.0)` before the already-reserved weight
  `v_w_class = 6` applies. The saturation constant `v_class_saturation = 8.0`
  is new and sits with the other shaping constants; the weight itself did not
  move. Practical effect: a member the viewer trained beside on 8 or more
  days inside the trailing 60 gets the full 6 points, 4 days gets 3, no
  overlap gets 0 (a zero, never a missing term and never a raise). A member
  the viewer has blocked in either direction never reaches the scoring pass
  at all, unchanged. Pinned by
  `supabase/tests/0039_classmate_signal_test.sql`.
- Re-created a third time in 202608310006 (COMM-303) with the same signature
  and the same returned columns. **The eight weights in its weight block are
  now resolved per caller.** They stop being `constant`, keep their values
  character for character, and are passed to
  `feed_weights_resolve(auth.uid(), <the default object>)` in one new section
  placed after the auth check and before anything is scored — once per feed
  request, never once per candidate row, and fixed for the whole call the way
  `v_anchor` is. **A member with no `member_feed_weights` row gets exactly the
  ranking this function produced before**, and that is every member today,
  because nothing writes that table yet. Pinned by
  `supabase/tests/0042_personalized_feed_weights_test.sql` against the same
  three fixture posts and the same three six-decimal-place literals 0038
  captured from the pre-COMM-301 function — which have now survived three
  re-creations unchanged — asserted five times over: no row, an empty object,
  an explicit all-1.0 object, every multiplier at the 2.5 ceiling, and a row
  of junk.
- The scoring expression itself is the previous file's text **unchanged**, as
  are the candidate filters, the repetition penalty, the cursor and the row
  projection. **COMM-112 diversity still runs after scoring**, in the same
  place, against the rows the scoring query returned; personalization changes
  the score and therefore which rows reach the page, never a diversity rule.
  0042 pins that both structurally (the resolve appears before the scoring
  query and the diversity pass after it, read off `prosrc`) and behaviourally
  (a personalized feed still breaks a same-author run at two).
- **The weight block's "the positive weights sum to 104" comment was stale
  and is corrected to 110 in this migration.** 104 was the seven live weights
  while `v_w_class` was declared at 6 and multiplied by a hard 0; COMM-302
  turned that component on in 202608310003 and left the comment behind. **No
  weight moved in COMM-303** — renormalising the block down to 104 would have
  changed every existing feed score on deploy day, which is the one thing
  that ticket must not do. Nothing hardcodes the total any more: the invariant
  is "a personalized set sums to whatever the default block sums to",
  computed from the defaults at call time.
- `my_classes` stays parked deliberately even though attendance now exists.
  A class-connection **score** and a my-classes **scope** are different
  questions: `attendance_log` records days, not classes, so it carries no
  class identity to filter a post by. The scope still returns empty and the
  client still renders that chip disabled.

### member_feed_weights (table)

- Shipped in 202608310006. COMM-303.
- `user_id uuid primary key references profiles(id) on delete cascade`,
  `weights jsonb not null default '{}'`, `computed_at timestamptz not null
  default now()`. Three columns, as the ticket's outline named — **no
  `club_id`**, unlike `weekly_recaps`: the row is a private ranking artifact
  about one member, nothing aggregates it per club, and so this table also
  needs no `default_club_id()` grant.
- One addition beyond the outline: a check constraint
  `member_feed_weights_object`, `jsonb_typeof(weights) = 'object'`. The reader
  defends against a non-object anyway (it must — it also has to survive a row
  written before the constraint existed), but a column every reader treats as
  an object should not be able to hold `[1,2,3]`.
- `weights` is **multipliers relative to `feed_page`'s defaults**, not
  absolute weights: `{"relationship": 1.4, "class": 2.1}`. 1.0 means the
  default, an **absent key means 1.0**, and unknown keys are ignored by the
  reader rather than rejected, so a later ticket can start writing a ninth
  component's key before `feed_page` learns to read it. Multipliers rather
  than absolute weights because the default block has already been retuned
  twice in this module's life, and with absolute weights every stored row
  would silently become wrong the next time a default moves.
- **`'{}'` is the thin-signal answer** and is deliberately indistinguishable
  from having no row at all, so a job can record "I looked on Monday and
  found nothing" with a fresh `computed_at` without that meaning anything
  different for the feed.
- Auth: RLS on. `select` granted to `authenticated` with one policy,
  `member_feed_weights_self_select`, `user_id = auth.uid()`. **No insert,
  update or delete grant and no policy for any of the three, for anyone** —
  not the member, not an admin. The same shape `weekly_recaps` and
  `notification_batches` use, for a sharper reason: a member who could write
  here would be supplying their own ranking input, which is exactly what
  COMM-303's contract section refuses when it says the weights are "never
  passed as a parameter". The read is granted because there is nothing
  private in a member's own weights. `anon` cannot reach the table at all.
- **Nothing writes this table yet.** See `recompute_feed_weights()` below.

### feed_weights_resolve(p_user uuid, p_defaults jsonb) returns jsonb

- Shipped in 202608310006. COMM-303. **Internal, not a client call.**
- Purpose: what weights `p_user`'s feed should actually use, as an object
  with the same keys as the `p_defaults` object handed in. The one copy of
  the redistribution arithmetic.
- Not named by COMM-303's migration outline; added for the same reason
  COMM-302 added `classmate_day_counts()` beyond its own. The alternative was
  a forty-line procedural block inlined in `feed_page` where nothing could
  assert anything about it, and the invariants below are the whole substance
  of the ticket.
- **It takes the defaults as a parameter rather than holding them**, so the
  eight numbers stay stated exactly once, in `feed_page`'s weight block —
  this function owns the algorithm, `feed_page` owns the numbers, and there
  is no pair to drift. It never names a component, so adding a ninth weight
  needs no edit here.
- Returns: `p_defaults` **itself, unexamined**, when there is no row, when the
  stored value is an empty object, when it is not an object, or when every
  readable multiplier is exactly 1.0. Otherwise an object with the same keys
  and redistributed values.
- The algorithm: clamp each stored multiplier to **0.40..2.50** (COMM-303's
  worked example, adopted as the real bound), then **bounded proportional
  rescale** — repeatedly scale the not-yet-pinned components by (remaining
  budget / their unscaled total), pinning at a bound any component the scale
  would push out of range and taking its weight out of the budget, until a
  pass pins nothing. The sum is then the defaults' total by construction and
  every component is inside its bounds by construction. Neither
  clamp-then-rescale nor rescale-then-clamp achieves both; a worked
  counterexample is in the migration header.
- **And it is verified anyway before it is used**: the resolved set is summed
  and bounds-checked, and any violation returns `p_defaults` unchanged. So a
  bad stored row, or a wrong future edit to the loop, costs a member their
  personalization and never their feed. Tolerance 1e-9, nine orders above the
  rounding a single `numeric` division introduces.
- Auth: `security invoker`, **no grant to any role** — `public`, `anon` and
  `authenticated` are all revoked, the same shape `relationship_score()` and
  `classmate_day_counts()` have. Called from `feed_page` (definer, having
  already checked `auth.uid()`), it borrows those rights to read
  `member_feed_weights` past `member_feed_weights_self_select` — but only ever
  for the caller's own row, which that policy would have granted anyway. A
  client reaching it directly gets 42501.
- Unlike `classmate_day_counts()` it **does** take a user parameter, and that
  is not the same trap: it consults no privacy toggle that would silently
  ignore the argument, and no client can pass one regardless.
- Side effects: none, `stable`.

### recompute_feed_weights(p_limit integer default 500) returns integer

- Shipped in 202608310006. COMM-303. **A DELIBERATE NO-OP STUB.**
- Purpose, eventually: derive each member's multipliers from their own
  `feed_interactions` history (COMM-114) and upsert one `member_feed_weights`
  row per member. **That body is not written and is explicitly out of
  COMM-303's scope** — the ticket puts the derivation in the same "infra not
  built here" bucket as the notification batch flusher and `recap_weekly`'s
  cron gap.
- What ships is the signature, the grants, the return convention and the auth
  boundary, all pinned by 0042 now so a later ticket writes only the body. It
  is shipped rather than omitted so `feed_page` is not left reading a table
  with no named writer; it is empty rather than heuristic because a guessed
  derivation would ship unreviewed ranking to every member, and a no-op that
  writes no row cannot distort anybody's feed.
- Returns the number of member rows written — the same "rows written" integer
  `notif_batch_flush_due()` returns. **Today always 0**, so a scheduler wired
  up early gets a harmless no-op rather than an error. `p_limit` is the batch
  bound the real body will honour, mirroring `notif_batch_flush_due(p_limit)`;
  it is accepted and unused today so a scheduler's call site does not change
  when the body lands.
- Auth: `security definer`, `execute` revoked from `public`, `anon` and
  `authenticated`, granted to `service_role` only. **No `auth.uid()` check** —
  the same documented exception `notif_batch_flush_due()`,
  `notif_queue_batched()`, `seed_onboarding_progress()` and
  `post_new_member_on_join()` already carry, since `service_role` has no uid
  and the execute grant is what stands in for one.
- **Cadence: weekly**, resolved for COMM-303 alongside the clamp bounds. It
  matches the cadence this schema already runs its other periodic
  recomputations on — consistency streaks are a week-shaped question and
  `recap_weekly` is literally weekly — so the module has one periodic rhythm
  rather than three. **Nothing schedules it**: `pg_cron` is not guaranteed
  present in the CI stack, and the cadence is expressed in exactly one place,
  the commented cron line in 202608310006
  (`'17 4 * * 1'`, Monday 04:17 UTC). Changing it is an edit to that one line;
  no schema depends on it.

### relationship_score(p_viewer uuid, p_other uuid, p_as_of timestamptz default now()) returns numeric

- Shipped in 202608310002. COMM-301. **Internal, not a client call.**
- Purpose: how close `p_viewer` already is to `p_other`, as a 0..1 number.
  The one copy of the arithmetic `feed_page` used to hold inline.
- Params: `p_viewer` and `p_other` are member ids. `p_as_of` is the instant
  the 30-day interaction window is measured back from.
- Returns: `numeric` in `[0, 1]`, never null. Mutual follow 1.0, one-way
  follow 0.55, a reaction or comment by the viewer on the other member's
  posts inside the window adds 0.45, the sum capped at 1. A null viewer, a
  null other, or a member scored against themselves is 0.
- Auth: `security invoker`, **no grant to any role** — `public`, `anon` and
  `authenticated` are all revoked, the same shape
  `consistency_week_streaks()` has. It is called only from `security
  definer` functions that have already resolved and checked `auth.uid()`,
  and it borrows their rights to read `follows`, `reactions` and
  `post_comments` across members. A client reaching it directly gets 42501.
- Side effects: none, `stable`.
- Two things differ from this file's own forward reference, both so the
  extraction stays behaviour-preserving; neither changes a number:
  - **`p_as_of` is a third parameter**, defaulted, so the promised
    two-argument form `relationship_score(viewer, other)` still resolves
    verbatim. The inline version measured the window from `feed_page`'s
    frozen `v_anchor`, not from `now()`, and that is load-bearing: the
    anchor is what makes every page of one feed session score identically.
    A two-argument function reading `now()` internally would move the 30-day
    boundary between page 1 and page 2. `feed_page` passes `v_anchor`.
  - **The mutual-follow test is written out rather than delegated to
    `are_friends()`**, which resolves its viewer from `auth.uid()` and so
    cannot answer for an arbitrary `p_viewer`. The predicate is
    `are_friends()`'s body with `auth.uid()` replaced by `p_viewer`,
    self-exclusion and null guards included. `are_friends()` remains the one
    definition of "friends" every client-facing surface uses, and 0038
    asserts the two agree for every fixture member so the second copy cannot
    drift.
- Not used by `people_suggestions` (COMM-232), deliberately. That function
  answers "who should this member start following"; this one answers "how
  close is this pair already", which is close to its opposite. 0038 asserts
  `people_suggestions`' body does not mention it, so folding them together
  becomes a deliberate decision rather than a quiet one.

### classmate_day_counts(p_as_of timestamptz default now()) returns table(user_id uuid, shared_days integer)

- Shipped in 202608310003. COMM-302. **Internal, not a client call.**
- Purpose: how many calendar days inside a trailing 60-day window the caller
  and another member both have an `attendance_log` row for. The one copy of
  the recurring-classmate arithmetic, and the one copy of its privacy gate.
- Params: `p_as_of` is the instant the 60-day window is measured back from.
  **There is deliberately no viewer parameter** — the viewer is `auth.uid()`.
  `can_view_profile_field()` resolves *its* viewer from `auth.uid()` and
  cannot be told to answer for somebody else, so a `p_viewer` argument would
  be honoured by the overlap count and silently ignored by the privacy gate.
  That is the same trap COMM-301 refused when it declined to hand
  `are_friends()` a viewer it would ignore.
- Returns: one row per member with **at least one** shared day. A member with
  no overlap is absent, not a zero row; both callers read absent as 0. The
  caller themselves is never returned.
- The window is 60 days, stated once here, matching `people_suggestions`'
  two pre-existing time-stamped signals so all four of that function's
  signals are measured over the same period. Lower-bounded only, like
  `relationship_score()`'s 30-day window.
- Privacy: every returned member passes
  `can_view_profile_field(member, 'show_attendance')`, applied after the
  aggregate so it runs once per member who actually shares a day.
  `show_attendance` is attendance's own toggle, separate from
  `visible_to_club`, and it **defaults to false** — so out of the box no
  member contributes a classmate signal to anyone. A member with it off still
  accumulates `attendance_log` rows and those rows still count toward their
  own achievements (COMM-305) and their own leaderboard rank (COMM-306).
  Block edges in both directions and deleted profiles fall out through the
  same call; they are not re-implemented here. The helper's `is_admin()`
  short-circuit applies here too, so a real admin's feed and suggestion strip
  do see classmate signals from members who opted out — that is the
  module-wide behaviour of the one resolution point, the same way
  `feed_leaderboard`'s contract already records it, not a rule invented here.
- Auth: `security invoker`, **no grant to any role** — `public`, `anon` and
  `authenticated` are all revoked, the same shape `relationship_score()` and
  `consistency_week_streaks()` have. Called from `feed_page` and
  `people_suggestions` (both definer, both having already checked
  `auth.uid()`), it borrows their rights to read other members'
  `attendance_log` rows past `attendance_log_self_select`. A client reaching
  it directly gets 42501 — a member must not be able to ask who trains with
  whom, only to be ranked by it. The null-uid guard in the body returns an
  empty set rather than raising; it is a correctness guard, not an
  authorization one.
- Side effects: none, `stable`.
- Set-returning rather than scalar, and that is forced rather than stylistic:
  `people_suggestions` builds its candidate set *from* its signals union, so
  a member whose only overlap with the caller is attendance has to be
  introduced by this branch or they are never a candidate at all.
- Backed by `attendance_log_club_day_idx` (202608310001), created for exactly
  this read.

### attendance_classmates_today(p_limit int default 6) returns setof jsonb

- Shipped in 202608310005. COMM-307, closing COMM-P05. **Both halves are now
  in.** The client half landed in `cloud.js` in the same ticket: the
  trained-with-you card in COMM-115's feed top area, the follow action reusing
  `follow()` (COMM-230) and the `classmates_card_viewed` event. See "The
  client's side of this contract" at the end of this entry.
- Purpose: "who else trained today". Members other than the caller who have an
  `attendance_log` row for `current_date`, returned only when the caller has
  one too.
- Params: `p_limit`, clamped 1..20, null means 6. The forward reference named a
  zero-argument function; the parameter is defaulted, so that call form still
  resolves verbatim — the same accommodation COMM-301 made when it gave
  `relationship_score()` a defaulted `p_as_of`. 6 is a card-sized number for
  COMM-115's feed-top slot, where `people_suggestions`' 10 is a horizontally
  scrolling strip. The clamp range is the server's and is fixed; the default
  inside it is the client half's to revisit by passing an argument.
  **There is deliberately no viewer parameter**, the same refusal
  `classmate_day_counts()` documents and for the same reason: this function
  only ever answers for `auth.uid()`.
- Returns `setof jsonb`, one object per candidate, exactly four keys:
  `{user_id, display_name, handle, avatar_url}`. No date, no time, no count,
  no streak, no session detail — a caller learns that these members trained
  today and nothing about any other day. Those four keys are also exactly the
  header `community_profile` already returns to any member for any member.
- **"Today" means `occurred_on = current_date` on both sides of the self-join,
  and nothing else.** No window, no lookback, no count — that is the entire
  distinction from `classmate_day_counts()` (COMM-302), which answers "how
  often do these two train together" over 60 days. This function is written
  out rather than layered on that helper because reusing it would mean asking
  for a 60-day overlap and discarding 59 days of it, and would return members
  who trained beside the caller last week and not today. What *is* reused, to
  the letter, is the privacy gating. `current_date` is the server's UTC day,
  the same day `attendance_log`'s trigger compares against.
- The caller's own `current_date` row is the anchor: no row, no rows returned,
  which the join does on its own rather than by a separate check.
- Ordered most recently recorded first (`attendance_log.recorded_at`), then by
  display name falling back to handle, then by id — a total order, so the cut
  at `p_limit` is deterministic. Every member in the set trained today, so
  there is no signal to rank them by and the order is a choice: the card is a
  post-class moment, so the members who logged closest to the caller's own log
  are the likeliest to have been in the room, and in a club bigger than
  `p_limit` an alphabetical cut would show the same few members every day.
  `recorded_at` is when the row was written, not when the member trained —
  `attendance_log` records a day, not a time — which is why it is only the
  first key of a total order and not a claim the card makes.
- Privacy, per candidate: `can_view_profile_field(candidate,
  'show_attendance')`, the identical call `classmate_day_counts()` makes,
  applied after the candidate set is built for the identical reason. Block
  edges in both directions, deleted profiles and `visible_to_club` all fall
  out through that one call and are not re-implemented. `show_attendance`
  **defaults to false**, so out of the box this card is empty for everybody. A
  member with it off still logs attendance and it still counts toward their
  own achievements (COMM-305) and leaderboard rank (COMM-306). The `is_admin()`
  short-circuit applies to this gate as it does everywhere else.
- **Privacy, the caller's own toggle: enforced here, in the function.** A
  caller whose own `show_attendance` is off gets an **empty set** — the whole
  card, not a shorter one — which is COMM-307's "off means the card never
  renders for them, even though their own attendance is still logged and still
  counts elsewhere". It is not left to the client: every boundary in this
  module is enforced server-side rather than by a UI check, and this one is a
  reciprocity rule (every member on the card has opted into being seen
  training, so a member who declined that must not read the list).
  - It is a **direct `profiles.show_attendance` column read, not
    `can_view_profile_field(auth.uid(), 'show_attendance')`**, and that is
    load-bearing: the helper returns true for `p_target = auth.uid()` before
    it consults any toggle (the property `feed_leaderboard` relies on to keep
    a member on their own board), so asking it about the caller would always
    answer true and the gate would silently do nothing.
  - One consequence, stated rather than discovered: the direct read does not
    carry the `is_admin()` short-circuit, so an admin who never opted in gets
    an empty card like anybody else. The short-circuit exists so staff can see
    members' data, not to opt an admin into a reciprocal surface they
    declined. It still applies in full to the per-candidate gate.
  - **Empty, never a raise.** The card is already specified to render nothing
    at all when the member has not trained today or nobody else has
    (COMM-232's "on no signal, show nothing", which COMM-307 adopts by name),
    so the three ways to get no card — did not train, trained alone, opted
    out — are indistinguishable from outside and no client branch or error
    path is added.
- Self is excluded.
- No `allow_follows` filter and no `allow_follows` key, deliberately unlike
  `people_suggestions`: this is not a follow strip, it is "who trained today",
  and hiding a classmate who simply does not want followers would be wrong.
  The card's Follow control is the client's render decision, and the
  `follows_insert_self` policy (202608280003) enforces `allow_follows`
  server-side regardless.
- Auth: `security definer`, raises `not authorized` for a null `auth.uid()` or
  a caller with no `my_role_code()`, both checked before anything is read.
  `authenticated` may execute; `public` and `anon` are revoked. Definer crosses
  exactly one boundary, the one `people_suggestions` already documents:
  `attendance_log`'s policies are own-row plus staff (202608310001), so
  without elevation this could only ever return the caller's own row, which is
  the one row it excludes.
- Side effects: none, `stable`.
- Backed by `attendance_log_club_day_idx` (202608310001), which named this read
  when it was created.
- **The client's side of this contract** (`cloud.js`, COMM-307's client half):
  - One call per feed session, `p_limit: 6` passed explicitly rather than
    defaulted — the clamp is the server's, the number the card wants lives at
    the card. Issued from `afterRenderCommunity()` when the Feed sub-tab is on
    screen, on the same lazy pattern the consistency board and the directory
    use, **not** from `refreshSession()`'s boot batch: the member's own row for
    today is written by the `private_records` trigger behind `flushOutbox()`,
    which runs after that batch, so a boot-time call could ask before the row
    that anchors the join exists.
  - **Empty, failed and not-yet-answered all render nothing** — no heading, no
    empty state, no retry, no skeleton. `people_suggestions`' own error choice,
    and COMM-232's "on no signal, show nothing" for the empty case. The client
    does not try to tell the three server-side empties apart and has no
    client-side notion of "today" at all.
  - **The Follow control is rendered for every row**, unlike
    `memberRowHtml()`/`followListRowHtml()`, which guard on `allow_follows`.
    That is a direct consequence of the "no `allow_follows` key" decision two
    bullets up: there is nothing to guard on, `follows_insert_self` refuses the
    insert server-side, and `follow()` already surfaces a refused write the
    same way it does everywhere else. No pre-filter, so no other member's
    setting leaks into the card.
  - **No Message affordance**, per the phase's standing no-messaging
    resolution.
  - `classmates_card_viewed` (`rows`, `source`) fires once per load of the
    card, from the render hook rather than the fetch, and only when the card is
    on screen with rows on it. Not in `ACTIVE_MEMBER_EVENTS` — see
    `docs/community/metrics.md`.
  - Covered by `test/community-classmates-today.test.mjs`.

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

### leaderboard_row composite type

- Shipped in 202608290015. `(user_id uuid, display_name text, handle text,
  avatar_url text, rank integer, value numeric, is_self boolean)`, exactly the
  shape this file promised the feed cluster.
- A composite type rather than jsonb because a leaderboard is a table: every
  row has every column. `community_profile` is jsonb for the opposite reason,
  an absent key there means hidden.
- `chal_progress`'s `leaderboard` key still builds its own simpler
  `{user_id, name, handle, avatar_url, value}` objects (202608290003) and is
  deliberately untouched. Widening it to this type is an additive follow-up,
  not a break.

### feed_leaderboard(p_mode text, p_challenge_id uuid, p_scope text, p_limit int) returns setof leaderboard_row

- Shipped in 202608290015. COMM-210, COMM-211, COMM-212. Defaults are
  `p_challenge_id null`, `p_scope 'club'`, `p_limit 50`; `p_mode` has no
  default, so a typo cannot silently become the consistency board.
- Purpose: one ranked board for both modes and both scopes, with the caller's
  own standing always included.
- Params. `p_mode` is `consistency` or `progress`, `p_scope` is `club` or
  `friends`, both matched case-insensitively after trimming; anything else
  raises `unknown leaderboard mode %` or `unknown leaderboard scope %` naming
  the value. `p_limit` clamps to 1..100 (null means 50).
- `consistency` ranks club members by consecutive ISO weeks with a logged
  session, the same number `community_profile` returns as `current_streak`.
  `p_challenge_id` is ignored. The computation lives in
  `public.consistency_week_streaks()` (internal, no grants) so it exists once
  set-wide; `community_profile` keeps its own inline copy because merged
  migrations are not edited, and `0034_feed_leaderboard_and_suggestions_test`
  asserts the two agree on the same member (`0040` widens that to every member
  on the board at once). Since COMM-306 (202608310004) "a logged session" means
  an `attendance_log` day, not a posted workout; this signature, and everything
  else in this entry bar the privacy line below, did not move.
- `progress` ranks `challenge_participants.progress_value` for one challenge,
  participants with status `withdrawn` excluded. `p_challenge_id` is required:
  null raises `challenge required`, an unknown id raises `challenge not
  found`, and a draft challenge raises `challenge not found` for anyone but
  its creator or a `community.challenge.create` holder, so the board is not an
  existence oracle. In this mode the caller gets a row only if they are a
  participant; there is no standing in a challenge you did not enter, and that
  is the one case where the always-return-self rule cannot apply.
- `friends` restricts the ranked set to `are_friends()` (mutual follow) edges,
  always still including the caller.
- Every ranked member passes `can_view_profile_field(member,
  'in_leaderboards')` and `can_view_profile_field(member, 'visible_to_club')`,
  and in `consistency` mode `can_view_profile_field(member,
  'show_attendance')` as well (COMM-306, 202608310004 — the value being ranked
  is verified attendance, which carries its own toggle). A member who fails any
  of the three is **absent from the ranked set, not ranked at 0**: on a board
  where 0 is a real value, publishing a 0 for an opted-out member would state
  something false about them rather than withhold something true. The
  `show_attendance` gate is not applied in `progress` mode, which ranks a
  challenge and has nothing to do with attendance. All three are self-exempt,
  so the always-return-self rule below is unaffected by any of them.
  Blocks are not re-implemented: that helper settles a block edge in either
  direction before it looks at any toggle. Its is_admin() short-circuit
  applies here too, so a real admin's board includes members who opted out;
  that is the module-wide behaviour of the resolution point, not a leaderboard
  rule.
- `rank` is a position, never shared and never gapped. Ties break by longer
  club tenure (`invite_redemptions.redeemed_at`, falling back to
  `profiles.created_at`), then alphabetically by display name (falling back to
  handle), then by id.
- Every eligible member is ranked, including a 0-week streak or 0 progress,
  because a rank is only real if the caller is inside the ranked set.
  COMM-210's "not enough data yet" empty state is therefore "no rows returned,
  or every returned `value` is 0", not "no rows returned".
- The caller's own row is always returned, appended last (after the top
  `p_limit` rows, in rank order) with its real rank when it falls outside the
  limit, so "where do I stand" is never a second round trip. COMM-212's "hide
  my result" is a client-only render choice on top of that row, not a
  parameter. The real, server-enforced opt-out is `in_leaderboards`, and it
  never hides the caller from themselves.
- Returns rows in board order, self last when appended. Club scope has no
  `club_id` filter, matching every other Phase 2 read function; the module is
  single-club today.
- Auth: security definer. Raises `not authorized` for a null `auth.uid()` and
  for a caller with no `my_role_code()`. Definer buys two things and no more:
  the caller's own row when their `visible_to_club` is off, and a streak count
  over posts the viewer cannot read one at a time (the same trade
  `community_streaks` already makes).
- Side effects: none.

### people_suggestions(p_limit int default 10) returns setof jsonb

- Shipped in 202608290015. COMM-232. Re-created in 202608310003 (COMM-302)
  with the **same signature** and an **additive** returned shape.
- Purpose: "אנשים שאולי תכירו" for the directory strip.
- Ranks candidates by, in priority order and lexicographically (one shared
  challenge outranks any number of shared training days, and any number of
  shared training days outranks any number of shared reactions):
  1. shared participation in a live challenge (`challenges.status = 'active'`
     and `end_at >= now()`);
  2. **shared training days** — calendar days both members have an
     `attendance_log` row for, from `classmate_day_counts()` (COMM-302);
  3. `feed_interactions` of kind `react` or `comment` on the same post by
     both members;
  4. `event_attendees` with response `going` on the same event by both.

  Ties break by display name (falling back to handle), then id. Position 2 is
  a product decision COMM-302 states rather than derives: recurring
  in-person overlap outranks a shared reaction or a shared "going" RSVP,
  because actually training beside someone repeatedly is a stronger reason to
  know them than tapping the same post once; it does not outrank a shared
  live challenge, which is a joint commitment with a deadline that both
  members opted into by name.
- The trailing 60-day window applies to three of the four signals
  (`feed_interactions.created_at`, `event_attendees.registered_at`, and
  `attendance_log.occurred_on` — the last stated inside
  `classmate_day_counts()`), on both sides of the pair. The challenge signal
  is bounded by the challenge being live instead, since an active challenge
  that started 90 days ago is current by definition.
- The classmate signal is additionally gated on
  `can_view_profile_field(candidate, 'show_attendance')`, inside
  `classmate_day_counts()` rather than here, so the gate cannot be applied
  differently in the two functions that use it. A candidate with attendance
  private is not merely ranked lower: they contribute no classmate signal at
  all, and if attendance was their only overlap with the caller they get no
  card. Their `attendance_log` rows still exist and still count for them.
- Excludes the caller, any follow edge in either direction, and anything
  `can_view_profile_field(candidate, 'visible_to_club')` or
  `can_view_profile_field(candidate, 'allow_follows')` rejects, which also
  settles block edges in both directions and deleted profiles. A candidate
  with no qualifying signal is not returned at all, so a brand new member gets
  a genuinely empty strip rather than a padded list.
- Returns `setof jsonb`, one object per candidate:
  `{user_id, display_name, handle, avatar_url, reason, signals}` where
  `reason` is the advisory label of the strongest signal (`challenge`,
  `classmate`, `interaction`, `event`) and `signals` is
  `{shared_challenges, shared_classmate_days, shared_interactions,
  shared_events}` integer counts. The ranking score itself is internal and
  not returned.
- **The COMM-302 change to this shape is additive only.**
  `shared_classmate_days` joined `signals`; `shared_challenges`,
  `shared_interactions` and `shared_events` keep their names and their
  meanings, so a client reading any of them needs no change. `reason` gained
  one possible value, `'classmate'`. That is exactly what 202608290015's own
  migration comment promised ("without renaming or removing a key any client
  is already reading"), and no client changed for COMM-302.
- `p_limit` clamps to 1..20 (null means 10).
- Auth: security definer, raises `not authorized` for a null `auth.uid()` or a
  caller with no `my_role_code()`. Definer crosses two boundaries on purpose:
  `feed_interactions` is self-select only, and `attendance_log`'s policies are
  own-row plus staff (202608310001), so no member could compute either kind of
  overlap otherwise. Only counts leave the function — never a post id, never
  an event id, never a date somebody trained.
- Side effects: none.
- COMM-307 (Phase 3) added a *different* attendance surface,
  `attendance_classmates_today()`: "who trained today", not "who to follow".
  **Shipped in 202608310005 and it did not change this function** — no
  signature, no key, no ordering here moved. Its contract is above.

### consistency_week_streaks() returns table(user_id uuid, streak integer)

- Shipped in 202608290015, re-created in 202608310004 (COMM-306) on the same
  signature. Internal, security invoker, **no grants at all** — not to `anon`,
  not to `authenticated`. `feed_leaderboard` is its only caller and it inherits
  that definer's rights, which is also how it reads every member's days past
  `attendance_log_self_select`.
- Purpose: the set-based form of `community_profile`'s `current_streak`, so
  the streak is computed once for every member instead of per member in a
  loop. Arithmetic: distinct ISO weeks carrying at least one
  `attendance_log.occurred_on` day, anchored on the member's latest such week,
  counted back while each week is exactly 7 days before the previous, and only
  when the anchor is the current week or the previous one. A week not trained
  does not break the streak while the anchor still qualifies.
- COMM-306 changed the source and nothing else: it read distinct ISO weeks
  carrying a POST_WORKOUT or POST_PR until 202608310004. That is the change
  this entry promised, made in the one place it promised to make it.
- A member with no `attendance_log` row is **absent from the returned set**,
  not a zero row. Every caller left-joins and coalesces, so zero-is-real is
  the caller's rule to keep, and both callers keep it.
- **Carries no privacy filter**, deliberately unlike `classmate_day_counts()`
  (202608310003), which folds `show_attendance` into itself. That helper's two
  callers both want an opted-out member to read as absent; this one's caller
  has to *exclude* the member from a ranked set instead, and a gate here would
  produce exactly the coalesced 0 COMM-306 rules out. `feed_leaderboard`
  applies `can_view_profile_field(member, 'show_attendance')` itself.
- Not a second definition of "streak": `0034` pins it to
  `community_profile`'s number for the caller and `0040` for every member on
  the board, so the two copies cannot drift.

### Leaderboard and suggestions client contract, COMM-210 to COMM-212, COMM-232

- One fetch path and one row renderer serve every board in the client. Rows are
  rendered in the order `feed_leaderboard` returned them and are never
  re-sorted, re-ranked or re-filtered; the printed position is the row's `rank`
  column, never an array index, because the caller's appended row's index is
  not its position.
- Three surfaces, two of them new:
  - Boards sub-tab, "טבלת עקביות": `consistency`, `p_limit 50`. Replaces the
    older `community_streaks` strip that used to sit there. `loadStreaks()` and
    `state.streaks` remain for the coach Welcome surface, which reuses the same
    per-member figure.
  - Challenge detail panel for `individual_performance` and `coach`:
    `progress`, `p_limit 20`, fetched inside `refreshChallengeView()` before the
    dialog drops its loading flag so the board and the detail land in one paint.
    This replaced the panel's earlier read of `chal_progress()`'s own
    `leaderboard` key. That key is unchanged and still shipped, per the
    `leaderboard_row` entry above; the client simply no longer reads it.
  - The same panel re-asking with `p_limit 50` is COMM-211's "dedicated full
    leaderboard screen": one code path and one set of states rather than a
    second surface.
- Empty states follow the contract's zero rule, not the row count: "no rows OR
  every `value` is 0". The friends-scope empty state is narrower still - the
  caller is always returned whatever the scope, so "no mutual follows yet" is
  "no row that is not mine", not "no rows".
- `p_scope` is the only thing the scope switch changes. A stale in-flight
  answer for the previous scope is dropped rather than painted.
- "Hide my result" is `state.hideMyLeaderboardResult`, a per-device
  localStorage flag (`haimunia-demo:hideMyLeaderboardResult`, default off,
  stored the same way `syncEnabled` is). It filters the caller's row out of the
  render and does nothing else: no request, no parameter, no write. It is
  deliberately worded in the UI so it cannot be mistaken for `in_leaderboards`,
  which is the real, server-enforced opt-out and stays in the Privacy panel.
- COMM-232's strip renders `people_suggestions(10)` in the order returned, with
  an advisory Hebrew label per `reason`. Follow reuses the same `follow()`
  insert-or-delete path the search UI's follow button uses; the card is dropped
  locally afterwards because the server already excludes a follow edge in
  either direction. On error the strip is omitted entirely - no heading, no
  empty state, no retry - which is deliberately unlike every other surface in
  this module.
- Two forward-looking markers, both `TODO(COMM-231)` in `cloud.js`: the
  suggestions strip is mounted on the Account sub-tab under COMM-228's search
  UI, and COMM-212's friends empty state routes to that same search, because
  the members directory does not exist yet. Both should point at the directory
  once it ships.

## Needs from schema, feed (Phase 2)

Nothing outstanding. `leaderboard_row`, `feed_leaderboard`,
`people_suggestions` and `consistency_week_streaks` all shipped in
202608290015; their contracts are the four entries directly above, under
"## Feed". COMM-210, COMM-211, COMM-212 and COMM-232 point at this heading and
should read those entries instead.

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
  display string, sessions per week over the last 28 days, omitted at zero)
  and `recent_workouts` (`[{title, date}]`, up to 5). Both read
  `workout_posts` directly and answer "what did this member choose to share",
  which is why COMM-306 left them exactly as they were.
- Present only when `show_workout_results` **and** `show_attendance` both
  pass: `current_streak` (consecutive ISO weeks with an `attendance_log` day,
  the same number `consistency_week_streaks()` computes set-wide; a week not
  yet trained does not break it; 0 for a member with no attendance days,
  never an error). Since 202608310004, COMM-306. The second toggle is the one
  addition that ticket's own outline did not name: the number is now derived
  from attendance, so it may not travel past attendance's own toggle — the
  rule 202608310001 wrote down for every member-facing Phase 3 reader. It also
  keeps this function and `feed_leaderboard` saying the same thing about the
  same member, since an opted-out member is absent from the board. Absent key
  means hidden, as everywhere else here, and the client already renders it as
  no row rather than a blank.
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
- Every number here except `current_streak` is derived from posts the member
  published. A member who trains and never posts reads as zero in those. Since
  COMM-306 (202608310004) `current_streak` is the exception and comes from
  verified attendance, so the reverse also holds: a member who trains and
  never posts has a real streak and no `training_frequency`.

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
  `count`, plus `member_id` (produced since 202608310007, COMM-305; the
  renderer reads only the first two, `member_id` is what the producer's own
  "already posted" guard matches on).

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
  are not repeated and stayed `enabled = false` until COMM-P03. **They are
  `enabled = true` since 202608310007 (COMM-305), which gave them a
  producer.** None of the four carries a `client_claimable` key and
  `ach_claim` refuses them on `trigger_type` regardless — enabling them
  widened nothing on the claim path.

## Needs from schema, achievements

Functions the achievements cluster (COMM-130 to COMM-134) relies on and that
schema still owns. No migration is written here.

- `ach_evaluate(user_id uuid, trigger text, payload jsonb)`, the service-role
  event-bus path. **Still not built**, and COMM-305 did not build it either:
  the four `ATTENDANCE_RECORDED` codes are evaluated by a direct table
  trigger instead (see "Needs from schema, attendance achievements" below),
  the same precedent `challenge_progress_apply` set for cooperative
  challenges. Everything community, challenge, and club shaped in the seed is
  `client_claimable: false` and unlocks only through `ach_evaluate`, so those
  rows still cannot be earned at all until it lands. Attendance is now the
  only trigger type with a real server-side producer.
- The `ACHIEVEMENT_UNLOCKED` consumer is an AFTER INSERT trigger on
  `public.member_achievements`, not a per-function emit. That way `ach_claim`
  and `ach_evaluate` produce one shape and neither can forget to fire. It
  needs `notif_create`, which notifications still owns, so it lands with that
  function. See "Needs from schema, notifications". **Confirmed live for
  attendance unlocks by COMM-305**: `member_achievements_notify`
  (202608280027) is `after insert ... for each row` with no `WHEN` clause and
  no filter on how the row got there, so an attendance-sourced unlock
  notifies exactly like a claimed one and COMM-305 wrote no notification code
  at all. Asserted, not assumed, in
  `supabase/tests/0043_attendance_achievements_test.sql`.

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

Schema the Phase 2 coach dashboard (COMM-223 to COMM-226) needs. Shipped by
schema in 202608290013; the three subsections below record what actually
landed, and where it differs from the ask stated here. Nothing in that
migration touches `coach_engagement_flags` (COMM-011): it ships empty in
Phase 2 too, per COMM-226, and is out of scope until COMM-304.

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

### coach_celebrate_feed(p_days int default 7) returns setof jsonb (202608290013)

- Purpose: the whole COMM-223 Celebrate list in one call, and the source of
  the items COMM-225's Congratulate action acts on.
- Params: `p_days integer`, default 7, clamped to 1..30 rather than
  rejected; null falls back to 7. Anything outside the range is silently
  clamped, because a bad number here is a client bug and not something worth
  an error toast in front of a coach.
- Returns: `setof jsonb`, newest first, capped at 100 rows. Each row is a
  flat, self-describing object, no joins to make on the client:
  `{ kind, user_id, handle, display_name, avatar_url, occurred_at, post_id,
  detail }`.
  - `kind` is `'pr'`, `'anniversary'`, or `'challenge_completion'`.
  - `occurred_at` is the PR's `created_at`, the anniversary crossing
    (`redeemed_at + threshold days`), or `completed_at`.
  - `post_id` is the source post, and is null exactly when there is none.
    That is the flag COMM-225 branches on: non-null takes
    `add_post_comment`, null takes `post_create`.
  - `detail` is kind-shaped: `{movement, result}` for a PR (read from
    `metadata->>'movement'` / `metadata->>'new_result'`, falling back to
    `title` / `result_text`), `{code, title, years}` for an anniversary
    (`years` is a plain integer, not the numeric threshold), and
    `{challenge_id, title}` for a completion.
- Auth: SECURITY DEFINER, `auth.uid()` checked first, then `is_staff()`
  inline. Both failures raise `not authorized` (P0001), so a non-staff or
  unauthenticated caller is refused by the database and not only by a hidden
  nav item. Executable by `authenticated` only.
- Privacy: every row is subject to the subject member's own toggle, resolved
  through `can_view_profile_field()` — `show_prs` for a PR (plus
  `post_visible_to_viewer()` for the post's own followers/friends/block
  rules), `in_leaderboards` for a completion, `visible_to_club` for an
  anniversary. There is no anniversary-specific toggle and none was
  invented. A deleted profile, and a member on either side of a block edge,
  drop out. Celebrate surfaces what a coach could already see; it never
  bypasses a member's choice.
- Anniversaries reuse `ach_claim`'s tenure arithmetic exactly
  (202608290002): any enabled `achievement_definitions` row with
  `config->>'metric' = 'tenure_days'` and `threshold >= 365`, tested against
  `invite_redemptions.redeemed_at`, plus one window bound. A tenure
  definition added later is picked up with no further migration, and the day
  an anniversary appears here is the day `ach_claim` grants the badge.
- No birthday source is queried, and none exists to query.
- Side effects: none, the function is `stable`. No rate limit: it is a
  dashboard read by a staff-only caller.

### profiles.assigned_coach_id + coach_assign_coach (202608290013)

- `profiles.assigned_coach_id uuid references public.profiles(id) on delete
  set null`, nullable, with a partial index on the non-null rows. A coach
  leaving the club nulls their members' assignments rather than taking the
  rows with them.
- Correction to the ask above: "no policy change needed beyond the update
  grant already open to `authenticated`" was not true on this schema.
  `profiles` has exactly one UPDATE policy, `profiles_update_self`
  (202608270003), and it is `id = auth.uid()` on both sides — a coach's
  direct UPDATE of another member's row does not fail, it silently matches
  zero rows, which would have made "Assign coach" a button that appears to
  work and does nothing.
- Rather than widen the `profiles` UPDATE policy — which would let any coach
  rewrite any member's handle, display name, and every privacy toggle, and
  which is identity-privacy's call rather than a side effect of the coach
  dashboard — the migration crosses the boundary once, on purpose, in a
  function that can touch only this column:
  `coach_assign_coach(p_user_id uuid, p_coach_id uuid default null) returns
  uuid`.
  - Purpose: COMM-224 "Assign coach (optional)". Sets
    `profiles.assigned_coach_id` for `p_user_id`, or clears it when
    `p_coach_id` is null (so unassign needs no second function).
  - Returns the value written, i.e. `p_coach_id`.
  - Auth: SECURITY DEFINER, `auth.uid()` first, then `is_staff()` inline.
    Raises `not authorized` (P0001) otherwise. Executable by
    `authenticated` only.
  - Also raises: `member required` on a null `p_user_id`, `member not found`
    when the target does not exist or is deleted, and `assigned coach must
    be staff` when `p_coach_id` is not itself admin or rank >= 20 — the
    field means "which coach owns this relationship", so pointing it at a
    plain member would make every dashboard reading it lie.
  - Side effects: one UPDATE of one column on one row. No notification, no
    audit row, no analytics.
- `protect_is_admin()` (the existing BEFORE UPDATE trigger on `profiles`)
  now also pins `assigned_coach_id`, alongside `is_admin`, `club_id`, and
  `recovery_verified_at`. Without it a member could set their own assigned
  coach through the existing own-row update, and a field a member can set
  about themselves is not a coach assignment. The pin is lifted for exactly
  one statement by the transaction-local `app.allow_coach_assign` GUC, the
  same escape hatch `mark_recovery_verified()` uses and for the same reason:
  `auth.role()` still reads `authenticated` inside a definer function.
- Still open, for identity-privacy: `profiles_insert_self` does not require
  `assigned_coach_id is null`, so a member's first profile insert could
  carry a value. Closing that is a one-clause policy change on `profiles`
  and is left to identity-privacy rather than taken here. The narrower
  staff UPDATE policy the ask anticipates can also still replace
  `coach_assign_coach` later without changing the column's shape.

### member_contact_log (202608290013)

- Columns exactly as asked: `id uuid primary key default gen_random_uuid()`,
  `user_id uuid not null references profiles(id) on delete cascade`,
  `contacted_by uuid not null default auth.uid() references profiles(id) on
  delete cascade`, `contacted_at timestamptz not null default now()`, `note
  text not null default '' check (char_length(note) <= 500)`. Indexed on
  `(user_id, contacted_at desc)` and `(contacted_by, contacted_at desc)`.
  No `club_id`: the contract named five columns and this is the shape the
  client gets from `select *`.
- The client inserts `{user_id, note}` and never names itself —
  `contacted_by` defaults to `auth.uid()`.
- RLS, four policies:
  - `member_contact_log_staff_select`: `is_staff()`. Every staff member
    reads every row, which is what makes it coordination rather than a
    private note.
  - `member_contact_log_staff_insert`: `is_staff() and contacted_by =
    auth.uid()`. The same author pin every other insert policy in this
    schema carries; staff cannot log contact in another coach's name.
  - `member_contact_log_author_update` / `..._author_delete`: `is_staff()
    and contacted_by = auth.uid()`. Correcting or withdrawing an entry is
    the author's to do.
- No `user_id <> auth.uid()` clause anywhere, deliberately, and that is the
  one line where this table differs from `coach_engagement_flags`: a staff
  member may log contact with themselves here. Being welcomed is not a
  decline flag.
- Not member-readable in this ticket's scope: a plain member reads nothing,
  including the row about themselves. Adding a member-facing SELECT policy
  later is one line; removing a leak is not.
- `anon` has no grant on the table at all.

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
  no other file. COMM-300 (Phase 3) gave it one — `flushOutbox()` in
  cloud.js, payload `{occurred_on}` — and the prediction held: `eventbus.js`
  needed no change beyond its own comment. A consumer must not assume the
  emit is authoritative; `attendance_log` is written server-side by a trigger,
  independently, so an older cached build produces the row without the event.

### window.HaimuniaAnalytics, COMM-013

`src/analytics.js`. The only writer of `analytics_events`.

- `track(eventName, props)`, aliased as `window.analyticsTrack`. Returns a
  promise resolving true when the row was accepted. It never throws and
  never rejects: a dropped analytics row is acceptable, a broken button is
  not. Every call site may ignore the result.
- `EVENTS` frozen map of the tracked names from spec section 77: the 21
  Phase 1 names, plus `search_performed`, `push_opt_in`,
  `coach_congratulate_sent` and `directory_opened` from COMM-233, plus
  `attendance_recorded` from COMM-300. Also
  aliased as `window.ANALYTICS_EVENTS`. An unknown name is warned and
  dropped, it never reaches the table. COMM-233's `recap_viewed` and
  `recap_shared` are the already-reserved `weekly_recap_opened` and
  `weekly_recap_shared`, wired rather than renamed.
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
  CHALLENGE_COMPLETED, EVENT_REGISTERED, and ATTENDANCE_RECORDED from
  COMM-300. WORKOUT_COMPLETED, PR_CREATED, MEMBER_JOINED and
  ACHIEVEMENT_UNLOCKED are deliberately unmapped: completing a workout is not
  sharing one, and unlocking an achievement is not sharing it.
  ATTENDANCE_RECORDED was unmapped for a different reason until Phase 3 — it
  had no producer at all — and unlike WORKOUT_COMPLETED it is deduplicated to
  one emit per member per calendar day, which is what makes it genuinely
  one-to-one rather than a per-set firehose.
- `BUS_PROP_KEYS` is the per-event prop allow-list the bridge projects each
  payload through, with `projectBusPayload(productEvent, payload)` doing the
  work. A bus payload is built for its consumers, not for this table, so a
  key that is not on the list is dropped and an array prop is stored as its
  length (`mentions` becomes `mention_count`). That is what keeps the props
  shape a stable contract and keeps member-authored text out of analytics.
  A feature agent never hand-tracks one of the seven bridged names: the bridge
  already wrote the row, and a second call would double count.
- `HAND_PROP_KEYS` (COMM-233) is the same allow-list for the hand-tracked
  Phase 2 names, applied by `track()` itself through
  `projectHandProps(eventName, props)`. A key not on the list is dropped
  before the row is built, so no call site can attach challenge rules text,
  a recap sentence or the search query. Phase 1 names have no entry and pass
  their props through unchanged.
- `ACTIVE_MEMBER_EVENTS` and `isActiveMemberEvent(name)` are the qualifying
  subset for Weekly Community Active Members, spec section 78. COMM-233
  reviewed every Phase 2 name against it explicitly:
  `coach_congratulate_sent` (for the coach) and `weekly_recap_shared` count;
  `leaderboard_viewed`, `weekly_recap_opened`, `search_performed`,
  `directory_opened` and `push_opt_in` do not.
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

Shipped in `202608290011_recaps_and_onboarding.sql`. Covered by
`supabase/tests/0031_recaps_and_onboarding_test.sql`.

**Follow-up from COMM-220, `202608290012_notif_create_service_role.sql`:**
`notif_create()` (202608280026) is `revoke all ... from public, anon,
authenticated`, same as `default_club_id()` originally was. Every caller
until COMM-220 was a trigger owned by the migration owner, which Postgres
checks as an effectively unrestricted role - the missing `service_role`
grant never showed for the same reason `default_club_id()`'s didn't.
`recap_weekly` is the first caller that reaches `notif_create` over
PostgREST as the literal `service_role` role, which does have EXECUTE
checked for real; without this one-line grant every `recap_weekly`
notification call fails `42501` silently (the recap row itself still
lands - see the function's own try/catch). Found and fixed while building
and manually verifying COMM-220 against a fresh local stack; independently
confirmed with `has_function_privilege('service_role', ...)` before and
after.

### weekly_recaps

`id uuid pk`, `user_id uuid not null` → `profiles(id)` cascade, `club_id uuid
not null default default_club_id()`, `week_start date not null`,
`sessions_completed integer not null default 0`, `streak integer not null
default 0`, `prs jsonb not null default '[]'`, `achievements jsonb not null
default '[]'`, `challenge_progress jsonb not null default '[]'`,
`club_challenge_progress jsonb not null default '{}'`, `upcoming_event jsonb`
(nullable — null means no upcoming event), `generated_at timestamptz not null
default now()`.

- Unique `weekly_recaps_user_week_key (user_id, week_start)`. This is what
  makes `recap_weekly` idempotent per user per week: upsert with `on conflict
  (user_id, week_start) do update` and a rerun updates in place rather than
  duplicating.
- **`week_start` must be a Monday**, enforced by `check (extract(isodow from
  week_start) = 1)`. `recap_weekly` must key on the ISO week's Monday. A
  free-form date would make the unique key unique per date rather than per
  week, so two runs disagreeing about where the week starts would both
  insert. A non-Monday raises `23514`.
- Own-row select for `authenticated`, and nothing else. There is no insert,
  update, or delete grant or policy for any client, the owning member
  included. Only `recap_weekly`, running as service role (which bypasses
  RLS), writes it. `anon` cannot reach the table at all.
- A quiet week is a real row: the defaults give zeros and empty lists rather
  than nulls, so COMM-221 renders the quiet-week state without guessing.
- `club_challenge_progress` is aggregate club figures only, never a
  per-member breakdown — a recap naming who else trained would leak the
  attendance data COMM-316 has not been cleared to expose.
- `default_club_id()` is now also granted to `service_role`. `weekly_recaps`
  is the first table a service-role caller writes directly rather than
  through a security definer function, so the `club_id` default is evaluated
  as `service_role`; without the grant every `recap_weekly` insert would fail
  `42501`. `recap_weekly` can therefore omit `club_id` and let the default
  fire.

### onboarding_progress

`user_id uuid primary key` → `auth.users(id)` cascade, `welcomed_at
timestamptz`, `first_week_shown_at timestamptz`, `first_month_shown_at
timestamptz`. Null means "not shown yet".

- Own-row select and update for `authenticated`. The update is the client
  marking a step seen at render time. No insert grant and no delete grant, so
  a member cannot invent a fresh row — or delete and re-create one — to
  re-see a step.
- The FK is to `auth.users`, not `profiles`, because a redemption lands
  before the profile exists (`profiles_insert_self` requires the redemption
  to already be there).
- **Stamps are one-way.** Trigger `onboarding_progress_pin` (BEFORE UPDATE)
  pins `user_id` and every already-set timestamp to its previous value.
  Clearing or moving a stamp is accepted and silently has no effect rather
  than raising, so a benign double-write from two tabs, or a retry after a
  failed dismiss-write, is a no-op instead of an error on a new member's
  first day. Clients should treat mark-seen as fire-and-forget.
- There is no `joined_at` column here. The onboarding clock runs from
  `invite_redemptions.redeemed_at`, the module's authoritative
  `MEMBER_JOINED` timestamp, which the member can already read on their own
  row and which `ach_claim` already meters the anniversary achievements off.
- The two steps tied to first and third class attendance are not columns
  here; they land with COMM-316.

### seed_onboarding_progress()

- Trigger function, `security definer`. Fires as
  `invite_redemptions_seed_onboarding`, AFTER INSERT on
  `invite_redemptions`, one row per statement row.
- Purpose: seed exactly one `onboarding_progress` row at `MEMBER_JOINED`.
  `on conflict (user_id) do nothing`.
- Params: none (trigger). Returns: `trigger`.
- Auth rule: revoked from `public`, `anon`, and `authenticated` — not
  callable as an RPC. It carries no `auth.uid()` check by design: it acts on
  the row being inserted, not on the caller, and the real boundary is that no
  client can insert into `invite_redemptions` at all (only
  `redeem_invite_code()` can).
- Side effects: one `onboarding_progress` insert. INSERT-only on purpose —
  `grant_coach_role()` and `grant_coach_role_by_handle()` UPDATE
  `invite_redemptions` and move `redeemed_at`, and firing on those would
  reset onboarding for a member who has already been through it.
- The migration also backfills a row for every pre-existing redemption.

## Needs from schema, new-member post (COMM-107)

### post_new_member_on_join() (202608290014)

- Trigger function, `security definer`. Fires as
  `invite_redemptions_new_member_post`, AFTER INSERT on
  `invite_redemptions`, one row per statement row.
- Params: none (trigger). Returns: `trigger`.
- Purpose: the server-side producer for `POST_NEW_MEMBER`. COMM-107 shipped
  the enum label (202608280004), the nullable `author_id` that exists for it,
  and `renderNewMemberPostCard` in cloud.js back in Phase 1; the INSERT that
  creates the row was never built, which is what made COMM-224's coach
  "Welcome" button inert. This is that INSERT and nothing else.
- Auth rule: revoked from `public`, `anon`, and `authenticated` — not callable
  as an RPC. No `auth.uid()` check, same documented exception as
  `seed_onboarding_progress()`: it acts on the row being inserted, not on the
  caller, and the boundary is that no client can insert into
  `invite_redemptions` at all (only `redeem_invite_code()` can). A member also
  cannot hand-write an equivalent row directly — `posts_insert_self` still
  requires `author_id = auth.uid()`, so an authorless post is unreachable from
  any client key.
- Side effects: exactly one `public.workout_posts` insert, with
  `author_id = null`, `post_type = 'POST_NEW_MEMBER'`, `visibility = 'club'`,
  `status = 'active'`, `club_id = default_club_id()`,
  `source_type = 'member'`, `source_id = <the new member>`,
  `published_at = redeemed_at`, `occurred_on = redeemed_at::date`, and a
  Hebrew `body`. No notification, no profile write, no other table touched.
- `metadata` shape, fixed by the already-shipped renderer and by the fixture
  in `test/community-post-cards.test.mjs`:
  `{member_id: uuid-as-string, member_name: text (optional), joined_on:
  timestamptz-as-string}`. `member_id` is always present and is what
  `findNewMemberPost()` in cloud.js matches on. Nothing else is written into
  `metadata`.
- `member_name` is **optional and usually absent in production**. A redemption
  lands before the profile exists (`profiles_insert_self` requires the
  redemption row), so at trigger time there is normally no `display_name` and
  no `handle` to read. The function looks anyway — `display_name`, falling
  back to `handle` — and omits the key entirely when neither is available,
  rather than storing a placeholder. The client's existing fallback chain
  (`m.member_name || postAuthorName(post) || "חבר/ה חדש/ה"`) is what covers
  the absent case. Filling the name in later would mean a trigger on
  `profiles`, which is identity-privacy's call, not this migration's.
- Idempotency: a guard (`exists` on
  `metadata ->> 'member_id'` where `post_type = 'POST_NEW_MEMBER'`, backed by
  `workout_posts_new_member_metadata_idx`), deliberately not a unique index —
  a unique violation would abort the enclosing redemption and block a real
  person from joining the club over a duplicate feed post.
- INSERT-only, so promoting an existing member (`grant_coach_role()` and
  `grant_coach_role_by_handle()`, both UPDATEs) never re-announces them, and
  the one-arg `redeem_invite_code()`'s `on conflict do update` does not
  either.
- Fires for every redemption regardless of role, including a coach-code
  redemption. Only the promote-an-existing-member path is excluded, and it is
  excluded by the trigger event rather than by a role test.
- `invite_redemptions` now carries two AFTER INSERT ROW triggers, this one and
  `invite_redemptions_seed_onboarding`. Both fire on a single insert and
  neither depends on the other's output; `0033_new_member_post_test.sql`
  asserts both effects from one insert.
- **No backfill.** Unlike `onboarding_progress`, these rows are club-visible
  feed content, so backfilling every existing member would publish one
  arrival announcement per member at once for joins that happened months ago.
  Members who joined before 202608290014 therefore have no welcome post and
  cannot be welcomed through COMM-224; publishing historical welcomes is a
  product decision with a chosen schedule, not a migration side effect.

## Needs from schema, attendance (COMM-300, Phase 3)

Shipped in 202608310001. This is the whole attendance source; nothing reads
it yet. COMM-302, 304, 305, 306, 307 and 316 all read it once they exist and
none of them needs to know how it got populated.

### attendance_log (table)

- `attendance_log(id uuid pk default gen_random_uuid(), user_id uuid not null
  references profiles(id) on delete cascade, club_id uuid not null default
  default_club_id() references clubs(id), occurred_on date not null,
  source_record_type text, source_record_id text, recorded_at timestamptz not
  null default now(), unique (user_id, occurred_on))`.
- One row per member per calendar day. Three lifts logged on one day are one
  row, which is the entire point of the unique key.
- `source_record_type` / `source_record_id` are provenance, nullable, and
  deliberately not a foreign key: the `private_records` row they name may be
  soft-deleted or hard-deleted later without touching the attendance day.
  Nothing may join on them.
- Index `attendance_log_club_day_idx (club_id, occurred_on desc)` for the
  cross-member day-window reads COMM-302/304/307 will issue. The unique
  constraint already serves every own-history read.
- RLS enabled. `grant select` to `authenticated` and nothing else.
  - `attendance_log_self_select`: `user_id = auth.uid()`.
  - `attendance_log_staff_select`: `has_perm('community.analytics.view') or
    is_staff()`. Two separate permissive policies rather than one OR'd
    predicate, so a member's own read never pays for the permission lookups.
  - **No insert, update, or delete grant and no policy for any of the three,
    for any client role, admin included.** The trigger below is the only
    writer, the same shape `pins` and `notification_batches` use.
  - This policy pair is the staff/analytics boundary only. It is **not**
    gated on `can_view_profile_field(user_id, 'show_attendance')` — that
    toggle governs what one member may see about another, and every
    member-facing Phase 3 reader (COMM-302, COMM-306, COMM-307) must apply it
    in its own body.

### attendance_session_record_types() returns text[]

- Purpose: the session-bearing `private_records.record_type` set in one
  place, so the trigger's WHEN clause, the backfill, pgTAP and any later
  Phase 3 reader assert against the same value. Same reasoning as
  `notification_batch_window()`.
- Params: none. Returns: `text[]`, currently exactly
  `array['strength_entry', 'wod_entry']`.
- `language sql immutable`, `security invoker`, `search_path` pinned.
- Auth rule: revoked from `public`/`anon`, executable by `authenticated`.
  It exposes no data.
- Side effects: none.
- `bodyweight` and `measurement` are deliberately absent even though both
  carry a `date` key of the same shape: stepping on a scale is not training.
  `session_note` is absent because nothing in app.js writes it.

### attendance_parse_day(p_raw text) returns date

- Purpose: turn a client-owned `payload ->> 'date'` into a date, or null.
  The one place that decision is made, shared by the trigger and the
  migration's backfill.
- Params: `p_raw text`. Returns: `date`, or `null` for every rejection.
- `language plpgsql immutable`, `security invoker`, `search_path` pinned.
- Auth rule: revoked from `public`/`anon`, executable by `authenticated`.
- Side effects: none. **Never raises**, including on `'2026-13-45'`, which
  matches the shape regex and raises `22008` on a bare cast. A raise inside
  the trigger would wedge the source record in the member's offline outbox
  forever (`flushOutbox()` only deletes an outbox row after a successful
  upsert), so nothing on this path is allowed to throw.
- Accepts exactly `^\d{4}-\d{2}-\d{2}$` plus a successful cast — the same
  shape `cleanISODate()` in `src/sanitize.js` guarantees, re-asserted
  server-side because `private_records` takes a direct RLS insert and the
  payload is member-controlled.

### attendance_log_from_record()

- Trigger function, `security definer`. Fires as
  `private_records_attendance_log`, AFTER INSERT OR UPDATE on
  `private_records`, one row per statement row, with
  `when (new.deleted_at is null and new.record_type = any
  (attendance_session_record_types()))`.
- Params: none (trigger). Returns: `trigger`.
- Purpose: derive one `attendance_log` row per member per calendar day from
  the member's own existing offline sync. There is no new client call and no
  new affordance — a member on a months-old cached build produces attendance
  rows the moment their existing sync runs.
- `occurred_on` comes from `payload ->> 'date'` via `attendance_parse_day()`.
  Confirmed against the real producer, not assumed: `queueSyncRecord()` in
  app.js sets `payload: record` (the whole local record object, unwrapped)
  and `flushOutbox()` in cloud.js forwards it unchanged, so for the two
  session types the payload is whatever `sanitizeEntry()` /
  `sanitizeWodEntry()` returned — both of which carry the logged day as a
  top-level `date` key already through `cleanISODate()`.
- Auth rule: revoked from `public`, `anon`, and `authenticated` — not
  callable as an RPC, reachable as a trigger and nowhere else. No
  `auth.uid()` check, the same documented exception `notif_queue_batched()`,
  `seed_onboarding_progress()` and `post_new_member_on_join()` record: it
  acts on the row being inserted, and that row was already pinned to the
  caller by `private_records_self_insert` / `private_records_self_update`,
  which is a stronger check than re-reading `auth.uid()` here. An
  `auth.uid()` gate would also break the migration's own backfill and any
  future service-role repair, both of which legitimately have no session.
  It is `security definer` for exactly one reason: to cross the
  no-client-write boundary on `attendance_log` on purpose.
- Side effects: at most one `attendance_log` insert, `on conflict (user_id,
  occurred_on) do nothing`. Nothing else. It never updates and never deletes.
- Four ways it produces no row, all silent, none of them an error:
  1. `attendance_parse_day()` returned null (missing, malformed, or
     impossible date).
  2. `occurred_on > current_date + 1`. The future-date rule: **refused, not
     clamped.** The table is append-only, so a wrong day could never be taken
     back, and clamping to today would invent a training day the member never
     claimed. The refusal is of the attendance row, not of the transaction —
     a member with a broken clock loses the credit for that entry, not the
     ability to sync their training log. One day of slack is deliberate:
     `current_date` is the server's UTC day and the client writes a local
     calendar day, so an Asia/Jerusalem member training at 01:00 legitimately
     logs "tomorrow" in UTC; zero slack would drop those entries nightly.
  3. No `profiles` row for `new.user_id`. `private_records.user_id`
     references `auth.users` while this table references `profiles`, so a
     member inside the COMM-016 gate window can legally hold private records
     with no profile to point at. Skipping is the only correct answer; the
     alternative is a foreign key violation that breaks their sync.
  4. The WHEN clause did not match (non-session `record_type`, or
     `deleted_at` set).
- Append-only, matching the `challenge_progress` "correct forward, not
  backward" precedent: a later soft-delete of the source record does not
  retract a day already logged, and a soft-delete UPDATE is a no-op rather
  than a re-log.
- AFTER INSERT **OR UPDATE**, not INSERT-only: `flushOutbox()` upserts on
  `(user_id, record_type, record_id)`, so a record that already exists
  server-side arrives as an UPDATE. INSERT-only would miss every edited entry
  and every re-sync from a second device.

### Backfill (202608310001)

- The migration backfills one row per member per day from the
  `private_records` rows that already existed, under the same four rules,
  `distinct on` the earliest `created_at` so `source_record_*` matches what
  the trigger would have written.
- Not in COMM-300's migration outline; added deliberately. Without it every
  existing member's attendance history starts at zero on deploy day and
  COMM-306's consistency board and COMM-304's decline detection both read a
  club that has apparently never trained. It is also strictly safer here than
  later: COMM-305 adds an AFTER INSERT trigger on `attendance_log` that mints
  achievements and posts milestones, and that trigger does not exist yet, so
  this backfill cannot spam anybody's feed. Run after COMM-305, the same rows
  would.

### Client side (not a migration)

- `flushOutbox()` in cloud.js emits
  `HaimuniaEvents.emit(PRODUCT_EVENTS.ATTENDANCE_RECORDED, {occurred_on})`
  after a successful `private_records` upsert of a non-deleted
  `strength_entry` / `wod_entry` whose payload date matches
  `^\d{4}-\d{2}-\d{2}$`. `ATTENDANCE_RECORDED`'s first producer since
  COMM-012 defined it in Phase 0.
- Deduplicated to one emit per `(user id, occurred_on)` for the life of the
  page, mirroring the unique key server-side.
- **This emit is a courtesy for client consumers and the analytics bridge.
  It is not what writes `attendance_log`** — the trigger does that,
  independently, from the same upsert. Nothing downstream may depend on it
  firing for correctness: a member on an older cached build produces the
  table row and no event. `attendance_log` is the source of truth for
  attendance; the event is the source of truth for WCAM.
- `attendance_recorded` is added to `HaimuniaAnalytics.EVENTS`, bridged from
  `ATTENDANCE_RECORDED` through `BUS_EVENT_MAP`, projected by `BUS_PROP_KEYS`
  to `["occurred_on"]` only (no workout title, no result text), and added to
  `ACTIVE_MEMBER_EVENTS` (WCAM). Documented in `docs/community/metrics.md`,
  which now closes its own "Still not wired: Attendance" line.

### What "verified attendance" means

Every later Phase 3 ticket title that says "verified attendance" means
"derived server-side from the member's own private training log, not proxied
through an optional public post-share" — the same trust boundary
`private_records` already has. It is not a physical check-in, not
staff-confirmed, and a determined member could still misdate a local entry
before it syncs. That is the accepted shape of the 2026-08-30 resolution, not
a gap this ticket left open.

## Needs from schema, attendance achievements (COMM-305, Phase 3)

Shipped in 202608310007, closing the parked COMM-P03. Two new functions, one
trigger, one index, one `UPDATE` to four seeded rows. No new table, so no new
RLS policy; no new client call and no changed signature anywhere, so nothing
on the client side moved.

### achievement_definitions, the four attendance rows

- `update public.achievement_definitions set enabled = true where trigger_type
  = 'ATTENDANCE_RECORDED' and not enabled`. Keyed on `trigger_type`, not on a
  list of four codes, so a fifth attendance-triggered definition is enabled by
  its own seed row. Idempotent.
- The thresholds are unchanged and are now load-bearing rather than
  decorative: `attendance_first_class` 1, `attendance_25_classes` 25,
  `attendance_100_classes` 100 (all `repeatable = false`),
  `attendance_weekly_streak` 4 (`repeatable = true`). The trigger below reads
  every one of them from this table and keeps no second copy, so re-tuning a
  milestone is an `UPDATE` to one row and adding a fifth is an `INSERT`.
  Disabling a row stops its unlocks immediately.
- Still never client-claimable. `ach_claim`'s `d.trigger_type <>
  'ATTENDANCE_RECORDED'` (202608280020, re-created unchanged in 202608290002)
  is untouched by this ticket. Before COMM-305 an attendance code was refused
  twice over — disabled *and* attendance-triggered — so 0043 re-asserts the
  refusal now that only one of the two reasons is left, including for a
  caller who has genuinely reached the milestone and for the repeatable code,
  where an accepted claim would have written a second row rather than being
  absorbed by the once-per-code index.

### attendance_week_streak(p_user uuid, p_exclude_day date default null) returns integer

- New, internal, `security invoker`, `stable`. No grant to any role
  (`revoke all` from `public`, `anon`, `authenticated`) — the same shape
  `consistency_week_streaks()` and `classmate_day_counts()` have. Only
  `attendance_milestones_on_log()` calls it, and it borrows that function's
  rights to read past `attendance_log_self_select`.
- Purpose: one member's current consecutive-ISO-week training streak over
  `attendance_log`, computed with **the same arithmetic
  `consistency_week_streaks()` (COMM-306) uses set-wide** — distinct ISO weeks
  carrying at least one attendance day, anchored on the member's most recent
  such week, counted backwards while each week is exactly 7 days before the
  previous one, and only when the anchor is the current week or the previous
  one. A member with no attendance days, or whose most recent trained week is
  older than the previous week, is `0`.
- Params: `p_user`. `p_exclude_day` optionally drops one `occurred_on` day
  from the set, which is what lets an AFTER INSERT trigger ask what the streak
  was *before* the row it just saw. Excluding a day does not remove its week
  when another day carries it, which is the correct answer and falls out of
  the arithmetic rather than being special-cased.
- Auth rule: no privacy filter, deliberately and for a stronger reason than
  `consistency_week_streaks()` has: the number is only ever used to decide
  whether a member earned **their own** achievement, and `show_attendance`
  governs what other members are told, never whether a member's own training
  counts for them.
- Side effects: none, it is `stable`.
- It is a second copy of one rule, pinned rather than trusted: 0043 compares
  it against `consistency_week_streaks()` for every member of the fixture at
  once, the same drift-pin shape 0040 uses for `community_profile`'s inline
  copy.

### attendance_milestones_on_log()

- Trigger function, `security definer`. Fires as `attendance_log_milestones`,
  AFTER INSERT on `public.attendance_log`, one row per statement row, no
  `WHEN` clause.
- Params: none (trigger). Returns: `trigger`.
- Purpose: the evaluation COMM-305 needs, done inline off the source table
  rather than through the still-unbuilt generic `ach_evaluate` — the same
  precedent `challenge_progress_apply` (202608290004) set. It is the only
  producer of `POST_ATTENDANCE_MILESTONE`, a post type that had an enum label
  and a client renderer and no producer from Phase 1 until now.
- Auth rule: revoked from `public`, `anon`, `authenticated` — not callable as
  an RPC. No `auth.uid()` check, the same documented exception
  `attendance_log_from_record()`, `post_new_member_on_join()` and
  `notif_queue_batched()` record: it acts for `new.user_id`, on a row that
  reached `attendance_log` only through a `private_records` row already
  pinned to its owner by RLS. `security definer` for exactly two boundaries:
  `member_achievements` has no client insert grant or policy, and an
  authorless `workout_posts` row is unreachable through `posts_insert_self`.
- It takes `select ... for update` on the member's own `profiles` row before
  evaluating — the same serialisation `challenge_progress_apply` takes on its
  `challenges` row, so two attendance rows landing for one member in the same
  instant cannot both decide "not posted yet". It is the row the function has
  to read anyway for `show_attendance` and the display name.
- **Count milestones (non-repeatable).** Fires when the member's all-time
  distinct `occurred_on` count (`count(*)`, since the table is unique on
  `(user_id, occurred_on)`) reaches a definition's threshold and they do not
  already hold that code. "Do not already hold" is decided by `insert ... on
  conflict do nothing returning id` against `member_achievements_once_idx`,
  atomically, so a concurrent double-unlock is impossible and a lost race is
  swallowed. **This is state, not a delta**, and deliberately so: a
  `count = threshold` or `count - 1 < threshold` form reads like the ticket's
  sentence and holds for the production writer (one single-row insert per
  statement) but silently awards nothing for any multi-row insert, because
  Postgres queues AFTER-FOR-EACH-ROW triggers to the end of the statement and
  every row of a 30-row insert then sees a count of 30. The state form is the
  same shape `ach_claim` already uses for the same question, and is right for
  both paths.
- **Weekly streak (repeatable).** Fires only on a genuine fresh crossing:
  `attendance_week_streak(user, null) >= threshold and
  attendance_week_streak(user, new.occurred_on) < threshold`. Silent for every
  day of a run that already qualifies, silent for a second day inside a week
  already counted, and firing again on the fourth week of a later rebuilt
  streak — which is what "repeatable definitions write a fresh row each
  qualifying event" means here. There is no index that can express this, which
  is why the crossing has to be computed. Consequence, stated rather than
  buried: a **multi-row** insert into `attendance_log` awards no streak badge,
  because every row of the statement sees the whole statement and no single
  day's exclusion changes anything. A bulk import of history is not a training
  event; the production writer inserts one row per statement.
- A streak must be **live** to count, because `attendance_week_streak()`
  carries `consistency_week_streaks()`' anchor rule: back-filling four
  consecutive weeks that ended two months ago earns nothing, and that is the
  same number the member's profile and the consistency board show them.
- **Side effects, per crossing:** one `member_achievements` row, copying
  `visibility` from the definition. For a count milestone whose threshold is
  above the first-day threshold, additionally one `workout_posts` row —
  `author_id = null`, `post_type = 'POST_ATTENDANCE_MILESTONE'`,
  `visibility = 'club'`, `status = 'active'`, `club_id` from the attendance
  row, `source_type = 'member'`, `source_id = <the member>`,
  `occurred_on = <the day of the crossing>`, `published_at = now()`, and a
  Hebrew `body`. Nothing else is written; the `ACHIEVEMENT_UNLOCKED`
  notification comes from `member_achievements_notify`, not from here.
- `metadata` shape, fixed by the already-shipped renderer:
  `{member_id: uuid-as-string, milestone_label: text, count: integer}`.
  `renderAttendanceMilestonePostCard` in cloud.js reads `milestone_label` (its
  title line) and `count` (its result line) and nothing else;
  `member_id` exists for the idempotency guard, the same key name and role it
  has in `POST_NEW_MEMBER`. `milestone_label` is the **definition's own
  `name`**, so the feed post and the badge on the member's profile cannot
  announce two different things, and `count` is the definition's own
  `threshold`.
- **A first class is an achievement and not also a post.** Expressed as
  `threshold > 1` rather than as a code allow-list, so a future
  `attendance_250_classes` posts automatically and a future first-anything
  does not. This matches how every other unlock in the schema is celebrated:
  `ach_claim` writes a `member_achievements` row for a first PR and never a
  post, and a `POST_ACHIEVEMENT` exists only because the member deliberately
  shared it.
- **The privacy branch.** The post — and only the post — is gated on the
  member's own `show_attendance`, read as a direct `profiles` column, not
  through `can_view_profile_field()`, which is viewer-relative and answers
  true for the subject before consulting any toggle. Same direct read
  `attendance_classmates_today()` (202608310005) makes for the same question.
  The achievement is never gated on it: achievements carry their own
  `show_achievements`, applied by `member_achievements_read` and
  `community_profile`. `show_attendance` defaults to **false**
  (202608280003), so out of the box this trigger unlocks achievements for
  everyone and posts for nobody.
- **The toggle is a write-time gate and the moment is not replayed.** The post
  branch is reachable only on the call that actually wrote the achievement
  row, so a member who crossed 25 with attendance private and turns the toggle
  on months later gets no belated announcement on their next session. Same
  one-shot shape `post_new_member_on_join` has.
- Idempotency for the post: `exists` on a `POST_ATTENDANCE_MILESTONE` row
  already carrying that `metadata ->> 'member_id'` and that
  `metadata ->> 'count'` — read from `workout_posts` itself, exactly as
  `challenge_progress_apply` asks the same question, never from a second piece
  of tracking state that could drift from what was actually posted.
  Deliberately a guard and **not** a unique index, the reason 202608290014
  spells out: a unique violation here would abort the enclosing transaction,
  which is a member's training-log sync.
- Nothing in this function raises. A missing `profiles` row returns early. The
  standing rule from 202608310001 holds: nothing downstream of a member's
  training-log sync may abort that sync.
- Index: `workout_posts_attendance_milestone_metadata_idx` on
  `(metadata ->> 'member_id') where post_type = 'POST_ATTENDANCE_MILESTONE'`,
  mirroring the two 202608290004 and 202608290014 already added.
- **No backfill of achievements or posts**, for the reason 202608290014 gave
  about historical welcome posts. Migrations apply in order, so 202608310001's
  `attendance_log` backfill is finished before this trigger exists and no
  member is awarded anything at migration time. What does happen, and is
  deliberate: because the count branch reads state, a member whose backfilled
  history already stands at 60 days earns `attendance_first_class` and
  `attendance_25_classes` on their **next** logged session — once each, spread
  across the club as members sync, never as a burst. The feed side of that is
  bounded by `show_attendance` defaulting to false.

## Needs from schema, member of the week (COMM-315, Phase 3)

Shipped in `202609010001_member_of_week.sql`. One table, four functions, and
one widened `CHECK` on `admin_actions.action_type`. The forward reference
under "Needs from schema, coach-tools (Phase 3)" is closed by this section;
read this one.

The client half (the suggestion card, the publish control, the coach's-pick
form) is not in that migration and lands separately, the same two-phase split
the Phase 2 coach-tools cluster used.

### The rotation

Four categories, one per week, in this fixed order and never randomly:

| index | category | source of the candidate |
| --- | --- | --- |
| 0 | `consistency_streak` | `feed_leaderboard('consistency')` |
| 1 | `most_prs` | count of `POST_PR` posts in the week |
| 2 | `challenge_completion` | count of `challenge_participants` completions in the week |
| 3 | `coachs_pick` | none — free staff selection |

The index is **whole weeks since the epoch Monday `2026-01-05`, modulo 4**,
not the ISO week number. ISO week number mod 4 was the example COMM-315
offered and it is not a cycle: an ISO year has 52 or 53 weeks, so at every
53-week year (2026 is one) the sequence runs week 52 → index 0, week 53 →
index 1, week 1 of the next year → index 1 again, repeating a category two
weeks running, silently, every few years. Counting weeks from a fixed Monday
has no year boundary in it. The modulo is written `((x % 4) + 4) % 4` because
Postgres's `%` keeps the sign of the dividend, so weeks before the epoch
resolve correctly rather than falling off the `case`.

### member_of_week_category(p_week_start date) returns text (202609010001)

- Purpose: the rotation rule, and the only copy of it, so the suggestion side
  and the publish side can never disagree about whose week it is.
- Params: `p_week_start date`, the Monday of an ISO week. Not normalised
  here — both callers normalise before calling.
- Returns: one of the four category codes above. Never null for any date,
  including dates before the epoch.
- Auth: `immutable`, `security invoker`, reads no table, so no `auth.uid()`
  check. Executable by `authenticated` (revoked from `public` and `anon`) so
  a client can label a week without re-deriving the rule in JavaScript.
- Side effects: none.

### member_of_week_category_label(p_category text) returns text (202609010001)

- Purpose: the Hebrew display label for a category code, kept beside the rule
  so the suggestion card and the published post name a category identically.
- Returns: `עקביות באימונים`, `שיאים אישיים השבוע`, `השלמת אתגר`,
  `בחירת המאמן/ת`, or `''` for an unknown code.
- Auth: `immutable`, no table read, executable by `authenticated`.
- Side effects: none.

### member_of_week (table, 202609010001)

- `id uuid pk default gen_random_uuid()`, `club_id uuid not null default
  default_club_id() references clubs(id)`, `week_start date not null unique
  check (extract(isodow from week_start) = 1)`, `category text not null check
  (category in ('consistency_streak','most_prs','challenge_completion',
  'coachs_pick'))`, `user_id uuid not null references profiles(id) on delete
  cascade`, `reason text not null default '' check (char_length(reason) <=
  500)`, `post_id uuid references workout_posts(id) on delete set null`,
  `published_by uuid references profiles(id) on delete set null`,
  `published_at timestamptz not null default now()`.
- One row per **published** week. There is no draft row and no nullable
  `published_at`: a generated draft here is not a row, it is what
  `member_of_week_candidates()` returns.
- RLS: enabled. **One policy, `member_of_week_read`, `for select to
  authenticated using (true)`.** Club-wide, because a published member of
  the week is public by construction. **No write grant and no write policy of
  any kind** — not for staff, not for an admin, not for the owner. The `pins`
  shape (202608280017), for the same reason: the once-per-week rule, the
  consecutive-week refusal, the category resolution and the `admin_actions`
  row would all be bypassable by a direct insert.
- `category` is **stored, not re-derived on read.** It records what was
  actually published, which can be `coachs_pick` on a week whose rotation
  said something else; re-deriving would rewrite the past if the rotation is
  ever re-tuned.
- The unique key is on `week_start` alone, as COMM-315's outline writes it,
  and deliberately **not** `(club_id, week_start)`. `club_id` is provenance
  here exactly as it is on `weekly_recaps`, `challenges` and
  `challenge_progress`, none of which carry it in a unique key either. The
  module is single-club, so the two are the same constraint today; the day a
  second club exists this changes along with every other table in the module,
  not on its own.
- Indexes: `member_of_week_recent_idx (week_start desc)`,
  `member_of_week_user_idx (user_id, week_start desc)`.

### member_of_week_candidate_set(p_category text, p_week_start date, p_limit int default 3) returns table (user_id uuid, value numeric, detail jsonb) (202609010001)

- **Internal, not in COMM-315's outline.** It exists because
  `member_of_week_publish` has to ask the identical "is this member on the
  shortlist" question that `member_of_week_candidates` asks, and a second
  copy of three queries would drift.
- `security invoker`, **no grant to any role** — `public`, `anon` and
  `authenticated` all revoked. Called from the two definer functions it runs
  with the migration owner's rights; called from anywhere else it cannot be
  called at all. It carries no staff gate of its own because both callers
  have one.
- Privacy is applied here, once, for both callers. Per category:
  `consistency_streak` delegates to `feed_leaderboard('consistency', null,
  'club', 50)` and therefore inherits all three of that board's gates —
  `in_leaderboards`, `visible_to_club` and, since COMM-306,
  `show_attendance`; `most_prs` applies `can_view_profile_field(author,
  'show_prs')` plus `post_visible_to_viewer(post)` on each counted post,
  exactly as `coach_celebrate_feed`'s PR branch does; `challenge_completion`
  applies `can_view_profile_field(user, 'in_leaderboards')`, exactly as
  `coach_celebrate_feed`'s completion branch does. `coachs_pick` returns
  nothing, by definition rather than by exhaustion.
- **One addition beyond `coach_celebrate_feed`'s pattern**, stated because it
  is an addition: every branch **also** reads the relevant toggles from the
  **raw `profiles` columns**, on top of the `can_view_profile_field()` call
  and never instead of it — `visible_to_club and in_leaderboards and
  show_attendance` for consistency, `visible_to_club and show_prs` for PRs,
  `visible_to_club and in_leaderboards` for completions.

  The two answer different questions. `can_view_profile_field()` asks "may
  this caller see this?": it settles block edges in both directions, returns
  true for the caller's own row, and **short-circuits to true for an admin
  before it consults any toggle** (202608280003). That is the right question
  for a dashboard row a coach reads, which is all Celebrate is, and the admin
  short-circuit is that resolution point's module-wide behaviour rather than
  anything this ticket should fight. It is the wrong question *on its own*
  here, because a candidate is a suggestion the caller is about to
  **broadcast**. Read through the helper alone, an admin would be offered —
  and could publish — a "most PRs this week" celebration of a member who
  keeps their PRs private. A member's own toggle has to outrank the caller's
  rank when the output is a club-wide post.

  Both are kept because each does something the other cannot: the helper is
  the only thing that settles blocks, and the columns are the only thing that
  survives an admin caller. 0045 mutation-tests them separately — deleting
  the column reads fails three admin assertions, deleting the helper calls
  fails the block assertion.
- The member recognised in the immediately prior week is excluded from the
  shortlist. That is the courtesy; `member_of_week_publish`'s refusal is the
  rule.
- Windowing: `most_prs` keys on `coalesce(occurred_on, created_at::date)`
  between `week_start` and `week_start + 6`, the same key
  `community_profile`'s PR block uses. `challenge_completion` keys on
  `completed_at::date` in the same range, excludes `status = 'withdrawn'`
  participants and `status = 'draft'` challenges.
- **Known limitation, flagged rather than hidden.** `feed_leaderboard`'s
  consistency mode reports the streak **as of now**: it takes no as-of date
  and `consistency_week_streaks()` anchors on `current_date`. Asking for a
  past week returns today's streaks. For the intended use — staff publishing
  the current or the just-ended week — the two are the same. Publishing a
  months-old week under that category would credit a present-day streak.
  Fixing it means COMM-306's arithmetic growing an as-of parameter, which is
  a change to a shipped contract and out of COMM-315's scope.

### member_of_week_candidates(p_week_start date default null) returns setof jsonb (202609010001)

- Purpose: the suggestion half of COMM-309's generated-draft/staff-publishes
  shape. It writes nothing and it is `stable`; the club sees nothing until a
  human calls `member_of_week_publish`.
- Params: `p_week_start date`, default null. Null means the current week.
  Any other date is **normalised to the Monday of its own ISO week** rather
  than rejected — a coach tapping a date picker means the week a human means.
  The same normalisation runs in `member_of_week_publish`.
- Returns: `setof jsonb`, and **always exactly one row**. The signature is
  `setof` because COMM-315's contract pins it; the envelope carries the
  category as well as the list because the empty state needs both — "no
  candidates this week for *this* category" cannot be rendered from an empty
  set of rows. The client reads `data[0]` and joins nothing:

  ```
  { week_start, category, category_label, rotation_index, free_selection,
    published, previous_week_user_id, candidates[] }
  ```

  - `rotation_index` is 0..3, sent so the client can show "week N of 4"
    without re-deriving the rule.
  - `free_selection` is true only for `coachs_pick`. The client branches on
    the flag rather than string-matching the category name.
  - `published` is null for an unpublished week, otherwise
    `{id, user_id, category, reason, post_id, published_at}`.
  - `previous_week_user_id` is last week's member, who publish will refuse —
    sent so the free-selection form can grey them out rather than letting a
    coach discover the rule by hitting it.
  - `candidates` is at most 3 of `{user_id, handle, display_name,
    avatar_url, value, detail}`, ordered by `value` desc then display name
    then id, which is a **total** order — two identical calls return an
    identical envelope. `detail` is category-shaped: `{streak_weeks, rank}`,
    `{pr_count}`, or `{completions, titles}`. Always `[]` for `coachs_pick`.
- Auth: `security definer`, `auth.uid()` checked first, then `is_staff()`
  inline. Both raise `not authorized` (P0001). Executable by `authenticated`
  only — the staff test is in the body, not in the grant, so a coach who is
  not an admin can still call it.
- Side effects: none.

### member_of_week_publish(p_week_start date, p_user_id uuid, p_reason text) returns uuid (202609010001)

- Purpose: the **only** writer of `member_of_week`, and the first and only
  producer of a `POST_ANNOUNCEMENT` row anywhere in this schema.
- Params: `p_week_start` normalised as above, null meaning the current week;
  `p_user_id` required; `p_reason` trimmed, control characters stripped
  (`0x01`-`0x08`, `0x0B`-`0x1F`, keeping tab and newline — the same class
  `post_create` strips, because this text reaches the club feed), then
  **capped** at 500 rather than rejected.
- Returns: the new `member_of_week.id`.
- Auth: `security definer`, `auth.uid()` first, then `is_staff()` inline.
- **Refusals**, all checked before the first insert, so a rejected publish is
  never a half-published one:
  - `week already published` — a second call for a week that already has a
    row. Explicitly **not** an upsert, unlike `weekly_recaps`: a recap is a
    regenerated summary, this is a public act of recognition that has already
    reached the feed, and quietly replacing it would leave the post naming
    one member and the row naming another. The `unique (week_start)`
    constraint stands underneath as the backstop.
  - `member was recognised last week` — a row exists for `week_start - 7`
    with the same `user_id`. A real refusal, not a suggestion-level nicety:
    it holds for a hand-made call and for a coach's pick that never fetched
    the shortlist. It is about **adjacency**, not repetition — the same
    member may be published again after a gap of one week.
  - `member not found` — no profile, or soft-deleted.
  - `member is not visible to the club` — **the one refusal COMM-315 does not
    name.** Read from the raw `visible_to_club` column, not through
    `can_view_profile_field()`, for the reason given on the candidate set
    above: publishing is broadcasting, and a member who removed themselves
    from the club's view did not consent to being its headline. Reverting it
    is deleting one `if`.
  - `reason required for a coach's pick` — an empty reason when the resolved
    category is `coachs_pick`. A free selection with no stated reason
    publishes a name and nothing else; the three computed categories carry
    their reason in the category itself, so an empty reason is fine there.
- **Category resolution, and why there is no `p_category` parameter.** The
  signature is fixed by the ticket, so the category is derived by *looking*:
  if `p_user_id` is in the week's computed shortlist, the row records the
  week's rotation category; if not, it records `coachs_pick`. That is exactly
  COMM-315's stated empty state ("nobody logged a PR that week … staff can
  fall back to coach's pick"), expressed as a fact about who was chosen
  rather than as a flag the client must remember to send. `admin_actions`
  keeps both: `after_data` carries `category` and `rotation_category`.
- **The post pattern, decided here because COMM-315 required it be stated:
  an authorless, club-visibility `POST_ANNOUNCEMENT`.** Not COMM-225's
  comment-on-the-member's-card pattern, for three reasons. (1) That pattern
  needs a card to comment on — it branches on Celebrate's `post_id`, which is
  non-null only for a PR, and three of the four categories here have no
  source post at all, so it would work for one category in four and silently
  degrade for the rest. (2) Member of the week is club voice, not a coach's
  reply; rendering it under one coach's face would make it read as that
  coach's opinion of a member. `author_id` is null, which 202608280004 made
  legal for exactly this kind of row, and `member_of_week.published_by` keeps
  the accountability where an audit wants it. (3) `cloud.js`'s
  `renderAnnouncementPostCard` already reads `metadata.title` falling back to
  `title` and already passes `authorless: !postAuthorName(post)`, so the row
  renders correctly with no client change.
- The post: `post_type = 'POST_ANNOUNCEMENT'`, `author_id = null`,
  `visibility = 'club'`, `status = 'active'`, `title = 'חבר/ת השבוע'`,
  `body` naming the member, the category label and the reason,
  `source_type = 'announcement'`, `source_id` = the `member_of_week.id`
  (generated before both inserts so the two rows reference each other in one
  transaction), `occurred_on = week_start`, and `metadata`
  `{title, member_of_week: true, member_id, member_name, category,
  category_label, week_start, reason}`.
- Side effects, all in one transaction: one `workout_posts` row, one
  `member_of_week` row, one `admin_actions` row via `log_admin_action`, so a
  failed log fails the whole publish. Same shape `pin_set()` uses.

### admin_actions.action_type gains one label (202609010001)

- `admin_actions_action_type_check` is dropped and re-added with a twelfth
  value, `'member_of_week_publish'`. Nothing else about the table moves, and
  `target_type` is **not** widened — `'member'` already exists and is exactly
  right, since the subject of the action is the member being recognised.
- Reusing an existing label (`'achievement_edit'`, `'privacy_config'`) was
  the alternative and was rejected: it would make the audit log describe
  something that did not happen, which is the one thing an audit log may not
  do.

## Edge Functions

### recap_weekly

- Schedule: weekly. Idempotent per user per week via the unique `(user_id,
  week_start)` key on `weekly_recaps` (see "Needs from schema, recaps").
  Phase 2, COMM-220. `week_start` must be the ISO week's Monday; a CHECK
  rejects anything else, so a run that computes a Sunday-start week fails
  loudly rather than silently double-inserting.
- Output: one `weekly_recaps` row per active user, plus one `notif_create(U,
  'weekly_recap', 'club', ...)` call per user with a deep link to the recap
  surface (COMM-221), matching the routing table entry above.
- Records success and failure counts with no personal content.
- Shipped in `supabase/functions/recap_weekly/index.ts`, the first Edge
  Function in this repo. "Active member" for this function's purposes means
  a non-deleted profile with an `invite_redemptions` row - deliberately not
  WCAM (which answers "did something this week", the opposite of the
  members a quiet-week recap exists for). Only ever notifies for a row that
  did not already exist before that run (checked before the upsert, since
  after the upsert a first run and a rerun are indistinguishable).
- **Auth: explicit service-role check inside the function body, not just
  the platform's default `verify_jwt`.** `verify_jwt` only proves the caller
  presented some valid JWT - the public anon key already shipped in
  `cloud-config.js` satisfies that as well as the real service role key
  does, which is not this function's intent (it runs as service role and
  touches every member's data). The handler compares the `Authorization`
  header against `Bearer <service role key>` directly and returns 401
  otherwise. Verified locally: an anon-key call and a no-header call both
  get 401, a service-role-key call gets 200 with the expected
  `{weekStart, weekEnd, success, failure, total}` shape. The weekly
  cron/schedule itself (what actually calls this with the service role key,
  and how that key reaches the caller without living in a client bundle)
  remains the same open infra item the notification batch flusher already
  has - not built here.

### recap_monthly_club

- Schedule: monthly. Admin preview before publish. Phase 3, COMM-309.
- Output: aggregate club figures. No member names in public sections.
- Full shape (added when COMM-309's ticket file was written): writes a draft
  `monthly_club_recaps` row (unpublished, `published_at null`); a staff
  `community.analytics.view` or admin holder previews it and calls
  `recap_monthly_publish(p_id)` to fan out the notification and make it
  member-readable. See "Needs from schema, recaps (Phase 3)" below.

### purge_abandoned_profiles

- Schedule: daily. Versioned. Idempotent. Phase 3, COMM-314.
- Purpose: remove abandoned anonymous profiles per the retention rule.
- Records success and failure counts with no personal content.
- Not the same job as the already-shipped `purge_due_accounts()`
  (202608260001, a member's own explicit deletion request purged 30 days
  after they ask). "Abandoned" here means `auth.users.is_anonymous = true`,
  no `invite_redemptions` row, no `profiles.recovery_verified_at`, older
  than a named retention window. See "Needs from schema, identity-privacy
  (Phase 3)" below — the exact window is an open question, not yet decided.

## Phase 3 forward contracts (not yet built)

Every function below is named by a Phase 3 ticket in
`docs/community/tickets/` and recorded here before it is built, per this
file's own standing rule. None of these exist in a migration yet. All of
them are additive to an existing signature (`feed_page`, `feed_leaderboard`,
`people_suggestions`, `community_profile`, `consistency_week_streaks`) or
are brand new — no existing signature is narrowed by any entry here.

### Needs from schema, attendance foundation (Phase 3) — SHIPPED

COMM-300, the prerequisite for everything else in this section, shipped in
202608310001. It is no longer a forward reference: the built contract, with
the parts that differ from what was promised here, is
**"## Needs from schema, attendance (COMM-300, Phase 3)"** above. Read that,
not this.

What a dependent ticket needs to know changed between the two:

- Everything promised here shipped as promised. The table columns, the
  unique key, the RLS shape, the trigger's timing and filter, the emit and
  the analytics wiring are all exactly as written above.
- Two helper functions were added that were not named here and that a
  dependent ticket should reuse rather than re-derive:
  `attendance_session_record_types() returns text[]` (the session-bearing
  set, currently `{strength_entry, wod_entry}`) and
  `attendance_parse_day(p_raw text) returns date` (the null-on-anything-bad
  payload date parser).
- The future-date rule resolved to **refuse the attendance row, never clamp**,
  with one day of slack for the UTC-vs-local-calendar-day gap.
- The migration backfills existing `private_records`, which was not in the
  outline. Members therefore have real attendance history from day one
  rather than starting at zero.
- The staff/analytics select policy is **not** gated on
  `can_view_profile_field(user_id, 'show_attendance')`. Every member-facing
  reader (COMM-302, COMM-306, COMM-307) applies that toggle in its own body.

### Needs from schema, feed (Phase 3)

- ~~`relationship_score(p_viewer uuid, p_other uuid) returns numeric`~~ —
  **SHIPPED in 202608310002, COMM-301.** No longer a forward reference: the
  built contract is **"### relationship_score(p_viewer uuid, p_other uuid,
  p_as_of timestamptz default now()) returns numeric"** under `## Feed`
  above. Read that, not this. It shipped as promised — same purpose, same
  numbers, `security invoker`, no grant to any role — with one addition: a
  third, defaulted `p_as_of` parameter carrying the window anchor, so the
  two-argument call form above still resolves and a caller with a frozen
  session anchor keeps the same 30-day boundary across every page. A
  dependent ticket that has an anchor should pass it.
- ~~`feed_page(cursor, limit, scope)` re-created: `v_class_connection` stops
  being hard-0'd~~ and ~~`people_suggestions(p_limit)` re-created: one more
  UNION ALL branch~~ — **both SHIPPED in 202608310003, COMM-302, closing
  COMM-P01.** No longer forward references: the built contracts are
  **"### feed_page(...)"** and **"### people_suggestions(...)"** under
  `## Feed` above. Read those, not this. Both shipped as promised — same
  signatures, `v_class_connection` computed from `attendance_log` overlap in
  a trailing 60-day window gated by `can_view_profile_field(author,
  'show_attendance')`, one more UNION ALL branch, one more `scored` column,
  one more `signals` key `shared_classmate_days`, `reason` gaining
  `'classmate'`, priority order challenge, classmate, interaction, event —
  with one addition this section did not name:
- `classmate_day_counts(p_as_of timestamptz default now()) returns
  table(user_id uuid, shared_days integer)` — new, internal, `security
  invoker`, no grant to any role. COMM-302's own migration outline named only
  the two re-creations; this helper exists because both of them need the same
  window, the same overlap count and the same `show_attendance` gate, and the
  privacy gate in particular is the last thing that should exist twice. Full
  contract under `## Feed` above. A dependent ticket (COMM-303, COMM-307)
  should reuse it rather than re-derive the overlap.
- ~~`consistency_week_streaks()` re-created: body reads `attendance_log`
  instead of `workout_posts`~~ and ~~`community_profile(user_id uuid)`
  re-created: `current_streak`'s inline copy updated to match~~ — **both
  SHIPPED in 202608310004, COMM-306, closing COMM-P02.** No longer forward
  references: the built contracts are **"### consistency_week_streaks()"**,
  **"### feed_leaderboard(...)"** and **"### community_profile(...)"** above.
  Read those, not this. Both shipped as promised — same signatures, same
  arithmetic, one table swapped, and `feed_leaderboard`'s consistency filter
  gaining `can_view_profile_field(member, 'show_attendance')` so an opted-out
  member is absent from the ranked set rather than ranked at 0 — with one
  addition this section did not name: `community_profile`'s `current_streak`
  key is gated on `show_attendance` in addition to `show_workout_results`. The
  number is attendance-derived now, so it may not travel past attendance's own
  toggle (202608310001's standing rule for every member-facing Phase 3
  reader), and without it a member would be absent from the board and
  published on their profile in the same breath. `training_frequency` and
  `recent_workouts` are untouched and still read `workout_posts` under
  `show_workout_results` alone.
- ~~`attendance_classmates_today() returns setof jsonb`,
  `{user_id, display_name, handle, avatar_url}` — `security definer`, same
  boundary-crossing shape as `people_suggestions`. Distinct from COMM-302's
  signal: "today" only, no window, no historical count.~~ — **SHIPPED in
  202608310005, COMM-307's schema half, closing COMM-P05.** No longer a
  forward reference: the built contract is
  **"### attendance_classmates_today(p_limit int default 6) returns setof
  jsonb"** under `## Feed` above. Read that, not this. It shipped as promised —
  same returned shape, same four keys, `security definer`, today only with no
  window and no count, `can_view_profile_field(candidate, 'show_attendance')`
  and block edges in either direction — with two additions this section did
  not name:
  - **A defaulted `p_limit int default 6`, clamped 1..20.** COMM-307's own
    "validation rules and limits" asked for it ("matching
    `people_suggestions`'s own limit shape, clamp 1..20, default a smaller
    number appropriate to a card"); the zero-argument call form promised here
    still resolves verbatim, the same accommodation COMM-301's `p_as_of` made.
  - **The caller's own `show_attendance` is enforced inside the function**, as
    a direct `profiles` column read rather than through
    `can_view_profile_field` (which answers true for the caller before reading
    any toggle and so could not express the question). Off means an empty set,
    never a raise. COMM-307's acceptance criteria stated the behaviour but not
    where it lives; it lives server-side because every boundary in this module
    does. Full reasoning in the contract above.
  - ~~**Still open: COMM-307's client half.**~~ — **also SHIPPED**, in the
    same ticket: the feed-top card in COMM-115's slot, the follow action
    reusing `follow()` (COMM-230) and the `classmates_card_viewed` event with
    its `metrics.md` row. The built contract for it is the last bullet of
    "### attendance_classmates_today(p_limit int default 6) returns setof
    jsonb" above.
- ~~`member_feed_weights(user_id uuid pk, weights jsonb not null default
  '{}', computed_at timestamptz not null default now())` — own-row select
  only, no client write grant. `feed_page` re-created again to read it and
  fall back to today's fixed defaults when absent.~~ — **SHIPPED in
  202608310006, COMM-303.** No longer a forward reference: the built contracts
  are **"### member_feed_weights (table)"**, **"### feed_weights_resolve(...)"**
  and **"### recompute_feed_weights(...)"** under `## Feed` above, plus the
  third re-creation bullet on **"### feed_page(...)"**. Read those, not this.
  It shipped as promised — three columns, own-row select only, no client write
  grant of any kind, `feed_page` falling back to the fixed defaults when the
  row is absent — with three things this section did not name:
  - **`feed_weights_resolve(p_user uuid, p_defaults jsonb) returns jsonb`**,
    new, internal, `security invoker`, no grant to any role. The
    redistribution arithmetic, extracted so it has a name the pgTAP file can
    assert invariants against. It takes the defaults as a parameter so the
    eight numbers stay stated once, in `feed_page`'s weight block.
  - **`recompute_feed_weights(p_limit integer default 500)` is a deliberate
    no-op.** COMM-303's outline names the function; the ticket puts the
    derivation out of scope. The signature, grants and auth boundary ship; the
    body does not. **The actual weight-derivation algorithm from
    `feed_interactions` history is NOT built**, so today every member has no
    row and every member gets the fixed defaults. This is the "storage exists,
    computation does not" shape, not a finished personalization feature.
  - **The two tuning numbers the ticket flagged are resolved**: clamp bounds
    0.40..2.50 of each component's default, recomputation cadence weekly. Both
    are revisable; the cadence lives only in a commented cron line.
  - And one correction rather than an addition: **the weight block's "sum to
    104" was stale since COMM-302 and reads 110 now.** No weight moved.

### Needs from schema, achievements (Phase 3)

- ~~`update achievement_definitions set enabled = true where trigger_type =
  'ATTENDANCE_RECORDED'`~~ and ~~one security-definer AFTER INSERT trigger on
  `attendance_log`: computes the member's total distinct days and current
  streak, inserts a `member_achievements` row on a genuine crossing (1, 25,
  100 days; a fresh 4-week streak for the repeatable code), and, for the two
  count milestones only, an authorless `POST_ATTENDANCE_MILESTONE` post gated
  by the member's own `show_attendance`~~ — **both SHIPPED in 202608310007,
  COMM-305, closing COMM-P03.** No longer forward references: the built
  contract is **"## Needs from schema, attendance achievements (COMM-305,
  Phase 3)"** above. Read that, not this. Everything promised here shipped as
  promised — the `UPDATE`, the trigger, the crossing rule, the two count
  milestones posting and the first class not, the `show_attendance` gate on
  the post and not on the achievement, the `workout_posts`-is-the-record
  idempotency, `club` visibility, `ach_claim`'s refusal untouched, and the
  generic `ach_evaluate` deliberately not built — with four things this
  section did not name:
  - **`attendance_week_streak(p_user uuid, p_exclude_day date default null)
    returns integer`**, new, internal, `security invoker`, no grant to any
    role. The outline named no helper; this one exists because the repeatable
    code has to know what the streak was *before* the row that just landed,
    which `consistency_week_streaks()` is set-wide and zero-argument and
    cannot answer. Same arithmetic, pinned against it for every member by
    0043 so the two cannot drift.
  - **The count milestones test state, not a delta.** "Reaches the threshold
    and does not already hold the code", decided by
    `member_achievements_once_idx`. A literal just-crossed delta silently
    awards nothing for any multi-row insert. Full reasoning in the contract
    above; the repeatable streak still tests a genuine before/after crossing,
    because a repeat cannot be answered from state.
  - **`metadata` carries a third key, `member_id`**, beyond the two the Phase
    1 client contract fixed. The renderer ignores it; the "already posted this
    milestone" guard needs it, since the rule is "that member and that count".
  - **The `show_attendance` gate is a write-time gate**, read once at the
    unlock and never re-asked, so turning the toggle on later does not
    retro-publish a milestone crossed while it was off.

### Needs from schema, coach-tools (Phase 3)

- `coach_detect_engagement_decline()` — service-role only, same auth shape
  as `chal_notify_ending_soon()`. Reads `attendance_log`, writes
  `coach_engagement_flags` (empty since 202608280011). COMM-304, closing
  COMM-P04. Flips COMM-226's `state.featureFlags.coachEngage` to
  default-on.
- ~~`member_of_week(...)` table, own-row-free (club-wide select once
  published), no client write grant. `member_of_week_candidates(p_week_start)`
  and `member_of_week_publish(p_week_start, p_user_id, p_reason)`, both
  `security definer`, staff-gated. COMM-315 — flagged as an open question
  in its own ticket file, category set not spec-grounded.~~ — **SHIPPED in
  202609010001, COMM-315.** No longer a forward reference: the built
  contract is **"## Needs from schema, member of the week (COMM-315, Phase
  3)"** above. Read that, not this. Everything promised here shipped as
  promised — the table, its club-wide select, its total absence of a client
  write path, and both staff-gated definer functions with the exact
  signatures named — with five things this line did not name:
  - **`member_of_week_category(date)` and `member_of_week_category_label(text)`**,
    two new immutable helpers. The rotation rule had to live in exactly one
    place because both entry points consult it, and the index is *weeks since
    a fixed epoch Monday mod 4*, not the ISO week number, which repeats a
    category across every 53-week ISO year.
  - **`member_of_week_candidate_set(text, date, int)`**, internal, no grant
    to any role, so publish and candidates ask the shortlist question from
    one copy.
  - **The category is derived at publish, not passed.** Publishing somebody
    the week's shortlist did not contain *is* a coach's pick and is recorded
    as one — which is how the ticket's "staff can fall back to coach's pick"
    empty state works with the fixed three-parameter signature.
  - **Two refusals beyond the two the ticket names**: an empty reason on a
    coach's pick, and a member whose `visible_to_club` is false. Relatedly,
    every candidate toggle is read from the **raw column** as well as through
    `can_view_profile_field()`, because that helper short-circuits to true
    for an admin — publishing is broadcasting, and an admin's rank must not
    override a member's own choice.
  - **`admin_actions.action_type` gained `'member_of_week_publish'`**, the
    first widening of that closed list since 202608280002.

### Needs from schema, challenges (Phase 3)

- `challenge_teams` gains `captain_id uuid references profiles(id) on
  delete set null`.
- `chal_reassign_team(p_challenge_id, p_user_id, p_team_id)` and
  `chal_set_captain(p_team_id, p_user_id)`, both `security definer`,
  `community.challenge.create` gated, both writing `admin_actions`. COMM-308.

### Needs from schema, recaps (Phase 3)

- `monthly_club_recaps(id uuid pk, club_id uuid not null default
  default_club_id(), month_start date not null unique check
  (extract(day from month_start) = 1), sessions_logged integer not null
  default 0, posts_created integer not null default 0, new_members integer
  not null default 0, challenges_completed integer not null default 0,
  events_held integer not null default 0, generated_at timestamptz not null
  default now(), published_at timestamptz)`. Staff select-any; plain member
  select only `published_at is not null`; no client write grant.
  `recap_monthly_publish(p_id uuid)`, `security definer`,
  `community.analytics.view`/`is_admin` gated, stamps `published_at`, fans
  out the notification, writes `admin_actions`. COMM-309.
- `weekly_recaps` gains `classmates jsonb not null default '[]'`, written
  only by `recap_weekly` (service role). `onboarding_progress` gains
  `first_class_shown_at timestamptz` and `third_class_shown_at
  timestamptz`, both covered by the existing `onboarding_progress_pin`
  trigger. COMM-316, closing COMM-P06 and COMM-P07.

### Needs from schema, admin-moderation (Phase 3)

- `analytics_dashboard(p_period_start date, p_period_end date) returns
  jsonb` — `security definer`, `community.analytics.view`/`is_admin`
  gated, one call for every metric in `docs/community/metrics.md`'s "Core
  metrics" and "Additional metrics" sections. COMM-310.
- `member_segments(p_as_of date default current_date) returns setof jsonb`
  — `security definer`, same gate. COMM-311. Open question: segment set and
  thresholds not spec-grounded, see the ticket file.
- `community_health_scores(...)` table plus
  `community_health_history(p_weeks int default 12) returns setof jsonb` —
  real `is_admin` only, narrower than the other three tickets in this
  cluster. COMM-312. Open question: weighting formula not spec-grounded.
- `retention_cohorts(p_cohort_months int default 6)`,
  `retention_onboarding_correlation()`, `retention_welcome_correlation()` —
  real `is_admin` only. COMM-313. Open question: cohort window and which
  correlations, not spec-grounded. Depends on COMM-316's two new
  `onboarding_progress` columns.

### Needs from schema, identity-privacy (Phase 3)

- `purge_abandoned_profiles` Edge Function, service-role only, same
  explicit `Authorization: Bearer <service role key>` check
  `recap_weekly` already established. No new table — reads `auth.users`,
  `invite_redemptions`, `profiles` directly. COMM-314. Open question: the
  retention window (days of inactivity before eligible) is not decided.
