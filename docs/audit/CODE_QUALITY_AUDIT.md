# Code quality audit — post-2026-09-02 additions

Production-readiness audit, code-quality stream. Scope: the 25 migration slugs
added after the 2026-09-02 cross-repo audit and their client halves in
`cloud.js`. **Authorization / RLS correctness is owned by a separate parallel
stream.** Findings below concern client logic, error handling, race conditions,
loading/error UI, and DOM-injection safety — never whether a policy is right.

Finding IDs: `CQ-NNN`. Status is `open` for all.

---

## 0. Headline

Overall the reviewed code is **unusually disciplined**: near-universal `{ error }`
destructuring, explicit skeleton/error/empty/populated state machines, optimistic
writes paired with rollback, and long inline rationale comments that are accurate
far more often than not.

**Escaping is clean.** A full scan of every `${…}` interpolation in `cloud.js`
that lands in an HTML sink found **zero** unescaped untrusted values. Newer code
uses the shared helper (`esc` reaches `cloud.js` via `window.BoxLogSafe`, per
`src/shared/safe-helpers.js:30-33`); the duplicate `safeText()` that COMM-367
removed has not crept back. The three interpolations that at first look raw
(`cloud.js:1709`, `:7350`, `:8843`) all build **plain-text post/comment bodies**
sent to the server, not HTML — and where the same value is later rendered it is
escaped (`cloud.js:7355` `${esc(what)}`).

**Of the 25 reviewed slugs: 17 are clean, 8 carry a real defect.** Two of those
(`report_profile_target`) are user-visible bugs in a shipped moderation flow.

---

## 1. Per-feature verdict

| # | Migration slug | Client code | Verdict |
|---|---|---|---|
| 1 | `202609030001_person_invites` | `renderPersonInvitesPanel()` 2571, `createInvite()` 2489, `revokeInvite()` 2515 | **Clean** |
| 2 | `202609030002_shared_code_admin` | `renderSharedCodesPanel()` 2530, `loadInviteCodes()` 2396, `createInviteCode()` 2406, `setInviteCodeActive()` 2437 | **Clean** |
| 3 | `202609030003_redeem_person_invite` | `redeemCode()` 1088 | **Clean** (see CQ-006 for the adjacent `loadRedemption()`) |
| 4 | `202609030004_onboarding_step_content` | `loadOnboardingStepContent()` 972, `saveOnboardingContent()` 1403, `renderOnboardingContentEditor()` 1434 | **Clean — exemplary.** The only save path in the file that does an honest read-back to detect a silently-dropped RLS UPDATE (`cloud.js:1420-1431`) |
| 5 | `202609030005_member_roster` | `loadRoster()` 5255, `renderMemberRoster()` 5281 | **Clean.** Pagination gap is real but documented in place (`cloud.js:5266-5279`) |
| 6 | `202609030006_registration_funnel` | `loadRegistrationFunnel()` 2840, `renderRegistrationFunnel()` 5677 | **Clean** |
| 7 | `202609030007_fix_admin_search_members_ambiguity` | — | **Clean**, no client change needed |
| 8 | `202609030008_invite_create_coach_role_requires_admin` | `createInvite()` 2489, radio gate 2587 | **Clean.** Client mirrors the server narrowing and says so (`cloud.js:2493-2496`) |
| 9 | `202609010010_avatar_photo` | `uploadAvatarPhoto()` 9067, `saveAvatarUrl()` 9105, `avatarPhotoSelected()` 9117 | **Defect — CQ-004** (+ minor CQ-004b) |
| 10 | `202609010011_member_roles` | `loadMemberRoles()` 3546 | **Defect — CQ-003** |
| 11 | `202609010012_club_features` | `loadClubFeatures()` 664, `isModuleEnabled()` 678, `toggleClubFeature()` 4127 | **Clean.** Optimistic toggle with correct rollback |
| 12 | `202609010013_admin_search_members_avatar` | `memberManagementRowHtml()` 5211 | **Clean** |
| 13 | `202609050001_password_reset_audit_label` | `adminResetPassword()` 3058, audit labels 5136/5154 | **Clean** |
| 14 | `202609050002_report_profile_target` | `reportProfile()` 4005, mod queue 5079 | **Defects — CQ-001, CQ-002** |
| 15 | `202609050003_report_admin_alert` | — (server trigger → existing notification stream) | **Clean**, no client change needed |
| 16 | `202609050004_event_map_link_scheme` | `saveEvent()` ~8169, render 8509 | **Defect (low) — CQ-005** |
| 17 | `202609050005_scheduled_jobs` | — (no client surface) | **Stale comment — CQ-011.** Feature gaps tracked as FEAT-004/005/007/010 |
| 18 | `202609050006_club_modules_coach_and_directory` | `COACH_MODULE_TOGGLES` 647, `renderClubModulesPanel()` 5318 | **Clean.** All 11 keys match the seeded rows exactly |
| 19 | `202609050007_intro_carousel_content` | `loadIntroCarouselContent()` 994, `renderIntroCarousel()` 1051, `saveIntroCarouselContent()` 1479 | **Clean.** Same read-back discipline as #4 |
| 20 | `202609060001_anonymous_read_gate` | — (schema-only) | **Clean** — parallel stream owns |
| 21 | `202609060002_community_streaks_privacy` | `loadStreaks()` 1146 | **Clean** — parallel stream owns |
| 22 | `202609060003_avatar_bucket_private` | `avatarHtml()` 739, `resolveAvatarUrl()` 3096, `avatarUrlCache` 549 | **Defect — CQ-004** |
| 23 | `202609060004_post_type_privilege_guard` | POST_COACH promotion 1738, 1968 | **Defect — CQ-007** |
| 24 | `202609060005_challenge_write_boundaries` | `setWeeklyChallenge()` 1614 | **Defect (low) — CQ-008** |
| 25 | `202609060006_profiles_avatar_url_scheme` | `uploadAvatarPhoto()` return 9100 | **Clean.** The `getPublicUrl()`-as-identifier decision is deliberate and documented at `cloud.js:9084-9099` |
| 26 | `202609060007_post_edit_rpcs` | `postSaveCaption()` 9302, `postApplyVisibility()` 9320 | **Defect — CQ-009** |
| 27 | `202609060008_attendance_achievement_copy` | (definitions rendered generically) | **Clean**, no client change needed |
| 28 | `202609060009_definer_read_gate` | — (schema-only) | **Clean** — parallel stream owns |
| 29 | `202609060010_feed_interaction_session_scope` | `trackFeedInteraction()` 3289 | **Clean.** `p_feed_session_id` threaded correctly and commented (`cloud.js:3292-3295`) |

