# Security audit — findings

Security/threat-modeling audit stream, static analysis only. No command was run
against any live or remote Supabase project and no exploit was executed; every
"reproduction" below is the call sequence the cited policy/grant text permits,
not something I ran. Confidence is stated per finding: **high** = I read the
exact policy/grant/function text and the conclusion follows from it directly;
**medium** = the code is clear but the runtime outcome depends on platform
behaviour I could not observe; **low** = partially verified, needs a live check.

Scope covered: 108 files in `supabase/migrations/`, 3 Edge Functions,
`cloud.js` (12,501 lines), `app.js`, `index.html`, `sw.js`, `cloud-config.js`,
`supabase/config.toml`.

## Summary

| Priority | Count |
|---|---|
| P0 | 1 |
| P1 | 3 |
| P2 | 8 |
| P3 | 7 |
| **Total** | **19** |

Of these, 4 are recorded as `already-mitigated-verify-citation` (SEC-101..104) —
controls I checked because a prior claim existed, found genuinely in place, and
am citing so a later reader does not have to re-derive them.

---

## Findings

| ID | Category | Priority | Severity | Confidence | Status |
|---|---|---|---|---|---|
| SEC-001 | Broken access control / confidentiality | **P0** | High | High | open |
| SEC-002 | Moderation bypass / integrity | P1 | High | High | open |
| SEC-003 | Rate-limit bypass / abuse | P1 | Medium | High | open |
| SEC-004 | Bot abuse / account-creation cost | P1 | Medium | High | open |
| SEC-005 | Data integrity / ranking + leaderboard forging | P2 | Medium | High | open |
| SEC-006 | Resource abuse (Storage) | P2 | Medium | High | open |
| SEC-007 | Resource abuse (DB write amplification) | P2 | Medium | High | open |
| SEC-008 | Multi-tenancy | P2 | High (latent) | High | open |
| SEC-009 | Privacy / insider | P2 | Medium | High | open (by design — confirm) |
| SEC-010 | Insider integrity | P2 | Medium | High | open (by design — confirm) |
| SEC-011 | Edge Function hardening | P2 | Medium | Medium | open |
| SEC-012 | Authentication strength | P2 | Medium | Medium | open |
| SEC-013 | Session handling | P3 | Low | High | open |
| SEC-014 | Clickjacking | P3 | Low | High | open (host limitation, documented) |
| SEC-015 | Token storage | P3 | Low | High | accepted-risk |
| SEC-016 | Admin read bypass | P3 | Low | High | open (by design — record) |
| SEC-017 | Timing side channel | P3 | Informational | Medium | open |
| SEC-018 | XSS surface in `app.js` | P3 | Low | **Low** | needs-verification |
| SEC-019 | Impersonation via display name | P3 | Low | High | open |
| SEC-101 | Anon-role lockout | — | — | High | already-mitigated-verify-citation |
| SEC-102 | Definer read gate | — | — | High | already-mitigated-verify-citation |
| SEC-103 | Privilege escalation paths | — | — | High | already-mitigated-verify-citation |
| SEC-104 | PostgREST filter injection | — | — | High | already-mitigated-verify-citation |

---

### SEC-001 — The anonymous read gate was applied to 4 relations; ~14 more still leak member data to a ghost session

- **Category:** Broken access control / confidentiality
- **Priority:** P0 · **Severity:** High · **Confidence:** High
- **Status:** open

**File:line**

- `supabase/migrations/202608280009_challenges.sql:110` — `challenge_participants_read`
- `supabase/migrations/202608280009_challenges.sql:127` — `challenge_progress_read`
- `supabase/migrations/202608280009_challenges.sql:96` — `challenge_teams_read`
- `supabase/migrations/202608280010_events.sql:63` — `event_attendees_read`
- `supabase/migrations/202609010012_club_features.sql:149` — `events_read`
- `supabase/migrations/202609010012_club_features.sql:159` — `challenges_read`
- `supabase/migrations/202609010012_club_features.sql:172` — `member_achievements_read`
- `supabase/migrations/202609010001_member_of_week.sql:210` — `member_of_week_read`
- `supabase/migrations/202608270001_community_growth.sql:142` — `weekly_challenges_read`
- `supabase/migrations/202608280017_pins.sql:80` — `pins_read`
- `supabase/migrations/202608280001_clubs_and_rbac.sql:256,264,272,280` — `clubs`/`roles`/`permissions`/`role_permissions`
- `supabase/migrations/202609010012_club_features.sql:43` — `club_features_read`
- `supabase/migrations/202608280007_achievements.sql:65` — `achievement_definitions_read`
- `supabase/migrations/202609010002_monthly_club_recap.sql:228` — `monthly_club_recaps_published_select`
- Contrast: `supabase/migrations/202609060001_anonymous_read_gate.sql:114-177` (the fix, applied to `profiles`, `workout_posts`, `announcements` only) and `202609060002_community_streaks_privacy.sql:118` (`community_streaks`).

**Evidence.** `202609060001_anonymous_read_gate.sql:5-11` states the threat
exactly: *"Anonymous sign-in is enabled on the real project and the publishable
key ships in the browser bundle, so ANY visitor can mint a real `authenticated`
JWT … Three read policies were written `to authenticated … using (<no membership
predicate>)`, which for this schema has always meant 'anyone who can obtain a
token'."* It then names three policies and fixes those three. `202609060009`
fixed five definer read functions. `202609060002` fixed one view.

The same defect is present, unmodified, in the policies listed above. Each is
`for select to authenticated` with a predicate that never calls
`is_community_member()`. `enable_anonymous_sign_ins = true`
(`supabase/config.toml:53`) and the publishable key is in the shipped bundle
(`cloud-config.js:6`), so the ghost role is available to the public internet.

The member-identifying subset is what makes this P0, not the config tables:

