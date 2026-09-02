# COMM-331 Defer the community data-load cascade until the Community tab is first opened

Phase: Design sync & audit remediation (2026-09-02)
Agent: platform
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

`refreshSession()` fires unconditionally at the bottom of `cloud.js`'s top-
level IIFE (and again in `onAuthStateChange`), triggering ~16 parallel
Supabase requests (`loadProfile`, `loadFeed`, `loadStreaks`,
`loadAnnouncements`, `loadWeeklyChallenge`, etc.) on every cold boot — even
for a signed-in user who only opens the app to log a set in the training-log
tabs. This costs battery/data on every launch and contends with the offline-
first core's own IndexedDB reads.

## Acceptance criteria

- [x] Auth-session restore stays eager. (Revised: the unread-notification
  badge is community-tab-scoped, not a global header badge — see the
  second attempt below — so it did not need to stay eager after all.)
- [x] Most of the cascade is deferred until first navigation to the
  Community tab. (Revised down from "~15" to 9 of the 16 original
  loaders — see below for exactly which, and why the rest could not move
  without breaking cross-tab behavior.)
- [x] Cold boot into the add/wod/history/calendar tabs issues far fewer
  community-data requests than before. (Revised: not "0" — `loadProfile`,
  `loadRedemption`, `loadChallenges`, `loadClubFeatures` stay eager,
  bringing the boot-time request count from 16 down to ~4, not to zero.)
- [x] Opening the Community tab for the first time in a session triggers
  the remaining load cascade with no visible behavior change to the user
  once loaded — verified by the full `node --test` suite (941 tests) and a
  real Chromium pass (`scripts/browser-check`).

## Location / evidence

- `cloud.js:10252` (`refreshSession()` call site)
- `cloud.js:531-548` (cascade body: `Promise.all([loadProfile(),
  loadPermissions(), loadClubFeatures(), loadFeed(), loadStreaks(), ...])`)
- `cloud.js:10199-10220` (`onAuthStateChange`, same cascade repeated)

## Attempted and reverted, 2026-09-02

A first implementation deferred the whole cascade (including `loadProfile()`,
`loadRedemption()`, `loadPermissions()`, `loadClubFeatures()`) behind a new
`ensureCommunityDataLoaded()`, triggered from `afterRenderCommunity()`
(mirroring the existing once-per-session lazy pattern already used there for
the audit log and analytics dashboard). Running the full test suite surfaced
18 real behavioral failures, not just source-text mismatches — `node --test`
actually boots `cloud.js` in jsdom for a real subset of tests
(`community-live-sync-and-auth.test.mjs` and others), and those caught it.

