# Database Audit — schema integrity, migration hygiene, test coverage, deletion semantics

Scope: `supabase/migrations/*.sql` (101 files), `supabase/tests/*.sql` (76 pgTAP files + `rls_helpers.sql`), `supabase/config.toml`, `supabase/functions/*`.
Out of scope (owned by the parallel security stream): deep RLS policy correctness. Structural DB issues that *touch* authorization are noted here only where they affect data integrity or deletability.

Audited from a static checkout on 2026-09-06, branch `community/phase-0`.

## What could NOT be verified in this environment

| Item | Why | What it needs |
| --- | --- | --- |
| `supabase test db` (pgTAP suite pass/fail) | `which supabase` → not found; `docker ps` → no containers running | Supabase CLI + Docker. **No claim of pass or fail is made below** — only which migrations have/lack a test *file*. |
| `supabase start` (do all 101 migrations apply cleanly in order?) | same | same |
| Actual production schema drift vs. these migrations | no live credentials | psql/dashboard access to the real project |
| Whether `pg_cron` / `pg_net` are actually enabled on the live project | no dashboard access | Supabase dashboard → Database → Extensions |
| Whether the two `edge_functions_*` Vault secrets were ever set to real values | no dashboard access | Supabase dashboard → Vault |
| Row counts / index bloat / actual query plans | no live DB | production connection |

---

## 1. Findings by severity

### HIGH

#### DB-H1 — `purge_due_accounts()` is never scheduled: the 30-day GDPR deletion window never fires

`request_account_deletion()` (202608260001) writes an `account_deletion_requests` row with `purge_after = now() + interval '30 days'` and soft-deletes the profile and posts. `purge_due_accounts()` is the function that actually removes `auth.users` rows once that window closes. It is `grant execute … to service_role` and documented as "Invoke daily from a trusted scheduler/Edge Function".

`202609050005_scheduled_jobs.sql` is the migration that finally gave every dormant periodic function a cadence. It schedules **eight** jobs:

```
notif-batch-flush, recap_monthly, feed-weights-recompute, chal-notify-ending-soon,
coach-engagement-decline, purge-abandoned-profiles, recap-weekly, telemetry-retention-purge
```

`purge_due_accounts` is **not among them**, and it is not called by any of the three Edge Functions either (grepped `supabase/functions/` — it appears only in prose comments). The only mention in the scheduler migration is a passing reference on line 43 ("everything else … has an existing purge (purge_due_accounts, purge_abandoned_profiles)") — i.e. it was assumed already covered while writing the very file that would have covered it.

**Effect:** an account-deletion request is honoured as a soft-delete (profile hidden, posts hidden) but the underlying `auth.users` row, `private_records` payloads, `attendance_log`, `analytics_events`, `feed_impressions` etc. persist indefinitely. The product promises erasure after 30 days and the schema never performs it.

Fix: add a `cron.schedule('purge-due-accounts', …, $$select public.purge_due_accounts()$$)` alongside the other seven, or call it from an Edge Function.

#### DB-H2 — Three FKs point at `auth.users` with no `ON DELETE` action, and can hard-block both purge paths

```
public.invites.created_by                  -> auth.users(id)   NO ACTION   (202609030001:87, NOT NULL)
public.invites.revoked_by                  -> auth.users(id)   NO ACTION   (202609030001:95)
public.invites.redeemed_by                 -> auth.users(id)   NO ACTION   (202609030001:97)
public.onboarding_step_content.updated_by  -> auth.users(id)   NO ACTION   (202609030004:40)
public.intro_carousel_content.updated_by   -> auth.users(id)   NO ACTION   (202609050007:38)
```

Every other `auth.users` reference in the schema (9 of them) is `on delete cascade`. These five were added later and broke the invariant.

`202609010004_purge_abandoned_profiles.sql` predicted this in its own header comment:

> "a future FK added on some other table straight to `auth.users` without `on delete cascade` becomes one counted failure, not a run that aborts for every candidate behind it."

Three such FKs were added 2 days later. The consequences differ by purge path, and the *worse* one is the path that was not defended:

