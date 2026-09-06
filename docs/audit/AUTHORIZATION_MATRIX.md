# Authorization matrix — real RLS, as written

Security/threat-modeling audit stream. Built by reading every file in
`supabase/migrations/` in filename order and recording the **live** policy text
(the last `create policy` for a given name wins), not the stated intent in any
doc or comment. Every row cites `file:line` of the migration that declares the
policy that is live today.

Nothing here was verified against a running database — this repo has no
reachable Supabase project from the audit sandbox. Everything is static reading
of SQL. Where I could not fully determine an outcome I say so in the Notes
column.

## 0. Roles in play

| Role | What it is |
|---|---|
| `anon` | The publishable key with **no** session. Postgres role `anon`. |
| *ghost* | An **anonymous sign-in** session. Postgres role `authenticated`, real `auth.uid()`, **no** `invite_redemptions` row, **no** `profiles` row. Obtainable by anyone in one unauthenticated POST (`enable_anonymous_sign_ins = true`, `supabase/config.toml:53`). **This is not the `anon` role** and every `to authenticated` policy applies to it. |
| `member` | Redeemed + `profiles.recovery_verified_at` set → `is_community_member()` true (`202609060001_anonymous_read_gate.sql:88`). `invite_redemptions.role = 'member'`, rank 10. |
| `coach` | `invite_redemptions.role = 'coach'`, rank 20 (`202608280001_clubs_and_rbac.sql:48-54`). `is_staff()` true. Holds `post.create`, `comment.moderate`, `challenge.create`, `event.manage`, `announcement.publish`, `member.invite`. |
| `admin` | `profiles.is_admin = true` → `my_role_code()` resolves `'admin'`, rank 50 (`202608280001_clubs_and_rbac.sql:164-187`). `is_admin()` true. |
| `service_role` | Bypasses RLS entirely. Key never in the browser bundle (verified: `cloud-config.js:1-22` holds only URL + publishable key + VAPID **public** key). |

Two authorization primitives:

- `public.is_staff()` = `role_rank(my_role_code()) >= 20` — `202608280001_clubs_and_rbac.sql:238-241`
- `public.is_admin()` = `role_rank(my_role_code()) >= 50` — `202608280001_clubs_and_rbac.sql:245-248`
- `public.has_perm(text)` — `202608280001_clubs_and_rbac.sql:198-210`; `owner` short-circuits to true.
- `public.is_community_member()` — `202609060001_anonymous_read_gate.sql:88-100` (SECURITY DEFINER).

Baseline grants: `revoke all on all tables in schema public from anon, authenticated`
(`202608260001_community_foundation.sql:103`) plus
`alter default privileges in schema public revoke select, insert, update, delete on tables from anon, authenticated`
(`202608270002_lock_anon_defaults.sql:29`). So `anon` (keyless, sessionless) has
no table access anywhere in `public`. **The exposure surface is the ghost
session, not `anon`.**

---

## 1. Per-table matrix

Legend: `Y` = permitted, `–` = denied (no grant and/or no policy), `self` =
own rows only, `cond` = permitted subject to the predicate in Notes.

### Identity / membership

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `profiles` SELECT | – | **self only** | Y cond | Y cond | Y (all) | Y | `202609060001:115` — `deleted_at is null AND no block edge AND (id = auth.uid() OR (is_community_member() AND (visible_to_club OR is_admin())))` |
| `profiles` INSERT | – | – | self | self | self | Y | `202608280003:214` — `id = auth.uid() AND is_admin = false AND recovery_verified_at is null AND exists(invite_redemptions)` |
| `profiles` UPDATE | – | – | **self, any column** | self | self | Y | `202608270003:82` — `using(id=auth.uid()) with check(id=auth.uid())`. Column restriction is a *trigger*, not the policy: `protect_is_admin()` (`202608280003:67-78`) pins `is_admin`, `club_id`, `recovery_verified_at` when `auth.role() = 'authenticated'`. Everything else (`handle`, `display_name`, `bio`, `avatar_url`, all 12 privacy toggles) is freely writable. |
| `profiles` DELETE | – | – | – | – | – | Y | no grant |
| `invite_codes` all | – | – | – | – | – | Y | no grant at all (`202608270003:14-18`) |
| `invites` all | – | – | – | – | – | Y | `202609030001:134` RLS on, reached only through `admin_invite_*` definer fns |
| `invite_redemptions` SELECT | – | self | self | self | self | Y | `202608270003:28` — `user_id = auth.uid()`. Cross-member `role` is read only via `member_roles()` (`202609060009:1124-1130`, now gated on `is_community_member()`). |
| `invite_redemptions` I/U/D | – | – | – | – | – | Y | **no write grant** — only `redeem_invite_code()`, `grant_coach_role()`, `admin_grant_coach()`, `admin_revoke_coach()` |
| `invite_attempts` all | – | – | – | – | – | Y | `202608270006:48` revoked from all; `202608280013:35-37` |
| `rate_limits` all | – | – | – | – | – | Y | `202608270010:20` |
| `account_deletion_requests` SELECT | – | self | self | self | self | Y | `202608260001:142` |

