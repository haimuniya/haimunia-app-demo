# Threat model — Haimunia community PWA

Security/threat-modeling audit stream. Built from source: 108 migrations,
3 Edge Functions, `cloud.js`, `app.js`, `index.html`, `sw.js`,
`cloud-config.js`, `supabase/config.toml`. No live system was touched.

Companion documents: `AUTHORIZATION_MATRIX.md` (the real per-table RLS matrix),
`SECURITY_AUDIT.md` (numbered findings SEC-001..019).

---

## 1. System shape

There is no application server. The product is a static, build-free PWA served
from GitHub Pages, talking directly to a Supabase project over PostgREST,
GoTrue, Storage and Realtime. **Row Level Security in Postgres is the only
authorization layer that exists.** Every UI check in `cloud.js` is a rendering
convenience; nothing in the client is a boundary, and the client is fully
readable and modifiable by any user.

Three Edge Functions sit outside that: `recap_weekly` and
`purge_abandoned_profiles` (service-role callers only) and
`admin_reset_password` (called from the browser by a real admin session).

## 2. Assets, ranked

| # | Asset | Where it lives | Why it matters |
|---|---|---|---|
| A1 | Member identity set — UUIDs, handles, display names, avatars, bios | `profiles`, `avatar-photos`, and indirectly `challenge_participants.user_id`, `event_attendees.user_id`, `member_achievements.user_id`, `member_of_week.user_id` | A closed, invite-only club. Membership itself is confidential; a roster is the primary thing an outsider should not get. |
| A2 | Private training history | `private_records` (`payload jsonb`), local IndexedDB | Bodyweight, measurements, session notes. Owner-only by design and never surfaced in the feed. |
| A3 | Social content | `workout_posts`, `post_comments`, `reactions`, `post_media`, `post-photos` | Photos and free text, with per-post visibility (`only_me`/`friends`/`club`). |
| A4 | Attendance and behavioural signal | `attendance_log`, `activity_pings`, `feed_impressions`, `feed_interactions`, `analytics_events` | Reveals when a person is at the gym — a physical-safety-relevant pattern. |
| A5 | Privacy toggles as promises | 12 boolean columns on `profiles` (`202608280003:20-33`) | A toggle that does not hold is worse than no toggle. |
| A6 | Moderation state and audit trail | `reports`, `workout_posts.status`, `post_comments.status`, `admin_actions`, `posting_restrictions` | The club's only safety mechanism. |
| A7 | Credentials and session material | `auth.users`, session in `localStorage` | Usernames are guessable by design (`${username}@members.haimuniya.invalid`). |
| A8 | Invite codes | `invite_codes.code_hash`, `invites.code_hash` (sha256 only) | The single gate between the internet and membership. |
| A9 | Role assignments | `invite_redemptions.role`, `profiles.is_admin` | Coach/admin powers. |
| A10 | Backend availability and cost | The Supabase project | A free-tier project is DoS-able by cost, not just by load. |

## 3. Trust boundaries

```
                    PUBLIC INTERNET
                          |
  ┌───────────────────────┴────────────────────────┐
  │ B1  GitHub Pages / browser                     │
  │     index.html, app.js, cloud.js, sw.js,       │
  │     cloud-config.js (publishable key, public)  │
  │     IndexedDB + localStorage (session tokens)  │
  │     >>> ZERO TRUST. Fully attacker-controlled. │
  └───────────────────────┬────────────────────────┘
                          │  HTTPS, publishable key + JWT
  ┌───────────────────────┴────────────────────────┐
  │ B2  Supabase edge: GoTrue / PostgREST / Storage│
  │     Issues JWTs. Anonymous sign-in is ON.      │
  └───────────────────────┬────────────────────────┘
                          │  role = anon | authenticated | service_role
  ┌───────────────────────┴────────────────────────┐
  │ B3  Postgres — THE ONLY REAL BOUNDARY          │
  │     RLS policies + SECURITY DEFINER functions  │
  │     + column-pinning triggers                  │
  └──────┬─────────────────────────────┬───────────┘
         │                             │
  ┌──────┴──────────────┐   ┌──────────┴─────────────────────┐
  │ B4 Edge Functions   │   │ B5 Supabase Vault / dashboard  │
  │  service-role key   │   │  service-role key, is_admin    │
  │  in env, never in   │   │  grants, pg_cron secrets       │
  │  the repo           │   │  (202609050005:171-181)        │
  └─────────────────────┘   └────────────────────────────────┘
```