Root cause: `window.isCommunitySignedIn = function () { return
!!(state.user && state.profile); }` (`cloud.js:10173`) is a **global** gate,
not a Community-tab-scoped one — it's consumed by core, cross-tab flows
triggered from the training-log tabs (PR-share prompt on `PR_CREATED`,
`syncCommunityMilestones()` on achievement unlock, etc.), not just by
`renderCommunityApp()`. Deferring `loadProfile()` behind first Community-tab
render meant `state.profile` stayed null for a member who never opened that
tab, so `isCommunitySignedIn()` never became true and every cross-tab
feature gated on it silently stopped firing — achievement claiming, PR
sharing, and more. This is exactly the failure mode a static-only reading of
the code (this ticket's original acceptance criteria) would miss: it looks
like a Community-tab-only cascade from the call site, but several of its 16
loaders gate behavior that fires from other tabs entirely.

The change was fully reverted (`refreshSession()`/`onAuthStateChange()` are
back to the original eager cascade) rather than shipped partially fixed,
given this repo is going live soon and the failure mode is silent (no error,
just a feature that stops firing).

## Before re-attempting

This needs a precise, verified map of which of the 16 loaders are truly
Community-tab-rendering-only versus which back a cross-tab gate or listener,
before deferring anything. Loaders confirmed NOT safe to defer without
further changes: `loadProfile()` (via `isCommunitySignedIn()`), and by
extension anything sequenced after it that depends on it staying eager
(`pingActivity()`, `syncCommunityMilestones()`). `loadRedemption()` is
suspect for the same reason — check what else reads `state.redemption`
before assuming it's Community-tab-only. Loaders not yet implicated by this
attempt (`loadFeed`, `loadStreaks`, `loadAnnouncements`, `loadWeeklyChallenge`,
`loadClubSummary`, `loadBlockedIds`, `loadMyAchievements`, `loadNotifPrefs`,
`loadPins`, `loadChallenges`, `loadEvents`, `loadOnboardingProgress`,
`loadPermissions`, `loadClubFeatures`) are more likely genuinely safe, but
each should be traced (`grep` every reader of the `state.*` field it sets,
and every `window.*`-exposed function that reads it) rather than assumed —
this ticket's author assumed the same thing about `loadProfile()` and was
wrong. A real browser + Playwright pass (not just `node --test`) covering a
cold boot into a core tab, then later opening Community, is the right final
verification before this ships.

## Second attempt, shipped, 2026-09-02

Traced every one of the 16 original loaders against every top-level
`window.HaimuniaEvents.on(...)` bus listener and every `window.*`-exposed
function `app.js` calls, per this ticket's own "before re-attempting"
guidance, before deferring anything.

**Kept eager** (in `refreshSession()` and `onAuthStateChange`, inside one
`Promise.all([loadProfile(), loadChallenges(), loadClubFeatures()])`
alongside `loadRedemption()`):
- `loadProfile()` — `window.isCommunitySignedIn()` reads `state.profile`
  and gates the PR-share prompt (`onPrCreated`) and achievement claiming
  (`syncCommunityMilestones()` → `claimCommunityAchievements()`), both
  triggered from saves on the core training-log tabs, not just Community.
- `loadRedemption()` — cheap, kept alongside profile rather than proven
  independently safe to defer.
- `loadChallenges()` — `onPrCreatedForChallenges()` (a second listener on
  the same `PR_CREATED` event) reads `state.challenges`/
  `state.challengeParticipation` to auto-log a challenge delta from a
  core-tab PR.
- `loadClubFeatures()` — not independently required by any cross-tab
  consumer, but `isModuleEnabled()` defaults every module "on" until its
  own row loads. With challenges data eager but the feature gate still
  pending, a module the club had actually turned off would render for the
  gap between the two — caught by a real test
  (`community-club-features.test.mjs`), not static analysis. Loading both
  together closes the gap instead of leaving a visible flash to
  self-correct.
- `pingActivity()`, the `syncCommunityMilestones()` trigger, `flushOutbox()`
  /`pullPrivateRecords()` (private backup sync — a separate feature from
  Community, unrelated to this ticket either way).

**Deferred** into a new `ensureCommunityDataLoaded()`, triggered from
`afterRenderCommunity()` (the same once-per-session lazy pattern already
used there for the audit log and analytics dashboard): `loadPermissions`,
`loadFeed`, `loadStreaks`, `loadAnnouncements`, `loadWeeklyChallenge`,
`loadClubSummary`, `loadBlockedIds`, `loadMyAchievements`, `loadNotifUnread`,
`loadNotifPrefs`, `loadPins`, `loadEvents`, `loadOnboardingProgress`, the
staff-only loaders, and `loadModQueue` — plus `ensureNotifRealtime()` and
the pending-push-deep-link consumption, both confirmed community-tab-only.

**A second real bug found only by running a real browser**, not
`node --test` (jsdom doesn't execute service workers or load real network
requests the way Chromium does): `ensureCommunityDataLoaded()` also had to
be gated on `state.profile.recovery_verified_at`, not just `state.user`.
`renderCommunityApp()` returns the COMM-016 recovery gate's own content and
nothing else while verification is pending, so there is no UI yet for any
of the deferred cascade to feed — but running it anyway raced
`loadFeed()`'s `state.message = ""` reset (on success) against
`verifyRecovery()`'s own failure message on the exact same field. Whichever
finished last silently won, so a real verification failure could show no
error at all depending on timing — caught by
`community-recovery-method.test.mjs` failing under full-suite load, not in
isolation.

**Verification**: full `node --test` suite green (941 tests, 940 pass / 1
pre-existing skip / 0 fail) after every fix above, plus a full
`scripts/browser-check` Chromium pass (see COMM-333, which this ticket's
work also exercised indirectly via the nav and mock-cloud fixes made
alongside it).

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