### Content

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `workout_posts` SELECT | – | **self only** | Y cond | Y cond | **Y (all, ungated)** | Y | `202609060001:138` (main) OR'd with `posts_select_admin_review` `202608270009:32` — a second **permissive** policy `using(exists profiles where id=auth.uid() and is_admin)` with no block/feature-flag/`is_community_member` clause. Admin therefore reads deleted, removed, blocked-author and feature-flag-disabled posts. Intentional for moderation; recorded here because it is invisible from the main policy. |
| `workout_posts` INSERT | – | – | Y cond | Y cond | Y cond | Y | `202608280015:207` — `author_id = auth.uid() AND is_community_member() AND has_perm('community.post.create') AND not is_posting_restricted()`. **Direct grant still live** (`202608260001:105`) so this path bypasses `post_create()`'s rate limit. |
| `workout_posts` UPDATE | – | – | **self, any column** | self | self | Y | `202608260001:133` — `using(author_id=auth.uid()) with check(author_id=auth.uid())`, **no column restriction**. Only two columns are trigger-guarded: `post_type` (`202609060004:104`) and `photo_path`/`author_id` (`202608270006:186`). `status`, `deleted_at`, `visibility`, `score_value`, `comparison_key`, `published_at`, `is_pinned`, `metadata`, `body` are all author-writable. See SEC-002/SEC-005. |
| `workout_posts` DELETE | – | – | self | self | self | Y | `202608260001:134` |
| `post_comments` SELECT | – | – | cond | cond | cond | Y | `202608280016:98` via `post_visible_to_viewer()` — closed to a ghost because `posts_feed_select` is now gated |
| `post_comments` INSERT | – | – | via RPC | via RPC | via RPC | Y | grant **revoked** `202608270010:86`; only `add_post_comment()` |
| `post_comments` UPDATE | – | – | – | – | – | Y | no grant; `comment_edit()` / `comment_moderate()` only |
| `post_comments` DELETE | – | – | self | self | self | Y | `202608270004:60` |
| `comment_mentions` SELECT | – | – | cond | cond | cond | Y | `202608280021:44` — mentioned member or comment author |
| `reactions` SELECT | – | – | cond | cond | cond | Y | `202608270001:25` via `post_visible_to_viewer()` |
| `reactions` INSERT | – | – | via RPC | via RPC | via RPC | Y | grant revoked `202608270010:87`; `toggle_reaction()` only |
| `reactions` DELETE | – | – | self | self | self | Y | `202608260001:138` |
| `post_media` S/I/U/D | – | – | cond/self | cond/self | cond/self | Y | `202608280005:169-193` |
| `reports` SELECT | – | self | self | self | Y (all) | Y | `202608260001:141` — `reporter_id = auth.uid() OR profiles.is_admin`. A coach reads the queue only through `mod_queue()`. |
| `reports` INSERT | – | – | via RPC | via RPC | via RPC | Y | grant revoked `202608270010:88`; `report()` only |
| `hidden_posts` / `saved_posts` | – | self | self | self | self | Y | `202608280014:51-95` |
| `pins` SELECT | – | **Y** | Y | Y | Y | Y | `202608280017:80` — `using (true)`, no membership gate |
| `pins` write | – | – | – | – | – | Y | no grant; `pin_set()`/`pin_clear()` require `content.pin` |