- `purge_abandoned_profiles()` deletes one candidate per iteration inside its own `exception when others` block → the blocked account is silently counted as `failure` and never purged. Degraded but contained. Note the exception handler deliberately discards the error detail, so the *reason* is unrecoverable from logs — the operator sees only a rising failure count.
- `purge_due_accounts()` does a **single bulk statement**: `delete from auth.users u using due d where u.id = d.user_id`. A FK violation on any one row aborts the whole statement. One admin or coach who created a per-person invite and then requested deletion makes the function raise, and **zero** due accounts get purged — for everyone, forever, until someone notices. (Currently moot only because of DB-H1; fixing DB-H1 without fixing this converts a silent no-op into a silent hard failure.)

Fix: `on delete set null` for `revoked_by`/`redeemed_by`/`updated_by`; `created_by` is `NOT NULL` so it needs either a nullable + set-null change or an explicit pre-delete step.

#### DB-H3 — A member hard-deleting their own post cascade-deletes the moderation reports filed against it

`workout_posts` has a real DELETE grant and a DELETE policy:

```sql
grant select, insert, update, delete on … public.workout_posts … to authenticated;   -- 202608260001:105
create policy posts_delete_self on public.workout_posts for delete to authenticated
  using (author_id = auth.uid());                                                     -- 202608280005:134
```

and `reports.post_id uuid references public.workout_posts(id) on delete cascade` (202608260001). There is **no BEFORE DELETE trigger on `workout_posts`** (the only delete triggers on that table are the four `pins_unpin_deleted_*` AFTER-DELETE cleanups).

So a reported member can `DELETE FROM workout_posts WHERE id = …` via PostgREST and destroy the evidence: the `reports` rows, `post_media` rows, `reactions`, `saved_posts`, `hidden_posts` all cascade away. The moderation queue loses the item entirely rather than showing "content removed by author".

The intended path is the `post_delete(uuid)` RPC, which soft-deletes — but the direct grant + policy makes the hard path equally reachable. This is the same "the RPC is the intended path but the raw grant is still live" pattern that `202609050005` section 1b explicitly identified and revoked for `feed_impressions`; it was not applied to `workout_posts`.

Related orphan: `post_media` rows cascade away but the **Storage objects they point at do not**. `post_media.storage_path` has a unique index but nothing deletes from `storage.objects` on cascade, so every deleted post leaves its images in the `post-photos` bucket permanently, unreferenced and unbillable-to-anyone. Same for `avatar-photos`.

#### DB-H4 — Deleting an `achievement_definitions` row cascade-deletes every member's earned unlock

```sql
member_achievements.achievement_id uuid not null
  references public.achievement_definitions(id) on delete cascade;   -- 202608280007:30
grant insert, update, delete on public.achievement_definitions to authenticated;
create policy achievement_definitions_delete_admin … for delete to authenticated …
```

An admin retiring or renaming a badge silently erases user-earned history (`unlocked_at`, `shared_at`) for every member who ever earned it, with no soft-delete and no confirmation surface in the schema. `achievement_definitions` already has an `enabled` flag (there is a partial index `… where enabled`), so a disable path exists and is the correct one — the DELETE grant/policy/cascade combination is the hazard.

Same shape, lower blast radius, on `challenges`: `challenges_delete_perm` (coach-reachable) + `challenge_participants.challenge_id … on delete cascade` + `challenge_progress.challenge_id … on delete cascade` means deleting a challenge destroys every participant's logged progress. `challenges` has no `deleted_at` column and no `status='deleted'` value that would allow a reversible retirement.

Also `roles`/`permissions`: `roles_delete_owner` and `permissions_delete_owner` policies plus `role_permissions.role_code … on delete cascade` / `.permission_code … on delete cascade` mean deleting one role silently rewrites the permission matrix.

### MEDIUM

#### DB-M1 — Migrations are NOT strictly forward-only: four were edited in place after being applied

`git log --follow` over each migration file shows four with more than one commit:

| Migration | Commits | Evidence |
| --- | --- | --- |
| `202608270006_security_hardening.sql` | **5** | `7e00112` "Fix invite_codes primary-key/foreign-key ordering bug", `4bfeb41` "Fix is_staff() default-removal bug", `ec3c6c7` "Fix policy-dependency ordering bug", `88ce716` "Schema-qualify pgcrypto calls" |
| `202608270004_community_engagement.sql` | **3** | `f565a4a` **"Fix column-ordering bug in 202608270004 that broke a live migration run"**, `4f9f5e0` "Fix view-column-ordering bug (was left uncommitted)" |
| `202608280020_achievement_claim_and_seed.sql` | 2 | `db7a6ba` "Phase 1 schema follow-up 1" |
| `202608310002_relationship_score.sql` | 2 | `e7a6148` "Relationship score extraction (COMM-301)" |