- `challenge_participants` and `challenge_progress` expose `user_id` for every
  participant in every non-draft challenge. `202608280009:110` is
  `using (exists (select 1 from public.challenges c where c.id = challenge_id))`
  — the challenge existing is the entire test.
- `member_achievements` (`202609010012:172`) exposes `user_id` + unlock for
  every member whose `show_achievements` is on — and it defaults **true**
  (`202608280003:27`). The `can_view_profile_field()` guard does not help: it
  returns false only for a **null** `auth.uid()` (`202608280003:159-160`), and a
  ghost has a non-null one.
- `event_attendees` (`202608280010:63`) same shape, via
  `show_in_attendee_lists`, also default **true** (`202608280003:32`).
- `member_of_week` (`202609010001:210`) is `using (true)` on a table that
  carries `user_id`.
- `events` (`202609010012:149`) exposes every published event's title,
  description, location and time — real club operational data.

Chained, these give an unauthenticated attacker a **complete member-UUID roster**
plus per-member achievement and challenge participation, and the club's event
calendar. `profiles` itself is now closed, so handles and display names do not
come out this way — but the UUIDs are then usable as input to any surface keyed
on a user id, and are a durable identifier for correlation.

**Reproduction (not executed).**
1. `POST /auth/v1/signup` with the publishable key from `cloud-config.js:6` and
   an empty body → an `authenticated` JWT with a fresh `auth.uid()`, no invite
   redemption, no `profiles` row.
2. `GET /rest/v1/challenge_participants?select=user_id,challenge_id,progress_value`
   with that JWT → every participant row.
3. `GET /rest/v1/member_of_week?select=user_id,week_start,category` → recognised
   members.
4. `GET /rest/v1/events?select=*` → the club calendar.
5. `GET /rest/v1/member_achievements?select=user_id,achievement_code,unlocked_at`
   → per-member unlock history.

**Impact.** Confidentiality breach open to the public internet, of the same
class and by the same mechanism as the P0 that `202609060001` was written to
close. Membership size, member identifiers, who trains toward what, and when the
club meets are all readable with zero credentials.

**Proposed fix.** One migration, same shape as `202609060001`: add
`and public.is_community_member()` to the non-self branch of each policy listed
above. For `member_of_week`, `pins` and `weekly_challenges`, replace
`using (true)` with `using (public.is_community_member())`. Leave
`onboarding_step_content`, `intro_carousel_content` and `club_features`
un-gated (they are the pre-redemption onboarding screens and carry no member
field, per `202609060001:54-61`), and leave `achievement_definitions`,
`roles`, `permissions`, `role_permissions`, `clubs` and the published
`monthly_club_recaps` un-gated or gate them for tidiness only — none carries a
member identifier. Then re-run the ghost probe the `202609060001` header asks
for, against **every** relation, not a sample.

---

### SEC-002 — A post author can undo a moderator's removal with one PostgREST UPDATE

- **Category:** Moderation bypass / integrity
- **Priority:** P1 · **Severity:** High · **Confidence:** High
- **Status:** open

**File:line**

- `supabase/migrations/202608260001_community_foundation.sql:105` — `grant select, insert, update, delete on … public.workout_posts … to authenticated;` (never revoked; verified by grepping every `revoke` in the tree — only `post_comments`, `reactions`, `reports` and `feed_impressions` inserts are ever revoked)
- `supabase/migrations/202608260001_community_foundation.sql:133` — `create policy posts_update_self on public.workout_posts for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());` — still the live UPDATE policy, never re-declared
- `supabase/migrations/202608280025_moderation_reshape.sql:117-119` — `post_delete()` removes a post with `set deleted_at = now(), status = 'removed'`
- `supabase/migrations/202608280004_post_types_and_columns.sql:35,41` — `post_status` enum and the `status` column

**Evidence.** `posts_update_self` gates the **author of the row** and nothing
else. It carries no column list; `USING`/`WITH CHECK` see whole rows. Only two
columns on this table are trigger-guarded: `post_type`
(`202609060004_post_type_privilege_guard.sql:104`) and
`photo_path`/`author_id` (`202608270006_security_hardening.sql:186`). Neither
`status` nor `deleted_at` is guarded by anything. The `workout_posts_touch`
trigger (`202608280004:105`) only stamps `updated_at`.

`202609060007_post_edit_rpcs.sql:36-45` names this exact property in its own
header: *"workout_posts DOES carry an UPDATE grant and posts_update_self permits
an author any column of their own row, so these are not a boundary the way
comment_edit is… Making them the ONLY path would mean revoking UPDATE on
workout_posts… That is a separate change with its own blast radius and is not
smuggled in here."* The consequence for moderation was not followed through.

**Reproduction (not executed).**
1. A member posts. A coach or admin reports it and a moderator calls
   `post_delete(<id>)` → row becomes `status='removed'`, `deleted_at=now()`.
2. The author, with their ordinary session, issues
   `PATCH /rest/v1/workout_posts?id=eq.<id>` with body
   `{"status":"active","deleted_at":null}`.
3. `posts_update_self`'s `USING` is `author_id = auth.uid()` → passes.
   `WITH CHECK` is the same → passes. No trigger fires on those columns.
4. The post is live again in `posts_feed_select` (`202609060001:138`, which
   requires `deleted_at is null` and `status = 'active'`).

**Impact.** Moderation is advisory, not enforced, for post removal. Every
removal an admin or coach performs — including of harassment or a privacy
violation, the exact reasons `reports.reason` enumerates
(`202608260001:80`) — can be reversed by the offender, silently, with no
`admin_actions` row for the reversal. The same UPDATE also reverses a
`mod_review` outcome and lets a member restore a post they soft-deleted
themselves after an account-deletion request (`request_account_deletion()`
sets `deleted_at` on every own post, `202608260001:150`).

