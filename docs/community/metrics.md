# Community metrics

The one place that says what the community measures, what each tracked event
means, and where it fires from. COMM-013 shipped the helper, COMM-170 wired
the Phase 1 surfaces.

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

Passive views alone do not count. Opening the club tab or scrolling the feed
is not membership activity. Uniqueness is per member per week, not per
action, so ten comments from one member is one active member. Week
boundaries follow the club's local week, not UTC.

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
  'post_opened','profile_opened','member_followed','notification_opened')
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
| `challenge_viewed` | Entering the Boards sub-tab with an active challenge, and the challenge link card | `challenge_id`, `challenge_key`, `source` (`boards`, `post_card`) | no |
| `challenge_joined` | Bus, `CHALLENGE_JOINED` | `challenge_id`, `challenge_type` | yes |
| `challenge_completed` | Bus, `CHALLENGE_COMPLETED` | `challenge_id`, `challenge_type` | yes |
| `leaderboard_viewed` | Entering the Boards sub-tab | `board`, `rows`, `source` | no |
| `event_viewed` | The event link card on a `POST_EVENT` card | `event_id`, `source` | no |
| `event_rsvp` | Bus, `EVENT_REGISTERED` | `event_id`, `rsvp_status` | yes |
| `notification_opened` | `openNotif()`, before the mark-read await | `notification_id`, `type`, `target`, `was_unread` | yes |
| `report_submitted` | `submitReportSheet()` after the report RPC succeeds | `target_type`, `reason` | no |
| `weekly_recap_opened` | Phase 2, COMM-220. Constant defined, unwired | to be defined | no |
| `weekly_recap_shared` | Phase 2, COMM-220. Constant defined, unwired | to be defined | no |

### Events that come from the bus

`post_created`, `comment_created`, `reaction_added`, `challenge_joined`,
`challenge_completed` and `event_rsvp` are never hand-tracked. The bridge in
`src/analytics.js` subscribes to the matching product event and writes the
row, which is what keeps one producer from having to remember two calls. A
second hand-written call at the same surface would double count.

`BUS_PROP_KEYS` projects each payload down to the listed props. A key the
producer sends that is not on the list is dropped, and an array prop named in
`BUS_COUNT_KEYS` is stored as its length. `mentions` on `COMMENT_CREATED` is
the live case: the bus carries the resolved mention objects for the
notification consumer, and analytics keeps only `mention_count`.

`WORKOUT_COMPLETED`, `PR_CREATED`, `MEMBER_JOINED`, `ACHIEVEMENT_UNLOCKED`
and `ATTENDANCE_RECORDED` are deliberately unmapped. Completing a workout is
not sharing one and unlocking an achievement is not sharing it, so mapping
either would inflate WCAM with actions that are not community
participation.

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
  never counted as one. The two exceptions are `profile_opened` and
  `notification_opened`, both recorded at the moment of the action because
  the member opened the thing whether or not the fetch behind it answers.

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

The section 79 list in the product spec was not in this repo when this doc
was written, so the set above is what the shipped event schema supports.
Planner to reconcile the two and add anything missing as an additive prop or
a new constant rather than a rename.

## Not wired in Phase 1

- `weekly_recap_opened` and `weekly_recap_shared`. The recap surface is
  Phase 2, COMM-220. The constants exist and stay unused until then.
- `challenge_joined`, `challenge_completed` and `event_rsvp` have no
  producer yet. The bridge is attached and the prop shape is agreed, so the
  challenge module (COMM-201) and the event module (COMM-217) only have to
  emit the bus event.
- `challenge_viewed` and `event_viewed` fire from the link card tap, which
  has no detail view to open until those same two tickets land. The tap is
  still the member asking to see the item. When the detail surfaces exist
  they record the same event with their own `source`.
- `post_opened` is not recorded when a notification routes to a post.
  `openNotif()` opens the thread directly rather than through
  `toggleComments()`. `notification_opened` covers that member for WCAM, so
  nothing is lost from the core metric, and the open-rate denominator is
  feed impressions, which that path does not touch either.
- Attendance. `ATTENDANCE_RECORDED` has no producer and no analytics name.
  The attendance data source is parked, COMM-P03.