The `f565a4a` message is the explicit admission: the file was edited *after a live migration run*. Supabase records applied migrations by version in `supabase_migrations.schema_migrations` and will not re-apply a version it has already seen. Therefore:

- Any environment that applied the *original* `202608270004` / `202608270006` still carries the buggy object definitions and will **never** receive the fix.
- CI's `supabase start` builds from scratch and applies the *current* file contents, so **CI is structurally incapable of detecting this class of drift** — it validates the repo against itself, not against production.
- The repo is consequently not a reliable description of the live schema for these two migrations.

All four edits are same-day/next-day and predate the current branch, so the practical exposure depends on whether the live project was migrated before or after each fix — **unverified in this environment; requires a `select * from supabase_migrations.schema_migrations` against the live project plus an object-level diff (`pg_dump --schema-only`) to confirm.** Add that diff to the pre-launch checklist.

Going forward: fixes to an already-applied migration must be new, higher-numbered migrations, not edits.

#### DB-M2 — 28 of 31 `club_id` foreign keys have no supporting index

Every one of the 31 club-scoped tables carries `club_id uuid not null default public.default_club_id() references public.clubs(id)` with **no `ON DELETE`** (i.e. `NO ACTION`). Only 3 of those 31 tables have an index leading on `club_id`.

- Integrity is *fine* — `NO ACTION` is the right choice here (a club must not be deletable while content references it) and is arguably deliberate.
- But `clubs` has a live DELETE grant and a `clubs_delete_owner` policy. Deleting a club therefore triggers 31 unindexed sequential FK checks. On a single-club deployment this is invisible; on any real multi-club table it is a full-table lock-and-scan across the entire schema.
- Lower-severity but real: the club-scoped read paths themselves (`where club_id = …`) also have no index to lean on, so multi-club scale-out would degrade every feed/notification/analytics query at once.

Recommendation: not urgent while `default_club_id()` makes this effectively single-tenant, but this is the single largest latent scaling cliff in the schema, and it should be recorded as a known precondition for multi-club.

#### DB-M3 — FK columns with no supporting index (non-`club_id`)

Cascade/set-null FKs whose referencing column has neither an index nor a leading position in the PK/unique key. Each one is a sequential scan on the child table every time a parent row is deleted:

| Child column | Parent | ON DELETE |
| --- | --- | --- |
| `announcements.author_id` | `profiles(id)` | cascade |
| `blocks.blocked_id` | `profiles(id)` | cascade (only `blocker_id` leads the PK) |
| `challenge_progress.user_id` | `profiles(id)` | cascade |
| `challenge_progress.entered_by` | `profiles(id)` | set null |
| `challenge_progress.team_id` | `challenge_teams(id)` | set null |
| `challenge_teams.captain_id` | `profiles(id)` | set null |
| `challenges.created_by` | `profiles(id)` | set null |
| `coach_engagement_flags.reviewed_by` | `profiles(id)` | set null |
| `events.created_by` | `profiles(id)` | set null |
| `member_achievements.achievement_id` | `achievement_definitions(id)` | cascade |
| `member_of_week.post_id` / `.published_by` | `workout_posts` / `profiles` | set null |
| `post_comments.deleted_by` | `profiles(id)` | set null |
| `posting_restrictions.source_report_id` | `reports(id)` | set null |
| `reports.post_id` | `workout_posts(id)` | cascade |
| `reports.reviewed_by` | `profiles(id)` | no action |
| `role_permissions.permission_code` | `permissions(code)` | cascade |
| `saved_posts.post_id` | `workout_posts(id)` | cascade |
| `weekly_challenges.created_by` | `profiles(id)` | cascade |
| `invites.created_by` / `.revoked_by` / `.redeemed_by` | `auth.users(id)` | no action |
| `invite_redemptions.code` / `.person_invite_id` | `invite_codes(code)` / `invites(id)` | no action |
| `onboarding_step_content.updated_by`, `intro_carousel_content.updated_by` | `auth.users(id)` | no action |