**Proposed fix.** A `BEFORE UPDATE OF status, deleted_at` trigger on
`workout_posts`, shaped exactly like
`challenge_participants_guard_progress()` (`202609060005:124-155`), which is
already the module's answer to this pattern: refuse the change when
`auth.role() = 'authenticated'` unless a transaction-local
`app.allow_moderation_write` GUC is pinned, and pin it inside `post_delete()`
and `mod_review()` around their own UPDATEs. Do **not** fix this by revoking
UPDATE on `workout_posts` alone — `202609060007:41-44` lists shipped writes that
still need it.

---

### SEC-003 — `post_create()`'s rate limit is bypassable by inserting into `workout_posts` directly

- **Category:** Rate-limit bypass / abuse
- **Priority:** P1 · **Severity:** Medium · **Confidence:** High
- **Status:** open

**File:line**

- `supabase/migrations/202608280023_post_create.sql:65` — `if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;`
- `supabase/migrations/202608260001_community_foundation.sql:105` — the standing `grant … insert … on public.workout_posts to authenticated`
- `supabase/migrations/202608280015_posting_restrictions.sql:207` — `posts_insert_self`, which enforces membership, `community.post.create` and the posting restriction, but **not** volume

**Evidence.** `202608270010_rate_limiting.sql:39-43` states the design rule:
*"the table's own INSERT grant is revoked below so a client can't bypass the
check by calling .insert() directly."* That revoke was done for `post_comments`,
`reactions` and `reports` (`202608270010:86-88`) and later for
`feed_impressions` (`202609050005:128`). It was **never** done for
`workout_posts`, even though `post_create()` (`202608280023`) added the same
kind of guarded write path for that table three migrations later.

`cloud.js` itself still uses the direct path in places — `cloud.js:3072` and
`cloud.js:4211` both call
`client.from("workout_posts").upsert(payload, { onConflict: "author_id,source_type,source_record_id" })`
— so the grant cannot simply be revoked without moving those call sites first.

**Reproduction (not executed).** A redeemed member loops
`POST /rest/v1/workout_posts` with `{"author_id": <own uid>, "body": "…", "visibility": "club"}`.
`posts_insert_self` passes on every call. `check_rate_limit('post_create', …)`
is never consulted because `post_create()` is never entered. Feed flooding is
bounded only by network throughput.

**Impact.** Unlimited feed spam by any redeemed member, and by extension by
anyone holding one leaked invite code. Amplified by the mention/notification
fan-out, and by `feed_page`'s repetition penalty being a ranking nudge rather
than a cap.

**Proposed fix.** Move `cloud.js:3072` and `cloud.js:4211` onto `post_create()`
(or a new guarded upsert RPC), then `revoke insert on public.workout_posts from
authenticated`. Interim mitigation if the client change cannot ship first: a
`BEFORE INSERT` trigger calling `check_rate_limit('post_create', 20, 10)` for
`auth.role() = 'authenticated'` sessions, which covers both paths at once.

---

### SEC-004 — Account creation is free: no CAPTCHA on `signInAnonymously()` / `updateUser()`

- **Category:** Bot abuse / account-creation cost
- **Priority:** P1 · **Severity:** Medium · **Confidence:** High
- **Status:** open

**File:line**

- `supabase/config.toml:53` — `enable_anonymous_sign_ins = true`
- `cloud.js:3789` — `await client.auth.signInAnonymously()`
- `cloud.js:3884` — `await client.auth.updateUser({ email: usernameToEmail(username), password })`
- `COMMUNITY_SETUP.md` §"Recommended, not yet done: CAPTCHA on sign-up"
- Throttle that exists: `supabase/migrations/202609030003_redeem_person_invite.sql:92-102` (5 attempts / 15 min, keyed on `uid:<auth.uid()>` **and** on `ak:<sha256(device key)>`, whichever count is higher), helper at `202608280013_invite_actor_throttle.sql:42-59`

**Evidence.** `202608280013:20-22` is explicit that the device key *"is not a
security boundary, it is a cost floor"* and is rotatable. Beneath it, the uid
key resets for free with each new anonymous session. So the effective invite
throttle against a determined scripted attacker is 5 guesses per rotated device
key per 15 minutes, unbounded in parallel.

This does **not** make invite brute force practical — codes are 24 random bytes
rendered as 48 hex characters (`202608270006:97`), 192 bits — and the format gate
`^[a-f0-9]{40,128}$` (`202609030003:103`) is checked before any table read. The
real exposure is different: **every ghost-readable relation in SEC-001 is
reachable by an unlimited number of free, uncorrelated identities**, and the
anonymous account pool is the raw material for the write-amplification abuse in
SEC-007.

**Reproduction (not executed).** Script `POST /auth/v1/signup` in a loop with the
publishable key. Nothing rate-limits it in this repo's control set; only
Supabase's own platform-level auth throttling applies, which I cannot inspect
from here.

**Impact.** Bot-driven scraping at scale (SEC-001), telemetry/storage flooding
(SEC-006, SEC-007), and an `auth.users` table that grows without bound.
`purge_abandoned_profiles` (`supabase/functions/purge_abandoned_profiles/index.ts:63`)
reclaims these only after 30 days and only if a scheduler runs it.

**Proposed fix.** The step `COMMUNITY_SETUP.md` already names: enable Cloudflare
Turnstile or hCaptcha under Authentication → Bot and Abuse Protection, and thread
`captchaToken` through `signInAnonymously()` at `cloud.js:3789` and
`updateUser()` at `cloud.js:3884`. This needs a site key only the project owner
can create, which is why it is still open — but with SEC-001 unfixed it is no
longer optional hardening.

---

### SEC-005 — A post author can forge ranking and comparison signals on their own row

- **Category:** Data integrity / ranking + leaderboard forging
- **Priority:** P2 · **Severity:** Medium · **Confidence:** High
- **Status:** open

**File:line**

