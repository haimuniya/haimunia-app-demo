# Community metrics

The one place that says what the community measures, what each tracked event
means, and where it fires from. COMM-013 shipped the helper, COMM-170 wired
the Phase 1 surfaces, COMM-233 wired the Phase 2 ones.

Owner: platform. A feature agent that adds a surface adds a row to the table
below in the same change.

## How an event is recorded

- `window.analyticsTrack(name, props)` from `src/analytics.js` is the only
  writer of `public.analytics_events` (migration 202608280012).
- `cloud.js` calls `HaimuniaAnalytics.configure({ client, getUserId })` once,
  at the head of the session-ready path in `refreshSession()` and
  `onAuthStateChange`. Before that call `analyticsTrack` is an inert no-op
  that drops the event, so ordering matters: configure runs first.
- Six of the names are not hand-tracked at all. They arrive through the
  product event bus bridge, see "Events that come from the bus" below.
- Nothing awaits an analytics call. A failed write is invisible to the
  member and no call site reads the return value.

## Schema and versioning

- `SCHEMA_VERSION` is 1. Every row carries it.
- Adding a prop to an existing event is additive and does not move the
  version. Removing a prop, renaming one, or changing what an existing one
  means bumps it, so a query can tell the two shapes apart.
- Props are trimmed, never rejected. Over `PROPS_BUDGET_BYTES` (3 KB) the
  largest values are dropped first and `_truncated: true` is added. The
  server trigger rejects over 4 KB.
- Props carry ids, enums, counts and booleans only. No display name, no
  handle, no caption, no comment body, no report note. The bus bridge
  enforces this with a per-event key allow-list, `BUS_PROP_KEYS`, so a
  producer that widens its payload cannot widen the analytics row.
- COMM-233 added the same enforcement for the hand-tracked Phase 2 events:
  `HAND_PROP_KEYS` in `src/analytics.js` lists the props each of those names
  may carry, and `track()` drops anything else before the row is built. That
  is what makes "a challenge's rules text, a recap sentence, or the search
  query" impossible rather than merely avoided by hand at each call site.
  The Phase 1 names have no entry and pass their props through untouched:
  narrowing an event already in the table is the kind of change
  `SCHEMA_VERSION` exists to make visible, and their call sites are pinned
  by `test/community-analytics-surfaces.test.mjs` instead.

## The dev switch

Set `window.HAIMUNIA_ANALYTICS_DEBUG = true` from a console, or pass
`configure({ debug: true })`. Every tracked event is then logged to the
console and nothing is written. The global wins over the configure option,
which is what makes it usable on a device that is already running. Unset it
to go back to writing.

## Weekly Community Active Members (WCAM)

Spec section 78. The core community health metric. One agreed definition, so
the client event stream and any later server-side rollup cannot disagree.

WCAM for a calendar week is the count of unique members who, inside that
week, did at least one of:

- created a post
- created a comment
- added a reaction
- joined a challenge
- participated in an event (an RSVP of going, or attending)
- shared an achievement
- interacted with a coach or with a community item (opened a post, opened a
  member profile, opened an announcement, opened a notification)
- shared a weekly recap figure, or, as a coach, sent a congratulation from
  the Coach Dashboard

Passive views alone do not count. Opening the club tab or scrolling the feed
is not membership activity. Uniqueness is per member per week, not per
action, so ten comments from one member is one active member. Week
boundaries follow the club's local week, not UTC.

COMM-233 reviewed each Phase 2 name against this bar one at a time rather
than letting a new event default in or out:

- `challenge_joined`, `challenge_completed` and `event_rsvp` count. They
  were already qualifying activity types here; Phase 2 only gave them real
  producers.
- `coach_congratulate_sent` counts, **for the coach**. The row's `user_id`
  is the actor, so the celebrated member is never made active by somebody
  else's action - they become active when they answer it, through their own
  `comment_created` or `reaction_added`.
- `weekly_recap_shared` counts, on the same reading as `achievement_shared`
  already in the list: a share is a post the member published.
