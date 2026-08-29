# Fedora development handoff

Move the Community module build from this Windows machine to a Fedora
environment and continue with Claude Code. Written 2026-08-29.

## What this project is

- `haimunia-app-demo-publish`, an installable offline-first Hebrew RTL
  training-log PWA. Zero build step, vanilla JS served static from GitHub
  Pages.
- `app.js` is the offline training log (lifts, WODs, bodyweight,
  measurements, calendar, achievements). `cloud.js` is the community layer,
  one IIFE with a `state` object and a `rerender()` call.
- Backend is Supabase. The browser uses a vendored client directly. Every
  boundary is enforced by Row Level Security, not UI checks. Heavier logic
  runs as Postgres functions and Deno Edge Functions.
- Tests: `npm test` is `node --test` with jsdom and fake-indexeddb.
  `scripts/browser-check` is a Playwright suite. CI job `migration-check`
  applies every migration against a throwaway Postgres and now also runs a
  pgTAP suite.
- Repo: `https://github.com/haimuniya/haimunia-app-demo.git`. Working
  branch `community/phase-0`.

## What the upgrade is for

The repo already shipped a partial Community V1. The upgrade evolves this
demo into the production Community module per a full product spec: a ranked
feed, structured post types with per-type cards, one reaction plus threaded
comments, an achievement engine, a notification center, challenges, events,
weekly and monthly recaps, a coach dashboard, role-based access control,
moderation, and analytics.

Structure of the work:

- Four phases. Phase 0 foundations, Phase 1 Community V1, Phase 2
  engagement, Phase 3 intelligence.
- 15 per-section agent definitions in `.claude/agents/`, one per area
  (schema, feed, posts, engagement, achievements, challenges, events,
  notifications, recaps, coach-tools, admin-moderation, identity-privacy,
  platform, qa, planner).
- Tickets in `docs/community/tickets/COMM-xxx.md`. Phase board in
  `docs/community/backlog.md`. Function contracts in
  `docs/community/contracts.md`. Master plan in
  `2026-08-28-community-module-plan.md`.

Locked decisions:

- This repo becomes the production module.
- Zero build step on the client stays. Postgres functions and Edge
  Functions do the heavy work.
- Identity is recoverable and required. A verified email and password
  before or right after invite redemption.
- Attendance and class-connection features are parked until a data source
  is chosen.

## Current state

Phase 0: complete and pushed. 13 migrations, 22 tables, RLS on every table,
the identity recovery gate, an actor-level invite throttle, granular
privacy toggles, four `src/` platform modules (event bus, analytics,
realtime, image resize), and a two-user pgTAP RLS suite that is advisory in
CI. Last CI run on the branch tip was green on node-tests, browser-checks,
and migration-check.

Phase 1 client: complete. posts, feed, engagement, achievements,
notifications, admin-moderation, coach identity, and analytics wiring are
all built in `cloud.js` and `app.js` and committed. `npm test` is green at
555 tests, 554 pass, 1 skip.

Branch `community/phase-0`, latest local commit `52fdda6`.

Important: the Phase 1 client calls Postgres functions that do not exist
yet. They are registered only in the test mock. The branch is not
deployable until the schema follow-up lands. The "Needs from schema"
sections in `docs/community/contracts.md` list every missing function.

## Before you switch machines

Do this from Windows or the work stays here.

1. Let any running Claude Code agent finish and commit. A background
   agent's uncommitted edits live only on this machine.
2. `git status` must be clean or intentionally staged.
3. Push every local commit:
   ```
   cd C:\Users\shaha\Desktop\Shahaf_Private\Project\haimunia-app-demo-publish
   git push
   ```
   Several commits after `d0d1ff1` are local only. Without this push the
   Fedora clone will not have posts, feed, engagement, achievements,
   notifications, admin-moderation, coach identity, or analytics.
4. Confirm the push:
   ```
   git log --oneline origin/community/phase-0 -1
   ```
   It should show the same commit as local `HEAD`.

## Fedora setup

### Required

```
sudo dnf install -y git nodejs npm
node -v      # need 22 or newer, use nvm or dnf module if the repo Node is older
```

Install Claude Code per its current Linux instructions.

Clone and verify:

```
git clone https://github.com/haimuniya/haimunia-app-demo.git
cd haimunia-app-demo
git checkout community/phase-0
npm ci
npm test          # expect 555 tests, 554 pass, 1 skip
```

### Git credentials

The Windows Git Credential Manager GUI prompt was the reason pushes needed a
human at the terminal. On Fedora use one of:

- SSH: add an SSH key to GitHub, set the remote to
  `git@github.com:haimuniya/haimunia-app-demo.git`.
- A Personal Access Token with `git config --global credential.helper store`
  so the token is cached after the first push.

Either one lets Claude Code push without a prompt.

### Optional but recommended: local Supabase

Only the local Supabase stack needs Docker. Everything else is pure Node.
Installing it unblocks pgTAP debugging (COMM-020) and local migration
validation instead of a push-and-wait-for-CI loop.