- `supabase/migrations/202608260001_community_foundation.sql:133` — `posts_update_self`, column-unrestricted (same root cause as SEC-002)
- `supabase/migrations/202608260001_community_foundation.sql:56-58` — `comparison_key`, `score_value`, `score_direction`
- `supabase/migrations/202608280004_post_types_and_columns.sql:44-46` — `is_pinned`, `metadata`
- `cloud.js:4258` — `client.from("community_feed").select(…).eq("comparison_key", …)` — the "השוואה" board that reads `score_value`

**Evidence.** Beyond `status`/`deleted_at` (SEC-002), an author may set on their
own post: `score_value`, `score_direction`, `comparison_key`, `rx`,
`occurred_on`, `published_at`, `is_pinned`, `metadata`, and `visibility`. The
`community_feed` view ranks the comparison board purely on `score_value`
(`202608260001:170-171`), so a member can top any comparison by writing the
number they want. `published_at` is `feed_page`'s recency input
(`202609060009`, the 36-hour half-life block), so back- or forward-dating a post
moves its rank directly. Setting `visibility` here also skips
`post_set_visibility()`'s posting-restriction check on widening
(`202609060007:174-176`).

Note what is **already** closed, and closed well: `post_type` promotion to
`POST_COACH` (`202609060004:104`), and `challenge_participants.progress_value` /
`status` (`202609060005:124-155`), which is the actual challenge-leaderboard
number. `feed_leaderboard()` reads consistency streaks and challenge progress
(`202609010012:220+`), not `score_value`, so the *primary* leaderboard is not
forgeable this way. The comparison board and the feed ranker are.

**Reproduction (not executed).** `PATCH /rest/v1/workout_posts?id=eq.<own post>`
with `{"score_value": 9999, "comparison_key": "fran", "score_direction": "higher", "is_pinned": true, "published_at": "<future>"}`.

**Impact.** Vanity-metric forging and feed-position gaming. Low harm in a
40-person club, non-trivial once the comparison board is treated as a real
record. Also a correctness trap: `is_pinned` has an index
(`202608280004:114`) implying it is meant to be staff-controlled, but nothing
enforces that.

**Proposed fix.** Extend the SEC-002 guard trigger's column list to
`status, deleted_at, score_value, score_direction, comparison_key, published_at, is_pinned`
and refuse authenticated changes to them, pinning the GUC inside the legitimate
server writers.

---

### SEC-006 — `avatar-photos` has no per-member object cap and no orphan sweep

- **Category:** Resource abuse (Storage)
- **Priority:** P2 · **Severity:** Medium · **Confidence:** High
- **Status:** open

**File:line**

- `supabase/migrations/202609010010_avatar_photo.sql:42-50` — `can_write_own_avatar()`: own-uid path prefix + a redeemed, non-deleted profile. **No count check.**
- `supabase/migrations/202609010010_avatar_photo.sql:33` — bucket file size limit 2 MiB
- Contrast: `supabase/migrations/202608270006_security_hardening.sql:197-198` — `can_upload_post_photo()` caps at `< 20` objects per member
- Contrast: `supabase/migrations/202608270006_security_hardening.sql:214-222` — `list_orphaned_post_photos()` exists for `post-photos` and has no avatar counterpart

**Evidence.** `202609010010:36-41` states the reasoning: *"but with no
object-count cap: an avatar is one-per-member by convention (the client always
uploads to `{auth.uid()}/avatar.{ext}` with upsert:true)."* Convention is a
client behaviour, and the policy is what a non-client caller has to satisfy.
`split_part(p_name, '/', 1) = auth.uid()::text` permits **any** filename under
the member's own prefix.

**Reproduction (not executed).** A redeemed member loops
`POST /storage/v1/object/avatar-photos/<own-uid>/<random>.webp` with 2 MiB
payloads. Each call satisfies `can_write_own_avatar()`. Nothing counts.

**Impact.** Unbounded storage growth and egress cost per redeemed account,
multiplied by the free-account problem in SEC-004 once an invite code leaks.
No cleanup job exists, so the growth is permanent.

**Proposed fix.** Add the `post-photos` count clause to
`can_write_own_avatar()` — `(select count(*) from storage.objects o where
o.bucket_id = 'avatar-photos' and split_part(o.name,'/',1) = auth.uid()::text) < 3`
(3 rather than 1 so the extension-change cleanup path at `202609010010:65-68`
still works). Add a `list_orphaned_avatar_photos()` mirroring
`list_orphaned_post_photos()`.

---

### SEC-007 — Three unbounded client write paths with no rate limit and no size ceiling

- **Category:** Resource abuse (DB write amplification)
- **Priority:** P2 · **Severity:** Medium · **Confidence:** High
- **Status:** open

**File:line**

- `supabase/migrations/202608260001_community_foundation.sql:24,105,115` — `private_records.payload jsonb not null default '{}'`, full CRUD grant, `private_records_self_insert` is `user_id = auth.uid()` and nothing else. **No `CHECK` on payload size, no row-count cap, no membership gate, no rate limit.** `record_id` is capped at 160 chars (`:23`); the payload is not capped at all.
- `supabase/migrations/202608280012_analytics_events.sql:38,44` — `grant select, insert`, `analytics_events_insert_self` is `user_id = auth.uid() or user_id is null`. A per-row props size trigger exists (`:33-34`) but there is no volume limit.
- `supabase/migrations/202608280008_notifications.sql:104` — `push_subscriptions_self_insert` is `user_id = auth.uid()`; no count cap. `endpoint` is unique and ≤1000 chars (`:38`).

**Evidence.** Compare against the tables that *were* locked down:
`202608270010:86-88` revoked direct inserts on `post_comments`, `reactions` and
`reports` precisely so `check_rate_limit()` could not be skipped, and
`202609050005:92-128` revoked `feed_impressions` insert for the same reason
(*"The direct grant is therefore pure attack surface"*). These three tables were
not included. `retention_purge_telemetry()` (`202609050005:66`) purges
`analytics_events` at 90 days, which bounds the steady state but not a burst.