- `leaderboard_viewed`, `weekly_recap_opened`, `search_performed` and
  `directory_opened` do not. Viewing is not the bar set above; a roster and
  a search box are navigation, not participation. A member who only ever
  browsed the club is not an active member of it.
- `push_opt_in` does not. Changing a notification setting is account
  configuration.

COMM-307 reviewed `classmates_card_viewed` against the same bar and it does
**not** count, on the `leaderboard_viewed` reasoning above. Two things make it
a clearer no than most: the card appearing is not an action the member took -
it is a fact about their training and somebody else's - and the training that
produced it is already counted once, as `attendance_recorded`, so counting the
card too would count one session twice and would also let another member's
session make this member active. Acting *from* the card does count, through
`member_followed` and `profile_opened`, which is where the participation
actually is.

The qualifying event names are `ACTIVE_MEMBER_EVENTS` in `src/analytics.js`,
and `isActiveMemberEvent(name)` answers for one name. They are kept as data
so a rollup query and the client cannot drift apart. The WCAM column in the
table below is the same list in readable form.

Computed from the stored events:

```sql
select count(distinct user_id)
from public.analytics_events
where event_name in (
  'post_created','workout_shared','achievement_shared','comment_created',
  'reaction_added','challenge_joined','challenge_completed','event_rsvp',
  'post_opened','profile_opened','member_followed','notification_opened',
  'weekly_recap_shared','coach_congratulate_sent','attendance_recorded')
  and created_at >= :week_start and created_at < :week_end
  and user_id is not null;
```

The community tables are the cross-check, not the source. `post_comments`,
`reactions` and `workout_posts` hold the same actions with server
timestamps, so a week whose event count and table count disagree by a wide
margin means events were dropped, not that members were inactive.

## Tracked events

WCAM marks the events that make a member active for the week.