*(29 files, 25 distinct feature slugs — the prompt's "24" undercounts by one; the
extra is `202609030002_shared_code_admin`, folded into the `person_invites`
group.)*

Cross-cutting findings that are not attributable to one slug: **CQ-006, CQ-010,
CQ-012, CQ-013, CQ-014**.

---

## 2. Findings

### CQ-001 — A reported profile is labelled "post" in the moderation queue and the context sheet
- **Category:** logic error (unhandled enum branch)
- **Priority:** P1
- **File:** `cloud.js:5097`, `cloud.js:10980`
- **Evidence:** `202609050002_report_profile_target.sql:78` widened `reports.target_type` to `('post', 'comment', 'profile')` and taught `mod_queue()` to return profile rows (`:205-212`, `:245`). The client renders the target kind with a **two-way ternary** that predates the widening:
  ```js
  // cloud.js:5097  (mod queue row)
  <div style="font-weight:800;">${esc(r.target_type === "comment" ? "תגובה" : "פוסט")} · …
  // cloud.js:10980 (mod context overlay)
  <div …>${esc(c.target_type === "comment" ? "תגובה" : "פוסט")} מאת …
  ```
  A `profile` row therefore falls into the `else` and is labelled **"פוסט"** (post). `pinTargetLabel()` and `auditTargetLabel()` (`cloud.js:5139-5153`) *do* carry a full mapping, so the pattern for doing this correctly already exists in the same file.
- **Impact:** the moderator sees "פוסט · <member name>" with the member's own display name + bio as the "post excerpt" (which is what the migration puts in `content_excerpt`, `:205-212`). They are being asked to judge a post that does not exist. Wrong moderation decisions follow directly from the wrong label.
- **Proposed fix:** replace both ternaries with a `MOD_TARGET_LABEL = { post: "פוסט", comment: "תגובה", profile: "פרופיל" }` lookup, in the same shape as `MOD_STATUS_LABEL` two lines below (`cloud.js:5099`).
- **Status:** open

---