### Club / RBAC / config

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `clubs` SELECT | – | **Y** | Y | Y | Y | Y | `202608280001:256` — `using (true)` |
| `clubs` I/U/D | – | – | – | – | – (owner only) | Y | `202608280001:257-262` — `my_role_code() = 'owner'`. No account can hold `owner` today. |
| `roles` / `permissions` / `role_permissions` SELECT | – | **Y** | Y | Y | Y | Y | `202608280001:264,272,280` — `using (true)` |
| same, I/U/D | – | – | – | – | – (owner only) | Y | `202608280001:265-286` |
| `club_features` SELECT | – | **Y** | Y | Y | Y | Y | `202609010012:43` — `using (true)` |
| `club_features` write | – | – | – | – | via RPC | Y | no policy; `admin_set_club_feature()` requires `has_perm('community.club.manage_modules')` (admin/owner only, `202609010012:92-96`) |
| `onboarding_step_content` SELECT | – | **Y** | Y | Y | Y | Y | `202609030004:77` — deliberately pre-redemption |
| `onboarding_step_content` UPDATE | – | – | – | – | Y | Y | `202609030004:85` — `has_perm('community.content.manage_onboarding') or is_admin()` |
| `intro_carousel_content` SELECT | – | **Y** | Y | Y | Y | Y | `202609050007:65` — deliberately pre-redemption |
| `intro_carousel_content` UPDATE | – | – | – | – | Y | Y | `202609050007:68` |

### Announcements / challenges / events

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `announcements` SELECT | – | – | Y cond | Y cond | Y cond | Y | `202609060001:171` — `deleted_at is null AND (expires_at null/future OR is_staff()) AND club_feature_enabled('announcements') AND is_community_member()` |
| `announcements` INSERT | – | – | – | Y | Y | Y | `202608270006:142` — `author_id = auth.uid() AND is_staff()` |
| `announcements` UPDATE | – | – | – | **Y (any row)** | Y | Y | `202608270006:144` — `using(is_staff()) with check(is_staff())`, **not scoped to author**. Any coach may edit or soft-delete any announcement, including an admin's. |
| `weekly_challenges` SELECT | – | **Y** | Y | Y | Y | Y | `202608270001:142` — `using (true)` |
| `weekly_challenges` INSERT | – | – | – | Y | Y | Y | `202609060005:44` — `created_by = auth.uid() AND has_perm('community.challenge.create')` |
| `weekly_challenges` U/D | – | – | – | Y | Y | Y | `202609060005:53,56` |
| `challenges` SELECT | – | **Y** | Y | Y | Y | Y | `202609010012:159` — `(status <> 'draft' OR created_by = auth.uid() OR has_perm(...)) AND club_feature_enabled('challenges')`. **No `is_community_member()`.** |
| `challenges` I/U/D | – | – | – | Y | Y | Y | `202608280009:88-93` — `has_perm('community.challenge.create')`; insert also `created_by = auth.uid()` |
| `challenge_teams` SELECT | – | **Y** | Y | Y | Y | Y | `202608280009:96` — any row whose challenge exists |
| `challenge_teams` I/U/D | – | – | – | Y | Y | Y | `202608280009:98-103` |
| `challenge_participants` SELECT | – | **Y** | Y | Y | Y | Y | `202608280009:110` — any row whose challenge exists. **Exposes `user_id` of every participant.** |
| `challenge_participants` INSERT | – | – | self cond | self cond | self cond | Y | `202608280009:112` — `user_id = auth.uid() AND is_community_member() AND challenge active` |
| `challenge_participants` UPDATE | – | – | self cond | Y cond | Y cond | Y | `202608280009:118` `using(user_id = auth.uid() or has_perm(...))`, column-unrestricted — but `progress_value` and `status` are now trigger-guarded (`202609060005:124-155`) |
| `challenge_participants` DELETE | – | – | self | Y | Y | Y | `202608280009:121` |
| `challenge_progress` SELECT | – | **Y** | Y | Y | Y | Y | `202608280009:127` — any row whose challenge exists |
| `challenge_progress` INSERT | – | – | self cond | self cond | self cond | Y | `202608290005:38` — self + `is_community_member()` + active participant |
| `challenge_progress` U/D | – | – | – | – | – | Y | append-only, no grant |
| `events` SELECT | – | **Y** | Y | Y | Y | Y | `202609010012:149` — `(status <> 'draft' OR created_by = auth.uid() OR has_perm(...)) AND club_feature_enabled('events')`. **No `is_community_member()`.** |
| `events` I/U/D | – | – | – | Y | Y | Y | `202608280010:51-56` — `has_perm('community.event.manage')` |
| `event_attendees` SELECT | – | **Y cond** | Y cond | Y | Y | Y | `202608280010:63` — `user_id = auth.uid() OR has_perm(...) OR can_view_profile_field(user_id,'show_in_attendee_lists')`. That toggle defaults **true** (`202608280003:32`) and `can_view_profile_field` does not require membership, only a non-null `auth.uid()` (`202608280003:159-160`). **Exposes member `user_id`s to a ghost.** |
| `event_attendees` I/U/D | – | – | self cond | Y | Y | Y | `202608280010:68-77` |