| Event | Trigger surface | Props | WCAM |
| --- | --- | --- | --- |
| `club_tab_viewed` | `afterRenderCommunity()`, once per entry into a club sub-tab | `tab` | no |
| `feed_viewed` | Entering the Feed sub-tab, and a filter chip change in `setFeedScope()` | `scope`, `source` (`club_tab`, `scope_change`) | no |
| `post_impression` | `noteFeedImpression()`, a card at least half visible for one second | `post_id`, `position`, `feed_session_id` | no |
| `post_opened` | `toggleComments()` on open, the thread is the post detail view in V1 | `post_id`, `post_type`, `source` | yes |
| `post_created` | Bus, `POST_CREATED` | `post_id`, `post_type`, `visibility`, `has_media` | yes |
| `workout_shared` | `publishWorkout()` after the write succeeds | `source_type`, `visibility`, `has_photo` | yes |
| `achievement_shared` | `shareAchievementUnlock()` and `publishAchievement()`, both after the write | `member_achievement_id`, `code`, `source` (`unlock_sheet`, `app_share_button`) | yes |
| `reaction_added` | Bus, `REACTION_CREATED` | `post_id`, `reaction_type` | yes |
| `comment_created` | Bus, `COMMENT_CREATED` | `post_id`, `comment_id`, `parent_comment_id`, `mention_count` | yes |
| `profile_opened` | `viewCommunityProfile()` on open, before the RPC answers | `user_id`, `self` | yes |
| `member_followed` | `follow()` on a new follow edge only | `user_id` | yes |
| `challenge_viewed` | Entering the Boards sub-tab with an active weekly challenge, and every `openChallenge()` | `challenge_id`, `challenge_key`, `source` (`boards`, `post_card`, `search`, `club_top`, `onboarding`) | no |
| `challenge_joined` | Bus, `CHALLENGE_JOINED`, emitted by `joinChallenge()` (COMM-207) | `challenge_id`, `challenge_type` | yes |
| `challenge_completed` | Bus, `CHALLENGE_COMPLETED`, emitted when a member's own progress reaches the target (COMM-207) | `challenge_id`, `challenge_type` | yes |
| `leaderboard_viewed` | Entering the Boards sub-tab (weekly challenge + consistency boards), and the challenge detail's own progress board | `board` (`weekly_challenge`, `consistency`, `challenge_progress`), `rows`, `source` | no |
| `event_viewed` | Every `openEvent()`: the Boards list card, the `POST_EVENT` link card, a search result, the club header, the recap's upcoming event, a notification | `event_id`, `source` | no |
| `event_rsvp` | Bus, `EVENT_REGISTERED`, emitted by `rsvpEvent()` (COMM-214) | `event_id`, `rsvp_status` | yes |
| `notification_opened` | `openNotif()`, before the mark-read await | `notification_id`, `type`, `target`, `was_unread` | yes |
| `report_submitted` | `submitReportSheet()` after the report RPC succeeds | `target_type`, `reason` | no |
| `weekly_recap_opened` | `openRecap()` on open, before the row is fetched. COMM-233's `recap_viewed` | `source` (`account`, `notification`) | no |
| `weekly_recap_shared` | `shareRecapFigure()` after `post_create` succeeds. COMM-233's `recap_shared` | `figure` (`sessions`, `streak`, `pr`, `achievement`), `post_id` | yes |
| `search_performed` | Both search boxes, once per settled search rather than per keystroke | `source` (`community_search`, `directory`), `query_length`, `member_count`, `event_count`, `challenge_count` | no |
| `push_opt_in` | `enableNotifPush()` after the `push_subscriptions` upsert succeeds | `source` (`notif_pref`), `pref_type` | no |
| `coach_congratulate_sent` | `congratulateCelebrateItem()` after the comment or post write succeeds | `kind`, `via` (`comment`, `post`) | yes, for the coach |
| `directory_opened` | Entering the Directory sub-tab | `source` (`club_tab`, `leaderboard`) | no |
| `attendance_recorded` | Bus, `ATTENDANCE_RECORDED`, emitted by `flushOutbox()` after a session-bearing `private_records` upsert succeeds (COMM-300) | `occurred_on` | yes |
| `classmates_card_viewed` | `afterRenderCommunity()`, once per load of COMM-307's trained-with-you card, and only when it renders with at least one classmate on it | `rows`, `source` (`feed`) | no |

### Events that come from the bus

`post_created`, `comment_created`, `reaction_added`, `challenge_joined`,
`challenge_completed`, `event_rsvp` and `attendance_recorded` are never
hand-tracked. The bridge in
`src/analytics.js` subscribes to the matching product event and writes the
row, which is what keeps one producer from having to remember two calls. A
second hand-written call at the same surface would double count.

`BUS_PROP_KEYS` projects each payload down to the listed props. A key the
producer sends that is not on the list is dropped, and an array prop named in
`BUS_COUNT_KEYS` is stored as its length. `mentions` on `COMMENT_CREATED` is
the live case: the bus carries the resolved mention objects for the
notification consumer, and analytics keeps only `mention_count`.

`WORKOUT_COMPLETED`, `PR_CREATED`, `MEMBER_JOINED` and
`ACHIEVEMENT_UNLOCKED` are deliberately unmapped. Completing a workout is
not sharing one and unlocking an achievement is not sharing it, so mapping
either would inflate WCAM with actions that are not community
participation.

`ATTENDANCE_RECORDED` was on that list too until COMM-300, for a different
reason: it had no producer at all. It has one now, and it is mapped. The
distinction against `WORKOUT_COMPLETED` is not hair-splitting - one is a
local UI event that fires per logged set, the other is one emit per member
per calendar day, after the record reached the server, which is the same
grain the `attendance_log` table stores.

### Counting once

- `club_tab_viewed` is recorded from `afterRenderCommunity()`, which runs on
  every re-render of the Community tab. The last counted sub-tab is
  remembered, so a re-render of the same one records nothing. Leaving the
  Community tab clears that memory, so returning counts as a new view.