### CQ-002 — The moderation queue offers "remove content" on a profile report, which the server always rejects
- **Category:** logic error / dead-end UI
- **Priority:** P1
- **File:** `cloud.js:5107-5109` (button list), `cloud.js:2264-2270` (`MOD_DECISIONS`), `cloud.js:2304-2328` (`runModAction`)
- **Evidence:** `mod_review()` raises unconditionally for a profile target with the `remove` decision:
  > `202609050002_report_profile_target.sql:316` — `raise exception 'a profile report has no content to remove';`
  (also stated in the function comment at `:346`). The client renders every one of the five `MOD_DECISIONS` for every row regardless of `target_type`:
  ```js
  // cloud.js:5107-5109
  ${done ? "" : MOD_DECISIONS.map((d) =>
    `<button class="chip-btn${d.destructive ? " danger" : ""}" data-community-action="mod-action" …>${d.label}</button>`).join("")}
  ```
  and `runModAction()` collapses the raise into a generic retry message:
  ```js
  // cloud.js:2312-2317
  if (error) { a.saving = false; a.error = "לא ניתן היה להשלים את הפעולה. נסו שוב."; rerender(); return; }
  ```
  The message says "try again"; retrying can never succeed.
- **Impact:** the destructive-styled, most prominent action on a profile report is a guaranteed failure presented as a transient one. `state.admin.modAction.targetType` is **already captured** at `cloud.js:2301` for exactly this kind of branch, so the information needed to fix it is one line away.
- **Proposed fix:** filter `MOD_DECISIONS` by target type in the row renderer (`d.id !== "remove" || r.target_type !== "profile"`), and add `'a profile report has no content to remove'` to a named-error map in `runModAction` as a defensive second layer, matching the named-error maps already used at `cloud.js:2389`, `:2481`, `:2831`.
- **Status:** open

---

### CQ-003 — `loadMemberRoles()` ignores the RPC error and permanently caches "not a coach"
- **Category:** missing error handling + cache poisoning
- **Priority:** P1
- **File:** `cloud.js:3546-3553`
- **Evidence:**
  ```js
  async function loadMemberRoles(ids) {
    const need = [];
    for (const id of ids || []) if (id && !(id in state.members.roles)) need.push(id);
    if (!need.length) return;
    for (const id of need) state.members.roles[id] = null;     // pre-seed as "no role"
    const { data } = await client.rpc("member_roles", { p_ids: need });   // ← error dropped
    for (const r of (data || [])) state.members.roles[r.user_id] = r.role || null;
  }
  ```
  This is the **only** `.rpc()` call in the reviewed set that does not destructure `error`. The pre-seed at line 3550 is what makes it worse than a plain silent failure: on error, `data` is `null`, the loop does nothing, and every requested id is left at `null`. The `if (id in state.members.roles)` guard on the next call means those ids are **never retried for the rest of the session**.
- **Impact:** one transient failure of `member_roles(uuid[])` — a network blip, a cold function, a rate limit — permanently strips the coach badge from every member in that batch, on every surface (feed post authors, comment authors, profile headers, people search, the member directory), until a full reload. This is the exact class of silent-wrongness that `202609010011_member_roles.sql:8-20` was written to fix; the fix restored the data path but left the failure path unobservable. The migration header even notes the original bug was *"Invisible to this repo's own tests, because `mockSupabase.mjs`'s plain `.from()` reads carry no RLS simulation"* — and this failure mode is invisible for the same reason.
- **Proposed fix:** destructure `error`; on error, `delete state.members.roles[id]` for each id in `need` so the next render retries, matching how `resolveAvatarUrl()` (`cloud.js:3096-3105`) deliberately leaves a failed lookup uncached and explains why at `:3091-3094`.
- **Status:** open

---

### CQ-004 — Signed avatar/photo URLs are cached for the session but expire after one hour
- **Category:** logic error (TTL mismatch)
- **Priority:** P2
- **File:** `cloud.js:3096-3105` (`resolveAvatarUrl`), `cloud.js:3106-3110` (`resolvePhotoUrl`), caches declared at `cloud.js:543`, `:549`
- **Evidence:** both resolvers sign for **3600 seconds** and store the result in a plain object with no timestamp:
  ```js
  const { data, error } = await client.storage.from("avatar-photos").createSignedUrl(path, 3600);
  …
  if (!error && data && data.signedUrl) { avatarUrlCache[storedUrl] = data.signedUrl; rerender(); }
  ```
  Re-entry is short-circuited on the first line (`if (!storedUrl || avatarUrlCache[storedUrl] || avatarInFlight[storedUrl]) return;`), so a cached entry is never refreshed. `photoUrlCache` (`cloud.js:3106`) has the identical shape. Nothing clears either cache — grep for `avatarUrlCache` / `photoUrlCache` shows only the declaration, the read and the one write.
