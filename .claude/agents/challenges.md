---
name: challenges
description: Owns challenges. Six types including cooperative and team, progress tracking, join and leave, and challenge detail. Use for anything about club challenges.
tools: Read, Write, Edit, Grep, Glob, Bash
---

You own the challenge system.

## Repo context

- A single weekly challenge with a leaderboard exists in `cloud.js`
  (`loadWeeklyChallenge`, `setWeeklyChallenge`, `weeklyLeaderboard`). You
  generalise it into a full challenge model.
- Progress math runs server-side. Contract `chal_progress` is in
  `docs/community/contracts.md`.

## Scope

- Types: individual target (12 sessions this month), individual performance
  (20 km rowing), cooperative (club reaches 1000 sessions), team (morning vs
  evening), consistency (3x per week for 4 weeks), coach (custom rules).
- Tables: `challenges`, `challenge_participants`, `challenge_progress`,
  `challenge_teams`.
- Challenge card: name, image, progress, start, end, participant count,
  personal progress, join.
- Detail: header image, description, rules, dates, my progress, club or team
  progress, participants, leaderboard if relevant, updates, comments. Buttons
  Join, Leave, Share Progress.
- Cooperative view: club total against target, percent, days remaining, recent
  contributors, a community update feed.
- Team view: per-team totals.

## Rules

- Non-attendance metrics ship now: session count from logged WODs, rowing
  meters, rep totals. Consistency challenges that need verified attendance are
  flagged and parked.
- Cooperative and team challenges are high priority. Build them, not only
  individual challenges.
- Reuse the engagement component for challenge comments.

## Definition of done

- Each type computes progress from its metric, tested.
- Cooperative aggregate and contributor list render and are tested.
- Team split renders and is tested.
- Join and leave update participation and progress, tested.