The most load-bearing of these are `reports.post_id`, `saved_posts.post_id`, `challenge_progress.user_id` and `member_achievements.achievement_id` — they sit directly on the account-deletion and post-deletion cascade paths, which is exactly when scan cost is worst (many tables scanned in one transaction, holding locks).

`profiles.assigned_coach_id` is correctly covered by `profiles_assigned_coach_idx`.

#### DB-M4 — pgTAP coverage: 12 foundation migrations have no test file, and 5 more are uncovered by name

101 migrations, 76 `*_test.sql` files. 71 migrations have an exactly slug-matching test.

Five test files intentionally cover multiple migrations, and those account for most of the apparent gap:
`0035_challenge_progress_notifications` (covers 4 challenge migrations), `0036_realtime_and_search_runtime`, `0062_admin_search_members_fix`, `0063_scheduler_reports_and_retention`, `0064_deletion_requests_pings_challenges`.

After crediting those, the genuinely untested set is **the entire pre-`clubs_and_rbac` foundation era** — tests are numbered from `0001_clubs_and_rbac` = `202608280001`, so everything before it has no dedicated test:

```
202608260001_community_foundation          <- profiles, private_records, follows, blocks,
                                              workout_posts, reactions, reports,
                                              account_deletion_requests, community_feed view,
                                              request_account_deletion(), purge_due_accounts()
202608270001_community_growth              <- announcements, post-photos bucket
202608270002_lock_anon_defaults
202608270003_invite_gate                   <- invite_codes, invite_redemptions
202608270004_community_engagement           (one of the retro-edited files, DB-M1)
202608270005_coach_tier
202608270006_security_hardening             (retro-edited 4x, DB-M1)
202608270007_grant_coach_by_handle          <- 0 references anywhere in supabase/tests/
202608270008_hebrew_handles                 <- 0 references ("hebrew" appears in no test)
202608270009_admin_moderation_visibility
202608270010_rate_limiting
202608270011_admin_member_management
```

Plus, by name and confirmed by grepping the test bodies for their principal objects:
`202608290007_realtime_publication`, `202609010010_avatar_photo`, `202609030008_invite_create_coach_role_requires_admin`, `202609050001_password_reset_audit_label`, `202609050003_report_admin_alert` (`report_admin_alert` → 0 hits in `supabase/tests/`), `202609050005_scheduled_jobs` (`scheduled_jobs` → 0 hits; `0063` covers retention but not the cron wiring).

Spot-check of object-level coverage across the whole suite:

| Object | Test files referencing it |
| --- | --- |
| `is_staff` | 17 |
| `blocks` | 24 |
| `follows` | 10 |
| `redeem_invite_code` | 5 |
| `rate_limits` | 4 |
| `private_records` | 4 |
| `purge_due_accounts` | 2 |
| `request_account_deletion` | **1** |
| `community_feed` (the view) | **0** |
| `grant_coach_by_handle` | **0** |
| `report_admin_alert` | **0** |
| `scheduled_jobs` / cron wiring | **0** |
| Hebrew handle validation | **0** |

The two most under-tested areas are the *oldest, most security-critical* surface (the original profiles/blocks/reports policy set and the invite gate) and the *newest, least-exercised* surface (the scheduler). That the two retro-edited migrations from DB-M1 both fall in the untested block is the compounding risk.

**Not asserted: whether the 76 existing tests pass.** They were not run — no CLI, no Docker. See "What could NOT be verified".

### LOW / INFORMATIONAL

#### DB-L1 — Migration re-run safety

All 101 migrations are wrapped in `begin;` … `commit;` — verified mechanically, zero exceptions. That is a genuinely good property: a migration that fails partway leaves no partial state.

Non-idempotent DDL is nonetheless widespread and would fail on a naive re-run of an individual file: 50 bare `create table public.…`, 71 bare `create index`, 174 `create policy`, 52 `create trigger`, 8 `create type`, and 20 `drop policy` without `if exists`. This is **not a defect** under Supabase's version-tracked, run-once model, and `supabase db reset` (apply-all-from-empty) is unaffected. It only matters if someone hand-applies a file. Recorded for awareness, not for action.