- **Impact:** this is an installed PWA whose sessions routinely outlive an hour. After 60 minutes every avatar and every feed photo the member has already scrolled past renders as a broken image, with no retry and no fallback to the initials badge (the initials path is only taken when the cache is *empty*, `cloud.js:757-769`). The longer the session, the more of the feed is broken.
- **Proposed fix:** store `{ url, expiresAt }` and treat an entry within ~5 minutes of expiry as a miss; on an `<img>` `error` event, evict the entry so the next render re-signs.
- **Status:** open

### CQ-004b — `saveAvatarUrl()` has no read-back, unlike its two sibling editors
- **Category:** missing error handling (minor)
- **Priority:** P3
- **File:** `cloud.js:9105-9113`
- **Evidence:** `saveAvatarUrl()` optimistically sets `state.profile.avatar_url`, writes with `client.from("profiles").upsert(…)` and rolls back only on `error`. `saveOnboardingContent()` (`cloud.js:1420-1431`) and `saveIntroCarouselContent()` (`cloud.js:1496-1506`) both document that *"a refused UPDATE against this table never raises — a failing RLS USING clause on UPDATE just matches zero rows"* and add a read-back for exactly that reason. The avatar path does not.
- **Impact:** low today (the profiles self-update policy will match), but the codebase has established a rule and this one write silently opts out of it. If the profiles policy is ever narrowed, the failure is invisible.
- **Proposed fix:** either add the read-back, or add a one-line comment saying why this table's self-update is exempt.
- **Status:** open

---

### CQ-005 — `map_link` is validated only by the database; a bad scheme surfaces as a generic save failure
- **Category:** missing client validation / poor error UI
- **Priority:** P3
- **File:** `cloud.js:8169` (save), `cloud.js:8509` (render)
- **Evidence:** `202609050004_event_map_link_scheme.sql` added a scheme CHECK to `events.map_link` (previously any 500 characters, which admitted `javascript:` and `data:text/html`). The client sends the raw field (`cloud.js:8169` `map_link: mapLink || null`) with no scheme check, and every other field in `saveEvent()` *does* get inline validation. Rendering is safe — `href="${esc(e.map_link)}"` at `cloud.js:8509` plus `rel="noopener noreferrer"` — and the DB CHECK is the real boundary, so **this is not a security finding**; it is a UX one.
- **Impact:** a coach who pastes something the CHECK refuses gets whatever generic save-failure copy the event form shows, with no indication that the map link is the problem. The event form's other fields all name their own error.
- **Proposed fix:** add a `^https?://` test alongside the form's existing per-field validation, with a named error on the map-link field.
- **Status:** open

---

### CQ-006 — `loadProfile()` and `loadRedemption()` swallow their errors, so a transient failure re-runs new-member onboarding on an existing member
- **Category:** missing error handling → user-visible regression
- **Priority:** P1
- **File:** `cloud.js:944-957`, consumed at `cloud.js:11040`, `:11048`, `:11056`
- **Evidence:** both loaders drop `error` and collapse "failed" into "absent":
  ```js
  // cloud.js:946
  const { data } = await client.from("profiles").select(PROFILE_COLUMNS).eq("id", state.user.id).maybeSingle();
  state.profile = data || null;
  // cloud.js:954
  const { data } = await client.from("invite_redemptions").select("invite_id,role,redeemed_at").eq("user_id", state.user.id).maybeSingle();
  state.redemption = data || null;
  ```
  The three gates that follow read `state.profile` as ground truth for "has this member joined yet":
  ```js
  // cloud.js:11040
  if (!state.profile && !hasSeenIntroCarousel()) return renderIntroCarousel();
  // cloud.js:11048
  if (!state.profile) return `…השלמת פרופיל… <form id="communityProfile">…`;
  ```
  Every sibling loader in the file distinguishes the two states — `loadOnboardingStepContent()` (`:975`), `loadIntroCarouselContent()` (`:997`), `loadClubFeatures()` (`:667`), `loadPermissions()` (`:658`) all branch on `error` — so these two are the outliers, not the convention.