**The boundary that matters and is easiest to misread:** B2 issues a role of
`authenticated` to *anyone who asks*, because `enable_anonymous_sign_ins = true`
(`supabase/config.toml:53`). A policy written `to authenticated using (true)` is
therefore a **public** policy. The repo learned this the hard way once —
`202609060001_anonymous_read_gate.sql:5-23` documents it — and fixed three
policies. Fourteen more still have the defect (SEC-001).

Note also the distinction between the Postgres role `anon` (keyless requests,
comprehensively locked out by `202608260001:103` + `202608270002:29`) and an
*anonymous sign-in session*, which is `authenticated`. `202609060002:81-83`
states this explicitly. Confusing the two is the single most likely way to
mis-read this schema's security posture.

## 4. Entry points

| # | Entry point | Auth required | Reached from |
|---|---|---|---|
| E1 | `POST /auth/v1/signup` (anonymous) | none | anyone with the publishable key, i.e. anyone |
| E2 | `POST /auth/v1/token?grant_type=password` | username+password | `cloud.js:3859` |
| E3 | `PUT /auth/v1/user` (anon → permanent) | a session | `cloud.js:3884` |
| E4 | `/rest/v1/<table>` — direct CRUD | JWT | any of the tables in `AUTHORIZATION_MATRIX.md` §1 with a grant |
| E5 | `/rest/v1/rpc/<fn>` — 75 definer functions | JWT | `AUTHORIZATION_MATRIX.md` §2 |
| E6 | `/storage/v1/object/{post-photos,avatar-photos}/…` | JWT | both buckets private since `202609060003:40` |
| E7 | Realtime websocket | JWT | `202608290007_realtime_publication.sql` |
| E8 | `/functions/v1/admin_reset_password` | admin JWT | `cloud.js:3063` |
| E9 | `/functions/v1/{recap_weekly,purge_abandoned_profiles}` | service-role key | pg_cron via `cron_invoke_edge_function()` |
| E10 | The static bundle itself | none | GitHub Pages |
| E11 | Supabase dashboard / SQL editor | project owner | out of band |

## 5. Actors

---

### ACTOR 1 — Unauthenticated attacker (no credentials, no invite code)

**Entry points:** E1, E10. Trivially becomes a *ghost*: an `authenticated`
session with a real `auth.uid()`, no invite redemption, no profile row.

**Controls that exist**

| Control | Cite |
|---|---|
| `anon` role has zero table privileges, and default privileges are revoked so future tables inherit the lockout | `202608260001:103`, `202608270002:29` |
| `profiles`, `workout_posts`, `announcements` reads gated on `is_community_member()` | `202609060001:115,138,171` |
| `community_streaks` view gated the same way | `202609060002:118` |
| The five definer read functions (`feed_page`, `community_search`, `community_profile`, `club_summary`, `member_roles`) gated | `202609060009:225,659,800,1079,1130` |
| Both storage buckets private; avatar SELECT requires `is_community_member()` for anyone but the owner | `202609060003:40,70`; `202608270006:207` |
| Every community **write** requires `is_community_member()` | `202608280015:207`, `202608280023`, `202609050002:114`, `202608280009:112` |
| Invite codes are 192-bit, stored as sha256 only, format-gated before any table read | `202608270006:97`; `202609030003:103` |
| Redemption throttle 5 / 15 min on both a uid key and a hashed device key | `202609030003:92-102` |
| Generic `'invalid'` for every failure mode, so the throttle is not a status oracle | `202609030003:160-167` |
| CSP: `script-src 'self'`, no inline script, no CDN; `connect-src` limited to self + one Supabase origin | `index.html:36-48` |
| Service worker only ever caches same-origin precached assets; Supabase responses are cross-origin and returned early | `sw.js:206`, `sw.js:248` |
| `cloud-config.js` holds only URL + publishable key + VAPID **public** key | `cloud-config.js:1-22` |