- `post_impression` rides the same `state.feedSeen` guard the COMM-114
  impression pipeline uses, so both are exactly once per post per feed
  session. Two tables, two consumers, one trigger.
- `post_opened` fires on the open branch of `toggleComments()` only. A close
  is not an open.
- `member_followed` fires only when the insert succeeds. The follow control
  toggles, and the duplicate-key branch is an unfollow.
- Every write-backed event is recorded after the write, so a failed action is
  never counted as one. The exceptions are `profile_opened`,
  `notification_opened` and `weekly_recap_opened`, all recorded at the moment
  of the action because the member opened the thing whether or not the fetch
  behind it answers.
- `directory_opened` rides the same once-per-entry guard as
  `club_tab_viewed`, so a page of members arriving or a follow toggling is
  not a second view of the roster.
- `weekly_recap_opened` fires on the open only. Browsing to the previous or
  next week refreshes the same open surface, which is not a new open.
- `search_performed` is debounced by 600 ms, separately from the fetch: both
  boxes issue a request on every keystroke (COMM-228 chose latency over
  batching, and the token guard makes it safe), so tracking the raw call
  would put three rows in the table for a member typing "noam" and turn
  "searches per week" into "characters typed per week". Backspacing under
  the two-character floor cancels the pending row: an abandoned search was
  not a search.
- `coach_congratulate_sent` fires once per celebrate item. The client-side
  `congratulated` set makes a second tap a no-op before the write, so the
  event cannot repeat either.
- `attendance_recorded` is one event per member per calendar day, not per
  logged set. `flushOutbox()` keeps a per-page `(user_id, occurred_on)` set
  and skips a day it has already emitted, mirroring the `(user_id,
  occurred_on)` unique key on `attendance_log`. Three lifts logged on one
  day are one attendance day server-side and one event here. It is emitted
  only after the `private_records` upsert succeeds - a failed sync is not a
  session - and never for a soft-delete.
- `classmates_card_viewed` rides the same once-per-entry guard shape as
  `club_tab_viewed`, keyed to the card's own load rather than to a sub-tab: a
  cheer, a comment arriving over realtime or a photo URL resolving all
  re-render the feed and none of them is a second view. It fires from
  `afterRenderCommunity()` and not from the fetch, because the card only
  exists once it is in the document - a fetch that answered with rows is not
  yet a view. It never fires for an empty or failed `attendance_classmates_today()`,
  since there is no card at all in either case, which means "card impressions"
  and "how often the card had anything to show" are the same number by
  construction. `rows` is a count, never the members: the card's whole content
  is other people's identities and none of it reaches `analytics_events`.

## Core metrics

Spec section 78.

- Weekly Community Active Members, defined above. The headline number.
- WCAM as a share of club members, from `WCAM / count(profiles)` for the
  club in the same week.
- Posting members per week, `count(distinct user_id)` over `post_created`,
  `workout_shared` and `achievement_shared`.
- Engagement per post, `reaction_added` plus `comment_created` over
  `post_created`, in a week.
- Feed reach, `count(distinct post_id)` over `post_impression` against the
  posts published in the window.

## Additional metrics

Spec section 79. Every one of these is answerable from the event set above
plus the community tables, with no new event name.

- Open rate per surface, `post_opened` over `post_impression`, by
  `post_type`.
- Filter use, `feed_viewed` grouped by `scope`, and the share of sessions
  that ever change scope.
- Sub-tab split, `club_tab_viewed` grouped by `tab`.
- Notification effectiveness, `notification_opened` over notifications
  delivered, by `type`, with `was_unread` separating a real open from a
  revisit.
- Social graph growth, `member_followed` per week, and `profile_opened` with
  `self = false` as the discovery signal ahead of it.
- Challenge and leaderboard pull, `challenge_viewed` and
  `leaderboard_viewed` per week, against `challenge_joined` for the
  conversion.
- Moderation load, `report_submitted` grouped by `reason` and
  `target_type`, against the queue in `reports`.