- **Impact:** a returning member on a flaky connection is shown the **first-run intro carousel** and then an **unskippable "complete your profile" form**. Submitting it attempts to create a profile that already exists. `loadRedemption()`'s failure is the same shape one gate up: an existing member is asked to redeem an invite code again. The intro carousel makes this materially worse than before it shipped, because the carousel also writes the per-device `seenIntroCarousel` flag (`cloud.js:1027`) on completion.
- **Proposed fix:** track a load-failure flag on each (`state.profileLoadError`, `state.redemptionLoadError`) and render a retry state instead of the join funnel when it is set — the same three-way skeleton/error/populated switch used everywhere else in the file.
- **Status:** open

---

### CQ-007 — Coach "celebrate"/"welcome" posts leave an orphaned plain post when the POST_COACH promotion fails
- **Category:** race condition / partial failure with no reconciliation
- **Priority:** P2
- **File:** `cloud.js:1735-1742`, `cloud.js:1965-1972`
- **Evidence:** both paths are two non-atomic writes — create, then promote:
  ```js
  // cloud.js:1736-1740
  const { data: postId, error } = await client.rpc("post_create", { body, visibility: "club", media: [], links: null });
  if (!error && postId) {
    const { error: updErr } = await client.from("workout_posts").update({ post_type: "POST_COACH" }).eq("id", postId);
    ok = !updErr;
  }
  ```
  On `updErr` the client sets `ok = false` and shows *"לא ניתן היה לשלוח ברכה. נסו שוב."* (`cloud.js:1749`) — but the `POST_TEXT` post created by the first call is **never deleted and never mentioned**. `post_delete()` exists and is already wired at `cloud.js:9332`.
  `202609060004_post_type_privilege_guard.sql` added a BEFORE-UPDATE trigger on this exact column, giving the second write a new way to fail (it raises `'post type is staff only'`, `:109`). The guard's predicate matches the client's `isStaff()`, so the *authorization* case is aligned — but a network failure or a rate limit between the two calls produces the same split.
- **Impact:** the coach is told the greeting failed and retries; the club feed now carries two identical congratulation posts, both styled as ordinary member posts rather than coach posts. Because `congratulated[key]` is only set on success (`cloud.js:1748`), nothing prevents the repeat.
- **Proposed fix:** on `updErr`, call `post_delete(postId)` before reporting failure, so the operation is all-or-nothing from the member's point of view. The migration's own header (`:58-61`) notes these two client writes as the legitimate POST_COACH producers — worth folding them into a single server-side RPC instead.
- **Status:** open

---

### CQ-008 — Weekly-challenge form is client-gated on `isStaff()` while the server now checks `has_perm('community.challenge.create')`
- **Category:** client/server gate drift
- **Priority:** P3
- **File:** `cloud.js:1615`
- **Evidence:** `202609060005_challenge_write_boundaries.sql:9-17` replaced `weekly_challenges_insert_admin`'s `is_staff()` check with `has_perm('community.challenge.create')`, arguing that `is_staff()` (role_rank ≥ 20 → coach/head_coach/**staff**/admin/owner) is wider than the permission's seeded holders. The client still gates on `isStaff()`:
  ```js
  async function setWeeklyChallenge(form) {
    if (!state.user || !isStaff()) return;
  ```
  Today this is harmless: `isStaff()` (`cloud.js:695`) resolves to `is_admin || role in ('coach','head_coach')`, and all three of those hold `community.challenge.create` per the seed at `202608280001_clubs_and_rbac.sql:86, 92, 107`. The `staff` role (rank 40) that motivated the migration is not reachable through the client's `isStaff()` at all.
  Note the same file gates the *challenge* UI correctly — `hasPerm(PERM.CHALLENGE_CREATE)` at `cloud.js:7318`, `:7841`, `:7934`. Only the legacy `weekly_challenges` form was missed.
- **Impact:** none observable today; it is latent drift. The moment a `staff`-rank member can sign in, they see a weekly-challenge form whose submit fails with the generic *"קביעת האתגר נכשלה"* (`cloud.js:1633`).
- **Proposed fix:** change line 1615 to `!(hasPerm(PERM.CHALLENGE_CREATE) || isAdmin())`, matching the three sibling call sites.
- **Status:** open

---