**What is missing**

- **SEC-001 (P0).** Fourteen relations are still `to authenticated` with no
  membership predicate. A ghost reads `challenge_participants`,
  `challenge_progress`, `challenge_teams`, `event_attendees`,
  `member_achievements`, `member_of_week`, `events`, `challenges`,
  `weekly_challenges`, `pins`, `clubs`, `roles`, `permissions`,
  `role_permissions`, `club_features`, `achievement_definitions` and published
  `monthly_club_recaps`. Five of those carry `user_id`, which reconstitutes the
  **member roster as UUIDs** plus who trains toward what, plus the club's event
  calendar.
- **SEC-004 (P1).** No CAPTCHA. Ghost identities are free and unlimited, so
  SEC-001 is exploitable at scale and uncorrelatably.
- **SEC-007 (P2).** `private_records`, `analytics_events` and
  `push_subscriptions` all accept writes from a bare ghost session
  (`private_records` requires **no** profile and **no** redemption by design).
  No rate limit, and `private_records.payload` has no size ceiling at all.
- **SEC-014 (P3).** No clickjacking defence is possible on GitHub Pages; the
  `frame-ancestors` directive in the `<meta>` CSP is inert and the repo says so.

**Residual risk: HIGH.** Membership confidentiality — the thing an invite-only
club exists to protect — is not currently held against an unauthenticated
attacker, and the write-abuse paths are open to the same actor.

---

### ACTOR 2 — Malicious registered member (holds a valid invite, verified recovery)

**Entry points:** E2, E4, E5, E6, E7.

**Controls that exist**

| Control | Cite |
|---|---|
| Every own-data table keyed `user_id = auth.uid()` | `202608260001:114-125` |
| Cannot edit another member's post, comment or reaction: `posts_update_self`/`posts_delete_self` are `author_id = auth.uid()`; `post_comments` has **no** UPDATE grant at all; `reactions` has no UPDATE policy | `202608260001:133-134`; `202608280025:132`; `202608260001:136-138` |
| Comment edit/delete are definer functions that re-check authorship | `202608280016:168`, `202608280021:133` |
| Post promotion to `POST_COACH`/`POST_ANNOUNCEMENT`/`POST_SYSTEM`/`POST_NEW_MEMBER` blocked by a trigger — self-awarded coach badge, the +10 ranking weight and the coach feed scope are all closed | `202609060004:63-106` |
| Challenge `progress_value` refused for **every** authenticated session including staff; `status` only `active → completed` on one's own row | `202609060005:124-155` |
| `challenge_progress` is append-only: no UPDATE/DELETE policy, no grant | `202608280009:145-150` |
| `feed_impressions.opened/engaged` writable only through `feed_record_interaction()`, scoped to one session id | `202609060010:112-147`; insert grant revoked `202609050005:128` |
| Photo path must belong to the post author (trigger); upload capped at 20 objects | `202608270006:186`, `:197-198` |
| Rate limits: comment 20/10min, comment_edit 30/10, reaction 60/10, report 10/10, feed_interaction 300/10, ach_claim 30/10, post_edit_caption 30/10, post_create 20/10 | `202608270010:25`, and the call sites in `202608280016:134,191`, `202608280025:49`, `202608280006:97`, `202608290002:48`, `202609060007:92`, `202608280023:65` |
| `is_admin` / `club_id` / `recovery_verified_at` pinned by trigger on every authenticated update | `202608280003:67-78` |
| `recovery_verified_at` cannot be self-certified — `mark_recovery_verified()` re-reads `auth.users` for a real email+password+confirmation | `202608280003:83-110` |
| Blocks are bidirectional and are resolved in one place (`can_view_profile_field`), which every surface calls | `202608280003:152-207` |
| PostgREST `or()` filter injection closed on both client and server | `cloud.js:3731`; `202609060009:661-668` |

**What is missing**

- **SEC-002 (P1).** `posts_update_self` is column-unrestricted, so an author
  reverses a moderator's removal with
  `PATCH workout_posts {"status":"active","deleted_at":null}`. Moderation of
  posts is advisory. `202609060007:36-45` names the underlying property and
  explicitly defers the fix.