```
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # log out and back in

# Supabase CLI
npm i -g supabase   # or: use the release tarball from github.com/supabase/cli

cd haimunia-app-demo
supabase start      # applies every migration to a local Postgres, Auth, Storage
supabase test db    # runs the pgTAP suite in supabase/tests/
supabase stop
```

### What does not travel with the clone

- `~/.claude/CLAUDE.md`, the global writing and workflow instructions. Copy
  it over if you want the same behavior.
- `~/.claude/projects/.../memory/`, the auto-memory. Copy the `memory`
  directory if you want session continuity.
- Git credentials.
- Docker and the Supabase local stack.
- Any running background agents. They end with this Windows session.

Everything else is in the repo: all code, migrations, tests,
`.claude/agents/`, `docs/community/`, and the plan doc.

## Read these first on Fedora

1. `2026-08-28-community-module-plan.md`, the whole plan and the locked
   decisions.
2. `docs/community/backlog.md`, the phase board, current status, and the
   schema handoff sections for qa.
3. `docs/community/contracts.md`, every function signature and the "Needs
   from schema" sections that list what is still missing.
4. `.claude/agents/*.md`, the 15 agent definitions. They load as agent
   types at session start.
5. `CHANGES.md`, repo history and conventions.

## What is left to do

### Finish Phase 1

1. Schema follow-up run 1: DONE, commit `db7a6ba`. `ach_claim` and the
   27-row seed, a 4-arg `add_post_comment` writing `comment_mentions`,
   `comment_delete` for author soft-delete, the `community_profile(user_id)`
   jsonb function, and `post_media.decorative`.
2. Schema follow-up run 2, moderation reshape plus the missing post write
   path. `post_create` does not exist in the database, so publishing a post
   fails end to end. Add it first: it inserts `workout_posts` and
   `post_media` rows, checks `community.post.create` and
   `is_posting_restricted`, emits `POST_CREATED`, and takes the media item
   shape with `decorative`. Then the moderation reshape: `reports` table
   gains
   `target_type` and `target_id`, `report_status` enum gains
   `action_taken`, `report()` supersedes `submit_report`, `mod_queue()`,
   `mod_review` becomes 4-arg with `p_expires_at` and a
   `has_perm('community.comment.moderate') OR is_admin` check,
   `comment_moderate()`, `admin_grant_coach` gains `p_role` and writes a
   `role_change` audit row, and the `posts_feed_select` policy switches
   from `rp.post_id = p.id` to `rp.target_type = 'post' and rp.target_id =
   p.id`.
3. Schema follow-up run 3, notifications server side: `notif_create()`, the
   AFTER INSERT triggers `notif_on_comment()`, `notif_on_reaction()`,
   `notif_on_announcement()`, an `ACHIEVEMENT_UNLOCKED` to notification
   path, and a batch flush function. The flush scheduler is infra, a
   pg_cron entry or an Edge Function, note it rather than block on it.
4. qa sweep: COMM-190 dialog keyboard and focus tests for every new dialog
   (composer, PR prompt, profile overlay, notification center, moderation
   sheets, achievement celebration), then COMM-191 the coverage sweep and
   the Phase 1 CI gate.
5. Push, confirm CI green on all three jobs.

### COMM-020, pgTAP suite

The two-user RLS suite is written and advisory in CI. Run `supabase start`
then `supabase test db` locally, fix the failures, then remove
`continue-on-error: true` from the `supabase test db` step in
`.github/workflows/test.yml`.

### Open decisions, still unresolved

- Attendance data source: Arbox integration, an in-app class check-in, or
  self-reported. Gates the parked bucket and most of Phase 3.
- Reaction label: a club-specific Hebrew term, or keep the current wording.
  The database value stays generic either way.
- Hebrew copy review: every Phase 1 agent listed the new strings in its
  report. Collect them from the git history of this session and review.
- Web push VAPID keys, needed for Phase 2.

### Phase 2, not started

`planner` must first expand the 34 titles COMM-201 to COMM-234 in
`docs/community/backlog.md` into full ticket files. Then build: challenges
with six types including cooperative and team, the events module,
announcement priority and pin, the weekly recap and onboarding sequence,
the coach dashboard Celebrate and Welcome sections, realtime for comments
and reaction counts and challenge progress, member and event and challenge
search, the following system surface, the members directory, and web push
behind a flag. Build order is in the plan doc.

### Phase 3, not started

Feed personalization, the coach Engage section and attendance-decline
detection once attendance lands, the monthly club recap, the full admin
analytics dashboard, and a versioned abandoned-profile purge.

## Continuing the agent workflow on Fedora

- The `.claude/agents/` definitions load at session start, so `schema`,
  `feed`, `posts`, and the rest are available as agent types.
- Resume with schema follow-up run 2, then run 3, then the qa sweep.
- Commit after each agent. Push periodically.
- During this session the account hit a monthly spend limit and opus was
  blocked, with a reset at 8pm Asia/Jerusalem. If that recurs, run the
  `schema`, `feed`, and `platform` agents on Sonnet instead of opus. Their
  definitions request opus but the work is fine on Sonnet.
- Two agent runs failed mid-session on infrastructure, not on the task.
  Committing after every successful agent kept the tree safe. Keep that
  pattern.