### Achievements / recognition / recaps

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `achievement_definitions` SELECT | – | **Y** | Y | Y | Y | Y | `202608280007:65` — `using (true)` (no member data) |
| `achievement_definitions` I/U/D | – | – | – | – | Y | Y | `202608280007:67-71` — `is_admin()` |
| `member_achievements` SELECT | – | **Y cond** | Y cond | Y cond | Y cond | Y | `202609010012:172` — self, or `visibility='club' AND can_view_profile_field(user_id,'show_achievements')` (defaults **true**), or friends-branch; all `AND club_feature_enabled('achievements')`. **No `is_community_member()`; exposes member `user_id`s to a ghost.** |
| `member_achievements` write | – | – | via RPC | via RPC | via RPC | Y | `ach_claim()` (`202608290002:27`) |
| `member_of_week` SELECT | – | **Y** | Y | Y | Y | Y | `202609010001:210` — `using (true)`. Carries `user_id`. |
| `member_of_week` write | – | – | – | – | – | Y | no grant; `member_of_week_publish()` requires `is_staff()` |
| `monthly_club_recaps` SELECT | – | **Y (published)** | Y (published) | Y (all) | Y (all) | Y | `202609010002:224` staff/analytics all rows; `:228` `published_at is not null` for everyone. Aggregate-only by table shape (no `user_id`, no text column). |
| `weekly_recaps` SELECT | – | self | self | self | self | Y | `202608290011:92` |
| `community_streaks` (view) SELECT | – | **self only** | Y cond | Y cond | Y cond | Y | `202609060002:88-124` — `is_community_member()` + subject's `visible_to_club` + `in_leaderboards` (raw column *and* `can_view_profile_field`); `last_activity_on` additionally gated on `show_attendance`. Gated. |
| `community_feed` (view) SELECT | – | – | Y | Y | Y | Y | `202608260001:169-179`, `security_invoker = true` → inherits `posts_feed_select`, so gated. |