- **SEC-003 (P1).** The direct `insert` grant on `workout_posts` was never
  revoked, so `post_create()`'s 20/10min limit is skippable — the exact bypass
  `202608270010:39-43` revoked three other grants to prevent.
- **SEC-005 (P2).** Same root cause: `score_value`, `comparison_key`,
  `published_at`, `is_pinned`, `metadata` and `visibility` are author-writable,
  forging the comparison board and the feed recency term, and skipping
  `post_set_visibility()`'s posting-restriction check on widening.
- **SEC-006 / SEC-007 (P2).** Unbounded avatar objects, `private_records`
  payloads, `analytics_events` rows, `push_subscriptions` rows.
- **SEC-019 (P3).** `display_name` is unconstrained — staff impersonation by
  name is possible (`handle` is unique and safe).

**Residual risk: MEDIUM–HIGH.** Cross-member data access is genuinely well
closed. The gap is *self*-row integrity: the same permissive own-row UPDATE
underpins SEC-002 and SEC-005 and turns moderation into a suggestion.

---

### ACTOR 3 — Compromised anonymous / backup-only session

A real category here, not a hypothetical: `maybeAutoStartBackup()` creates a
backup-only anonymous session the first time any member saves a workout, even if
they never open Community (`COMMUNITY_SETUP.md` §Offline synchronization).

**Controls that exist.** `private_records` is strictly `user_id = auth.uid()`
(`202608260001:114-117`), so a stolen backup session reaches exactly one
person's training data and nothing community-side —
`is_community_member()` is false without a profile and a redemption.
`purge_abandoned_profiles` reclaims genuinely abandoned anonymous users after 30
days (`supabase/functions/purge_abandoned_profiles/index.ts:63` +
`202609010004`).

**What is missing.** A backup-only session is a durable credential with **no
recovery, no rotation and no revocation surface** — there is no "sign out other
devices". If the device is compromised the session persists until it is
manually cleared. The purge job also has no wired scheduler beyond
`202609050005`'s pg_cron entry, which is **inert** until the Vault secrets are
set on the live project (`202609050005:171-181`) — so on a project where that
provisioning has not happened, abandoned sessions accumulate forever. Plus all
of SEC-007: a ghost/backup session is the cheapest write path in the system.

**Residual risk: MEDIUM.** Blast radius per compromised session is correctly
scoped to one person's private records. The problem is longevity and the absence
of a revocation story.

---

### ACTOR 4 — Malicious or compromised coach (rank 20)

**Controls that exist**

| Control | Cite |
|---|---|
| Coach ≠ admin: `is_staff()` is rank ≥ 20, `is_admin()` is rank ≥ 50, and they are separate functions | `202608280001:238-248` |
| A coach **cannot** grant coach: `admin_grant_coach` requires raw `profiles.is_admin` | `202608280025:396-404` |
| A coach **cannot** mint a coach-role invite — narrowed after it was flagged | `202609030008:97` and its header at `:8-24` |
| A coach cannot read `admin_actions`, `analytics_events`, `analytics_dashboard`, `member_segments`, `retention_*`, `community_health_*`, `registration_funnel` — all gated on `community.analytics.view`, seeded to admin/owner only | `202608280002:46`; `202608280012:46`; `202608280001:104-122` |
| A coach cannot publish a monthly recap (preview only) | `202609010002:636` |
| A coach cannot read follower-only posts of members they do not follow: `post_visible_to_viewer()` and `posts_select_admin_review` both check real `is_admin`, deliberately not `is_staff()` | `202608270009:9-14,25,32` |
| `weekly_challenges` insert re-keyed from `is_staff()` to `has_perm('community.challenge.create')`, closing a latent `staff`-role divergence | `202609060005:43-45` |
| Every admin-tier action writes an `admin_actions` row through `log_admin_action()`, which is granted to **no** role and is callable only from inside another definer function | `202608280002:41-52` |

**What is missing**

- **SEC-009 (P2).** `attendance_log_staff_select` is
  `has_perm('community.analytics.view') **or is_staff()**`
  (`202608310001:151`), so every coach reads every member's raw per-day
  attendance, ignoring that member's `show_attendance` toggle — a toggle that
  defaults **off** and that `community_streaks`, `feed_leaderboard`,
  `chal_progress` and `recap_weekly_classmates` all honour. Documented as
  intentional at `202608310001:144-150`; not documented in `PRIVACY.md`, which
  is the gap.