### CQ-009 — `postSaveCaption()` / `postApplyVisibility()` have no in-flight guard and no loading state
- **Category:** race condition + missing loading UI
- **Priority:** P2
- **File:** `cloud.js:9301-9330`
- **Evidence:** both handlers `await` an RPC with no `saving` flag, no button disable, and no re-entry guard:
  ```js
  async function postSaveCaption() {
    const e = state.posts.captionEdit;
    if (!e) return;
    const body = cleanPostBody(e.body);
    const { error } = await client.rpc("post_edit_caption", { post_id: e.postId, body });
    …
  ```
  Every comparable write in the file carries one — `state.admin.inviteCodes.busy` (`cloud.js:2437`), `state.admin.invites.revoking` (`:2515`), `removeMemberBusy` (`:3040`), `resetPasswordBusy` (`:3057`), `state.coach.celebrate.busy` (`:1727`), `e.saving[step]` (`:1406`).
- **Impact:** a double-tap on a slow connection fires two `post_edit_caption` calls; the second may land after the first and, if the member edited between renders, the newer text can be overwritten by the older. The member gets no feedback at all between tap and completion. This is the newest pair of RPCs in the file (`202609060007`, shipped 2026-09-06) and the only pair to skip the convention.
- **Proposed fix:** add `state.posts.captionEdit.saving` / `visibilityEdit.saving`, guard re-entry, and disable the buttons — the shape `saveOnboardingContent()` already uses at `cloud.js:1405-1413`.
- **Status:** open

---

### CQ-010 — Keyboard focus is lost after Arrow-key navigation on the Community and Manage sub-tab bars
- **Category:** accessibility regression
- **Priority:** P2
- **File:** `cloud.js:11328` (Community `.subtabbar`), `cloud.js:11414` (Manage `.subtabbar`), handler at `app.js:3785-3793`
- **Evidence:** COMM-358's shared roving-tabindex handler restores focus after the click by **re-finding the tablist by id**, because a click here re-renders:
  ```js
  // app.js:3785-3793
  // The click above may fully re-render the tablist's own container
  // (bottomTabBar/communityFeedFilters do; …) - re-find "the now-selected tab"
  // inside the same container by id rather than trusting `next` is still the live node
  const container = tablist.id ? document.getElementById(tablist.id) : tablist;
  const selected = container && container.querySelector('[role="tab"][aria-selected="true"]');
  if (selected) selected.focus();
  ```
  The two tablists that COMM-327/the redesign added **have no `id`**:
  ```js
  // cloud.js:11328
  const tabBar = `<div class="subtabbar" role="tablist">${tabs.map(…)}</div>`;
  // cloud.js:11414
  const manageTabBar = `<div class="subtabbar" role="tablist">${manageTabs.map(…)}</div>`;
  ```
  and `setCommunityTab()` / `setManageTab()` both call `rerender()` → `window.render()` → full `innerHTML` replacement of the tab content (`app.js:3294-3297`). So `tablist` is a detached node by the time line 3791 runs; the fallback branch queries the detached subtree, finds the *stale* selected tab, and `.focus()` on a detached element is a no-op. The two tablists that **do** have ids (`bottomTabBar` in `index.html:845`, `communityFeedFilters` in `cloud.js:11139`) work correctly.
- **Impact:** a keyboard or screen-reader user who Arrow-keys across Community's (up to) 5 sub-tabs or Manage's 7 lands on `document.body` after each move, losing their place entirely. This is the specific failure the handler's own comment was written to prevent, and it regressed when the two new bars were added without ids. `test/tablist-keyboard.test.mjs` did not catch it — as `backlog.md:3826-3830` notes about a sibling case, it computes "the last tab" from a live query and kept passing.
- **Proposed fix:** give both bars an `id` (`communitySubTabs`, `manageSubTabs`). Add a regression test asserting `document.activeElement` is the newly-selected tab after an ArrowRight on each bar.
- **Status:** open

---

### CQ-011 — Stale comments claiming "there is no scheduler yet", contradicted by `202609050005`
- **Category:** misleading documentation
- **Priority:** P3
- **File:** `cloud.js:536`, `cloud.js:6040`; also `202608310006_personalized_feed_weights.sql:533`
- **Evidence:** `202609050005_scheduled_jobs.sql` installed `pg_cron` and scheduled eight jobs (`:252-306`). Three comments still assert the opposite:
  - `cloud.js:535-537` — *"null means no month has ever been generated (there is no scheduler yet — see the migration's own note …)"* — `recap_monthly` **is** scheduled (`:257`).
  - `cloud.js:6040` — *"'no scheduler wired yet' is the expected common case until one exists"* — a scheduler exists; `community_health_generate()` was simply omitted from it (**FEAT-004**).
  - `202608310006:533` — *"Nothing schedules it"* about `recompute_feed_weights()`, which **is** scheduled (`:263`) — but as a no-op stub (**FEAT-010**).
  Note `cloud.js:7573-7580` was already corrected in the same pass and reads accurately, which shows the sweep was started and not finished.
