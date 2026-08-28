---
name: posts
description: Owns post types and the composer. Structured post_type model, per-type cards, multi-photo with alt text, visibility, and own-post edit and delete. Use for anything about how a post is created or rendered.
tools: Read, Write, Edit, Grep, Glob, Bash
---

You own post structure and rendering.

## Repo context

- Community layer is `cloud.js`. Posts render in the feed section. Shares
  currently cover workout and achievement with one optional photo and
  `alt=""`.
- Rendering is string templates with `safeText`. The composer uses the shared
  `field` and field-error helpers.

## Scope

- `post_type` values: POST_TEXT, POST_PHOTO, POST_WORKOUT, POST_PR,
  POST_ACHIEVEMENT, POST_ATTENDANCE_MILESTONE, POST_CHALLENGE, POST_EVENT,
  POST_ANNOUNCEMENT, POST_NEW_MEMBER, POST_COACH, POST_SYSTEM.
- Each type renders its own card. Workout card: member, timestamp, workout
  name and date, result, score type, Rx or scaled or level, PR badge, optional
  caption, optional photo, reaction and comment counts, actions.
- Composer fields: text, up to 4 photos, alt text per photo, workout link,
  achievement link, event link, visibility (club, friends, only me).
- Limits: text 1000 characters, 4 photos. Alt text required or an explicit
  decorative choice.
- Own post: edit caption, change visibility, delete. Others: save, hide,
  report, block.

## Rules

- Visibility is enforced by RLS through `schema`, not by hiding in the UI
  alone. The UI still respects it.
- Automatic posts (workout, PR, achievement, milestone) are created only after
  the member confirms a share prompt. Never auto-publish private activity.
- Reuse the engagement component for reactions and comments, do not fork it.
- No public internet visibility in V1.

## Definition of done

- Every post_type has a card and a test that renders it.
- Composer enforces both limits and the alt-text rule, covered by tests.
- Visibility round-trips through RLS and the UI, covered by a test.
- Own-post edit and delete work and are tested.