### Social graph / telemetry / ops

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `follows` SELECT | – | self edges | self edges | self edges | self edges | Y | `202608260001:119` |
| `follows` INSERT | – | – | self cond | self cond | self cond | Y | `202608280003:239` — `follower_id = auth.uid() AND target allow_follows AND no block edge`. **No `is_community_member()`** — a ghost has no profile row so the FK to `profiles` blocks it in practice. |
| `follows` UPDATE | – | – | – | – | – | Y | grant exists, **no policy** → denied |
| `follows` DELETE | – | – | self | self | self | Y | `202608260001:121` |
| `blocks` S/I/D | – | self | self | self | self | Y | `202608260001:123-125` |
| `blocks` UPDATE | – | – | – | – | – | Y | grant exists, no policy → denied |
| `private_records` S/I/U/D | – | **self, unlimited** | self | self | self | Y | `202608260001:114-117` — `user_id = auth.uid()` only. **No membership gate, no rate limit, no `payload` size CHECK.** |
| `activity_pings` S/I | – | self | self | self | self | Y | `202608270001:69-70` |
| `attendance_log` SELECT | – | – | self | **Y (all, raw)** | Y (all) | Y | `202608310001:137` self; `:151` `has_perm('community.analytics.view') OR is_staff()` — a coach reads every member's raw attendance days regardless of that member's `show_attendance` toggle |
| `attendance_log` write | – | – | – | – | – | Y | no grant; trigger `attendance_log_from_record()` only |
| `analytics_events` INSERT | – | **self, unlimited** | self | self | self | Y | `202608280012:44` — `user_id = auth.uid() OR user_id is null`. No rate limit. |
| `analytics_events` SELECT | – | – | – | – | Y | Y | `202608280012:46` — `has_perm('community.analytics.view')` |
| `feed_impressions` SELECT | – | self | self | self | self | Y | `202608280006:45` |
| `feed_impressions` INSERT | – | – | via RPC | via RPC | via RPC | Y | grant **revoked** `202609050005:128`; `feed_record_impressions()` only |
| `feed_impressions` UPDATE | – | – | – | – | – | Y | never granted; only `feed_record_interaction()` (`202609060010:112`) |
| `feed_interactions` S/I | – | self | self | self | self | Y | `202608280006:50-52` |
| `member_feed_weights` SELECT | – | self | self | self | self | Y | `202608310006:162` |
| `notifications` SELECT/UPDATE | – | self | self | self | self | Y | `202608280008:61,63`. **No INSERT policy** — `notif_create()` is service_role (`202608290012`). |
| `notification_preferences` S/I/U/D | – | self | self | self | self | Y | `202608280008:93-99` |
| `push_subscriptions` S/I/U/D | – | **self, unlimited** | self | self | self | Y | `202608280008:102-108` — `user_id = auth.uid()`, no count cap |
| `notification_batches` SELECT | – | self | self | self | self | Y | `202608280018:56` |
| `admin_actions` SELECT | – | – | – | – | Y | Y | `202608280002:46` — `has_perm('community.analytics.view')` (admin/owner only) |
| `admin_actions` write | – | – | – | – | – | Y | no policy, no grant; `log_admin_action()` definer, granted to no role |
| `posting_restrictions` SELECT | – | – | self | Y | Y | Y | `202608280015:71` |
| `member_contact_log` SELECT/INSERT | – | – | – | Y | Y | Y | `202608290013:313,323` — `is_staff()` |
| `coach_engagement_flags` all | – | – | – | Y | Y | Y | `202608280011:32-39` — `is_staff()` |
| `community_health_scores` SELECT | – | – | – | – | Y | Y | `202609010009:287` |

### Storage buckets

| Object | anon | ghost | member | coach | admin | Notes |
|---|---|---|---|---|---|---|
| `post-photos` SELECT | – | – | cond | cond | Y | `202608270006:207` — object name's uid prefix must equal the post's `author_id` **and** `post_visible_to_viewer(p.id)`. Private bucket + signed URL. |
| `post-photos` INSERT | – | – | cond | cond | cond | `202608270006:204` → `can_upload_post_photo()` (`:189`) — own-uid prefix, redeemed, **`< 20` objects per member** |
| `post-photos` DELETE | – | – | self | self | self | `202608270004:36` |
| `avatar-photos` SELECT | – | self only | cond | cond | cond | `202609060003:70` — own object, or `is_community_member() AND can_view_profile_field(owner,'visible_to_club')`. Bucket flipped to private at `202609060003:40`. |
| `avatar-photos` I/U/D | – | – | cond | cond | cond | `202609010010:60-70` → `can_write_own_avatar()` (`:42`) — own-uid prefix + redeemed. **No object-count cap** (deliberate, see SEC-006). |

---

## 2. Client-callable SECURITY DEFINER surface

75 `SECURITY DEFINER` functions carry `grant execute … to authenticated`. Because
a definer function reads its base tables with the owner's rights, RLS never runs
inside one and each must restate its own gate. I enumerated all 75 mechanically
and read every one whose body contained no recognisable guard. Result:

**Gated on `is_community_member()`** (correct for member-data reads/writes):
`feed_page`, `community_search`, `community_profile`, `club_summary`,
`member_roles` (all five fixed in `202609060009_definer_read_gate.sql:225,659,800,1079,1130`),
`post_create`, `post_edit_caption`, `add_post_comment` (3-arg),
`comment_edit`, `comment_delete`, `toggle_reaction`, `report`, `ach_claim`,
`event_rsvp`, `chal_progress`, `attendance_classmates_today`.

**Gated on `is_admin()` / `has_perm()`** (correct for admin/staff surfaces):
all 20 `admin_*`, all 5 `mod_*`, `analytics_dashboard`, `member_segments`,
`retention_*`, `community_health_history`, `registration_funnel`,
`recap_monthly_publish`, `member_of_week_*`, `coach_*`, `chal_record_progress`,
`chal_reassign_team`, `chal_set_captain`, `pin_set`, `pin_clear`,
`admin_set_club_feature`, `review_report`.