- **Impact:** the comments make two genuine feature gaps (FEAT-004, FEAT-010) look like known, expected, pending states rather than omissions.
- **Proposed fix:** finish the sweep started at `cloud.js:7573`.
- **Status:** open

---

### CQ-012 — `renderManageApp()` builds all seven sub-tabs on every render and discards six
- **Category:** performance
- **Priority:** P2
- **File:** `cloud.js:11392-11411`
- **Evidence:** the sub-tab array is built with every `html` field **eagerly evaluated**, then one is selected:
  ```js
  const manageTabs = [
    { id: "dashboard",  label: "דשבורד",   html: renderManageDashboard() },
    { id: "members",    label: "חברים",    html: renderMemberManagement() + renderMemberRoster() },
    { id: "onboarding", label: "קליטה",    html: renderOnboardingContentEditor() + renderIntroCarouselContentEditor() },
    { id: "moderation", label: "מודרציה",  html: renderModeration() + renderAuditLog(), badge: pendingModerationCount() },
    { id: "settings",   label: "הגדרות",   html: renderClubModulesPanel() || … },
    { id: "analytics",  label: "אנליטיקס", html: (renderAdminAnalyticsDashboard() + renderRetentionCorrelations()) || … },
    { id: "invites",    label: "הזמנות",   html: renderInviteManagement() },
  ];
  const activeManageTab = manageTabs.find((t) => t.id === state.ui.manageTab) || manageTabs[0];
  ```
  `renderAdminAnalyticsDashboard()` alone composes ~20 sub-renderers (`cloud.js:5389-5560`); `renderMemberRoster()` maps the full accumulated roster; `renderAuditLog()` maps the full audit page. The Community tab beside it does the same thing but is at least bounded by its own sub-tab count. Both run on **every** `rerender()`, and `rerender()` fires on every reaction, comment, toast, signed-URL resolution and realtime event.
- **Impact:** an admin with a loaded roster, audit log and analytics period pays the cost of rendering all of it on every single state change, six-sevenths of it thrown away. `cloud.js:11365` shows the team already hit a related class of problem in this function.
- **Proposed fix:** make `html` a thunk (`html: () => renderManageDashboard()`) and invoke only `activeManageTab.html()`. `badge` must stay eager (it feeds the tab bar). This is a mechanical, low-risk change. `docs/community/2026-09-03-render-architecture-spike.md` (COMM-366) is the broader version of this problem; this is the cheap local win.
- **Status:** open

---

### CQ-013 — The post composer collapses every `post_create` failure into one generic message
- **Category:** missing error UI
- **Priority:** P2
- **File:** `cloud.js:9188-9192`
- **Evidence:**
  ```js
  if (error || !data) {
    c.publishing = false;
    c.error = "פרסום הפוסט נכשל, אפשר לנסות שוב";
    return rerender();
  }
  ```
  The **comment** path in the same file does the opposite — `commentErrorMessage()` (`cloud.js:3567-3570`) names the real cause: `if (msg === "posting_restricted") return "החשבון שלכם מוגבל כרגע משליחת תגובות";` — and `comment_edit` does the same at `:3697`. `post_create` can raise `posting_restricted` (`202608280015_posting_restrictions.sql`, enforcement point 1) and `rate_limited`, and neither reaches the member.
- **Impact:** a restricted member is told to "try again", forever, with no hint that they have been restricted — and (per **FEAT-006**) no admin UI exists to lift the restriction either. A rate-limited member is told the same. The advice given is actively wrong in both cases.
- **Proposed fix:** reuse `commentErrorMessage()`'s named-error map for the post path.
- **Status:** open

---

### CQ-014 — `postHide()` removes the post optimistically and never restores it on failure
- **Category:** optimistic update with no reconciliation
- **Priority:** P3
- **File:** `cloud.js:9285-9293`
- **Evidence:**
  ```js
  async function postHide(postId) {
    if (!state.user) return;
    state.posts.openMenu = null;
    if (Array.isArray(state.feed.items)) state.feed.items = state.feed.items.filter((p) => p && p.id !== postId);
    rerender();
    const { error } = await client.from("hidden_posts").insert({ user_id: state.user.id, post_id: postId });
    if (error && error.code !== "23505") setMessage("לא ניתן להסתיר את הפוסט");
    else setMessage("הפוסט הוסתר מהפיד שלך");
  }
  ```
  The item is dropped from `state.feed.items` before the write and never re-inserted. Compare `postSave()` immediately above (`cloud.js:9278-9282`), which **does** roll back (`delete state.posts.savedIds[postId]`), and `toggleClubFeature()` / `savePrivacyField()` (`cloud.js:4127`, `:4114`), which both restore the previous value.