**Reproduction (not executed).** A ghost or member loops
`POST /rest/v1/private_records` with distinct `record_id`s and multi-megabyte
`payload` objects — note `private_records` requires **no** profile and **no**
invite redemption (`COMMUNITY_SETUP.md` §Offline synchronization confirms this
is deliberate), so a bare anonymous session is enough. Same for
`analytics_events` and `push_subscriptions`.

**Impact.** Database size and cost DoS reachable with a free anonymous session
and no invite code — the cheapest write path in the system. `private_records` is
the worst of the three because a `jsonb` value can be very large and there is no
cap of any kind.

**Proposed fix.** (a) `alter table public.private_records add constraint
private_records_payload_size check (pg_column_size(payload) <= 65536);` plus a
per-user row cap enforced by a `BEFORE INSERT` trigger. (b) A
`check_rate_limit('private_record_write', …)` and
`check_rate_limit('analytics_event', …)` trigger on both tables. (c) A count cap
of ~10 on `push_subscriptions` per `user_id`.

---

### SEC-008 — No tenant isolation: `club_id` exists everywhere and is filtered nowhere

- **Category:** Multi-tenancy
- **Priority:** P2 · **Severity:** High (latent — currently unexploitable)
- **Confidence:** High
- **Status:** open

**File:line**

- `supabase/migrations/202608280001_clubs_and_rbac.sql:9-11` — *"There is deliberately no multi-tenant logic anywhere — the column exists so a second club is a data migration later instead of a schema rewrite, and nothing reads it as a filter today."*
- `supabase/migrations/202608280001_clubs_and_rbac.sql:25-27` — the single seeded club row
- `supabase/migrations/202608280001_clubs_and_rbac.sql:31-34` — `default_club_id()` returns a hardcoded literal UUID
- `supabase/migrations/202609010012_club_features.sql:49-58` — `club_feature_enabled()` queries `where cf.club_id = public.default_club_id()`, ignoring the caller's own club
- `supabase/migrations/202608280001_clubs_and_rbac.sql:259-260` — `clubs_insert_owner` permits an `owner` to create a second club row
- `supabase/migrations/202609010001_member_of_week.sql:180-187` — names the same gap for its own unique key

**Evidence.** I checked every read policy in `AUTHORIZATION_MATRIX.md` §1 for a
`club_id` predicate. There is not one. `profiles.club_id` is pinned by
`protect_is_admin()` (`202608280003:72`) so a member cannot move themselves
between clubs, but that is the only place `club_id` is enforced at all.

**Reproduction (not executed).** Not reachable today — one `clubs` row exists and
no account can hold `owner`. The finding is that the *first* day a second club
row is inserted, `profiles_read_authenticated`, `posts_feed_select`,
`events_read`, `challenges_read`, `community_streaks`, `feed_page`,
`community_search` and every leaderboard become cross-tenant reads, with no
migration flagging it.

**Impact.** A latent full cross-tenant data breach with a single-row trigger.

**Proposed fix.** Either (a) an explicit, tested `single_club` invariant —
a `CHECK`/unique constraint or a trigger refusing a second `clubs` row, so the
assumption fails loudly rather than silently — or (b) begin the `club_id`
filtering work now while there is one tenant and the change is a no-op. (a) is
the cheap correct answer for launch; (b) is the real one.

---

### SEC-009 — Any coach reads every member's raw attendance history regardless of `show_attendance`

- **Category:** Privacy / insider
- **Priority:** P2 · **Severity:** Medium · **Confidence:** High
- **Status:** open (documented as intentional — confirm the decision)

**File:line**

- `supabase/migrations/202608310001_attendance_log.sql:151-152` — `create policy attendance_log_staff_select … using (public.has_perm('community.analytics.view') or public.is_staff())`
- `supabase/migrations/202608310001_attendance_log.sql:135` — `grant select on public.attendance_log to authenticated`
- `supabase/migrations/202608280003_profile_privacy_and_recovery.sql:24` — `show_attendance boolean not null default false`

**Evidence.** `202608310001:144-150` states this is deliberate: *"Note what this
is NOT gated on: `can_view_profile_field(user_id, 'show_attendance')`. That
toggle governs what one MEMBER may see about another member's attendance."* The
policy grants on `is_staff()`, i.e. rank ≥ 20, i.e. **every coach**, not on
`community.analytics.view` (admin/owner only). So a coach reads raw per-day
attendance rows for every member, including members who explicitly switched
`show_attendance` off — a toggle that defaults off and that
`community_streaks` (`202609060002:107`), `feed_leaderboard`,
`recap_weekly_classmates` and `chal_progress` all honour.

**Impact.** The privacy toggle a member is shown does not describe what staff
can see. Whether that is acceptable is a product decision, not a bug — but the
gap between the toggle's implied promise and the actual boundary should be
stated in `PRIVACY.md`, which I did not find it in.

**Proposed fix.** Either narrow the policy to
`has_perm('community.analytics.view')` (dropping plain coaches), or document the
staff exception in `PRIVACY.md` and in the settings UI copy next to the toggle.

---

### SEC-010 — Any coach can edit or soft-delete any announcement, including an admin's

- **Category:** Insider integrity
- **Priority:** P2 · **Severity:** Medium · **Confidence:** High
- **Status:** open (likely intentional — confirm)

**File:line**

- `supabase/migrations/202608270006_security_hardening.sql:144-145` — `create policy announcements_update_admin on public.announcements for update to authenticated using (public.is_staff()) with check (public.is_staff());`
- `supabase/migrations/202608270001_community_growth.sql:45` — `grant select, insert, update on public.announcements to authenticated`

**Evidence.** The UPDATE predicate is `is_staff()` with **no** `author_id`
scope, unlike the INSERT policy immediately above it
(`202608270006:142-143`, which does require `author_id = auth.uid()`). There is
no DELETE grant, so removal is a soft delete via `deleted_at` — which is an
UPDATE, and therefore also open to any coach. `announcements` writes do not go
through `log_admin_action()`, so an edit or removal of another staff member's
announcement leaves no audit row.

