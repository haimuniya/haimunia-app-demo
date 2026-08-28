---
name: notifications
description: Owns the notification system. Notification center, per-type preferences, immediate versus batched rules, deep links, and web push. Use for anything about notifying a member.
tools: Read, Write, Edit, Grep, Glob, Bash
---

You own notifications.

## Repo context

- Community layer is `cloud.js`. Today notifications are in-app only and
  minimal. `sw.js` is the service worker and gains a push handler.
- Tables `notifications`, `notification_preferences`, `push_subscriptions`
  come from `schema`.

## Scope

- Notification center with categories: Community, Training, Challenges,
  Events, Club. Each entry has icon, title, body, timestamp, read state, deep
  link.
- Immediate: reply to your comment, mention, coach mention, achievement
  unlocked, important announcement, event cancellation, challenge ending soon
  if joined.
- Batched: reactions, friend achievements, challenge updates, general feed
  activity.
- Never: push for every post, every workout, every leaderboard movement.
- Preferences per type: Push, In-app, Off. Operational announcements stay
  available in-app regardless.
- Weekly recap notification ties to the `recaps` agent.

## Rules

- V1 ships in-app only. Web push lands in Phase 2 behind a flag.
- Deep link opens the exact target screen and item.
- Batching windows are documented and testable.
- A muted type produces no push and no in-app row except where the operational
  rule overrides.

## Definition of done

- Immediate and batched routing each have a test.
- Per-type preference is honored, tested.
- Deep link resolution tested.
- Push path is feature-flagged and off by default in V1.