- **SEC-010 (P2).** `announcements_update_admin` is unscoped `is_staff()`
  (`202608270006:144`), so any coach edits or soft-deletes any announcement
  including an admin's — and announcement writes produce no audit row.
- Post deletion by a moderator is reversible by the author (SEC-002), which cuts
  the other way: a coach's legitimate moderation does not stick.

**Residual risk: MEDIUM.** The coach/admin split is real and carefully
maintained — the two paths that would have made the coach tier self-propagating
were both found and closed. The residue is read-side privacy and the
announcement write scope.

---

### ACTOR 5 — Compromised full admin (rank 50)

**Controls that exist.** `admin_actions` is append-only for every client
including an admin: no INSERT/UPDATE/DELETE policy and no write grant
(`202608280002:41-45`). `admin_reset_password` never accepts a
client-supplied password — it is server-generated
(`supabase/functions/admin_reset_password/index.ts:45-54`) — and identity is
taken from the caller's own JWT via `getUser()`, never from a client-sent flag
(`:77-89`), with the audit row written through the **caller's** client so
`auth.uid()` inside the definer function is the real admin (`:131-139`).
`roles`/`role_permissions` are writable only by `owner`, not by admin
(`202608280001:265-286`), so an admin cannot rewrite the permission model.
Granting another admin remains a manual dashboard `update` with no function
behind it, deliberately (`COMMUNITY_SETUP.md`).

**What is missing**

- **SEC-011 (P2).** `admin_reset_password` has no rate limit, so one hijacked
  admin session resets every account's password in a loop — a club-wide lockout,
  since synthetic `.invalid` emails mean there is no self-service recovery. The
  audit write is best-effort and non-fatal (`:137-139`), so a burst partly
  evades the log. Target ids are not validated as UUIDs or as club members.
- **SEC-016 (P3).** `posts_select_admin_review` (`202608270009:32`) is a second
  permissive SELECT policy with no `deleted_at`, block-edge, feature-flag or
  membership clause, so an admin's post read is total. Intended for moderation;
  recorded because it is invisible from the main policy.
- There is no break-glass / dual-control on any admin action, and no alerting on
  `admin_actions` volume.

**Residual risk: MEDIUM.** Admin is correctly the most trusted tier and the
audit log is genuinely tamper-resistant. The one sharp edge is the unthrottled
password reset.

---

### ACTOR 6 — Supabase (third-party) compromise

**Controls that exist.** Almost none are possible, and the design does not
pretend otherwise. What does help: training data is authoritative in local
IndexedDB and remains usable with no backend at all (`README.md`); the app makes
zero network requests to any origin but its own and Supabase
(`index.html:41-42`, self-hosted fonts); the service-role key is never in the
repo, never in a static-host env var, and lives only in Edge Function env and
Supabase Vault (`202609050005:148-181`); the VAPID **private** key is
deliberately absent and push is default-off (`cloud-config.js:10-22`).

**What is missing.** No client-side encryption of `private_records` — Supabase
sees plaintext bodyweight, measurements and session notes. No integrity
verification of the served bundle (GitHub Pages cannot set SRI-relevant headers,
and there is no `integrity=` attribute on any script tag). A malicious Supabase
could serve a forged JWT signing key and impersonate any member. Complete data
exposure on a full compromise.

**Residual risk: MEDIUM, and structurally accepted.** Standard BaaS posture. The
realistic mitigation is operational (project-level 2FA, restricted dashboard
access, key rotation), not architectural.

---

### ACTOR 7 — Bot / scraper (invite-code guessing, feed and roster scraping)

**Controls that exist.** Invite codes are 192 bits and hashed
(`202608270006:97`); the format gate rejects anything not
`^[a-f0-9]{40,128}$` before a table is touched (`202609030003:103`); the
throttle counts against a uid key **and** a hashed device key and takes the
higher (`202609030003:92-102`); a used, revoked, expired or nonexistent code all
return the identical `'invalid'` (`:160-167`); per-person invites are claimed
with a single `UPDATE … RETURNING` so two simultaneous redemptions cannot both
win (`:146-152`); `use_count < max_uses` is re-evaluated under the row lock on
the shared-code branch (`:117-121`). `feed_page` is cursor-paginated with a
bounded scoring window, and `community_search` requires ≥2 characters and strips
wildcards (`202609060009:661-671`).