**Impact.** In a small club with a handful of trusted coaches this is low harm;
it is recorded because it is asymmetric with the INSERT policy right beside it
and because the audit log does not cover it.

**Proposed fix.** Either scope to `author_id = auth.uid() or is_admin()`, or
route announcement edits through a definer function that writes an
`admin_actions` row, matching the `pin_set`/`comment_moderate` shape.

---

### SEC-011 — `admin_reset_password` Edge Function: no rate limit, no target validation, no CORS preflight

- **Category:** Edge Function hardening
- **Priority:** P2 · **Severity:** Medium · **Confidence:** Medium
- **Status:** open

**File:line**

- `supabase/functions/admin_reset_password/index.ts:56-145` — the whole handler
- `:97-103` — `target_user_id` accepted as any non-empty string, passed straight to `auth.admin.updateUserById()` at `:122` with no UUID validation and no check that the target is a member of this club (or that a `profiles` row exists at all)
- `:109-119` — the caller's `is_admin` check, which is correct: identity comes from the caller's own JWT via `callerClient.auth.getUser()` (`:83`), never from a client-sent flag
- `:141-144` — the plaintext temporary password is returned in the response body
- `cloud.js:3063` — `client.functions.invoke("admin_reset_password", { body: { target_user_id: userId } })`

**Evidence, in three parts.**

1. **No rate limiting.** Unlike every SQL write path, this function calls no
   `check_rate_limit`. A single compromised or hijacked admin session can reset
   every account's password in a loop, locking out the entire club. The audit
   row (`admin_log_password_reset`, `:136`) is written best-effort and its
   failure is logged, not fatal (`:137-139`) — so a burst can partly evade the
   log.
2. **No target validation.** `updateUserById` is called with whatever string
   arrives. This can reach any `auth.users` row, including one with no
   `profiles` row (a ghost or a backup-only session, which
   `COMMUNITY_SETUP.md` §Offline synchronization confirms exist). Low severity
   given the caller must already be an admin, but the function should refuse a
   target that is not a club member.
3. **No CORS handling — confidence medium.** The handler never answers `OPTIONS`
   and never sets `Access-Control-Allow-Origin`. `cloud.js:3063` invokes it from
   the browser with an `Authorization` header, which forces a CORS preflight. If
   Supabase's Edge Runtime does not supply default CORS headers for this shape,
   the admin password-reset flow is **broken in production** — and since login
   emails are synthetic (`@members.haimuniya.invalid`) this is the *only*
   account-recovery path a locked-out member has. I could not verify the runtime
   behaviour without a live deployment, hence medium confidence and an explicit
   ask to test it. Both other Edge Functions are service-role-only and never
   called from a browser, so neither exercises this path.

**Impact.** (1) admin-session compromise escalates to a club-wide lockout;
(2) minor; (3) if real, the documented recovery mechanism does not work at all.

**Proposed fix.** Add an OPTIONS branch and explicit CORS headers scoped to the
app origin. Validate `target_user_id` as a UUID and require a matching
non-deleted `profiles` row. Add a server-side reset throttle (a
`check_rate_limit('admin_password_reset', 5, 60)` call through the caller's own
client, alongside the existing audit RPC). Make the audit write fatal, or at
minimum surface the failure to the admin UI rather than only to `console.error`.

---

### SEC-012 — Weak password policy

- **Category:** Authentication strength
- **Priority:** P2 · **Severity:** Medium · **Confidence:** Medium
- **Status:** open

**File:line**

- `supabase/config.toml:55-56` — `minimum_password_length = 6`, `password_requirements = ""`
- `supabase/config.toml:60-63` — `enable_confirmations = false` (correct and necessary here, see below)
- `cloud.js:3884` — `client.auth.updateUser({ email: usernameToEmail(username), password })`

**Evidence.** Six characters with no complexity requirement, on an account whose
identifier is a guessable username (`usernameToEmail()` builds
`${username}@members.haimuniya.invalid`, and handles are club-public via the
member directory). Credential stuffing and online guessing against a known
username list is the realistic attack; Supabase's platform auth throttling is
the only thing in the way, and it is not configured in this repo.

Confidence is medium only because `config.toml` declares itself
*"Local/CI-only config … the real project is configured through the Supabase
dashboard"* (`:1-6`) — I cannot read the real project's setting. But the file is
explicitly maintained to mirror production (`:60-62` says so for
`enable_confirmations`), so it is the best available evidence.

`enable_confirmations = false` is **not** a finding: there is no inbox behind a
`.invalid` address, so a confirmation requirement would lock out every signup.
That reasoning is sound and is documented in `COMMUNITY_SETUP.md`.

**Proposed fix.** Raise `minimum_password_length` to 10 and set
`password_requirements` on both the real project and `config.toml`. Verify the
dashboard setting matches; a client-side check in `cloud.js` alone is not a
control.

---

### SEC-013 — `detectSessionInUrl: true` with no redirect-based auth flow

- **Category:** Session handling · **Priority:** P3 · **Severity:** Low · **Confidence:** High · **Status:** open

**File:line:** `cloud.js:22` —
`auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }`

**Evidence.** The app uses only `signInAnonymously()` (`cloud.js:3789`),
`signInWithPassword()` (`:3859`) and `updateUser()` (`:3884`). There is no OAuth
provider, no magic link, and no email confirmation — `COMMUNITY_SETUP.md` states
email delivery is permanently out of scope. So `detectSessionInUrl` serves no
flow, and it makes supabase-js parse and adopt a session from the URL fragment on
every load. Combined with the app being installable and link-shareable, a crafted
`https://…/#access_token=…&refresh_token=…` URL becomes a one-click
session-fixation vector against a user who follows it.