**Gated on `auth.uid()` only — deliberate and verified safe:**

| Function | Why the weaker gate is correct |
|---|---|
| `post_set_visibility` (`202609060007:144`) | Own-row only (`author_id is distinct from v_uid → not authorized`, `:158`); narrowing must stay available to a restricted member. |
| `feed_record_impressions` (`202608280006:60`) | Writes only `user_id = auth.uid()` rows; ≤50 per call. |
| `feed_record_interaction` (`202609060010:112`) | Own rows; rate limited 300/10min; `post_visible_to_viewer()` check. |
| `notif_mark_read` (`202608280008:128`) | Own notifications. |
| `mark_recovery_verified` (`202608280003:83`) | Re-reads `auth.users` for a real email+password+`email_confirmed_at`; cannot be self-certified. |
| `redeem_invite_code` (`202609030003:64`) | This *is* the pre-membership entry point. |
| `submit_report` / `admin_grant_coach(uuid)` / `add_post_comment(4-arg)` | Thin wrappers delegating to a fully gated overload (`202608280025:75`, `:421`, `202608280021:83`). |
| `can_upload_post_photo`, `can_write_own_avatar`, `club_feature_enabled`, `role_rank` | Predicate helpers with no side effect; each answers only about `auth.uid()` or about non-member config. |

I found **no** client-callable definer function with a genuinely missing guard.

## 3. Privilege-escalation trace (answer: no client-reachable path exists)

`invite_redemptions.role` is the role store (`202608280001:139`) and has **no
INSERT/UPDATE/DELETE grant to `authenticated`** — only `select`
(`202608270003:27`). Every writer:

| Writer | Gate | Cite |
|---|---|---|
| `redeem_invite_code()` shared-code branch | hardcodes literal `'member'` | `202609030003:117-127` |
| `redeem_invite_code()` per-person branch | grants the `invites` row's role, which only an **admin** could have set to `coach` | `202609030003:146-158` + `202609030008:97` |
| `admin_grant_coach(uuid,text)` | raw `profiles.is_admin` check; `p_role in ('coach','head_coach')` only | `202608280025:396-404` |
| `admin_revoke_coach()` | raw `profiles.is_admin` check | `202608280025:433-436` |
| `grant_coach_role()` / `grant_coach_role_by_handle()` | `service_role` only | `202608270006:112`, `202608270007` |

`profiles.is_admin` is pinned by the `protect_is_admin()` trigger for any
`auth.role() = 'authenticated'` session (`202608280003:67-78`), and
`profiles_insert_self` forces `is_admin = false` (`202608280003:216`). So:

- **Coach → admin: not reachable.** A coach cannot mint a coach invite either
  (`202609030008:97`), so the tier is not self-propagating.
- **Member → coach: not reachable** without an admin action.
- **Ghost → member: requires a valid invite code**, 5 attempts / 15 min per
  `auth.uid()` **and** per hashed device key, whichever is higher
  (`202609030003:92-102`; helper `bump_invite_attempt` at `202608280013:42`).
  Codes are `encode(gen_random_bytes(24),'hex')` = 192 bits (`202608270006:97`),
  so guessing is not a realistic attack; the throttle is a cost floor, and the
  migration says so itself (`202608280013:20-22`).
- `owner` (rank 60) can rewrite `roles`/`role_permissions` via RLS
  (`202608280001:265-286`) — but nothing in the shipped system can grant `owner`,
  so this is latent, not live.

## 4. Cross-club isolation (answer: there is none)

`clubs` holds exactly one seeded row (`202608280001:25-27`). `club_id` columns
exist on `profiles`, `workout_posts`, `challenges`, `weekly_recaps`,
`member_of_week` etc., **and no read or write policy anywhere filters on it.**
`club_feature_enabled()` hardcodes `default_club_id()`
(`202609010012:49-58`), as does `admin_set_club_feature()` (`:92`). The
migration states the position plainly: *"There is deliberately no multi-tenant
logic anywhere — the column exists so a second club is a data migration later
instead of a schema rewrite, and nothing reads it as a filter today"*
(`202608280001:9-11`). Consequence: the day a second `clubs` row exists, every
policy in section 1 becomes a cross-tenant read. Recorded as SEC-008.
