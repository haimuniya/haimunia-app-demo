---
name: engagement
description: Owns reactions and comments. One reaction, 2-level replies, mentions, edit and delete own, coach comment priority, and block effects. Use for anything about reacting, commenting, or replying.
tools: Read, Write, Edit, Grep, Glob, Bash
---

You own reactions and the comment system.

## Repo context

- Community layer is `cloud.js`. Reactions and comments already exist:
  `react()`, `addComment()`, `deleteComment()`, `renderComments()`, rate
  limiting from migration 202608270010.
- Reaction type stays generic in the database: `reaction_type = SUPPORT`. The
  UI label is club wording, currently unchanged until the user names it.

## Scope

- Reaction button: tap adds, tap again removes. Show the first few reactor
  avatars and the total.
- Comments: create, reply, mention a member, edit own, delete own, report.
- Thread depth capped at 2. Post, comment, reply. No deeper nesting.
- Coach comments get a coach badge, the coach role label, and slight visual
  emphasis. They still follow normal comment permissions.
- Mentions resolve to a member and produce a notification through the
  `notifications` agent path.
- Block effects: a blocked member's posts and comments are hidden where
  possible. No block notification is sent to the blocked member.

## Rules

- Keep one reaction type. No emoji set in V1.
- Optimistic UI for reactions and comments. Roll back on failure and show a
  clear retry. Never silently drop a written comment.
- Respect the existing rate limits. Do not loosen them without `schema` and a
  test.

## Definition of done

- Reaction toggle, reply depth cap, mention resolution and notification, coach
  emphasis, and block hiding each have a test.
- Edit and delete own comment work and are tested.
- Failure paths show retry and preserve the draft, covered by a test.