Mitigating: `<meta name="referrer" content="no-referrer">` (`index.html:49`) and
the CSP's `base-uri 'none'` / `form-action 'none'` (`index.html:46-47`) reduce
the surrounding surface, and the attacker must supply a session they control,
which yields their data, not the victim's — the harm is the victim
unknowingly writing into an attacker-readable account.

**Proposed fix.** Set `detectSessionInUrl: false`.

---

### SEC-014 — No clickjacking protection available on the host

- **Category:** Clickjacking · **Priority:** P3 · **Severity:** Low · **Confidence:** High · **Status:** open (host limitation)

**File:line:** `index.html:19-34` (the comment) and `index.html:48`
(`frame-ancestors 'none'` inside the `<meta>` CSP).

**Evidence.** `frame-ancestors` is spec-ignored in a `<meta>` CSP; only a real
HTTP response header is honoured. GitHub Pages serves static files with no
header configuration. The repo documents this accurately and does not overclaim —
`index.html:22-34` states it is inert and says what it would take to fix. I
verified the directive is present and that no `_headers`/`netlify.toml`/
`vercel.json` exists in the tree.

**Proposed fix.** Front the site with a layer that can set response headers
(Cloudflare, Netlify, an nginx proxy) and set `X-Frame-Options: DENY` /
`Content-Security-Policy: frame-ancestors 'none'` there. Also gets
`Strict-Transport-Security` and a header-based CSP, which is strictly stronger
than the meta form.

---

### SEC-015 — Session tokens in `localStorage`

- **Category:** Token storage · **Priority:** P3 · **Severity:** Low · **Confidence:** High · **Status:** accepted-risk

**File:line:** `cloud.js:20-23` — `createClient(..., { auth: { persistSession: true, ... } })`, which uses supabase-js's default `localStorage` backend under `sb-<ref>-auth-token`.

**Evidence.** Standard supabase-js behaviour and unavoidable for a static
build-free PWA with no server to set an HttpOnly cookie. The residual risk is
XSS → token theft. It is meaningfully bounded here by the CSP: `script-src
'self'` with no `'unsafe-inline'` and no CDN (`index.html:38`), and `connect-src`
restricted to self + the one Supabase origin (`index.html:42`), so an injected
script cannot load remote code and cannot beacon a stolen token to an
attacker-controlled host. I found no `eval(`, `new Function(`, string-argument
`setTimeout`, `document.write`, or `insertAdjacentHTML` anywhere in `app.js`,
`cloud.js`, `sw.js` or `index.html`. `cloud.js` contains **zero** `innerHTML`
assignments.

**Proposed fix.** None available on this architecture. Recorded so it is a known
accepted risk rather than an oversight. Keep the CSP exactly as strict as it is.

---

### SEC-016 — `posts_select_admin_review` is a second permissive policy that bypasses every other post gate for admins

- **Category:** Admin read bypass · **Priority:** P3 · **Severity:** Low · **Confidence:** High · **Status:** open (by design — record it)

**File:line:** `supabase/migrations/202608270009_admin_moderation_visibility.sql:32-33` —
`create policy posts_select_admin_review on public.workout_posts for select to authenticated using (exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null));`

**Evidence.** Postgres OR's multiple permissive `SELECT` policies. This one has
no `deleted_at`, no block-edge, no `club_feature_enabled('feed')` and no
`is_community_member()` clause, so for an admin it fully supersedes
`posts_feed_select` (`202609060001:138`). An admin therefore reads soft-deleted
posts, moderator-removed posts, posts by members who have blocked them, and posts
while the feed module is switched off. The migration's own comment
(`:9-14`) explains the intent — moderators must see reported content — and
deliberately restricts it to real `is_admin`, not `is_staff()`, so coaches do
**not** get it.

**Impact.** None beyond the intended moderation capability, but the effective
admin read scope is invisible from the main policy and should be in the
authorization matrix (it now is).

**Proposed fix.** No change required. Consider narrowing the predicate to posts
that have an open `reports` row, so an admin's blanket read is tied to an actual
moderation need.

---

### SEC-017 — Non-constant-time service-role key comparison in two Edge Functions

- **Category:** Timing side channel · **Priority:** P3 · **Severity:** Informational · **Confidence:** Medium · **Status:** open

**File:line:**
- `supabase/functions/recap_weekly/index.ts:393` — `if (req.headers.get("Authorization") !== \`Bearer ${serviceRoleKey}\`)`
- `supabase/functions/purge_abandoned_profiles/index.ts:86` — identical

**Evidence.** JavaScript `!==` on strings short-circuits at the first differing
byte. Over a network, with Deno's scheduling and TLS jitter, extracting a key
this way is not a practical attack — hence Informational. Recorded because the
check itself is a genuinely good decision (`recap_weekly/index.ts:383-392`
explains why the platform's `verify_jwt` is insufficient: the publishable key
satisfies it), and the comparison is the one weak part of an otherwise correct
control.

**Proposed fix.** `crypto.subtle.timingSafeEqual` over the encoded bytes, or
compare SHA-256 digests.

---

### SEC-018 — `app.js` `innerHTML` sinks: escaping not exhaustively verified

- **Category:** XSS surface · **Priority:** P3 · **Severity:** Low · **Confidence:** LOW · **Status:** needs-verification

**File:line:** 35 `innerHTML` assignments in `app.js` (`:677, 787, 795, 874, 878, 1400, 1957, 1968, 1994, 1997, 2572, 2576, 2579, 2627, 2671, 2675, 2738, 2913, 2977, 3117, 3314, 3319, 3324, 3329, 3340, 3560, 3564, 3567, 3624, 3879, 3882, 3943, 3948, 4175, 4335`), plus three `outerHTML` writes (`:1489, 1523, 1884`). The composition point for community-rendered HTML is `app.js:3340` — `document.getElementById("content").innerHTML = content + cloudOverlay;`.