**What is missing.** **SEC-001** makes the roster scrapable without any invite
code at all, which moots the entire invite-guessing defence for the
confidentiality goal it was protecting. **SEC-004**: no CAPTCHA, so the throttle
is per-free-identity. Neither `feed_page` nor `community_search` is rate-limited
(only `feed_record_interaction` is), so a redeemed account can enumerate the feed
and the directory as fast as the network allows.

**Residual risk: HIGH**, entirely because of SEC-001. Brute-forcing a 192-bit
code is not the attack; walking in through an ungated read policy is.

---

### ACTOR 8 — DoS via rate-limit gaps

**Controls that exist.** The eight `check_rate_limit()` windows listed under
Actor 2. `feed_record_impressions` caps at 50 rows per call
(`202608280006:69-71`). `add_post_comment` caps mentions at 10
(`202608280021:78-81`). `analytics_events` has a per-row props size trigger
(`202608280012:33-34`) and a 90-day purge (`202609050005:66`).
`can_upload_post_photo` caps `post-photos` at 20 objects per member
(`202608270006:197-198`). Supabase's `[api] max_rows = 1000`
(`supabase/config.toml:15`).

**What is missing.** Every gap in one place:

| Path | Gap | Finding |
|---|---|---|
| `POST /rest/v1/workout_posts` | direct insert grant never revoked → `post_create`'s 20/10min unenforced | SEC-003 |
| `POST /rest/v1/private_records` | no rate limit, no payload size cap, no membership requirement | SEC-007 |
| `POST /rest/v1/analytics_events` | no rate limit | SEC-007 |
| `POST /rest/v1/push_subscriptions` | no count cap | SEC-007 |
| `POST /storage/v1/object/avatar-photos/<uid>/*` | no object count cap, no orphan sweep | SEC-006 |
| `follows` / `blocks` / `event_attendees` / `challenge_participants` insert-delete churn | no limit | SEC-007 (same class) |
| `POST /auth/v1/signup` | no CAPTCHA → unlimited identities multiply all of the above | SEC-004 |
| `/functions/v1/admin_reset_password` | no throttle | SEC-011 |
| `feed_page` / `community_search` RPC | no rate limit | noted under Actor 7 |

**Residual risk: MEDIUM.** Not a service-outage risk so much as a cost and
storage-growth risk, which on a small club's Supabase plan amounts to the same
thing. The `private_records` path is the sharpest: unbounded `jsonb` from a free
anonymous session.

---

## 6. Abuse cases the brief asked about — direct answers

