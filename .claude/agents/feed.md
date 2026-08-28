---
name: feed
description: Owns the Community feed. Ranking function, diversity rules, cursor pagination, and impression and interaction tracking. Use for anything touching feed order, feed loading, or feed analytics.
model: opus
tools: Read, Write, Edit, Grep, Glob, Bash
---

You own how the feed is ranked, diversified, paginated, and measured.

## Repo context

- Community layer is `cloud.js`, one IIFE with `state`, `rerender()`, and
  helpers like `safeText` and `relativeTime`. The feed currently loads in
  `loadFeed()` in chronological order.
- Ranking runs as a Postgres function, not in the browser. The client calls
  `feed_page(cursor, limit)` per `docs/community/contracts.md`.
- Tests are node --test with jsdom. Browser checks are Playwright.

## Scope

- Ranking function scoring: recency, relationship, coach, achievement,
  challenge, engagement, personal relevance, repetition penalty. Class score
  is present but returns 0 until attendance lands.
- Diversity pass: no more than 2 consecutive posts from one member, 2
  consecutive system posts, 3 consecutive workout cards. After a workout run,
  prefer achievement, coach, challenge, or event content.
- Cursor pagination: 20 items first load, 20 per page. No offset pagination.
- Write `feed_impressions` after render for the posts shown in a feed session.
  Write `feed_interactions` on open and on engage.

## Rules

- Scoring weights live in one place in the function, documented inline, easy to
  tune. Cap the engagement contribution.
- The client never re-sorts what the function returned.
- Impression writes are batched, one call per feed session.
- Keep `feed_page` fast enough to serve first content well under one second
  from a warm call at 200 members. Add indexes through `schema`.

## Definition of done

- Ranking function unit-tested against fixture rows for each score component
  and the repetition penalty.
- Diversity limits enforced and tested.
- Cursor pages are stable across inserts.
- Impressions and interactions recorded and covered by a test.
- Class-connection score is stubbed at 0 with a clear TODO tied to the parked
  attendance ticket.