**What I did verify (high confidence).**
- `esc()` is a single shared definition (`src/shared/safe-helpers.js`) escaping
  `& < > " '` — correct for both text and quoted-attribute contexts.
- `cloud.js` — the module that renders **remote, attacker-influenced** data — has
  **zero** `innerHTML` assignments and reaches `esc` unguarded at `cloud.js:18`,
  deliberately so it fails loudly rather than degrading to a no-op.
- I mechanically extracted all 947 template interpolations in `cloud.js` that are
  not literally wrapped in `esc()`/`Number()` and inspected the distinct
  expressions. Every one I sampled resolves to either a pre-escaped HTML fragment
  built by a sibling function, a numeric, or a hardcoded constant. I found no
  unescaped remote string reaching a markup position.
- Records loaded from disk or an import file all pass through
  `src/sanitize.js`'s per-record sanitizers, which `cleanStr()` (control-character
  strip + length cap) every free-text field.

**Why confidence is still low.** I did not read all 4,467 lines of `app.js`, and
I did not trace every one of the 35 sinks back to its data source to confirm that
no field pulled down from `private_records` (which round-trips through the
network and is therefore not purely local) reaches a sink unescaped. The sinks I
did read (`:1400`, `:1994`, `:2576`, `:3564`) all use `esc()` correctly.

**Impact if wrong.** Self-XSS at worst for `private_records` (a member's own
data), escalating only if a sync path ever carries another member's text. The
CSP (`index.html:36-48`) blocks remote script load and remote exfiltration
either way.

**Proposed fix.** A focused pass over the 35 `app.js` sinks confirming every
interpolated value is either `esc()`-wrapped or provably a number/constant. Worth
doing before launch; not worth blocking on.

---

### SEC-019 — `display_name` is unconstrained, enabling staff impersonation

- **Category:** Impersonation · **Priority:** P3 · **Severity:** Low · **Confidence:** High · **Status:** open

**File:line:**
- `supabase/migrations/202608270003_invite_gate.sql:82` — `profiles_update_self`, column-unrestricted apart from the trigger-pinned three
- `supabase/migrations/202608260001_community_foundation.sql:11` — `display_name text not null default '' check (char_length(display_name) <= 80)` — length only, no format constraint
- `supabase/migrations/202608260001_community_foundation.sql:10` — `handle` **is** unique and format-constrained, so handle impersonation is not possible

**Evidence.** Any member may set `display_name` to "מאמן/ת דנה" or to another
member's exact display name, at any time, unlimited times. The real coach badge
comes from `member_roles()` (`202609010011:45`) and is rendered separately, which
limits the damage — but on surfaces that show a name without the badge, and in
notification bodies, the name is the only signal.

**Proposed fix.** Low priority. Options: uniqueness on
`lower(btrim(display_name))`, a rate limit on name changes, or rendering the
coach badge on every surface that shows a display name (the badge cache already
exists for this).

---

## Already-mitigated — verified, with citations

### SEC-101 — The `anon` role is fully locked out of `public`
`202608260001:103` revokes all table privileges from `anon` and `authenticated`;
`202608270002:29` sets `alter default privileges … revoke … from anon,
authenticated` so a future table does not silently re-open. I checked every
`grant` in the tree: **not one names `anon` or `public` on a table**, and every
`grant execute` on a definer function is preceded by a matching
`revoke … from public, anon`. This control holds. Note it is **not** the control
that matters for SEC-001 — a ghost session is `authenticated`, not `anon`, and
`202609060002:81-83` says so explicitly.

### SEC-102 — The five leaking definer read functions are fixed
`feed_page` (`202609060009:225`), `community_search` (`:659`),
`community_profile` (`:800`), `club_summary` (`:1079`) and `member_roles`
(`:1130`) now all carry `is_community_member()`. I did not take
`202609060009`'s claim that *"every other client-callable definer read already
refuses"* on trust — I enumerated all 75 definer functions granted to
`authenticated` and read every body whose guard was not mechanically detectable
(`admin_grant_coach`, `submit_report`, `add_post_comment(4)`,
`post_set_visibility`, `feed_record_impressions`, `notif_mark_read`,
`can_upload_post_photo`, `can_write_own_avatar`, `club_feature_enabled`,
`request_account_deletion`). All ten are correctly guarded — see
`AUTHORIZATION_MATRIX.md` §2 for the per-function reason. The claim is accurate.

### SEC-103 — No client-reachable privilege escalation exists
Traced in full in `AUTHORIZATION_MATRIX.md` §3.
`invite_redemptions` has **no** write grant to `authenticated`
(`202608270003:27` grants `select` only). `profiles.is_admin` is pinned by
`protect_is_admin()` (`202608280003:67-78`) and forced false on insert
(`:216`). `admin_grant_coach` checks the raw `profiles.is_admin` column and
restricts `p_role` to `coach`/`head_coach` (`202608280025:396-404`).
`admin_invite_create` requires `is_admin()` specifically for a coach-role invite
(`202609030008:97`), closing the self-propagating-coach path that
`202609030001` had opened. Coach → admin and member → coach are both
unreachable from a client.

### SEC-104 — PostgREST filter injection is handled on both sides
`cloud.js:3731` strips `% _ , ( )` from the query before building the
`.or("handle.ilike.%" + q + "%,display_name.ilike.%" + q + "%")` string at
`:3736` — that character class is exactly the PostgREST `or()` metacharacter set,
so the concatenation cannot be broken out of. The server side does not rely on
the client having done it: `community_search()` re-applies the identical strip on
the raw RPC argument (`202609060009:661-668`, *"Replicated here because this
function receives the raw string over RPC, not the client's already-sanitized
copy"*). This is the only string-concatenated filter in the client. No SQL
string concatenation exists anywhere in the migrations — every definer function
uses parameterised PL/pgSQL, and the two `execute format()` calls
(`202608280001:136`, `202609060006:63`) interpolate `%I`-quoted catalog names
read from `pg_constraint`, not user input.