Two constructs *were* handled correctly and deserve the note:
- `202608280004` places its three `alter type public.post_visibility add value if not exists` calls as the **last statements before `commit;`**, with a comment stating "Nothing may reference them until this transaction commits, which is what 202608280005 is for." That is the correct handling of the PG "unsafe use of new value" rule, and it was done deliberately.
- `202608290007` documents why `ALTER PUBLICATION … ADD TABLE` *is* transaction-safe (unlike `CREATE INDEX CONCURRENTLY` / `ALTER TYPE ADD VALUE`).

#### DB-L2 — The only `DROP COLUMN`s were preceded by a backfill

Two raw drops exist in the entire history, both in `202608270006_security_hardening.sql`:

```sql
alter table public.invite_redemptions drop column code;
alter table public.invite_codes drop column code;
```

These replace a plaintext invite `code` with `code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$')`, and the migration swaps `invite_codes`' primary key from `code` to a new `id` first (`alter table public.invite_codes add constraint invite_codes_pkey primary key (id)`), in the correct order — a bug that was itself the subject of one of the four retro-edits (`7e00112`). Dropping the plaintext column is the *point* of the change, so there is deliberately no deprecation window. Acceptable.

No `DROP TABLE` anywhere in the migration history.

#### DB-L3 — Soft-delete is the dominant pattern and is applied consistently

53 of 101 migration files reference `deleted_at timestamptz`; the core content tables (`profiles`, `workout_posts`, `announcements`, `private_records`, `post_comments`) all carry it, and the hot read indexes are partial on it (`… where deleted_at is null` on `workout_posts_feed_idx`, `workout_posts_comparison_idx`, `announcements_feed_idx`, `profiles_visible_idx`). That is the right shape.

Literal `DELETE FROM` in the schema is rare and all of it is intentional:

| Location | What it deletes | Assessment |
| --- | --- | --- |
| `202608260001:162` | `auth.users` (due deletion requests) | intended terminal purge — but see DB-H1, never scheduled |
| `202609010004:101` | `auth.users` (abandoned anon) | intended, scheduled, 30-day window |
| `202609050005:75,79` | `feed_impressions`, `analytics_events` older than 90d | intended retention; migration states plainly it is "IRREVERSIBLE … no soft-delete and no archive" |
| `202608280005:115`, `202608270010:67` | own `reactions` row (un-cheer) | correct — a reaction has nothing to soft-delete |
| `202608280017:147,172` | `pins` on dead targets | correct — a pin is a pointer |

The exceptions to soft-delete are the ones flagged above (DB-H3, DB-H4): `workout_posts`, `achievement_definitions`, `challenges`, `roles`, `permissions` all have live client DELETE grants + policies that bypass their own soft-delete story.

#### DB-L4 — Grace window for account deletion: present and correct

```sql
create table public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null default (now() + interval '30 days')
);
```

`request_account_deletion()` upserts with `on conflict … do update set requested_at = now(), purge_after = now() + interval '30 days'`, so a re-request re-arms the clock. 30 days is a reasonable reversible window and the request row is `select`-able by the member.

However there is **no `cancel_account_deletion()` RPC** anywhere in the schema — the member can see their pending deletion but has no schema-level way to withdraw it, and `deleted_at` on their profile/posts is never cleared. The window is reversible only by an operator running SQL. Combined with DB-H1 (nothing ever purges), the current real-world behaviour is: deletion is *effectively permanent-but-not-actually-erasing* — the worst of both. Fix DB-H1 and add a cancel path together.

Anonymous-session purge (`purge_abandoned_profiles`, 202609010004) is well designed: four independent conditions all required, "genuinely absent" rather than "older than the window" for redemption and recovery-verification, per-candidate exception isolation, an explicit `PURGE_VERSION` in the Edge Function so a predicate change is distinguishable in logs, and documented idempotency. This is the strongest piece of deletion machinery in the repo.

#### DB-L5 — Structural notes (flagged for the security stream, not analysed here)

- **All 55 tables have `enable row level security`** — verified mechanically, zero gaps.
- **No table uses `force row level security`**, so the table owner (and every `security definer` function, of which there are many) bypasses RLS entirely. Standard for Supabase; the security stream owns whether each definer function re-implements its gate correctly.
- `alter default privileges in schema public revoke select, insert, update, delete on tables from anon, authenticated` (202608270002) is a good default-deny posture for future tables.
- `reports.target_id` has **no FK at all** — deliberate and documented ("it points at one of four different tables"), but it means a report can dangle at a deleted target with nothing to detect it. The polymorphic-target pattern also appears on `admin_actions.target_id` and `pins.target_id`, each with an in-file justification.
- `grant insert, update, delete on public.clubs, public.roles, public.permissions, public.role_permissions to authenticated` (202608280001:154) is a broad grant gated only by policy. Structurally relevant here because of the cascades in DB-H4; correctness of the gate itself is the security stream's call.