| Abuse case | Answer |
|---|---|
| **Edit another user's post** | **Not possible.** `posts_update_self` is `author_id = auth.uid()` in both `USING` and `WITH CHECK` (`202608260001:133`); `post_edit_caption()` re-checks authorship (`202609060007:85`). |
| **Edit another user's comment** | **Not possible.** `post_comments` has no UPDATE grant to `authenticated` at all; `comment_edit()` and `comment_moderate()` are the only paths and both check identity/permission. |
| **Edit another user's workout (`private_records`)** | **Not possible.** All four policies are `user_id = auth.uid()` (`202608260001:114-117`). |
| **Un-do a moderator's removal of your own post** | **POSSIBLE — SEC-002.** `PATCH workout_posts {"status":"active","deleted_at":null}`. |
| **Forge a challenge leaderboard score** | **Not possible.** `challenge_participants_guard_progress()` refuses any authenticated change to `progress_value` and restricts `status` (`202609060005:124-155`); `challenge_progress` is append-only. |
| **Forge the comparison board / feed rank** | **POSSIBLE — SEC-005.** `score_value`, `comparison_key`, `published_at`, `is_pinned` are author-writable on your own post. |
| **Self-award the coach badge / ranking boost** | **Not possible.** `workout_posts_guard_privileged_type()` (`202609060004:63-106`). |
| **Invite-code brute force** | **Not practical.** 192-bit codes (`202608270006:97`), format gate, generic failure, **5 attempts per 15 minutes** against `uid:<auth.uid()>` and `ak:<sha256(device key)>`, whichever count is higher (`202609030003:92-102`; helper `202608280013:42-59`). The throttle *is* resettable per free anonymous identity (SEC-004), but the keyspace makes that irrelevant. |
| **Duplicate submission / idempotency** | **Largely handled.** `toggle_reaction()` is an atomic definer toggle replacing a client insert-then-delete race (`202608270010:57-73`); `report()` upserts on `(reporter_id, target_type, target_id)` so a repeat does not move the distinct-reporter count (`202608280025:69-73`); `post_delete()` and `comment_moderate()` return early when already in the target state (`202608280025:115,159,168`); `feed_record_impressions` is `on conflict do nothing` (`202608280006:83`); `recap_weekly` checks existence **before** upserting so a rerun does not re-notify (`recap_weekly/index.ts:319-342`); per-person invites are claimed under a row lock (`202609030003:146-152`); `recap_monthly_publish` checks under `FOR UPDATE`. `workout_posts` upserts on `(author_id, source_type, source_record_id)` (`cloud.js:3072`). **Gap:** no idempotency key on `admin_reset_password` — a retried call issues a second password and invalidates the first. |
| **Cross-club data leakage** | **No isolation exists — SEC-008.** `club_id` is on `profiles`, `workout_posts`, `challenges` etc., and **no policy filters on it**; `club_feature_enabled()` and `admin_set_club_feature()` hardcode `default_club_id()` (`202609010012:49,92`). Latent only: one club row exists, and `clubs_insert_owner` needs `owner`, which no account can hold. |
| **Coach self-grants admin** | **No.** `admin_grant_coach` requires raw `profiles.is_admin` and permits only `coach`/`head_coach` (`202608280025:396-404`); `admin_invite_create` requires `is_admin()` for a coach-role invite (`202609030008:97`); `invite_redemptions` has no write grant (`202608270003:27`); `profiles.is_admin` is trigger-pinned (`202608280003:71`) and forced false on insert (`:216`). Admin is a manual dashboard `update` with no function behind it. **Full trace in `AUTHORIZATION_MATRIX.md` §3.** |

## 7. Residual risk summary

| Actor | Residual | Driven by |
|---|---|---|
| Unauthenticated attacker | **HIGH** | SEC-001, SEC-004, SEC-007 |
| Bot / scraper | **HIGH** | SEC-001, SEC-004 |
| Malicious member | MEDIUM–HIGH | SEC-002, SEC-003, SEC-005 |
| Compromised anonymous session | MEDIUM | no revocation surface, SEC-007 |
| Malicious coach | MEDIUM | SEC-009, SEC-010 |
| Compromised admin | MEDIUM | SEC-011 |
| Supabase compromise | MEDIUM (accepted) | no client-side encryption |
| DoS / cost | MEDIUM | SEC-003, SEC-006, SEC-007 |

**Single highest-risk item: SEC-001.** It is the same defect class that
`202609060001_anonymous_read_gate.sql` was written to close, applied to three
relations out of seventeen. Until it is finished, the invite gate — the control
this entire product is built around — does not protect membership
confidentiality.

## 8. What this stream did not cover

- Nothing was executed against a live database; all RLS conclusions are from
  policy text. The `npm run smoke-test-anon-key` check named in
  `COMMUNITY_SETUP.md` is the right runtime complement and should be extended to
  probe as an **anonymous-session ghost**, not only as the keyless `anon` role —
  the current smoke test would not have caught SEC-001.
- `app.js`'s 35 `innerHTML` sinks were sampled, not exhaustively traced
  (SEC-018, confidence deliberately marked low).
- Supabase platform configuration on the real project (auth throttling, CAPTCHA,
  JWT expiry, Vault contents, actual `minimum_password_length`) is not readable
  from this repo; `supabase/config.toml` was used as the best available proxy
  and is labelled local/CI-only.
- Dependency supply chain (`vendor/supabase.js`, `node_modules`) and CI/CD
  posture were out of scope for this stream.