- **Impact:** the member is told hiding failed while the post is already gone from their view; the next feed refresh brings it back, so the UI contradicts itself twice. Low severity (nothing is lost) but it is the one optimistic write in the file without the rollback its neighbours all have.
- **Proposed fix:** capture the removed item and its index, and splice it back on a non-23505 error.
- **Status:** open

---

## 3. Test coverage for the reviewed features (step 5)

pgTAP coverage is **complete**: every one of the 25 slugs has a matching file in
`supabase/tests/` (`0055_club_features` … `0076_feed_interaction_session_scope`),
and `.github/workflows/test.yml`'s `migration-check` job runs `supabase test db`
as a hard gate. The gaps below are all in the **node/jsdom client suite**.

| Slug | `test/*.test.mjs` | Verdict |
|---|---|---|
| person_invites / shared_code_admin / redeem_person_invite | `community-person-invite-redemption`, `community-invite-code-management`, `community-actor-throttle` | Covered |
| onboarding_step_content | `community-onboarding-content-editor` | Covered |
| member_roster | `community-member-roster` | Covered |
| registration_funnel | `community-registration-funnel` | Covered |
| avatar_photo / avatar_bucket_private / profiles_avatar_url_scheme | `community-avatar-photo`, `community-avatar-upload` (asserts `createSignedUrl`) | Covered |
| club_features / club_modules_coach_and_directory | `community-club-features` (pins all 11 keys, `:18`, `:63-64`, `:170`) | Covered |
| admin_search_members_avatar | `community-admin-member-management`, `community-member-roster` | Covered |
| intro_carousel_content | `community-intro-carousel` | Covered |
| feed_interaction_session_scope | `community-feed-client:267-283` | Covered |
| attendance_achievement_copy | `community-achievement-engine:194-200` | Covered |
| post_edit_rpcs | `community-post-actions` | Covered |
| report_admin_alert | `community-notifications` | Covered |
| password_reset_audit_label | `community-moderation:352-394` (audit label + filter chip) | **Partial** — the label is tested; `adminResetPassword()` (`cloud.js:3058`), the Edge-Function invoke and the one-time password reveal are not |
| event_map_link_scheme | `community-events:166` — `map_link` appears **only as fixture data** | **Partial** — no test of the href render or the scheme boundary |
| **member_roles** | none (`member_roles` appears only in `test/helpers/mockSupabase.mjs`) | **MISSING** — and this is where CQ-003 lives |
| **report_profile_target** | none (`report-profile` / `reportProfile` return zero hits across `test/`) | **MISSING** — and this is where CQ-001 and CQ-002 live |
| scheduled_jobs | none | Missing, but **acceptable**: no client surface. pgTAP `0063` covers it |
| anonymous_read_gate / community_streaks_privacy / post_type_privilege_guard / challenge_write_boundaries / definer_read_gate | none | Missing, but **acceptable**: schema-only RLS hardening owned by the parallel stream; pgTAP `0067`/`0068`/`0070`/`0071`/`0075` cover them |

**Two features with a real client surface have no node test at all: `member_roles`
and `report_profile_target`.** Both are exactly where the three highest-priority
findings in this document (CQ-001, CQ-002, CQ-003) turned out to be — the absence
of a test and the presence of the bug are the same fact.

---

## Summary counts

- **Reviewed:** 25 feature slugs across 29 migration files.
- **Clean:** 17. **Carrying a real defect:** 8.
- **Findings:** CQ-001 … CQ-014 (15 including CQ-004b) — 3×P1, 7×P2, 5×P3.
- **Escaping / `innerHTML` safety:** zero findings. Newer code uses the shared `esc()` correctly throughout.
- **Missing node test files (client-surface features):** 2 — `member_roles`, `report_profile_target`. Partial: 2 — `password_reset_audit_label`, `event_map_link_scheme`.
- **pgTAP coverage:** 25/25, run as a hard CI gate.