---

## 2. Core table reference

Primary keys are `id uuid primary key default gen_random_uuid()` on 29 tables; the rest are natural or composite. Composite PKs in use:

```
follows(follower_id, followed_id)        blocks(blocker_id, blocked_id)
reactions(post_id, user_id, kind)        private_records(user_id, record_type, record_id)
event_attendees(event_id, user_id)       challenge_participants(challenge_id, user_id)
comment_mentions(comment_id, mentioned_user_id)   role_permissions(role_code, permission_code)
club_features(club_id, module_key)       notification_preferences(user_id, type)
onboarding_progress-style (user_id, category) / (user_id, activity_date) / (user_id, action)
```

Text PKs with format CHECKs: `roles.code ~ '^[a-z][a-z0-9_]{2,31}$'`, `permissions.code ~ '^[a-z][a-z0-9_.]{4,63}$'`, `invite_codes.code ~ '^[A-Za-z0-9_-]{4,32}$'`, `onboarding_step_content.step in (…)`.

FK `ON DELETE` distribution across 107 parsed foreign keys: **55 cascade, 39 no action, 13 set null**. Of the 39 `no action`, 31 are the `club_id` set (DB-M2) and 8 are DB-H2 + `invite_redemptions`/`reports.reviewed_by`.

Constraint density is high and is a genuine strength of this schema: **232 `CHECK` constraints** and **527 `NOT NULL`** declarations across the migrations, including length bounds on every free-text column (`char_length(title) between 1 and 120`, `bio <= 160`, `details <= 500`, `endpoint between 1 and 1000`), enum-style `in (…)` checks on every status/type column, regex checks on handles, codes and hashes, and semantic checks such as `follower_id <> blocker_id`, `extract(isodow from week_start) = 1` (week_start really is a Monday) and `extract(day from month_start) = 1`.

Notable unique constraints: `profiles.handle`, `push_subscriptions.endpoint`, `post_media.storage_path`, `workout_posts(author_id, source_type, source_record_id)`, `attendance_log(user_id, occurred_on)`, `feed_interactions(user_id, feed_session_id, post_id)`, `member_of_week(week_start)`, `weekly_recaps(user_id, week_start)`, `monthly_club_recaps(month_start)`, `community_health_scores(week_start)`, `pins(club_id, target_type, target_id)`, `post_media(post_id, "position")`, `challenge_teams(challenge_id, name)`, `reports(reporter_id, target_type, target_id)`, and the partial `member_achievements_once_idx`.

71 indexes total, many of them partial and well-chosen for the actual read paths.

---

## 3. Recommended order of work

1. **DB-H1** — schedule `purge_due_accounts()`. One line; currently a live compliance gap.
2. **DB-H2** — fix the five `auth.users` FKs *before* doing (1), or (1) turns a silent no-op into a silent hard failure.
3. **DB-H3** — revoke the direct `delete` grant on `workout_posts` (and drop `posts_delete_self`), leaving `post_delete(uuid)` as the only path; mirrors the `feed_impressions` fix already shipped in `202609050005` §1b. Separately, decide whether Storage objects should be reaped.
4. **DB-H4** — replace the DELETE policy on `achievement_definitions` with the existing `enabled` flag; add `deleted_at` or a retired status to `challenges`.
5. **DB-M1** — diff live schema against the repo for `202608270004` and `202608270006`; adopt a no-edits-after-apply rule.
6. **DB-M4** — write pgTAP tests for the 12 foundation migrations, starting with `202608260001` (profiles/blocks/reports policies) and `202608270003`/`202608270006` (the invite gate).
7. **DB-M3 / DB-M2** — add indexes on the cascade-path FK columns; record the `club_id` index gap as a multi-club precondition.
8. **DB-L4** — add a `cancel_account_deletion()` RPC.
9. Run `supabase test db` and `supabase start` in an environment that has the CLI and Docker, and record the actual result — nothing in this document asserts it.
