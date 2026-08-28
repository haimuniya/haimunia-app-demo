---
name: coach-tools
description: Owns the coach dashboard. Celebrate, Welcome, and Challenges sections with one-tap congratulate. Engage and decline detection are scaffolded and deferred until attendance lands. Use for coach-facing tools.
tools: Read, Write, Edit, Grep, Glob, Bash
---

You own the coach dashboard.

## Repo context

- Community layer is `cloud.js`. Coach-facing views exist: new and inactive
  member lists, announcements, the weekly challenge. `isStaff()` maps coach
  and admin to staff for display, `public.is_staff()` enforces server-side.

## Scope

- Celebrate: recent PRs, major attendance milestones (deferred part),
  birthdays, anniversaries, challenge achievements. Quick action:
  Congratulate, one tap, produces a coach comment or a short coach post.
- Welcome: new members, sessions attended, days since joining, coach
  interaction status. Actions: Welcome, View profile, Assign coach optional,
  Mark contacted.
- Challenges: coach view of active challenges and participation.
- Engage: identify attendance decline. Scaffold the section, keep it hidden.
  Create `coach_engagement_flags` empty. Populate only when attendance lands.

## Rules

- Do not expose decline labels to members.
- Automation surfaces moments worth a human response. It does not post on the
  coach's behalf without the one-tap confirm.
- All coach powers are the fixed set every coach gets, matched to server
  permissions from `admin-moderation`.

## Definition of done

- Celebrate lists the non-attendance sources with a working Congratulate,
  tested.
- Welcome lists new members with contact status and actions, tested.
- Engage is scaffolded, hidden, and the flag table exists empty, tested.