- Share intent split, `workout_shared` by `visibility`, and
  `achievement_shared` by `source`.
- Recap pull-through, `weekly_recap_opened` by `source` against the recap
  notifications sent, and `weekly_recap_shared` over it by `figure`.
- Discovery split, `search_performed` by `source` with `member_count` at
  zero as the "found nothing" rate, against `directory_opened` for how many
  members browse the roster instead of searching it.
- Coach reach, `coach_congratulate_sent` per week by `kind`, against the
  celebrate items the dashboard offered.
- Push adoption, `push_opt_in` per week against the unrevoked rows in
  `push_subscriptions`.
- Trained-with-you reach, `classmates_card_viewed` per week with `rows` as the
  size of the overlap it found, against `attendance_recorded` for the share of
  training days that produced a card at all. A low ratio is `show_attendance`
  adoption, not a broken card: the toggle defaults to false and both sides of
  every pair have to have flipped it. `member_followed` and `profile_opened`
  in the same session are the conversion off it, and neither carries a prop
  saying the card was the source - the card's own event is the denominator.

The section 79 list in the product spec was not in this repo when this doc
was written, so the set above is what the shipped event schema supports.
Planner to reconcile the two and add anything missing as an additive prop or
a new constant rather than a rename.

## Closed in Phase 2, COMM-233

Everything the Phase 1 doc listed as parked is now wired, except attendance:

- `weekly_recap_opened` and `weekly_recap_shared` fire from COMM-221's recap
  surface. COMM-233 names them `recap_viewed` and `recap_shared`; the wire
  names stay the two spec 77 reserved, because a second spelling for the
  same two actions would split every recap query for no gain.
- `challenge_joined`, `challenge_completed` and `event_rsvp` have real
  producers now: `joinChallenge()`, the own-progress completion branch
  (COMM-207) and `rsvpEvent()` (COMM-214). Nothing was added to the bridge -
  the bus mapping and the prop shape agreed in Phase 1 were what those
  producers emitted into, and COMM-233 only confirmed the bridge is
  exercised end to end.
- `challenge_viewed` and `event_viewed` now open real detail surfaces
  (COMM-207, COMM-213) and carry the `source` each entry point passes.
- The Boards list cards were recording `source: "post_card"`, because the
  handler's default was written for the link card inside a feed post and the
  list cards carried no `data-source` of their own. Fixed in COMM-233 for
  both challenges and events: any `challenge_viewed` or `event_viewed` with
  `source = "post_card"` dated before that change may actually be a Boards
  open, so a source split across that boundary is not comparable.

## Closed in Phase 3, COMM-300

- Attendance. The line that used to sit under "Still not wired"
  (`ATTENDANCE_RECORDED` has no producer and no analytics name, the source
  is parked under COMM-P03) is closed. The source is a member's own
  session-logging sync: the `private_records_attendance_log` trigger
  (202608310001) derives one `attendance_log` row per member per calendar
  day from the `strength_entry` / `wod_entry` rows the offline outbox
  already upserts, `flushOutbox()` emits `ATTENDANCE_RECORDED` alongside it,
  and `attendance_recorded` is bridged off that emit and counts toward WCAM.
- Two caveats worth carrying into any query written against it. First, the
  emit is a courtesy for client consumers and the analytics bridge - it is
  not what writes `attendance_log`, the trigger is, independently, so
  `analytics_events` and `attendance_log` can legitimately disagree (a
  member on an older cached build produces the table row and no event).
  `attendance_log` is the source of truth for attendance; the event is the
  source of truth for WCAM. Second, "verified" attendance here means
  "derived server-side from the member's own private training log", not a
  physical or staff-confirmed check-in.

## Still not wired

- `post_opened` is not recorded when a notification routes to a post.
  `openNotif()` opens the thread directly rather than through
  `toggleComments()`. `notification_opened` covers that member for WCAM, so
  nothing is lost from the core metric, and the open-rate denominator is
  feed impressions, which that path does not touch either.
