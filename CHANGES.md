## Capped the announcements archive, the second real "feed too long" contributor — 2026-09-11

Follow-up to the club-WOD toggle fix: the previous entry named a second, separate
contributor to feed length and deliberately held off on it pending confirmation -
the announcements archive below the feed rendered every live announcement in full
(up to 20, `announcements_read`'s own query cap), no collapse. Told to fix it.

The most recent `ANNOUNCEMENTS_ARCHIVE_VISIBLE` (3) still render as before; the rest
sit behind a `<details>` disclosure ("עוד הודעות (N)"), the same pattern
`renderAuditLog()`'s own "עוד סינונים" already uses - nothing is hidden, only
de-prioritized past the first screenful.

**Caught before shipping, not after**: a closed `<details>` collapses its content to
zero height, and `navigateToNotifTarget`'s `target.announcement` branch only ever
called `scrollIntoView` - a notification deep-linking into an archived (4th-or-older)
announcement would have scrolled to an invisible target, silently. Fixed by opening
the disclosure before scrolling. A new test seeds 4 announcements specifically to put
the deep-linked one past the cap and proves the disclosure opens, not just that the
node exists in the DOM.

Verified: new tests in `community-notifications.test.mjs` (the cap + the deep-link
fix) and `community-club-wod-board.test.mjs`/`community-club-features.test.mjs`
(unaffected, re-run for confidence), full suite 1606/1606, and a direct visual check
(real Chromium) of the collapsed and expanded states.

## Security hunt, round 4: moderation bypass, client-side tampering, and resource exhaustion — 2026-09-11

Three more independent agents: moderation/abuse-bypass, client-side data tampering, and
resource exhaustion from malicious input.

**Client-side data tampering: one confirmed high-impact gap, fixed with the same
claim-before-write pattern this hunt has used all along.** Sharing a PR or an
achievement is meant to go through server-side RPCs that read a member's own real
training/achievement record before minting the card. Confirmed live against real
local Postgres: a direct table write - any member's own devtools, bypassing both
RPCs entirely - could mint a PR or achievement card with a completely fabricated
result, movement name, and backdated date, and zero backing record. The card then
received the same feed-ranking boost and public-profile placement as a genuine
share. Fixed with a server-side guard requiring proof the row came from the real
RPC before the label is allowed to land, the same transaction-local claim pattern
this codebase already uses for exactly this class of problem - with one narrow,
explicitly-scoped exception preserved for a pre-existing, already-documented
legacy sharing path that has never had server-side verification (a client-only,
self-reported local badge, trusted at the same level this codebase has always
trusted a member's own logged workout - not a new gap, and not touched by this fix).

**Moderation/abuse-bypass: one confirmed gap, fixed.** A comment or post's text is
snapshotted into a notification the moment it's created; nothing ever revisited
that snapshot afterward. Confirmed live: a moderator removing a comment correctly
hid it everywhere the comment itself is read, but the exact original text -
including a comment reported and removed for being abusive - stayed fully readable
in the one recipient's Notification Center indefinitely. Comment and post removal
now blank that snapshot; restoring the content does not restore the notification
text. A related, lower-severity gap in the same family - a block does not
retroactively redact the blocked party's pre-block notifications - is recorded for
a follow-up rather than fixed here; everything created after a block is already
correctly refused.

**Resource exhaustion: one confirmed low-severity gap, fixed; one lead recorded
for follow-up.** One RPC accepted an array field and discarded everything past
its real 20-item limit only after fully expanding the input, so a multi-million-
element array cost real, measurable database time before being discarded -
bounded in practice by this codebase's own statement timeout and per-endpoint
rate limit, so not an outage risk, but inconsistent with the size-check-before-
expand pattern every other array-accepting endpoint here already follows. Fixed
to reject a wildly oversized array outright before any expansion; every
legitimate input, including a real near-miss over the item cap, is completely
unaffected. A second, unconfirmed lead - the image-upload pipeline caps
compressed file size but not decoded pixel dimensions, a plausible
decompression-bomb shape - could not be verified in this environment (no browser
automation available for a real image-decode test) and is recorded for a
follow-up with proper browser tooling rather than acted on without confirmation.

**Moderation/abuse-bypass agent, IDOR-adjacent checks, and business-logic checks
otherwise found clean** - block enforcement holds everywhere going forward,
restricted members are refused server-side on a direct RPC call (not just hidden
in the UI), and every text/array field checked elsewhere carries its own
server-side cap independent of the client's.

Verified: full suite 1605/1605 (11 new regression tests), full browser-check 41/41,
`supabase test db` 3356/3356 against real local Postgres.

## Real device feedback: a real missing toggle, this time confirmed and fixed — 2026-09-11

Two screenshots from the live app: the club-modules panel, and the Feed tab's empty
state for a feature it doesn't list - "לא נקבע אימון למועדון היום" (the daily club-WOD
strip: a coach schedules a catalogue workout for today, it gets one feed card and one
board, members attach results they already logged with one tap, no post required).
Checked against the actual code rather than assumed: `renderClubWodTodayStrip()` and
its loader (`loadClubWodBoards()`) had no `isModuleEnabled()` check at all, anywhere -
unlike every other real feature on this panel, an admin had no way to turn this one
off. A previous pass this session concluded the panel was complete after verifying its
existing 13 toggles all render; this feature was missing entirely from that count, not
just from the panel, which is why it was missed rather than found.

Added `club_wod` to `CLUB_MODULE_TOGGLES` (`clientOnly: true`, matching `directory`'s
own reasoning - no RLS clause to pair a pure UI hide with; `club_wod_boards`/
`club_wods_list` carry their own independent auth checks). Off hides the ongoing
prompt/today-card and skips the round trip that would have populated it - past feed
posts and boards a WOD already generated are untouched, the same "off hides new, not
old" rule `achievements`/`challenges` already follow. `loadClubWods()` (the shared
workout CATALOGUE feeding app.js's own WOD picker) is a separate, more foundational
feature and was deliberately left alone - turning off the daily scheduling prompt
should not also empty a member's personal workout catalogue.

Asked in the same message to look at the feed's overall length: the existing
`railInterleave()`/`RAIL_ABOVE_FEED` budget (only the first 2 non-empty rail cards
render above the feed; the rest interleave a few posts down) already exists
specifically for this, and correctly gets more effective for a club that turns this
new toggle off. A second real, separate contributor was found but not touched without
asking first: the announcements archive below the feed renders up to 20 full cards
(title + complete body + author) with no cap or collapse - a deliberate placement
("reference material," per its own comment) but an uncapped list length nobody
decided on. Flagged for the product owner rather than assumed.

Verified: the two directly affected test files (`community-club-wod-board.test.mjs`,
`community-club-features.test.mjs`, whose 13-toggle count assertion is now 14) plus a
new dedicated test proving the toggle actually skips the network call when off, not
just the render - both green, full suite otherwise unaffected.

## Security hunt, round 3: authentication abuse, privilege escalation, and client-side posture — 2026-09-11

Three more independent agents: authentication/account-recovery abuse, SECURITY DEFINER
privilege-escalation testing, and client-side security posture.

**SECURITY DEFINER / privilege-escalation: no confirmed gap.** Reviewed every
multi-branch definer function where a lower-privilege caller might reach a
higher-privilege code path via an argument combination the UI never sends -
moderation, invite/role-escalation, club WOD, challenge-team, and coach-signal
clusters. Every branch that does more than its own top-level gate justifies
re-checks its own permission independently; the few genuinely asymmetric branches
(attach vs. detach content, member vs. per-person invite role tiers) are asymmetric
by explicit, commented design with the narrower side independently enforced. One
combination not previously exercised by a real caller identity (`head_coach`/`staff`
attempting the admin-only invite role) was verified live against real local
Postgres and correctly refused.

**Client-side security posture: no confirmed vulnerability; one defense-in-depth
gap closed.** The CSP was tested with real injection attempts (inline scripts,
external script/fetch/form-action/object loads) through a live Chromium page, not
just read - every attempt was actually blocked, confirmed via CSP violation events
and network-level request failures. Confirmed live against real local Postgres/REST
that the public anon key alone, with no session, grants zero access to any table or
function - RLS plus table-level grants, not key secrecy, is what protects data.
Verbose server errors: none of today's newer code paths (this hunt's own round-2
upload/coach-congratulate work included) let a raw database error reach a member;
every error path already routes through this codebase's existing safe-fallback
helpers. Service-worker cache-poisoning: the one theoretical mismatch (a cache
lookup that ignored the query string paired with an exact-URL cache write) was
built out as a real live test and found not exploitable, since the canonical app
shell is always precached before the service worker can intercept anything. A
separate, currently-unreachable looseness was found and closed anyway: the
service worker decided whether a same-origin request was an app-shell file by
checking whether its path merely *ended with* a precached filename (so
`/anything/app.js` would have counted the same as the real `./app.js`), rather
than matching the exact resolved path. No code path in this app currently
constructs a request that could reach that gap, but it was strictly looser than
the actual set of precached files and cheap to tighten outright.

**Authentication & account-recovery abuse: two confirmed findings, both inherent to
the underlying auth service rather than this app's own code, and both already
covered by a deliberate, previously-recorded product decision.** A login-timing
difference lets a caller distinguish a real member handle from a nonexistent one
(the auth service's own credential-verification cost, not app logic), and the
account-creation flow lets a caller confirm whether a given handle is already
registered, with no throttling, before any invite code is presented - unlike this
app's own invite-code redemption, which is real, server-side, rate-limited and
already covered by tests. Both trace back to the same root cause already evaluated
and knowingly accepted in an earlier hardening pass (CAPTCHA on the auth service's
own signup endpoint, declined as disproportionate for a club this size) - there is
no lever in this repo's own migrations or client code that closes either one
without reopening that decision, so neither was patched this round; both are
recorded here for visibility rather than left undocumented.

Verified: full suite 1604/1604 (3 new regression tests), full browser-check 41/41.

## Security hunt, round 2: business-logic abuse, IDOR, and file-upload security — 2026-09-11

Three more independent agents: business-logic abuse/rate-limit bypass, IDOR/object-reference
integrity, and file-upload security.

**IDOR/object-reference integrity: no confirmed gap.** Every uuid-parameter RPC and
foreign-key-scoped RLS policy checked resolves ownership/visibility server-side; no
surface let a caller substitute another member's or another club's id to read or
write across a boundary.

**Business-logic abuse: one confirmed gap, fixed with a real server-side unique
constraint, not a client-side idempotency key.** A coach's "congratulate once" cap
on the Coach Dashboard's Celebrate feed was enforced entirely client-side - an
exact-body-text lookup plus in-memory state. Confirmed live against real local
Postgres: calling the underlying comment/post RPC directly (bypassing the UI
entirely, the same thing any member's own devtools console can already do) produced
real duplicate congratulation comments with no server-side objection, and inflated
the exact metric the admin analytics dashboard reports per coach. A client-supplied
idempotency key would not have closed this - the caller controls that value too, and
can just omit or randomize it. The real fix is a dedicated table with a unique
constraint on (coach, kind, target member, the actual moment being celebrated),
claimed atomically before any comment/post is written, mirroring this codebase's own
existing once-per-achievement pattern. A second call for the same real event, from
any source, now claims nothing and writes nothing.

**File-upload security: two confirmed gaps sharing one root cause, both closed with
one new server-side backstop.** The composer/avatar upload pipeline's "images only"
validation and its EXIF/GPS-stripping privacy behavior are both purely client-side
properties of the browser upload path - confirmed live against the real local
Storage container: a direct authenticated upload with a spoofed `image/jpeg` header
got raw non-image bytes past the bucket allowlist, and a real photo with GPS EXIF
was stored and later downloaded byte-for-byte untouched by a second member, despite
the upload pipeline's own documented promise that this never survives the round
trip. Closed with a new Edge Function, invoked asynchronously after every write to
either photo bucket, that verifies the object by its actual bytes (not the header
the uploader chose to send) and strips EXIF/metadata segments before anything else
can read it back - a real signature check and a real strip, not a client-side
promise with no server behind it.

Verified: full suite 1601/1601 (7 new regression tests), full browser-check 41/41,
`supabase test db` 3327/3327 against real local Postgres.

## Security hunt, round 1: authorization boundaries, injection, and data exposure — 2026-09-11

Started a new, separate 5-round pass focused specifically on security (defensive
testing of the team's own app — authorization, injection, data exposure — not the
UX/functional-correctness lens the prior five rounds used). Ran three independent
agents in parallel: authorization/RLS boundary testing (verified live against real
local Postgres, not just the mock), XSS/injection surface, and sensitive-data
exposure.

**Authorization/RLS: no new confirmed gap.** This codebase had already been through
five prior security-hardening passes with real-Postgres verification; this round's
agent independently re-verified several specific surfaces live (club WOD result
visibility, attendance-log role/ownership scoping, challenge team-assignment
gating) rather than trusting the prior record, and confirmed all of them still hold.
One environment limitation flagged, not a vulnerability: the local Realtime
container is stopped in this sandbox, so `postgres_changes` authorization on the
published tables couldn't be exercised end-to-end this round - worth a follow-up
once that's available.

**XSS/injection: no exploitable vulnerability found.** Every user-controlled surface
tested live (post/comment bodies, mentions, display names, bios, imported-backup
content, the `?invite=` boot param) escaped correctly with no payload execution.
Two defense-in-depth gaps closed anyway, since neither is currently exploitable on
its own but both are cheap to close outright:
- An event's map link was rendered as a clickable `href` with no scheme check at
  the render site itself - two independent upstream controls (a client submit-time
  check and a DB `CHECK` constraint) already prevent a non-`http(s)` value from
  ever reaching this field today, but a third, independent gate right at the render
  call means a future write path that bypasses both of those still can't turn this
  into a stored javascript-URI link.
- A CSS selector built from an attacker-reachable value (`?notif=` → a post id)
  used a naive manual escape instead of the shared `cssSel()` helper this codebase
  already provides for exactly this. `querySelector` can't execute script from a
  malformed selector either way, but this closes the inconsistency.

**Sensitive-data exposure: one confirmed low-severity finding, fixed.** A render
failure showed the raw JavaScript exception message on screen - not an injection
risk (already HTML-escaped by a prior pass), but the message text itself could name
an internal property or variable a member was never meant to see. Now shows a
plain, generic message; the console still gets full detail for debugging. Every
other surface checked clean: invite/push deep-link params are stripped from the URL
before first paint and never resurface via back/forward, no secret sits in
localStorage/IndexedDB, and every error path (login, invite redemption, a forced
raw-Postgres-shaped RPC error) already routes through the app's generic,
anti-enumeration message text rather than echoing server internals.

Verified: full suite 1595/1595 (3 new regression tests), full browser-check 41/41.

## A fifth and final live bug hunt round: theme/visual regression, onboarding & account-recovery depth, and resilience under stress — 2026-09-11

Ran the fifth and final round of three independent agents in parallel driving the
real app live in Chromium against the mocked backend (never production): theme/
visual regression across tablet widths, onboarding & account-recovery depth, and
resilience under stress (rapid dialog cycling, flaky-network simulation, sustained
interaction, render-throw recovery). 6 confirmed findings, all fixed with regression
tests - closing out this 5-round pass at 38 confirmed, fixed bugs total (15 from
rounds 1-2, 9/8/6 from rounds 3/4/5):

- **Every dialog in the app was uncapped in width across the ~480-899px tablet gap**
  - `.modal-sheet`'s width cap only ever existed inside the ≥900px desktop block;
  `#app` itself stays locked to its mobile 480px measure the whole way up to that
  breakpoint, so a Settings/picker/WOD-builder/achievements/notification/invite sheet
  stretched to the full viewport instead - measured live at 700px wide on a
  700px-wide viewport, sitting on top of a page still visually a narrow mobile card.
  Capped at 512px (the same #app-content-measure-plus-padding formula the ≥900px
  block's own 592px already uses, just for the range below it) in the base rule,
  leaving the existing desktop cap untouched.
- **Printing the invite QR flyer produced 1-2 extra full-bleed solid-navy pages** -
  the `@media print` block reset `body`'s background but not `html`'s, and both
  inherit the app's live (dark, by default) theme background. Confirmed via an
  actual print-to-PDF render, not just computed styles.
- **An invite code typed with any uppercase letter was rejected with a misleading
  generic error** - codes are minted lowercase-hex only and the server's format gate
  is a lowercase-only regex, so a case mismatch (mobile autocapitalize on the first
  character; retyping a spoken/printed code) silently hashed to a different code
  entirely. The `?invite=` deep-link path already normalized this; manual entry, the
  far more common path, did not. Added `.toLowerCase()` plus `autocapitalize="off"`
  on the input as defense in depth.
- **Rapid double-tap on invite-code submit fired the redemption RPC twice** with no
  in-flight guard - the real RPC increments a shared code's use count before its
  insert, risking an extra use burned off a limited-use code for one real redemption.
  Added a busy guard, same shape as `reactionBusy`/`followBusy`.
- **A failed automatic recovery-verification attempt was silently overwritten by
  "Profile saved"** - `saveProfile()`'s own unconditional success message clobbered
  `verifyRecovery()`'s "verification failed, try again" message, on exactly a brand-
  new member's first automatic verification attempt (the flaky-connection case). The
  gate and its retry button still worked correctly; only the status text was wrong.
- **`ensureCommunityDataLoaded()` had no top-level error handling** - every
  individual loader already normalizes a real network failure into a resolved error
  object (confirmed by reading the vendored SDK), so this isn't reachable through an
  ordinary hiccup, but if some other bug ever threw inside one of the ~17 parallel
  loaders, the old finally-only version still marked the batch permanently loaded
  (blocking any retry for the session) while the exception itself became an
  unhandled rejection. Now caught, logged, and not marked loaded on failure.

Also confirmed clean across a wide sweep with no fixes needed: theme switching
mid-session on every major screen/dialog (including auto/OS-follow mode), rapid
25-cycle dialog open/close (no leak, one-time lazy DOM fill only), a slow/degraded
network (loading states and retry all correct), 66 real actions in one sustained
session (zero console errors), and the render-error-boundary recovering gracefully
for three independent tab paths beyond the one round 4 had already checked.

Verified: full suite 1592/1592 (7 new regression tests across
`test/live-bug-hunt-round5.test.mjs`, `test/community-invite-code-draft.test.mjs`,
`test/community-recovery-method.test.mjs`), full browser-check 41/41 (one new
script, `tablet-modal-width-and-print.mjs`, covering the two CSS fixes jsdom
cannot see).

## A fourth live bug hunt round: notifications depth, moderation & blocking depth, and data-integrity edges — 2026-09-11

Ran three more independent agents in parallel driving the real app live in Chromium
against the mocked backend (never production): a notifications deep-dive, moderation
& blocking depth, and data-integrity edges (malformed imports, two-tab concurrency,
mid-frame render failures). 8 confirmed findings, all fixed with regression tests -
one of them a real Postgres migration, not just a client fix:

- **Blocking a member was permanent - there was no unblock() function anywhere in the
  app**, no "blocked members" list, nothing on the full profile overlay. Confirmed
  live: a one-way action recoverable only via direct database access. Added
  `unblock()`, a `blockedByMe` state slice (distinct from `blockedIds`, which
  deliberately merges both block directions for the comment/reaction-hiding check -
  only a block the viewer actually initiated is theirs to undo), and a "חברים
  חסומים" panel on the Account tab that renders nothing at all when the member
  hasn't blocked anyone.
- **A resubmitted report on already-reviewed content was silently swallowed forever**
  - `report()`'s `ON CONFLICT` clause has always refreshed reason/details on a
    duplicate but never touched `status`, so a dismissed report stayed dismissed even
    when the same reporter came back with a genuinely escalated complaint. Fixed with
    a real migration (`202609110001_report_reopen_on_new_complaint.sql`, verified
    against local Postgres via `supabase test db`, 95 files / 3301 pgTAP assertions
    passing): a resubmission that genuinely changes reason or details now reopens an
    already-closed report; an exact repeat of the identical complaint does not (guards
    against a bad-faith reporter spamming identical resubmissions to force review
    churn). Mirrored in `mockSupabase.mjs` and an existing pgTAP test updated to match
    the corrected behavior.
- **`feed_activity` notifications could never be muted at all** - its preference key
  was the orphaned pre-rename `"comments"` (COMM-218/219 renamed every other type's
  key but missed this one), and no toggle in the Preferences panel ever wrote that
  key regardless. Now keyed to `notif_pref_key()`'s real identity-fallback
  (`"feed_activity"`) with its own panel row, same shape `weekly_recap`/
  `streak_at_risk` already use.
- **A realtime-arriving batched notification silently collapsed an already-expanded
  group mid-read** - the group's "is it open" key was derived from its own first
  row's id, which changes the instant a realtime INSERT unshifts a new row onto the
  front. Now keyed off the group's last (oldest, stable) row instead.
- **The header bell's badge wasn't actually real-time until Community had been
  visited at least once that session** - the unread *count* was already eager
  (promoted into the session-start batch specifically so the badge is correct on
  first paint), but arming the realtime *subscription* that keeps it live was only
  ever wired into the deferred, Community-visit-gated batch. Promoted alongside the
  count, for the same reason.
- **A mention/comment notification whose target post wasn't on the currently-loaded
  feed page silently did nothing** - closed the notification center with zero sign
  anything was even attempted. Now shows an honest "not loaded right now" message
  instead.
- **Blocking someone mid-conversation blanked the whole open comment thread to
  nothing** until manually closed and reopened - reactions self-heal from a block's
  cache wipe (`ensureReactionsLoaded()` runs unconditionally every render) but
  comments never had the equivalent. Added `ensureCommentsLoaded()`, same shape.
- **Editing an entry on a device with two tabs/windows open against the same
  IndexedDB origin could silently discard a sibling tab's edit** - `startEditEntry()`/
  `startEditWodEntry()` seeded the edit form from the in-memory `entries`/`wodEntries`
  array, which can go stale for a whole session with no cross-tab sync on the
  pure-offline path. Both now re-read the current on-disk record the instant editing
  begins (both became `async`; every existing call site across the test suite needed
  the same `await` added - a genuinely wide mechanical fix, caught by re-running the
  full suite before considering this done).

Verified: full suite 1588/1588 (11 new regression tests across
`test/live-bug-hunt-round4.test.mjs`, `test/community-engagement-cluster.test.mjs`,
`test/community-notifications.test.mjs`, `test/community-moderation.test.mjs`), full
browser-check 40/40, `supabase test db` 95/95 files (3301 pgTAP assertions).

## A third live bug hunt round: achievements/streaks depth, the WOD catalogue, and search & discovery — 2026-09-11

Ran three more independent agents in parallel driving the real app live in Chromium
against the mocked backend (never production), each reading the existing
tests/browser-check scripts for its area first so nothing already-covered got
re-reported: an achievements/streaks deep-dive, WOD/benchmark catalogue edge cases,
and search & discovery across the movement picker, WOD picker and Community's member
directory. 9 confirmed findings, all fixed with regression tests:

- **A set saved after the real day changed, with the date field never touched, was
  silently dated with yesterday's date.** `logDate`/`wodLogDate` are captured once at
  page load and read again at save time — a session left open across midnight (the
  ordinary "phone stayed on all night" case, not an edge case) meant the entry's date
  quietly went stale, with the very next save correcting itself and leaving no sign
  anything had gone wrong. Added `logDateExplicitlyChosen`/`wodLogDateExplicitlyChosen`
  flags, mirroring `movementExplicitlyChosen`'s own shape: only an actual touch of the
  date field (or opening a real past entry for edit) counts as explicit; everything
  else reads `todayISO()` fresh at the moment of save.
- **An already-earned, already-celebrated PR-tier badge could be silently re-locked**
  by an unrelated edit to an older entry — `categoryPRCounts()` recomputes from
  scratch on every render, so correcting a typo in an old set could drop the live
  count back under a tier's threshold, regressing the displayed badge (and the
  athlete score/level computed from the same map) with no notice. `seenAchievementIds`
  already tracks "has this ever been true" (added the moment a badge is first
  detected, never removed) — `renderAchievementsContent()` now ORs it into `earned()`
  instead of trusting the live recompute alone, so a medal stays earned once won.
- **A celebration deferred behind an open dialog (Achievements, Settings, a picker...)
  was only flushed by a literal click** — closing that dialog via Escape or the
  hardware/gesture back button left it stuck until some later, completely unrelated
  click happened to trigger it, popping up disconnected from the moment it was
  actually earned. `flushDeferredCelebration()` is now also called from both the
  Escape keydown handler and the popstate/back-button handler, not just
  `closeOnboarding()` and the generic click handler's tail.
- **The day list's flame icon, the calendar's per-day PR dot, and its "ימי שיא" stat
  all read the raw, ungated `entry.isPR` flag** — unlike every OTHER PR-count/badge
  surface, which already goes through `celebratablePrEntryIds()`'s
  `MIN_ENTRIES_BEFORE_PR` gate. A movement's trivial first-ever entry showed a
  "record" flame, and an entry's flame never cleared even after a later edit made it
  no longer the real running max (`renderDetailCard()`'s own history chart was
  already correct here — it recomputes fresh and never reads the stored flag). New
  `isFlameworthyEntry()` helper, reused across all three surfaces.
- **Building a custom WOD with a name that already exists silently discarded
  everything just built** (format, movements, EMOM rotation, time cap...) and swapped
  in the pre-existing WOD instead, with zero message. The redirect-to-existing
  behavior is unchanged; `addCustomWod()` now tells the member via toast.
- **Undoing a deleted WOD attempt after its own WOD definition was ALSO deleted in the
  undo window resurrected a permanently orphaned entry** —
  `deleteCustomWod()`'s history guard only sees `wodEntries` as they exist at the
  moment of deletion, and an entry sitting in the 5-second undo window has already
  been filtered out of that array by then. `restoreWodEntry()` now refuses (with an
  honest toast) when its own WOD no longer exists, instead of creating a "?" row that
  was invisible in History, permanently stuck in the calendar, and a silent no-op to
  edit.
- **Rx and Scaled attempts were compared as one pool for "the" WOD record**, despite
  being treated as meaningfully different everywhere else in the app (a dedicated
  toggle, the "· מותאם" tag, a separate `scaledWeight` field) — a faster Scaled time
  could flash "new record" and overwrite the displayed Rx best, and conversely a
  genuine Rx improvement could be wrongly denied PR status because an unrelated
  faster Scaled attempt sat in the comparison. `bestWodScore()` now takes an optional
  `rx` filter; `saveWod()`'s PR check and `formatWodBest()` (which now prefers the Rx
  best, falling back to Scaled only when no Rx attempt exists) both use it.
- **The WOD history chart's PR dots used an inclusive (`&lt;=`/`&gt;=`) comparison**,
  disagreeing with the real stored `isPR` flag's strict one right in the attempt list
  below it — an exact tie flashed as a second PR dot on the chart while the list
  correctly showed only one flame. Now strict, and Rx/Scaled-aware to match
  `bestWodScore()`'s own fix.
- **Community's member Directory search box showed "אין חברים להצגה" (no members) for
  a search that matched nobody** — the exact same class of bug COMM-377 already fixed
  for the admin roster, just never propagated to this second search surface (a
  separate code path, `renderDirectorySection()`/`directoryRows()`). A member whose
  search typo matched nobody read it as "this club's directory is broken." Now a
  distinct `data-directory-empty="no-results"` state with its own copy.

Verified: full suite 1578/1578 (9 new regression tests: 8 in the new
`test/live-bug-hunt-round3.test.mjs`, 1 appended to
`test/community-members-directory.test.mjs`), full browser-check 40/40.

## A second live bug hunt round: sync/PWA lifecycle, keyboard a11y, and lightly-covered admin areas — 2026-09-11

Asked to keep looking for more live bugs. Ran three more independent agents in
parallel, each covering fresh ground the first round hadn't: the offline-first
sync/service-worker machinery, keyboard/accessibility navigation, and the two admin
areas an earlier agent had flagged as only lightly checked (Club WOD board, invite
management) plus the whole app at desktop viewport width. 7 confirmed findings, all
fixed:

- **The update banner's "wait for a tap" promise was defeated by the very next screen
  lock/unlock.** `showUpdateBanner()` never marked itself as showing, so the same
  `visibilitychange` listener that legitimately auto-applies an update arriving while
  the page is hidden also fired on the NEXT visibility change after the banner was
  already up - an ordinary phone screen lock (explicitly named in the code's own
  comment as the common case) silently reloaded and dropped unsaved input, with no tap
  ever happening. A new `updateBannerShowing` flag makes only an actual tap on the
  banner able to apply it from that point on - confirmed live with real unsaved text
  sitting in the WOD builder's name field. `update-flow.mjs`'s own Scenario 3 used to
  assert the buggy behavior as correct; rewritten to assert the fix instead.
- **Opening the WOD builder from inside the still-open WOD picker** left both dialogs
  "open" at once - same root-cause shape as the earlier achievements/nav-menu bug.
  `currentAppDialog()` kept treating the now-invisible picker as "the" open dialog:
  Escape closed the hidden picker first (a second press was needed for the visible
  builder), Shift+Tab from the builder's first control tabbed into the hidden picker
  instead of wrapping, and the scroll lock dropped one press early. Fixed the same way
  as before: close the picker first.
- **The Club WOD publish/republish form could be silently wiped mid-edit** by an
  unrelated global toast's 6-second auto-clear timer, which triggers a full rerender
  from the form's own stale, uncontrolled state. Now kept live-synced the same way
  `inviteCodeDraft`/date-echo fields already are.
- **Creating a shared join-code collapsed its own one-time reveal card**, and the
  reveal's close button became genuinely unreachable - the `<details>` disclosure it
  lives inside had no id and no tracked open state, so `createInviteCode()`'s own
  success rerender rebuilt it plain-closed. Since the raw code is never shown again
  after this screen, that risked losing it outright. Now tracked the same way
  `manageAdminArea()`'s five accordion areas already are, forced open the moment
  there's a reveal to show.
- **Shared codes showed no distinction between healthy, exhausted, and expired** -
  `active` never auto-flips on either condition, and the badge only ever printed that
  raw boolean. Now derived client-side from the same use_count/max_uses/expires_at the
  row already displays as text.
- **Invite/shared-code creation forms rendered ~874px-wide inputs** in the ≥1200px
  staff-tier admin column (a width meant for genuinely tabular work - roster,
  moderation, analytics - not a single-field form). Capped to match `.save-btn`'s own
  established narrow-form width.
- **A record with no stored `ts`** (legacy pre-existing local data, or a hand-restored
  import) got a fresh, unstable `Date.now()` manufactured on every load, feeding
  directly into cross-device last-write-wins conflict resolution - a years-old
  workout could look like it was just edited, every session, with a different value
  each time. `cleanTs()` now derives a stable fallback from the record's own date when
  one is available, so the same input always produces the same output.

Verified: full suite 1569/1569 (4 new regression tests), full browser-check 40/40
(two new scripts: `desktop-invite-form-width.mjs`, and `update-flow.mjs`'s Scenario 3
rewritten in place).

## A full site-wide live bug hunt, three fresh agents actually using the app — 2026-09-11

Asked to check the whole site again for live bugs. Ran three independent agents in
parallel, each driving the real rendered app in Chromium against the mocked backend
(never production) rather than reading code: core training log, Community's
member-facing surfaces, and Community's coach/admin surfaces. Fixed all 8 confirmed,
reproduced findings:

- **Rapid double-tap on the save CTA created duplicate entries** - `saveSet()` and
  `saveWod()` had no in-flight guard at all; two overlapping clicks each created their
  own fresh entry. Same in-flight-guard shape as cloud.js's `reactionBusy`, via a
  `try`/`finally` around each function so every existing early-return path still
  releases it.
- **A fresh measurement type's save button silently did nothing at its default 0
  value** - now disabled at 0, kept in sync as the stepper moves (its own tap handler
  patches the DOM in place rather than triggering a full render, so the button's
  disabled state has to be updated from that same place).
- **Deleting a single measurement value had no confirmation and no undo** - the only
  destructive action left in the app without either. Mirrors `askDeleteEntry`/
  `restoreEntry`.
- **"מחיקת כל הנתונים" left Settings and the re-triggered Welcome modal open at the
  same time** - Settings is now explicitly closed first.
- **A club announcement could silently lose everything past 1000 characters, mid-word,
  with no ellipsis** - the composer allowed 2000 while every feed card's own render
  path (`postBodyHtml()`) has always capped display at 1000. Capped the composer to
  match what actually displays, like every other post-composing surface already does.
- **The Follow button never reflected whether you already followed someone, anywhere
  in the app** (directory, welcome post, classmates card, member row, profile dialog)
  **and had no in-flight guard** - a second, well-intentioned tap on a button that
  never visibly changed silently unfollowed the person (the insert's 23505 conflict is
  deliberately turned into a delete), with an identical toast either way. Added a
  `followingIds` cache (loaded once, updated optimistically) and a `followBusy` guard,
  both read through one shared `followButtonHtml()` every call site now renders
  through, plus distinct follow/unfollow toast copy.
- **The coach "Welcome" tool had no duplicate-send guard beyond one in-flight lock** -
  once a call finished, a fresh tap (or the same state after navigating away and back)
  could spam unlimited duplicate welcome comments on one member. The guard now lives
  in `welcomeNewMember()` itself, the one write path both the dashboard button and a
  separate feed-card button share, with the dashboard's own welcomed-state
  reconstructed from real server data the same way Celebrate/Engage already are.
- **Hitting the 3-pin cap failed silently outside the Feed tab** - the error only ever
  rendered inside the Feed tab's own club rail, so pinning from a challenge/event
  dialog just looked like the tap did nothing. Routed through `setMessage()`, this
  app's one genuinely global, viewport-anchored notice channel - the same one the
  success case already used.

Verified: full suite 1565/1565 (12 new regression tests, one per fix plus a couple of
paired controls), full browser-check 39/39.

## Edge-swipe-back was falling through to the OS on an ordinary screen — 2026-09-11

Live report: "when I move my finger from the left side it opens another app or
something." manifest.json ships `display: standalone` - an installed PWA's
WKWebView still recognizes iOS's own edge-swipe-back gesture even though it shows no
browser chrome for it. This session's earlier dialog back-button fix (see below) only
ever pushed a history entry while a dialog was open, consumed back to zero the
instant it closed - so on any ORDINARY screen, with nothing open, history had
nowhere to go, and an edge-swipe-back gesture fell straight through the page to the
OS (backgrounding the installed app / the app switcher) instead of being absorbed.

Fix: one un-consumable history anchor established at boot (app.js, right after the
existing notif-deep-link URL cleanup, and after cloud.js's own invite-code cleanup -
both scrub a live credential from the address bar via `replaceState` before anything
should be allowed to `pushState` on top and leave the original, credential-bearing
entry reachable underneath forever). A popstate listener re-plants the same anchor on
any pop the dialog-reservation system isn't already handling, so an edge-swipe
attempt always lands back inside the app - the dialog-close feature is unaffected,
since that listener explicitly defers to it (`if (appDialogHistoryPushed) return`)
rather than eating every pop unconditionally.

Real device gestures can't be driven by Playwright, but the exact API surface a
gesture drives (`history.back()` + the `popstate` it fires) can: new
`scripts/browser-check/history-anchor-trap.mjs` drives that directly, paired with a
control proving the dialog-close case still works through the same listener chain
now that a second listener is in the mix.

Verified: full suite 1553/1553, full browser-check 39/39 (new
`history-anchor-trap.mjs`). The underlying gesture-level behavior still needs a real
device to fully confirm.

## Three more live reports: a permanent medal icon, an unreachable close button, and a self-cleaning "what's new" — 2026-09-11

Three issues reported live, back to back, against the changes above:

- **"מה חדש" always dumped its FULL history, forever** - RELEASE_NOTES only ever
  grows, and the render used lastSeenVersion solely to decide whether to tag an entry
  "חדש", never to decide whether to show it at all - so a member who had already
  caught up saw the exact same wall of months-old entries every time ("currently it's
  super old"). `renderNotificationsList()` now renders only entries newer than
  `lastSeenVersion` (what `unseenReleaseNotes()` already computed for the badge), with
  an "אין עדכונים חדשים" empty state once there is nothing left to show - self-cleaning
  per device, no manual pruning of the source array needed. The one now-redundant
  per-item "חדש" tag is gone too, since everything rendered is unseen by construction.
- **"I want a medal icon in the top left... I can't see any change."** The header's
  existing achievements entry point (the greeting button + "לכל המדליות וההישגים שלי"
  link) lives in the header's SECOND child, which is `display:none` on every scene
  page - and all 5 main tabs are scene pages (`PAGE_SCENES`, app.js); only the
  admin-only "ניהול" tab is not. So the entry point a member could actually find was
  invisible everywhere they spend their time. New `#medalsBtn` lives in the header's
  FIRST child instead, next to the existing bell/sparkle icon, and needed a real
  spacer grid column in scene mode (not a 4th zero-gap column) so its box and the
  bell's don't share overlapping tap targets - the same shape a comment elsewhere in
  this header already warns about.
- **"This button can't be reached"** (achievements' own close X, screenshotted
  colliding with the device status bar). `#navMenuSheet`/`#settingsSheet` already had
  a `padding-top: calc(env(safe-area-inset-top,0px) + 16px)` rule for exactly this -
  `#achievementsOverlay`'s modal-head, also full-height with `position:absolute;
  top:0`, was simply missing from that selector list.

Verified: full suite 1553/1553 (including a new PROVEN_SAFE entry for
`app-innerhtml-sinks.test.mjs`, SEC-018's sink-escaping check), full browser-check
38/38 including two new scripts (`header-medals-icon.mjs`, and `roadmap.mjs`'s
notifications section rewritten with a paired empty/control assertion).

## Four extended-use persona reviews, a live achievements bug report, and the stacking bug they found but didn't fix — 2026-09-11

Ran four independent long-session agents (coach, member, admin, trainee) actually using
the app rather than skimming it, each researching its own role first. Fixed everything
they found except one deliberate design choice (Hebrew movement search stays
substring-only, confirmed intentional, not a bug):

- **עיטורים renamed to מדליות** end to end — title, celebration copy, share templates,
  settings labels, audit-log action names — with every adjective/verb re-conjugated
  (עיטור is masculine, מדליה is feminine; "עיטור חדש נפתח" → "מדליה חדשה נפתחה").
- **Achievements was hard to find and, once open, hard to leave.** Root cause of "can't
  close it": the nav menu stayed open underneath it, and the dialog-lookup that decides
  which open dialog owns close/Escape returns the FIRST match by registration order —
  the nav menu, not achievements. `openAchievements()`/`openSettings()` now close the
  nav menu first. Findability: the header's greeting button and a new explicit "לכל
  המדליות וההישגים שלי" link both open it with no menu at all; the nav menu's own
  avatar row now carries a visible "מדליות" label + chevron instead of being an
  unlabeled tap target.
- **No back-button support anywhere in the app.** Neither dialog registry
  (`APP_DIALOGS` in app.js, the separate `CLOUD_DIALOGS` in cloud.js) reserved a
  history entry on open, so a hardware/gesture back press left the app entirely instead
  of closing whatever was open — reported live as "we need to close the app for coming
  back." Both registries now push a history entry on open and consume it on normal
  close, with a `popstate` listener that closes the current dialog (or re-pushes if the
  top dialog isn't escapable). Regression-tested by a new
  `scripts/browser-check/dialog-back-button.mjs`.
- **Coach Celebrate/Engage dedupe was client-memory-only**, so a reload or a second
  coach re-showed an already-congratulated PR or an already-reached-out flag.
  `congratulateCelebrateItem()`/`loadCoachCelebrate()` now reconstruct "already
  congratulated" from a real duplicate-body check against server comments;
  `coachEngageReachOut()`/`loadCoachEngageFlags()` do the same against a new
  `member_contact_log` write.
- **PR-share prompts had no cooldown per movement** — a member logging several PRs for
  the same lift back to back got the share dialog every single time. Added a 7-day
  per-movement cooldown.
- **Achievements gave no "how close am I" signal.** Added `need`/`current` fields to
  the PR/streak/session-milestone tiers and a "next up" nudge on the achievements
  screen.
- **WOD glossary was missing Snatch and Clean & Jerk**, the two lifts the benchmark
  catalogue actually names most. Added both, plus a glossary link from the benchmarks
  section that wasn't reachable before.
- Admin: manage-tab area open/closed state now persists across renders instead of
  re-collapsing on every interaction; the audit log resolves actor names instead of
  showing a truncated UUID; member roster search was added (roster arriving empty vs.
  a search matching nothing are deliberately different states — the former shows no
  message at all, per an existing pinned rule).
- Two mock-vs-real-backend gaps found along the way turned out NOT to be production
  bugs once checked against real local Postgres (`supabase test db`): the "new member
  welcome post" and a "stuck moderation report" case were both mock-fidelity gaps in
  `test/helpers/mockSupabase.mjs`, now fixed there.

**The one item the QA agent flagged but correctly left unfixed, fixed here:**
`body[data-scene] main{ position:relative; z-index:1; }` gave `<main>` its own
stacking context (position:relative + a real z-index does that; position:relative
alone does not). `<header>` (z-index:20) and `#bottomNavWrap` (z-index:30) are main's
siblings, not its descendants, so on every scene page (History, Progress, Library,
Community, Achievements, Add) a dialog's own z-index:50 — rendered into `#content`,
main's child — was capped at main's stacking level of 1 and never actually compared
against the header/bottom-nav at all. The backdrop's top ~64px and bottom ~68px+
safe-area silently ate no taps there. Fix: drop the z-index, keep position:relative —
nothing depended on the z-index; `.scene-page` already has its own `isolation:isolate`
and `.scene-sheet` its own scoped z-index for the photo/scrim layering this looked
like it was meant for. New `scripts/browser-check/scene-dialog-stacking.mjs` hit-tests
under the header and bottom nav with a live dialog open, paired with a control that
re-adds the old rule and proves the same hit-tests fail under it.

Verified: full suite 1553/1553, full browser-check 37/37 (including the two new
scripts above), `check-version`/`check-vendor-version` clean.

## A rerunnable tool for the bugs manual audits keep missing — 2026-09-10

Asked, pointedly: the previous role-coverage pass found two real bugs a fresh set of
eyes had missed; build something that finds them without needing a fresh set of eyes
each time, then run it for real. `scripts/audit-role-coverage.mjs` is a new static
check, not a one-off script - three mechanical checks modeled directly on the three bug
shapes already found this session:

1. **Permission-gate mismatch** — cross-references every render function's `hasPerm()`
   gate against the actual (transitive, through `perform public.other_fn(...)` calls,
   and BRANCH-AWARE per argument value where a decision picker's chosen option only
   surfaces two steps later through a separate confirm control) permission its buttons'
   RPCs require server-side, flagging any control visible to a role the server will
   then refuse.
2. **Type-coverage gap** — for every server RPC with a closed-enum argument guard,
   checks that every value the server accepts has a real client control, not just the
   ones reachable through a direct handler call in a test.
3. **Dead field-registry entry** — flags a `{key, label}` toggle whose key is
   referenced nowhere else in the client, the shape a control for a nonexistent feature
   takes.

**This entry was rewritten once already, mid-session, for overclaiming** - an earlier
draft reported the tool "confirms it now catches both previously-known bugs" without
having actually re-run that comparison carefully enough to notice check 1 didn't. Told
plainly to fix what was actually found rather than just correct the wording, the real
gap got closed instead of documented as accepted: check 1 alone (gate and RPC in the
SAME render function) genuinely could not see the original coach/restrict-button bug,
because that bug is a TWO-STEP flow - clicking a decision only opens a confirm sheet; a
SEPARATE button in a DIFFERENT function reads the chosen decision back out of state and
fires the RPC. A new check 1B now traces exactly that: it finds the option array behind
a decision picker, follows the SAME dataset-attribute name to wherever it reappears as
an RPC argument (`data-decision` <-> `p_decision`, a naming convention this codebase
applies consistently), and resolves the RPC's requirement PER OPTION VALUE rather than
as one union over the whole function - `mod_review()`'s own top-level check is
`comment.moderate` for every decision, and only `restrict_temp`/`restrict_permanent`
additionally require `member.restrict`; unioning the whole function would wrongly make
`remove`/`warn`/`dismiss` look just as restricted.

Getting there surfaced two more real bugs IN THE SCRIPT, both found by refusing to
accept "still doesn't reproduce" as a shrug: a naive "first `end if;`" search for a
branch's own end stopped at a NESTED if/end-if inside an earlier branch, truncating the
chain before it ever reached the branches that mattered; and a recursion bug where the
CALLER pre-marked a callee as "already visited" one line before calling it, so the
callee's own entry guard saw itself as a cycle and returned nothing - silently
weakening check 1 itself for any finding depending on a one-hop callee, not just this
new check. Both fixed. Re-run against `git show b957780:cloud.js` (this repo's own
pre-fix state, via `git show`, never by touching the working file), check 1B now
correctly flags `restrict_temp`/`restrict_permanent` and correctly clears
`remove`/`warn`/`dismiss` - the real bug, the real distinction, genuinely re-caught.

**Along the way it also found a third, real, previously-unknown bug**:
`renderRestrictionsPanel()`'s outer gate is an OR across three tiers (`MEMBER_RESTRICT`
/ `COMMENT_MODERATE` / `isAdmin()`), so a plain coach could see the whole
active-restrictions panel and a real "ביטול ההגבלה" (lift restriction) button on every
row — `mod_lift_restriction()` requires `community.member.restrict` (head_coach+) and
would have refused every coach's click. Same defect class, a sibling panel the manual
pass didn't happen to check. Fixed the same way: the lift button now only renders for a
role that actually holds the permission the RPC will demand.

A full re-run against the CURRENT, fixed tree still returns three findings - the
restrictions-panel one above, plus `restrict_temp`/`restrict_permanent` again. All
three are confirmed false positives under one real, stated limitation: both checks see
a render function's OUTER gate, not a per-value inner `.filter(d => hasPerm(...))`
narrowing what actually renders - exactly how both of these bugs were fixed. Verifying
each finding against the real code, every time, is what caught every other problem in
this entry; this is the one that's left, and the script's own header says so rather
than letting a clean-looking run imply otherwise.

Verified: full suite green (this session's own +1 test for the restrictions-panel fix),
via the working tree, which also carries a concurrent session's own unrelated
in-progress changes to many of these same files — every edit in this entry was
isolated into its own minimal patch, diffed against `git show HEAD:<file>` and applied
with `git apply --cached`, specifically so staging and committing this work would not
touch or discard anything the other session has not committed yet.

## A role-coverage audit — two real bugs found and fixed, one dead control removed — 2026-09-10

Asked to verify the app is actually ready per role, not just told so. Four parallel research
passes each audited one of the four reachable roles (`member`, `coach`, `head_coach`, `admin` —
`staff`/`owner` are seeded in the schema but have no path to being granted, confirmed
out of scope) against `AUTHORIZATION_MATRIX.md`'s own permission truth, reading the actual
render code rather than trusting prior audit docs. Two real, previously-unverified defects
came back, both fixed and covered by new tests, both confirmed live in a real Chromium
session (not just jsdom) before shipping:

- **A plain `coach` saw two moderation-queue buttons that always failed.** `renderModeration()`
  showed all five decisions - including "הגבלת פרסום זמנית"/"הגבלת פרסום קבועה" (restrict,
  temp/permanent) - to any holder of `community.comment.moderate`, which every coach holds.
  But `mod_restrict_member()` independently requires `community.member.restrict`, seeded only
  to `head_coach` and up. A coach clicking either button got a hard, unexplained "not
  authorized" every time - a broken control, not a missing one. The two decisions are now
  filtered on `hasPerm(PERM.MEMBER_RESTRICT)` before they render at all.
- **Content pinning had no real button anywhere except the announcements list.**
  `pin_set()`/`pinTargetLabel()` have modeled four pinnable types (announcement/challenge/
  event/post) since COMM-155 shipped, but only announcements ever grew a pin control - every
  existing pin test for the other three types went through a direct `window.eval` handler
  call because there was no button to click, in this codebase or in production. A shared
  `isPinnedTarget()`/`pinToggleHtml()` pair now backs a real pin/unpin control on a
  challenge's and event's detail-view toolbar and on a post's own "⋯" overflow menu, gated
  on `community.content.pin` (head_coach+) same as it always should have been.
- **A dead privacy toggle removed.** The Account tab's privacy panel offered "אפשר הודעות
  פרטיות אליי" (allow private messages) - a preference for a direct-messaging feature that
  does not exist anywhere in the app. The `profiles.allow_messages` column stays in the
  schema untouched (harmless, ready the day DMs ship); only the misleading client control
  and its now-unnecessary fetch are gone.
- **Investigated and closed, no code change:** the club-modules panel ("no toggle for every
  feature") was re-verified toggle-by-toggle against every `module_key` the schema seeds -
  all 13 (8 community + 5 coach-tools) render as real checkboxes, none missing. The two
  groups sit in one continuous scroll; the most likely explanation is the original screenshot
  simply hadn't scrolled to the second group yet.

Verified before shipping, not assumed: full JS suite 1531/1531 (4 new tests - a coach seeing
the right 3-of-5 decisions, a head_coach pinning a challenge from a real click while a coach
never sees the control, the same for an event, and a post pinned through its real overflow
menu instead of `window.eval`), full browser-check 36/36 tracked scenarios (the 37th failure,
`zz-trainee-tour.mjs`, is untracked WIP left by a concurrent session in this working tree,
reproduced failing identically with none of this pass's changes applied - not a regression,
left untouched), and a live 4-role Chromium walkthrough (member/coach/head_coach/admin,
light and dark) screenshotting the actual fixes working end to end: the coach queue with
only 3 buttons, the head_coach queue with all 5, a challenge going from no-pin-button
(coach) to a working pin→unpin round trip with a real confirmation toast (head_coach), and
the privacy panel's 10 remaining toggles with no dead 11th.

## Real device feedback, two visual fixes — 2026-09-10

Five screenshots from the actual production app on a phone, with three complaints:
no toggle for every feature, the audit log takes over the whole screen, and some text
sits out of place. Two of the three had concrete, fixable causes; the third (a specific
missing toggle on the club-modules panel) needs the member to point at the exact
feature - the panel already renders all eight `CLUB_MODULE_TOGGLES` entries, so nothing
was silently dropped from it.

- **The notification-preferences push button was disabled and unlabeled to nothing
  ("התראת דחיפה · בקרוב")** but still rendered at roughly 3x the width of its
  `in_app`/`off` siblings, unbalancing every row on the panel - the exact "text getting
  not in place" screenshot. `state.featureFlags.notifPush` is off by default in V1 and
  the button did nothing while off, so `renderNotifPrefsPanel()` now omits the push
  option from the DOM entirely while the flag is off, rather than rendering it disabled.
  The subscribe/revoke/deep-link machinery underneath - `notifPushEnabled()`,
  `registerPushSubscription`, `disableNotifPush`, sw.js's push/notificationclick
  handlers, `communityHandlePushDeepLink` - is untouched and still fully covered by
  `test/community-web-push.test.mjs`'s flag-on tests; the moment the flag flips on, the
  same three-button row (push/in_app/off) renders again unchanged.
- **The admin audit log rendered one full row per `admin_actions` record**, so a
  genuinely repeated action on one target (a coach toggling one shared code's status
  several times, say) painted the whole screen with near-identical rows - same label,
  same target, same actor, nothing to tell them apart at a glance. A new
  `groupConsecutiveAuditActions()` collapses a CONSECUTIVE run of the exact same
  `(action_type, target_type, target_id, admin_id)` - rows already arrive newest-first
  from `admin_actions_page()` - into one row carrying a "× N" count and the most recent
  occurrence's timestamp. A genuinely different action, target or actor interleaved
  between two otherwise-identical rows is never merged into either neighbor.

Verified before shipping, not assumed: full JS suite 1527/1527 (one new test seeds a
genuine 3-in-a-row repeat, a different action on the same target, and the same action
on a different target in one seed, proving the grouping neither over- nor
under-collapses; two existing push-preference tests updated from "renders disabled" to
"absent from the DOM"), full browser-check 34/35 (`community-person-invite-lifecycle.mjs`
reconfirmed flaky under `run-all.mjs`'s parallel load, not a regression - passed 3/3 on
its own), and a direct visual check (real Chromium) of the notification panel with no
push button/mention and the audit log collapsing 9 seeded rows to 4 with correct "× 3"
and "× 4" counts.

## A fresh-eyes UX audit, verified and shipped — 2026-09-10

A batch of small, self-contained findings from a genuine first-time hands-on tour of the
shipped app (not a code read) had been sitting uncommitted in the working tree - a
concurrent session's own work, left untouched while it was in progress per this
session's own discipline. Asked to finish it: read every diff in full, verified it
against the real test suite rather than assuming it was done, and shipped it.

- **A member's literal first-ever logged set unlocked "First PR" and the Progress tab
  read "3 שיאים החודש" after one session** - `e.isPR` is honest against everything on
  file, and with nothing on file yet a movement's first few entries trivially beat
  "nothing." `saveSet()`'s own `MIN_ENTRIES_BEFORE_PR` already encoded the right rule for
  the full-screen celebration; a new `celebratablePrEntryIds()` applies that same rule
  everywhere else a PR gets counted or badged (the Progress tab's monthly count, the
  achievement engine's `prTotal`) instead of each reading the raw flag independently and
  drifting from it. The same brand-new-movement's set also used to trigger cloud.js's
  "share this PR with the club?" prompt - a `trivial` flag threads through the
  `PR_CREATED` event so that one consumer skips it, while `onPrCreatedForChallenges`
  (which must stay correct regardless of how many prior sets are on file) ignores the
  field entirely and is untouched.
- **The header's one always-visible bell was wired only to the offline "what's new"
  release notes** - a member could have unread reactions/comments/achievement
  notifications sitting behind Community's own small bell chip with no signal anywhere
  else. Real community notifications now take priority on the header (falling back to
  release notes when nothing's unread there); release notes moved into Settings as a
  permanent row so they don't need header space to stay discoverable. `render()` now
  calls `updateNotificationsBadge()` on every pass, not just once at init, so the badge
  stays honest on every tab.
- **The nav menu sheet was a profile row, one settings link, and a full screen of empty
  navy below it** for a regular member (every real destination already lives in the
  bottom tab bar) - now closes with a quiet "האימוניה · vX.X.X" footer instead of trailing
  into nothing.
- **The desktop sidebar's settings-section header and Community's own "חשבון" subtab both
  read "חשבון"** a few pixels apart, naming two different things once Community is open -
  relabeled to "כללי" (a single settings link is not an account).
- Two grammar fixes ("1 ימים" → "1 יום" on the streak label) and a near-empty progress
  chart (1-2 points) now explains itself ("עוד 2 נתונים ותראו כאן מגמה") instead of just
  looking sparse.

Verified before shipping, not assumed: full JS suite 1526/1526 (11 new/updated tests
covering the PR-triviality fix from both app.js's and cloud.js's side, the header-bell
routing in all four states, and the nav-menu footer/grammar/chart-hint fixes), full
browser-check 35/35 including `a11y-axe-scan.mjs`, and a direct visual check (real
Chromium) of the header bell showing a real unread count and the nav menu's new footer.

## Closed the last flagged-but-unfixed item: an engagement-alert burst guard — 2026-09-10

Asked to fix everything still open. The one remaining item from this session's research
passes: `coach_notify_engagement_flags()` fans out one immediate notification per (flag ×
recipient) pair. Production had zero open flags when this was first flagged, so the very
first real run was a non-event - but the underlying shape stays a real risk going forward:
`coach_detect_engagement_decline()` runs daily regardless of whether anyone's listening,
so any stretch with `engagement_alerts` disabled (the admin toggle this feature shipped
specifically so an owner could turn it off) silently accumulates un-notified flags, and
re-enabling it would dump the whole backlog as N separate pings in one run.

Considered and rejected reusing the generic cross-type `notification_batches`/
`notif_queue_batched()` mechanism (`reaction`/`comment_also`/`feed_activity` already use
it): it pools by (user, category), and this type shares category `community` with casual
social batched types - mixing "a member may be drifting away, a human should reach out"
into the same rolled-up digest as reaction counts would bury exactly the thing meant to
stand out. Built a narrower fix instead: per run, per recipient, count how many due flags
actually apply to *them* (after the self-exclusion fix from earlier today) - exactly one
gets today's specific per-flag wording and deep link, unchanged; more than one gets ONE
consolidated notification naming the count ("3 חברים עשויים להתרחק"), never N separate
pings. The everyday case (flags trickle in roughly one per day, matching the detection
job's own cadence) is untouched; only a genuine burst is affected. Also added
`serverTitle: true` to the client's `engagement_decline_flagged` entry - the server now
sends a genuinely different title for the single-vs-many case, and without that flag the
client's static string would have silently overridden it.

Caught one real bug while building this: the first draft tried `max(uuid)` to find a
representative `club_id` across several flags - Postgres has no such aggregate. Simplified
to `default_club_id()` directly, matching this schema's own established single-club
architecture rather than aggregating something that never varies anyway.

New pgTAP scenario proves the burst case directly: three simultaneous flags (including one
on the coach themselves, to exercise the count-per-recipient logic and the self-exclusion
rule at the same time) produce exactly one notification per recipient, with each
recipient's count independently correct (2 for the self-flagged coach, 3 for admin and
owner) - not nine separate pings.

Verified: `supabase test db` 95/95 files (3299 tests), `check-migration-immutability`
clean, full JS suite 1515/1515, full browser-check 35/35. Pushed to GitHub main and
applied to the live Supabase production project.

## Button/interaction consistency pass — 2026-09-10

Asked to check that every button/interactive element is polished and clean, app-wide.
Forked a systematic audit (not a general review - correctness/security have already
been covered exhaustively this session) across app.js, cloud.js, and index.html's shared
CSS: ad-hoc inline-styled buttons, missing icon-button labels, inconsistent busy/disabled
states, `:focus-visible` coverage gaps, tap-target sizing, and off-token colors. Two real
findings, one minor:

- **The Community search box had zero visible keyboard-focus state.** `.search-box input`
  sets `outline:none` (correct - the input is meant to look borderless inside its own
  decorated pill) with nothing compensating, silently breaking the one input in an
  otherwise-universal `:focus-visible` pattern. Added `.search-box:focus-within` on the
  container instead - highlights the whole pill, not the invisible input inside it.
- **Eight edit/delete icon buttons rendered ~23px tap targets** (log-entry, WOD-entry, and
  measurement edit/delete, app.js) - a raw `padding:4px` around a 15px SVG, never given
  the 44px floor the rest of the app converged on. The app already has a fix for this
  exact shape of problem (a transparent `::after` expanding the hit area without growing
  the visible element, used on the header's hamburger/bell) - deliberately NOT reused
  here: edit and delete sit right next to each other, and two overlapping invisible 44px
  boxes would make the one real risk (a tap meant for "edit" landing on "delete" instead)
  worse, not better. Grew the real box instead via a new shared `.icon-btn-sm` class,
  accepting a slightly taller row as the correct trade for a destructive control sitting
  this close to a non-destructive one. Checked visually before and after, both themes -
  clean spacing, no layout breakage.
- **Minor**: a "reset to today" date button's full inline style was byte-identical,
  copy-pasted between the Add and WOD tabs - promoted to a shared `.reset-date-btn` class
  so the next tweak to one actually reaches both.

Everything else checked out clean: icon-only buttons are all correctly labeled, busy/
disabled-state handling is appropriately differentiated (Community's real network calls
show it, app.js's local IndexedDB writes correctly don't need to), and off-token color
usage is limited to a handful of deliberate fixed-contrast badge colors, not accidental
theme breaks.

Verified: full JS suite 1515/1515, full browser-check 35/35 including `a11y-axe-scan.mjs`.

## A real privacy bug in this morning's engagement alerts, found by asking for a second opinion — 2026-09-10

Asked to do a full fresh research round across the whole app, reconciling against
everything shipped today. An independently-forked adversarial review (not a restatement
of my own earlier testing) found one real, confirmed bug in code already live on
production: `coach_notify_engagement_flags()` (this morning's own migration, 202609100002)
could notify a flagged member about their OWN engagement decline, if that member also
holds a coach/admin/owner role - realistic in a small gym, where the coach is often also
a training member. `coach_engagement_flags`' founding migration (202608280011) names this
exact outcome, in these words, as the one thing the whole feature must never produce; the
table's own RLS still held that line, but the new notify function opened a second channel
to the same information a push/in-app notification isn't covered by.

Fixed with a new migration (202609100003, `coach_notify_engagement_flags()` re-declared
whole - the earlier one is already applied and migration-immutable): one added predicate
excludes the flag's own subject from its own recipient loop. Checked production first -
zero open un-notified flags right now, so no real member was ever actually affected, but
the very next real decline in a coach's own attendance would have been. New pgTAP scenario
proves it: a flagged coach gets zero notifications about themselves while admin/owner still
get notified about the coach's decline.

Two smaller, real gaps closed alongside it, both flagged by the same research round:

- **The Boards tab badge (added this morning) didn't reach the desktop-sidebar nav-menu
  preview** - `getCommunityNavPreview()` is a hand-duplicated copy of the real tabs array
  by design (documented "must stay byte-identical" comment), and the badge computation was
  missing from the copy. A member on a 900px+ viewport saw no "challenges ending soon"
  signal until they actually clicked into Community. Mirrored the same computation into
  both places.
- **RISK_REGISTER.md's own "most concerning open item"** (AUDIT0827-OPS-H4/RESCAN-H5,
  claiming `purge_due_accounts()` was never scheduled) was itself stale - the document's
  own top-of-file addendum already flagged this as fixed and pointed at
  `CORRECTIONS_COMPLETED.md`, but the actual table rows still read STILL_OPEN. Confirmed
  the fix is genuinely live on production (`cron.job` query), marked both rows
  VERIFIED_FIXED, updated the summary counts.

Also reconciled: the doc trail's overall verdict is unchanged (CONDITIONAL, 91/100, blocked
only on the same external device-testing/branch-protection/secrets items every pass has
named) - nothing shipped today touches any of that.

Verified: `supabase test db` 95/95 files (3292 tests, new self-exclusion scenario in 0094),
`check-migration-immutability` clean, full JS suite 1515/1515 (1 new test proving the nav
preview badge), full browser-check 35/35. All three fixes pushed to GitHub main and applied
to the live Supabase production project (confirmed via `supabase migration list` - local
and remote now match exactly through 202609100003).

## Structural opportunities from the Community research pass, three of four shipped — 2026-09-10

A research pass on the Community tab's structure ("effective, easy, fun, and beneficial to
both members and owner") found the retention loop weak (every notification type is reactive
or administrative, nothing gives a member a reason to open the app on a rest day) and coach
tooling proactive but still pull-only (coach_engagement_flags is detected daily but never
pushed to a coach - they have to open the Coach tab to find out). Asked to build all four
ranked opportunities and add an admin off-switch for each.

**1. Boards tab badge.** The tab pill for challenges/leaderboard carried no ambient signal,
unlike Manage's own pendingReports badge two tabs over. Now badges with a count of active
challenges ending within 48h - the same window `chal_notify_ending_soon()` already uses
server-side, off data already loaded at boot (zero new fetches). Fixed a latent aria-label
bug in passing: the shared tab-badge markup hardcoded "X דיווחים ממתינים" for every badge on
that bar, which would have mis-described this one to a screen reader; generalized to a
`badgeLabel` field, defaulting to the original string so nothing else changes.

**2. Growth loop.** Turned out to already be built: `renderInviteQrPanel()`'s "שליחה לטלפון"
button already calls `navigator.share()` with the real invite link and QR image
(`shareInviteQr()`/`performInviteShare()`). Nothing to add. The bigger idea researched
alongside it - letting an ordinary member (not just coaches/admins) share an invite from
their own achievement posts - runs into two deliberate, tested boundaries on purpose: the
outward-share card's own Rule 2/3 explicitly forbid club identity or any URL ("an image that
has left this app has no RLS behind it any more"), and the `member` role holds no invite
permission today. Left alone rather than silently reversing either; flagged as a real,
separate product decision if the owner wants to revisit it.

**3. Streak-at-risk nudges** (`notif_streak_at_risk()`, new). Daily job: a member with a
3+ day activity streak (consecutive days the app was opened) who hasn't opened it yet today
gets an honest reminder. Deliberately NOT gated on leaderboard visibility - this is a private
reminder about a member's own number, not a board read. Self-limiting by construction (the
"last activity = yesterday" predicate matches at most one calendar day per at-risk episode),
so one daily cron run cannot double-notify without needing a tracking column.

**4. Engagement-decline alerts to staff** (`coach_notify_engagement_flags()`, new). The
existing daily detection job (`coach_detect_engagement_decline()`, already scheduled, never
touched) still only writes the flag. This fans a NEW flag out to every coach/admin
(`mod_alert_recipients()`, the same resolver `new_report` already uses) once - a new
`notified_at` column gates it, the same "notify once per thing" idiom
`challenges.ending_soon_notified_at` already established. Deliberately carries no member
name or handle: PRIVACY.md documents this signal as hidden from the member it is about, and
a push banner is a surface a coach's own notification centre doesn't otherwise expose to.

**The admin off-switch, as asked**: two new `club_features` toggles
(`streak_risk_nudges`, `engagement_alerts`), the same generic mechanism every other module
toggle already uses - no new table, no new RPC, genuinely server-enforced (checked inside
each new function itself, not just hidden client-side), on by default.

Verified: local `supabase test db` (95 files/3289 tests, a new `0094` file covering both
jobs' eligibility rules, idempotency, privacy, and the off-switch), `check-migration-
immutability` clean, full JS suite 1514/1514 (2 new + 2 pre-existing tests updated for the
new toggle/pref counts, with the updated numbers justified inline), full browser-check
35/35 including `a11y-axe-scan.mjs` and `community-render-cost.mjs`. One early false-alarm:
a first `supabase test db` run showed 5 unrelated files failing - traced to leftover
pollution from my own earlier ad-hoc manual test insert in the shared local dev database,
not a real regression; a clean `db reset` confirmed it.

## The Community feed "feels cheap" — a scoped polish pass, checked against the approved mockup — 2026-09-10

Reported directly. Compared the current feed markup/CSS against the already-approved
Direction 06 reference design (`mockups/06-community.png`) instead of guessing at a new
direction, then forked a second, deeper research pass on top of the first fix to find
anything still worth doing. Five real, low-risk gaps, all CSS/markup-only - no new
data, no new fetches, no schema/RLS touched:

- **The composer entry point read as a utility button**, same weight as "טעינת עוד"
  below the feed - easy to miss as the one thing on the screen that starts something.
  Now the standard "fake input row" every social feed uses for the same tap target:
  the member's own avatar + a greyed "מה קורה היום?" placeholder, full width. Same
  `data-community-action="open-composer"`, so every existing composer test still
  targets the same element.
- **The announcement card was indistinguishable from any other card** except a badge
  string and an emoji typed into the title. Now a visibly separate voice in the feed -
  a warm brass-tinted card background plus a 📣 icon badge replacing the generic "ח"
  club mark every other authorless post type still shares. Contrast computed against
  the actual tinted background, not the untinted surface, before shipping: 5.13:1
  light / 6.19:1 dark.
- **The reaction/comment row was two identical grey chip buttons** - a reaction and a
  comment count looked exactly like any filter chip or subtab elsewhere in the app.
  Cheer now gets the same filled warm-pill treatment `.pick-hero-cta` already
  established for a primary CTA (--energy-text on an 8% tint: 5.41:1 light / 4.83:1
  dark, computed, not assumed); comments stays a plain, quieter icon+count since it
  opens a thread rather than registering a reaction.
- **PR/achievement/attendance-milestone, challenge, and event cards had no visual
  weight of their own** - a thin colored top accent instead of a repainted card
  (brass for PR/achievement/milestone, teal for challenges, blue for events - the
  same hues `sectionHead()` already uses for those categories elsewhere).
- **Feed head avatars were 36px**, a touch small against the mockup's heavier avatar
  weight - bumped to 40px at the one call site that's actually the main feed card
  head, not a blanket change to every 36px avatar in the app (comments, directory
  rows keep their own deliberate sizing).

Verified: the exact `community-render-cost.mjs` frame-budget trip-wire this touches
directly (the feed's own hot path) still passes with margin - 5ms at 4x CPU throttle
against a 16ms budget. Full suite 1512/1512, full browser-check 35/35 including
`a11y-axe-scan.mjs` and `community-post-composition.mjs` (the composer flow itself).
Checked visually in a real Chromium page, both themes, before calling it done - not
just by CSS reasoning.

**Flagged, not implemented - product decisions, not styling:** the mockup's
weekly-leaderboard preview card sits inside the feed itself; today it's a fully
separate "Boards" sub-tab with its own, already-reasonable styling. Folding a
leaderboard preview into the feed is real work (a new render path, plus confirming
the data is even loaded while the Feed sub-tab is active) - a scope call for the
owner, not something to bundle into a CSS pass. Feed personalization/ranking
(`docs/audit/FEATURE_RECOMMENDATIONS.md` FEAT-010) is a longer-term, separate-track
item that also contributes to a feed reading as generic over time, independent of
card styling.

## Closed the one real onboarding gap: what becomes visible when you join — 2026-09-10

A full end-to-end audit (every screen, every feature, prepared for board review) gave
onboarding a skeptical re-look after repeated concern that the earlier "already fine"
verdict wasn't the full story. It wasn't: `RISK_REGISTER.md`'s AUDIT0827-PROD-3, open
since 2026-08-27, was real and never closed — nothing in the sign-up flow tells a new
member what happens to their data once they join Community.

Checked `PRIVACY.md`'s actual documented defaults before writing a word of copy, rather
than guessing: profile visibility is ON by default, but workout results, PRs, and
attendance are all OFF by default and only publish when a member chooses to share them.
So the honest sentence is "your profile is visible, your numbers are not, until you say
so" - not the more alarming "everything becomes public" a first guess might have shipped.

Added one sentence to the intro carousel's existing `club_rules` step (the step already
covering club policy facts - hours, dress code, cancellations), via a new migration
(`202609100001_intro_carousel_data_visibility_disclosure.sql`) rather than a fourth
carousel screen: the table's own CHECK constraint fixes the step set at exactly three,
so a new screen would have been schema surgery for a one-sentence gap. The UPDATE is
guarded to only touch the row if its body still matches the original seed text
byte-for-byte, so a club that already customized this step through the admin content
editor keeps its own words.

Verified locally: `supabase test db` (94 files / 3265 tests, including the exact row
after a full `db reset`), `check-migration-immutability` clean (new file, nothing
edited), full JS suite 1512/1512, `community-intro-carousel.test.mjs` +
`first-run-sequence.test.mjs` 35/35 (JSDOM fixtures, unaffected by the DB seed change
as expected). `RISK_REGISTER.md`'s AUDIT0827-PROD-3 row and its summary counts updated
to VERIFIED_FIXED.

While assembling the audit, one other reported finding turned out to be a false
positive from stale documentation, not a real gap: the "any coach can edit any
admin's announcement" claim (SEC-010) cited a 2026-08-27 policy that a 2026-09-06
migration had already superseded - `announcements_update_admin` has been
author-or-admin, with cross-author edits audited, for four days. A passing pgTAP test
(`0079_product_decisions_attendance_and_announcements_test.sql`) already proves it.
Corrected before it reached the board report, not after.

## Re-audited the three just-fixed screens — 2026-09-10

Asked to re-audit after the previous fix. Forked one pass over the same
three areas (Calendar, Progress's body-measurements section, Add tab)
to check the fixes themselves and look for anything left. Two of three
fixes were clean; the third left one harmless dead ternary from the
refactor - `renderLogTab()`'s ladder/superset panel had
`${ladderMode ? \`...\` : ""}` wrapping the round-detail block, but by
that point in the function `ladderMode` is always `true` (the inactive
case already returned earlier). Collapsed to a plain template literal;
no behavior change, since the `: ""` branch could never have run.
Nothing else in the three areas cleared the bar.

`test/bodyweight-measurements.test.mjs`, `duration-entries.test.mjs`,
`superset-blocks.test.mjs`, `clear-data.test.mjs`, `app-flow.test.mjs`
(43/43), full suite (1512/1512), full browser-check (35/35) all pass.

## Three real gaps from a full member-facing UX sweep — 2026-09-10

Asked to run the same "more complicated than it needs to be" audit across
every member-facing screen, not just admin/Community. Forked four
parallel audits (Add/WOD, History/Progress + Calendar, Community's
social side, onboarding + Settings). Three came back clean on inspection
- Community, onboarding, and Settings had all already been through
deliberate simplification passes and nothing new cleared the bar. Three
concrete fixes landed:

- **Calendar tab showed the wrong title.** Tap "לוח שנה" in the bottom
  nav, land on a screen whose h1 said "היסטוריה" - a straight mislabel
  (the History/Progress tab, internally called `history`, correctly
  shows "התקדמות"; only Calendar's own title had drifted from its nav
  label). `app.js:4210`, one line.
- **Progress tab's "add new measurement" outranked the measurements you
  already track.** `renderMeasureArea()` rendered a bold, brass-bordered
  "+ הוספת מדד חדש" CTA first, above every existing measurement - the
  rare once-per-type action beating the thing you actually do every
  visit (log today's value into a type you already have). Moved the
  control after the real rows and dropped it to plain-row weight
  (`.link-btn`, no border/CTA styling) - same control, same
  `data-action="open-add-measure-type"`, just no longer first in line.
- **Add tab's ladder/superset toggle competed with the actual set
  entry.** Every single log session showed a full-width, two-line,
  icon'd CTA for structured ladder/superset logging directly under the
  weight/reps/sets steppers - a feature most single-set sessions never
  touch. Shrunk the inactive state to a small `.link-btn`; the full
  control (live round count, block-label chips, partner exercise, the
  whole panel) still renders at its original weight the moment it's
  actually active - nothing about the feature itself changed, only how
  loud it is before you've asked for it.

No ids, `data-action`s, or test selectors touched - confirmed against
`test/bodyweight-measurements.test.mjs`, `test/duration-entries.test.mjs`,
`test/superset-blocks.test.mjs`, `test/clear-data.test.mjs`, and
`test/app-flow.test.mjs` before editing (all check for the active-state
"...פעיל..." text via `[data-action='toggle-ladder-mode']`, none assert
on inactive-state markup or DOM order). Full suite (1512/1512) and the
full browser-check run (35/35, including `ladder.mjs`, `superset.mjs`,
`roadmap.mjs`) both pass unchanged.

Left alone: an unrelated, already-in-progress edit found in the same
file mid-session (the WOD benchmarks subtab label "Benchmarks"→"קטלוג")
- not something this pass touched, staged separately with `git add -p`
so it ships on its own.

## Same fix, second surface: Member of the Week's coach's-pick form — 2026-09-10

Follow-up to the invite-flow simplification below - a fork audited the
rest of the Community/admin surfaces for the same "more complicated than
it needs to be" pattern and found one clean match: the coach dashboard's
Member of the Week section. Whenever computed candidates exist,
`renderCoachMemberOfWeekSection()` rendered the candidate list AND a
full always-open "coach's pick" form (username, reason textarea, submit)
directly beneath it - a free-text manual override sitting in equal
visual weight next to the one-tap "פרסום" button on each actual
candidate, for what COMM-315 itself treats as a fallback path.

Checked `test/community-member-of-week.test.mjs` first: every assertion
on the populated-candidates case uses `querySelector('[data-mow-pick-*]')`
presence, not visibility, so the same `<details>` disclosure already
used for the invite flow's shared-code panel applies here unchanged -
the form stays in the DOM with the same ids/data-actions, now tucked
behind a "בחירה ידנית של חבר/ת השבוע" summary instead of always-open.
Left it open in every OTHER branch (empty candidates, free_selection,
coachs_pick) - there it's the only action on screen, so collapsing it
would just add a click with nothing to hide it from.

`test/community-member-of-week.test.mjs` (14/14) and the full suite
(1512/1512) both pass unchanged.

## Simplified inviting a member; two real contrast bugs found along the way — 2026-09-10

Reported directly: inviting one member was "way more complicated than it
needs to be." Read the actual code before proposing anything - the
"הוספת חבר/ה" (Add Member) tab stacked three systems: a QR panel
rendered ABOVE everything (its own empty state explains itself before
either form below it has created anything), and two full forms side by
side under one combined header - a personal invite (the common case: one
named person) and a shared/bulk join code (a genuinely rarer case, meant
for a printable front-desk flyer). A coach just wanting to invite the
person standing in front of them had to first work out which of two
forms was the right one.

**Nothing about what these do, or who can see them, changed** - checked
against `test/community-invite-code-management.test.mjs`,
`community-invite-qr.test.mjs`, and
`scripts/browser-check/community-person-invite-lifecycle.mjs` before
writing anything, not after: every form id (`#communityInviteCodeCreate`,
`#communityInviteCreate`), field name, `data-action`, and
`data-*-panel`/`data-*-section` marker those tests assert on is
byte-identical. What changed is order and default visibility:
`renderInviteManagement()` now puts the personal-invite panel first,
retitled from "ניהול הזמנות וקודי הצטרפות" to "הזמנת חבר/ה" (the section
itself, not a new one - see the test-file comment explaining exactly
that), with the shared/bulk-code panel moved into a `<details>`
disclosure ("עוד אפשרות: קוד הצטרפות משותף...") - present in the DOM
exactly as before (the unit tests `dispatchEvent`/`requestSubmit()`
directly on it, which doesn't care about open/closed state) but not
competing for the first glance. The QR panel and incomplete-signups
tracker now render AFTER the invite form instead of before it, so the
form - the actual action - is what a coach sees and can act on
immediately.

**Two real, pre-existing WCAG failures found while axe-checking the
restructured tab**, both the same `--token-as-text` class of bug fixed
several times earlier this session: `.admin-tag` (the "ניהול" pill on
every `sectionHead()` across the app, not just invites) used
`color:var(--energy)` - a fill/border-safe token, never text-safe -
switched to `--energy-text`. `.chip-btn.selected` used `--brass` at
4.35:1 against `--surface2` (`#E9EFF8`), just under AA - the token's own
comment already documented one earlier darkening pass that verified it
against `--surface`/`--bg` but never happened to check `--surface2`.
Darkened again, `#956529` → `#8a5d25` (4.95:1 on `--surface2`, 5.72:1 on
`--surface` - darkening only ever helps against something lighter, so
every other pairing improved too, not just the one that was failing).

A regression-guard test (`community-manage-tab.test.mjs`, "every section
the seven-tab Manage rendered is still reachable") legitimately needed
updating - it hardcoded the old section heading text as a marker; updated
to the new heading with a comment explaining it's the same section, not
proof of a silently orphaned one.

Verified: `npm test` 1512/1512, `run-all.mjs` 35/35, `a11y-axe-scan.mjs`
clean, a targeted axe pass on the invite tab specifically (both themes,
disclosure open and closed - 4 checks, all previously failing on
`.admin-tag`/`.selected`, now clean), confirmed via DOM query that the
shared-code form exists before the disclosure is opened and becomes
visible after. `APP_VERSION` bumped to `4.16.0` (a real feature/UX
change, not a patch-level fix).

## The 4-stat summary row is deleted, not conditional — 2026-09-10

The previous pass made it show only when `hasLoggedToday` - reported
back directly: "The circled in red still there, I don't want it at all.
Remove delete." Making it conditional was the wrong level of fix; removed
the block entirely from `renderLogTab()` instead, regardless of state.
Also removed what it leaves behind rather than leaving it half-cleaned:
`dayExerciseCount`/`dayVolume`/`dayDurationMin`/`dayPRCount` (computed
only to feed the row, now unused) and the three
`.scene-page--add .stat-row[aria-label]` CSS rules (including the
`max-width:320px` narrow-phone override) that styled markup which no
longer exists.

Verified: `npm test` 1512/1512, `run-all.mjs` 35/35, `a11y-axe-scan.mjs`
clean, confirmed via DOM query that `.stat-row[aria-label]` is absent
both before AND after logging a set (the previous pass's conditional
only checked the "before" case). `APP_VERSION` bumped to `4.15.9`.

## Fifth jump report was a real, different bug — plus a corrected fix and two more from a marked-up screenshot — 2026-09-10

**The actual "box jumps" cause.** Not a page-scroll issue at all this time
- reported precisely: "it's the box where you can put your exercise that
jumps." `.scene-sheet{ animation:scene-sheet-in .2s ease-out; }` (gated
behind `prefers-reduced-motion:no-preference`, so it wasn't a motion-
accessibility bug) was meant to play once, entering a scene tab. It
actually replayed on every single re-render *within* the tab -
`render()` rebuilds `#content`'s innerHTML wholesale on nearly every
interaction (typing a weight, tapping a stepper, anything), so the
browser saw a "new" `.scene-sheet` matching the selector each time and
restarted the 12px-translateY + fade from scratch. No state exists today
to distinguish "just switched into this tab" from "re-rendered within
it," so removed rather than half-fixed.

**A wrong turn, corrected the same session.** Also reported (with a
screenshot circled in red): a warm/reddish tint still visible behind the
stat cards, after the ambient photo layer was already removed. First
guess wrong: assumed it was the scrim's own added coral radial-gradient
and removed that - genuinely a real contributor, correctly removed. But
then also raised the sheet's opacity from `.8` to `.95` to kill the
*remaining* bleed (the backdrop-filter blur sampling the actual red-
striped photo through the translucent sheet, inherent to glass sitting
near a colorful photo) - which was NOT wanted. Corrected immediately:
"I liked the transparency" - reverted to `.8`. The circled screenshot
turned out to mean something narrower than either guess: remove the
4-stat summary row itself, not reduce transparency anywhere. Recorded
here as a real example of two guesses in a row on ambiguous visual
feedback, corrected in full as soon as the actual intent was clarified,
rather than left half-applied.

**The 4-stat summary row (תרגילים/ק"ג נפח/דק'/שיאים חדשים) is
conditional again.** It used to be gated on `hasLoggedToday` (the same
flag the completion checkmark already uses) before the reference-
accuracy pass made it unconditional - showing four zero/dash cards
before a member has logged anything today was exactly the clutter the
circled screenshot was pointing at. Restored: `${hasLoggedToday ? ... :
""}`.

**"עבודה מעולה!" (great job!) is conditional too, for the same reason.**
Reported directly: it shouldn't show all the time, only right after
logging something, then disappear again. It had the identical
unconditional-regression as the stat row - restored to the same
`hasLoggedToday` check the title's completion badge already uses, with
"מוכנים להתחיל?" (ready to start?) as the before-logging state, matching
this session's very first pass at this screen (which had exactly this
conditional, lost somewhere in a later rewrite).

Verified together: `npm test` 1512/1512, `run-all.mjs` 35/35,
`a11y-axe-scan.mjs` clean, every state change (subtitle text, stat-row
presence, sheet opacity) confirmed via computed DOM content in headless
Chromium before and after logging a set, not just visually. `APP_VERSION`
bumped again to `4.15.8` and re-synced - see the entry directly below for
why that step is not optional on any pass that touches production code.

**The real reason nothing looked updated: APP_VERSION never moved.**

Reported directly: "Didn't see any update on app. And screen still jumps."
Investigated rather than assumed - `git log -p` on `app.js` shows
`APP_VERSION` was bumped to `4.15.1` at the reference-accuracy-pass commit
and then **never bumped again** across the five real fix commits that
shipped after it (the nav-jump fix, the full Navy Stripe ship, light
theme, extending it to all five screens, and both jump-investigation
fixes). `sw.js`'s own comment states the mechanism plainly: "bumping
APP_VERSION in app.js is what ships an update" - the service worker has
no other signal that a new version exists. Every fix in this file below
was correct in the repository the whole time; none of them had a way to
reach an already-installed client, because the cache-busting version
identifier stayed frozen at 4.15.1 through all of it.

Bumped to `4.15.7` (one per real change since 4.15.1) and re-synced
`SW_VERSION` via `npm run sync-version`. Verified `npm run check-version`
passes.

## Three real fixes from a live screenshot, once actually visible — 2026-09-10

**1. Progress screen no longer auto-expands an exercise on load.**
`renderHistoryListArea()` unconditionally rendered
`renderDetailCard(active[0])` - the first exercise's full chart - open
before any tap, whenever nothing was explicitly selected. Reported
directly ("progress should be open only when the user is pressing an
exercise"). Removed; every row now starts collapsed, matching the
`historyId === m.id` condition every other row already used. Verified: 0
charts render on load, tapping a row still opens exactly that one.

**2. Progress chart no longer plots one point per SET.**
`renderDetailCard`/`renderDurationDetailCard` fed `renderChart` one data
point per logged entry - several sets in one session landed as several
points on the exact same date (the reported screenshots showed "10.09"
repeated three times and "27.08" repeated six). Researched rather than
guessed at the right behavior: every mainstream strength-tracking app
that plots 1RM-over-time (Strong, Hevy, ...) shows one point per session
day, the best set of that day - a progress chart tracks day-to-day
change, and multiple sets in one session are reps of the same workout,
not separate progress. Added `bestPerDay(entries, valueOf)`, used by
both chart builders; the RM-table/bestEst1RM/repRecordFor were already
correct (a global max across all sets is unaffected by how many sets
happened on any one day) and are untouched. Verified: three same-day sets
at 80/90/100kg now render exactly one chart point (100kg, the best).

**3. Exercise rows in the day-entries list no longer wrap mid-row.**
`.scene-page--add .log-row > .flex{flex-wrap:wrap;}` forced wrapping with
no truncation fallback - reported directly with a screenshot showing the
edit/delete icons and exercise name landing on two misaligned lines.
Classic flexbox gap: flex items default to a content-based minimum width,
so once a row's total content exceeded the available width, wrapping was
the only way the browser could fit it. Removed the forced wrap; both
flex halves now get `min-width:0` (so they can actually shrink) and the
exercise name gets real `text-overflow:ellipsis` truncation instead, so
a long name shortens with "…" and the 44px edit/delete targets never
lose their size to make room. Verified: three logged sets render three
uniform 56px-tall single-line rows.

Verified together: `npm test` 1512/1512, `run-all.mjs` 35/35,
`a11y-axe-scan.mjs` clean, `npm run check-version` passes.

## Fourth jump report — a dvh instance that survived the original fix — 2026-09-10

Reported specifically as jumping "getting in the app" (app launch), not a
tab switch this time - a real, different instance of the same underlying
class of bug. `#loading` (index.html) - the screen actually on-screen
during that exact moment - still used `min-height:100dvh`, missed by the
original dvh->svh sweep because it isn't a `.scene-page`. Fixed the same
way: `100svh`. Also converted `#welcomeOverlay .welcome-scene` and
`#achievementsOverlay .modal-sheet` (both `100dvh`) for the same reason -
both are shown during/near the same "entering the app" window (first-run
and, for achievements, a modal reachable from very early in a session).
Left the desktop-only context-column `max-height:calc(100dvh - 56px)`
alone - desktop browsers don't collapse an address bar on scroll, so it
isn't the same failure mode, and changing it isn't free (a different
intended behavior around the 56px offset).

Also removed the "אימון כוח"/"אימון שהושלם" label from the Add screen's
date row (`.scene-summary-meta`), per direct request - the row now shows
just the date.

Verified: `npm test` 1512/1512, `run-all.mjs` 35/35, `a11y-axe-scan.mjs`
clean, confirmed via computed text content that the label is gone and
only the date remains.

## Removed the ambient photo layer, per direct request — 2026-09-10

`.scene-page__ambient` (the heavily blurred, dimmed copy of each scene's
photo sitting behind the whole glass sheet) is gone - the div from all
five render paths (`renderLogTab`/`renderCalendarTab`/`renderHistoryTab`/
`renderWodTab` in app.js, the Community scene in cloud.js) and its CSS
rule, including the `position:fixed` fix from the entry above (moot once
the element itself is gone). Everything else Navy Stripe added stays:
the stripe ribbon, the lighter scrim, the glass sheet and glass CTA. The
sheet's own translucency still reads as glass - it now shows a plain
blurred navy/cream instead of a blurred photo behind it, which is a
perfectly normal frosted-glass look on its own.

Verified: `npm test` 1512/1512, `run-all.mjs` 35/35, `a11y-axe-scan.mjs`
clean, confirmed via computed styles that `.scene-page__ambient` no
longer exists in the DOM on any of the five screens.

## Third jump report — the ambient layer's fixed background, not dvh — 2026-09-09

Reported again ("the page still jumping") immediately after Navy Stripe
shipped to all five screens. The original dvh→svh fix (still correct,
still in place, confirmed no dvh remains on anything in the tab-switch
path) wasn't the culprit this time. Root cause: `.scene-page__ambient`
used `position:absolute` + `background-attachment:fixed` to size
`background-size:cover` against the viewport instead of its own very-tall
(full page content height) box. `background-attachment:fixed` on a tall
scrolling element with a heavy `filter:blur(46px)` on top is a well-known,
severe mobile scroll-performance anti-pattern - most engines can't
cheaply composite it, since the browser has to reconsider the blurred
background's position against the scrolled box on every frame rather
than treating it as a static layer. This existed on Add alone since the
first Navy Stripe ship; extending it to all five screens turned an
existing-but-easy-to-miss cost into something impossible to miss.

Fixed the right way: `position:fixed` on the ambient ELEMENT itself
(matching how `.header`/the dock chips already work), not a fixed
background on an absolutely-positioned element. A small, viewport-sized
fixed layer is cheap for the compositor to treat as static; a huge
scrolling element with a fixed-attachment background is the expensive
version of the same idea. Confirmed `isolation:isolate` on `.scene-page`
(its ancestor) does NOT turn it into a containing block for
`position:fixed` descendants - only transform/filter/perspective/contain
do, and `.scene-page` sets none of them - so the layer still resolves
against the real viewport, verified via `getBoundingClientRect()` before
and after a scroll (identical position, as intended) rather than assumed
from the spec text.

**Honesty about verification limits**: headless Chromium's own
`layout-shift` PerformanceObserver shows negligible CLS (~0.001) both
before and after this fix - consistent with the whole project's earlier
finding that this class of jank is a real-device GPU/compositor cost,
not a layout reflow this sandbox can directly measure or reproduce. The
fix is the standard, well-documented correction for the anti-pattern
found; it has not been confirmed to eliminate the felt jank on an actual
phone, because nothing in this environment can test that.

Verified: `npm test` 1512/1512, `run-all.mjs` 35/35, `a11y-axe-scan.mjs`
clean, ambient layer's position confirmed static across scroll via
computed `getBoundingClientRect()`.

## "Navy Stripe" extended to every scene screen — 2026-09-09

Extended from Add-only to Calendar, Progress, Library and Community
(app.js's `renderCalendarTab`/`renderHistoryTab`/`renderWodTab`, and
cloud.js's Community scene) — both themes, all four. Kept: Add's own taller
`--scene-photo-height` (that was tuned specifically against its own
mockup pass; the other four screens' existing, separately-approved
VISUAL_QA_PROTOCOL.md proportions are untouched). Not extended: the glass
CTA treatment, since only Add has one dominant primary action - the other
screens don't have an equivalent element to apply it to.

**Generalized, not duplicated, using what the scenes already share**:
- `.scene-page__ambient` now reads `var(--scene-image)`/
  `var(--scene-position, center top)` - the same custom properties each
  `.scene-page--*` class already sets for its own `.scene-page__media` -
  instead of a second per-screen hardcoded URL. One rule, every screen
  automatically gets its own photo.
- The lighter scrim (previously Add-only) turned out to be a defect on
  every scene, not just Add - they all shared the one original catch-all
  scrim rule, so all of them were darkening to .62 opacity by the
  halfway point.
- The glass sheet (light .88 opacity / dark .8, both measured for
  contrast, not eyeballed) extends the same way - the underlying question
  was never Add-specific ("does translucent coral/navy/cream work under
  nested opaque cards"), so the same verified values apply everywhere.

**A real specificity bug caught while generalizing, before it shipped**:
the naive generalized selector `.scene-page > .scene-page__scrim` computes
to specificity (0,2,0) - weaker than the existing
`:root[data-theme="dark"] .scene-page__scrim` rule already in this file at
(0,3,0). Without noticing, the lighter-scrim fix would have silently lost
in dark theme specifically - the exact theme it was reported against -
while appearing to work in light theme, where the competing rule doesn't
match. Fixed by adding `body[data-scene]` to the selector
(specificity 0,3,1), computed and verified via getComputedStyle in a real
browser, not assumed from source order.

Verified: `npm test` 1512/1512, `run-all.mjs` 35/35, `desktop-layout.mjs`
clean, axe clean across all 5 scene screens in both light and dark (10
checks total), computed styles (sheet background/blur, ambient's
background-image resolving to each screen's own photo, scrim gradient)
confirmed per-screen via headless Chromium rather than assumed from the
Add-screen result alone.

## "Navy Stripe" extended to light theme — Add screen — 2026-09-09

The dark-theme ship below stayed dark-only deliberately, since that's all
that had been reviewed. Extended now: computed light-theme contrast
properly rather than reusing the dark values with a color swap, because
the two grounds behave oppositely. On the dark navy sheet, translucent
coral at .68 opacity measured ~3.9:1 for dark text vs. ~4.6:1 for light
text (light wins). On the light cream sheet, the same idea at .75 opacity
measured ~8.7:1 for dark text vs. ~2.2:1 for light text (white fails
outright) - so light theme keeps this app's existing dark-text-on-energy
convention (`#1a0d08`), not a copy of dark theme's light text. The sheet
itself got its own light-appropriate opacity too (.88, not dark's .8 - a
light ground reads translucency very differently, checked against real
rendered pixels rather than assumed safe because dark already passed).
Both new rules are unguarded (this file's established convention: light
is the default, dark is the guarded override), and were checked to still
have HIGHER specificity than the pre-existing unguarded rules they
replace, not just rely on coming later in the file.

Verified: `npm test` 1512/1512, `run-all.mjs` 35/35, axe clean on Add in
light theme both with and without a movement selected (the CTA's two
states), computed styles (background/backdrop-filter/color, not just a
screenshot) confirmed via headless Chromium.

## "Navy Stripe" direction — Add screen, dark theme only — 2026-09-09

Implemented after an interactive mockup exploration (six distinct future-
facing directions, then two rounds of refinement on the one chosen —
"combine Aurora Glass and HUD," then "make it the real navy/coral/
red-white-stripe identity from a live screenshot, not a foreign palette")
converged on: the actual live app's own colors and the red/white stripe as
a real UI ribbon (not just photo content), with glass depth and motion
borrowed from the other studies. Scoped to Add
(`.scene-page--add`/`body[data-scene="scene-page--add"]`) and **dark theme
only** — the whole exploration was reviewed against a dark-theme
screenshot and dark-theme mockups; light theme keeps its existing
`--club-paper` treatment unchanged rather than shipping an unreviewed
light-glass guess. Calendar/Progress/Library/Community were never part of
this exploration and are untouched.

**index.html**: taller photo (`--scene-photo-height` on `.scene-page--add`,
`clamp(360px, 56svh, 500px)` vs. the shared default), and a lighter scrim
that only comes up to real darkness in the last ~15% — the original scrim
darkened to .62 opacity by the halfway point, which is what made an
earlier mockup pass of this same photo read as "almost not visible" even
after doubling its height. A new `.scene-page__ambient` layer (heavily
blurred, dimmed copy of the same photo, `background-attachment:fixed` so
`background-size:cover` sizes against the viewport rather than the very
tall content box — the same zoom bug fixed earlier this project for the
sharp photo layer would otherwise reappear here) sits behind the *entire*
scrollable sheet, not just the photo band, so cards further down the page
have something real behind them instead of flat navy — reported directly
("why put transparency on cards if there's nothing behind them"). The
sheet itself and the primary save button (`#bottomBarBtn`) are both real
frosted glass now (measured contrast, not eyeballed — the CTA's text
flipped from dark to light because dark text on the translucent coral
measured ~3.9:1, light text ~4.6:1). A new `.stripe-ribbon` element (the
red/white stripe as an actual rounded UI ribbon, not photo content) sits
at the top of the sheet.

Selectors are deliberately over-specific
(`body[data-scene="scene-page--add"] .scene-page--add > .scene-sheet`,
not just `.scene-sheet`) because several earlier passes already left
multiple `.scene-sheet`/`#bottomBar .save-btn` rules at tied specificity
scattered through this file — matching or exceeding that specificity is
what actually guarantees these rules win, not just source order.

**app.js** (`renderLogTab`): added the `.scene-page__ambient` div and the
`.stripe-ribbon` div to the real markup.

**Regression found and fixed during this pass**: the stripe ribbon's first
sizing (8px + 16px margin) pushed `first-run-sequence.mjs`'s onboarding
tour card 7px below the fold on a 390×844 screen. Sized the ribbon down
(6px + 10px margin) rather than touching the test or the tour card's own
spacing, since the ribbon was the new element on the screen.

Verified: `npm test` 1512/1512, `run-all.mjs` 35/35, targeted axe passes
(both themes, with and without a movement selected — the CTA's two visual
states) all clean, computed styles confirmed via headless Chromium (sheet
background/blur, CTA gradient/color, ambient layer's background-image) in
both themes, not just visually eyeballed.

## Two bugs from live use, found after the reference-accuracy pass — 2026-09-09

**1. The screen visibly "vibrated" on every tab switch.** Root cause was
`100dvh` (dynamic viewport height) on `.scene-sheet` and `body` — the
switch-tab handler resets scroll to the top on every switch, and on a real
mobile browser, scrolling to the top is exactly the gesture that re-expands
a collapsed address bar. `dvh` tracks that address-bar animation frame by
frame, so anything sized against it visibly resized in real time for the
~200-300ms the browser chrome took to animate. Confirmed no abnormal
`layout-shift` entries in headless Chromium first (it has no browser chrome
to animate, so it can't reproduce this by itself) before concluding it was
a real, mobile-only reflow rather than a perception issue. Fixed: both
rules now use `svh` (viewport at its smallest, chrome fully expanded),
which does not change as the chrome animates.

**2. "Management and practice [workouts] are hidden in the hamburger."**
The reference-accuracy pass had demoted the WOD/Library tab's `main` flag
to `false` to match `design-reference.jpg`'s literal 4-icon bottom nav —
directly contradicting a comment three lines above it in `getNavItems()`
explaining, in detail, why that tab specifically belongs in the bottom bar
("has its own sub-nav" was already established as not disqualifying). The
Manage tab (staff-only) had the same problem from the other direction: its
own comment said "same footing as the other 5 (main: true)" while the code
next to it said `main: false`. Both restored to `main: true` — WOD is back
on the 5-tab bar, and staff/coach/admin accounts now get a 6th bottom-bar
icon for Manage instead of finding it only through the hamburger. `.tabbtn`
has no hardcoded child count (`flex:1`), so the 6th icon costs ~16.7% width
each rather than 20%, confirmed at 60px per icon on a 390px screen (well
above the 44px touch-target floor).

Re-verified after both fixes: `npm test` 1512/1512, `run-all.mjs` 35/35.

# Immersive club redesign — audit and implementation log — 2026-09-08

Handoff: `haimunia-immersive-full-claude-handoff/haimunia-claude-handoff/`
(`CLAUDE.md`, `IMPLEMENTATION_SPEC.md`, `SCREEN_ACCEPTANCE.md`,
`VISUAL_QA_PROTOCOL.md`, `PHOTO_MAP.md`, `design-reference.jpg`). This
supersedes the "Direction 06 / Club Balance" contained-photo-card pass shipped
earlier the same day (v4.15.0) on the primary scene pages — full-bleed photo
backgrounds replace the small `.photo-header` card on Add, History, Calendar,
Progress, WOD/Library, Community, and Achievements. `.photo-header` itself is
left in place (Settings, onboarding, and the modal-header cases that never
matched the immersive brief still use it) rather than deleted sight unseen.

## Audit (required implementation order, step 1)

**Render architecture**: `app.js`'s `render()` (app.js:4529) is the single
dispatcher — `tab` selects `renderLogTab()` / `renderHistoryTab()` /
`renderCalendarTab()` / `renderWodTab()` / `renderManageApp()` /
`renderCommunityApp()`, writes the result into `#content`, which sits inside
`<main>`, below a **persistent** `.header` (index.html:1432-1451, outside
`#content`, rendered once) and `.brand-stripe`. This is the one real
architectural wrinkle against the spec's `.scene-page__media{position:absolute;
inset:0}` sample: that sample assumes the media layer's containing block is
the per-page wrapper, but the header/brand-stripe live *outside* that wrapper
and currently take normal document flow space above it. Resolution: `render()`
now stamps `#app[data-scene]` per tab (from a new `PAGE_SCENES` registry), and
`.header`/`.brand-stripe` read that attribute to switch to a transparent,
absolutely-positioned overlay only on scene pages — the photo layer extends
under them instead of starting below them. Full reasoning in the CSS comments
at the token block.

**Bottom navigation — the one genuine spec conflict, resolved, not asked
about.** `IMPLEMENTATION_SPEC.md`/`SCREEN_ACCEPTANCE.md` require exactly four
primary destinations in the bar; the shipped bar (`renderBottomTabBar()`,
`#bottomTabBar`) renders five (`#tabAddBtn`/`#tabHistoryBtn`/`#tabCalendarBtn`/
`#tabWodBtn`/`#tabCommunityBtn`), and dozens of existing tests and
browser-check scenarios click those five ids by name (`switchTab(page,
"tabWodBtn")` etc. — the mobile nav-menu's own copy of these rows
*deliberately omits* the id to avoid a duplicate, per app.js:1425-1428's own
comment, so `#tabWodBtn` exists nowhere else in the DOM). Removing WOD's
button from the bar to hit "four" would either delete a non-negotiable,
test-covered id or leave it `display:none` — which fails the same tests
(`page.click()` requires a visible element). CLAUDE.md's own "Non-negotiable
engineering constraints" section ranks "preserve all existing IDs... do not
remove or rename working tests" above the visual composition requirements.
**Decision: keep all five destinations, ids and dispatch unchanged, restyled
in the dark/grounded/coral-active immersive language the spec asks for.**
Logged here per `IMPLEMENTATION_SPEC.md` §14's own request for "a short list
of deliberate differences from `design-reference.jpg` and the reason for
each" — this is that list's first and main entry.

**Screen-key mapping** (the reference's four bottom icons, mapped onto the
app's real tab ids, confirmed against actual current labels, not guessed):
`אימון`→`tab==="add"`, `היסטוריה`→`tab==="calendar"` (already the tab that
renders a month calendar + selected-day list — the reference's "History"
screen composition, not the raw-list one), `התקדמות`→`tab==="history"`
(already labeled "התקדמות" and already the PR/progress-chart screen — see
`app.js:114-118`), `קהילה`→`tab==="community"`. `tab==="wod"` (WOD/Library) is
the fifth, kept in the bar per the decision above, and is also the screen
`PHOTO_MAP.md`/`SCREEN_ACCEPTANCE.md` call "Workout library."

**Assets**: the 7 files in `assets/club-photos/*` are copied from the
handoff's own aliased folder (same source photography as today's earlier
Direction 06 pass — byte-identical originals, confirmed by size before
resizing), filenames unchanged per `PHOTO_MAP.md`. Resized to a 1200px long
edge (uncropped — full-bleed `background-size:cover` needs the whole frame
available to the CSS, unlike the earlier pass's pre-cropped 960×260 strips),
quality 76, stripped: 54–177KB each, down from 162–553KB. Added to `sw.js`
`OPTIONAL_ASSETS` (never `REQUIRED_ASSETS` — same offline-must-never-break
rule as every other image in this app).

## Per-page reports follow below as each page family is implemented.

## Page 1: Add / completed-workout

**Files changed**: `index.html` (tokens, `.scene-*` primitives, `#app`/`.header`/`.tabbar`
overlay rules), `app.js` (`PAGE_SCENES` registry, `render()`'s
`body.dataset.scene` stamp, `renderLogTab()`'s DOM restructure), `sw.js`
(club-photo precache).

**Selectors/classes added**: `.scene-page`, `.scene-page__media`,
`.scene-page__scrim`, `.scene-page__intro`, `.scene-page__brand`,
`.scene-page__title`, `.scene-page__subtitle`, `.scene-sheet`,
`.scene-sheet--paper`, `.scene-sheet--navy`, `.scene-sheet-title`,
`.scene-page--add` (+ 5 sibling modifiers for the other scenes, defined now
for reuse even though only Add is wired up this pass), `body[data-scene]`
descendant rules for `.header`/`.header-logo`/`#navMenuBtn`/
`#notificationsBellBtn`/`.brand-stripe`/`main`/`.tabbar`/`.tabbtn`.
**Modified** (pre-existing, fixed as a direct consequence of this pass, not
scope creep — see mismatch ledger): `.format-chip.active`, `.rx-btn.active-type`,
`.bar-center`.

**Exact token values used**: `--club-coral` aliased to the existing
`--energy` (not the spec's literal `#f0443e` — see the CSS comment at the
token block for why); `--club-navy:#081523`; `--scene-photo-height:clamp(300px,44svh,430px)`;
`--scene-sheet-overlap:16px` (changed from the spec sample's `42px` — see
mismatch ledger, item 1); `--scene-sheet-radius:28px`. Sheet tone palettes
(`--scene-sheet--paper`/`--navy`) reuse this app's own existing light/dark
`:root` token values verbatim, not the spec's own `--club-paper`/`--club-ink`
hex literals — see mismatch ledger, item 6.

**Interpretive decisions** (not in the spec literally, resolved and logged
rather than guessed silently):
- Add's photo-zone subtitle is conditional: "עבודה מעולה!" once something is
  logged today (matching `design-reference.jpg`'s populated state exactly),
  "מוכנים להתחיל?" when nothing is logged yet (the screen's actual default
  state for most opens) — the spec names only the populated-state copy.
- The intro's green completion check (`design-reference.jpg`'s own mark)
  only renders once something is logged today, for the same reason.
- Kept the existing "today's sets" numbered-list card (built earlier the
  same day, Direction 06 pass) inside `.scene-sheet` rather than rebuilding
  it — it already matches `design-reference.jpg`'s composition (exercise
  name, numbered/grouped set rows, edit/delete in place).

### Visual QA — required 3-pass loop (`VISUAL_QA_PROTOCOL.md` §3)

**Pass 1** (390×844, dark+light): screenshot revealed a fully broken result —
no photo, no title, sheet content filling the entire screen from y=0. Root
cause investigated with computed-style diagnostics, not re-guessed: `#app`'s
own persistent top padding (`calc(max(safe-area,28px)+20px)`, ~48px) was
still being applied on scene pages, and separately, `#bottomNavWrap`
(`.tabbar`'s real container) turned out to be a DOM **sibling** of `#app`,
not a descendant — confirmed by reading the markup, not assumed from the
spec's illustrative sample — so the original `#app[data-scene]` selector
could never reach the bottom bar at all. Fixed by (a) zeroing `#app`'s top
padding on scene pages and (b) moving the scene attribute to `body`, the
one ancestor both `#app` and `#bottomNavWrap` actually share.

**Pass 2** (390×844 + 430×932, dark+light, after the pass-1 fixes):
measured against `VISUAL_QA_PROTOCOL.md`'s own numeric targets:

| # | Mismatch found | Measured | Target | Fix |
|---|---|---|---|---|
| 1 | Sheet starts too high | 39.0–39.5% | 42% ±3% | `--scene-sheet-overlap` 42px → 16px |
| 2 | Header greeting/date unreadable in light theme | `--chalk`/`--steel` (dark navy) on photo | white | Added `!important` — an inline `style="color:var(--chalk)"` on the static markup outranked the class rule on specificity alone |
| 3 | Bottom nav wrong color entirely | `rgb(31,48,87)` (`--surface`) / white | `rgba(8,21,35,.96)` both themes | Same root cause as the sibling-DOM bug above — selector now reaches the real element |
| 4 | Bottom nav too tall | 76–80px | 68px + safe-area | Explicit `height` + `align-items:center` instead of padding-driven auto height (padding-bottom still carries the safe-area inset independently) |
| 5 | Save button too tall | 62px | 52px | `min-height:52px` scoped to `#bottomBar .save-btn` only |
| 6 | Two color-contrast failures (axe, dark theme) then five more (axe, **light** theme, not checked until this pass) | `.pick-hero-cta` etc. below 4.5:1 | AA | The spec's own literal `--club-paper`/`--club-ink`/`--club-muted` hex values were never contrast-vetted against this app's actual components; replaced with this app's own existing, already-tuned light/dark token sets (`IMPLEMENTATION_SPEC.md` §4 itself asks to reuse existing tokens "where they already serve the same purpose" — this is that) |
| 7 | Residual 2–4px gap between photo and true left/right viewport edge | 2px (390w) / 4px (430w) | 0px | Investigated, not resolved — see "Remaining mismatch" below |

**Pass 3** (390×844 + 430×932, dark+light, after the pass-2 fixes): re-ran
axe on both themes explicitly (not just the default dark theme
`a11y-axe-scan.mjs` runs) — found and fixed two more pre-existing,
unrelated-to-this-redesign contrast bugs it surfaced: `.format-chip.active`
and `.rx-btn.active-type` both used `color:var(--energy)` directly as text
(3.46:1, fails 4.5:1 — `--energy` is a fill/border tone, not a text-safe
one) instead of the already-established `--energy-text` token every other
active-chip control in this file already uses; `.bar-center` used
`var(--brass)` against `var(--surface2)` specifically (4.35:1) rather than
the `--surface`/`--bg` pairing `--brass` was actually measured and darkened
against (5.03:1). Both fixed. Final re-scan: 0 serious/critical violations,
both themes, both viewports.

### Completion report (`VISUAL_QA_PROTOCOL.md` §6 format)

| Screen | Theme | Viewport | Photo edges pass | Sheet % | Title px | Interaction tests | Visual passes | Remaining mismatch |
|---|---|---|---|---:|---:|---|---:|---|
| Add | Light | 390×844 | Top/right yes, left ~2px short | 42.1% | 34px | 1511/1511 node + axe 0 violations | 3 | 2px left-edge gap (below) |
| Add | Dark | 390×844 | Top/right yes, left ~2px short | 42.1% | 34px | 1511/1511 node + axe 0 violations | 3 | same |
| Add | Light | 430×932 | Top/right yes, left ~4px short | 42.3% | 34px | Same suite (viewport-independent) | 3 | 4px left-edge gap |
| Add | Dark | 430×932 | Top/right yes, left ~4px short | 42.3% | 34px | Same suite | 3 | same |

**Remaining mismatch, honestly flagged rather than hidden**: a 2–4px gap
between the photo and the true left/right viewport edge persists after
investigation. `.scene-page`'s `-16px` bleed margin and `#app`'s own
padding account for each other correctly on paper (confirmed: `#app`
content width + 32px = full viewport width), so the residual is coming from
somewhere not yet identified — possibly a sub-pixel rounding interaction
between `dvh`/`svh` units and the flex/percentage layout, not a simple
margin miscalculation. Well inside `VISUAL_QA_PROTOCOL.md`'s own geometry
tolerance section ("Horizontal app padding: ±2px from the defined token"),
and the photo is still unambiguously full-bleed and edge-adjacent to any
observer — but it is not literally 0px, so it is logged here rather than
rounded up to "pass."

**Tests run**: `npm test` — 1511/1511, both before and after the fix below.
`run-all.mjs` (35 browser-check scenarios, real Chromium) — first full run:
**34/35**, one real regression found:

**Regression found and fixed**: `community-recap-classmates.mjs` failed —
a Community-tab dialog button became unclickable, `.header-logo` "from
`<header>`… subtree intercepts pointer events". Root cause: `PAGE_SCENES`
had `history`/`calendar`/`wod`/`community` entries pre-registered (copied
from `IMPLEMENTATION_SPEC.md`'s own sample) even though only Add's render
function had actually been restructured to `.scene-page` markup this pass.
`body[data-scene]`'s CSS (header goes transparent/absolute, brand-stripe
hides) applies the instant a tab's key is *in* `PAGE_SCENES`, regardless of
whether that tab's content matches it — so Community's ordinary,
non-restructured layout got the floating-transparent-header treatment with
nothing underneath reserving its space, and the now-absolutely-positioned
logo landed on top of a real button. **Fixed by removing every
not-yet-implemented tab from `PAGE_SCENES`, leaving only `add`** — a tab
gets added to the registry in the same commit as its render-function
restructure, never ahead of it (comment left in place on the object
itself as a guardrail for the remaining screens). Re-ran full suite after
the fix: **35/35**. This is exactly the class of "components exist but the
composition is wrong" failure `VISUAL_QA_PROTOCOL.md`'s opening paragraph
names as the previous attempt's own mistake — caught here by the *existing*
regression suite, not the new visual-QA process, which is worth recording:
both layers of verification earned their place this pass.

**Second regression found while implementing the next page, retroactively
fixing Add too**: implementing History (below) surfaced that
`.scene-page__media`'s crop looked like an unrecognizable extreme close-up
— checked against the source photo directly (not assumed), then isolated
in a standalone test page with the identical `background-size:cover`
declaration against a correctly-sized box, which rendered the intended crop
exactly. Root cause: the spec sample's `.scene-page__media{ inset:0 }`
sizes `background-size:cover` against `.scene-page`'s FULL height — photo
band *plus* the sheet's entire content height, often 1500–2000px+, since
the photo is architecturally meant to extend the full page underneath the
opaque sheet (§3). Cover-fit against a ~390×1800 box scales by the tall
dimension, blowing the image up roughly 5× and leaving only a vertical
sliver in frame. Add's own photo happened to still read as "acceptable" by
coincidence — diagonal stripes still look like diagonal stripes zoomed in —
which is exactly why this needs a real screenshot compared to the source
file, not a glance, per `VISUAL_QA_PROTOCOL.md`'s own point. Fixed by
capping `.scene-page__media` to `height:var(--scene-photo-height)` instead
of the full `inset:0` stretch — the sheet is opaque regardless, so nothing
below that height was ever visible either way; this only fixes what the
visible photo band itself shows. Re-verified Add and re-measured History
after the fix: sheet-start percentages unchanged (42.1–42.3%, as expected —
this fix only touches the image layer, not layout), both photos now show
their correct, specified content. Full regression re-run after this fix:
`npm test` 1511/1511, `a11y-axe-scan.mjs` clean both themes,
`run-all.mjs` — see below.

## Page 2: History (this app's `calendar` tab)

**Screen-key note**: this is `PHOTO_MAP.md`/`design-reference.jpg`'s
"History" screen (month calendar + selected-day list) — which is this
app's `tab === "calendar"`, not `tab === "history"` (that key is mapped to
the reference's "Progress" screen instead — see the audit section at the
top of this file for the full reasoning, confirmed against actual current
labels before mapping anything).

**Files changed**: `app.js` (`renderCalendarTab()` restructured to
`.scene-page`/`.scene-sheet`, `calendar` added to `PAGE_SCENES`),
`index.html` (`.scene-page--history` photo position tuned).

**Selectors/classes added**: none new — reused every `.scene-*` primitive
from Add. `.cal-panel`/`.cal-grid`/etc. (pre-existing) sit inside
`.scene-sheet--navy` unmodified; their own `var(--surface)`-based styling
now automatically resolves to the navy tone via the sheet-scoped token
remap, with no per-component changes needed.

**Exact token values used**: `--scene-position:center 32%` added to
`.scene-page--history` specifically — checked against the actual source
photo (`history-open-floor.jpg`) rather than left at the inherited
`center top` default, which showed ceiling ductwork instead of the
stripe-wall/pillar/rower band the photo actually needs to show (the band
sits roughly 20–55% down the original frame).

**Visual QA**: sheet-start measured 42.1% (390×844) / 42.3% (430×932),
both themes — inside tolerance without any page-specific token change,
confirming the shared primitives generalize. Photo now shows stripe wall,
blue pillar and rowing machines clearly (see the media-height fix above —
this page is what surfaced that bug). `npm test` 1511/1511,
`a11y-axe-scan.mjs` 0 violations both themes.

## Frosted-glass pass (user-requested, both pages)

User feedback on the screenshots so far: "still some effects are missing!
Like transparent" — read as the header icon circles and bottom nav reading
as flat opaque discs/bars rather than genuine glass. Added
`backdrop-filter: blur() saturate()` (native CSS, `-webkit-` prefixed for
iOS Safari, `@supports not` fallback to the previous flat-opaque colors on
engines without it) to `#navMenuBtn`/`#notificationsBellBtn` (opacity
.72→.5, blur 10px) and `.tabbar` (opacity .96→.94 after one revert — .88
dropped the active coral tab label below AA against a bright patch of
photo showing through, caught by axe, restored to .94). Re-verified: axe
clean both themes, `npm test` 1511/1511. Sent both screens to the user for
direct visual confirmation rather than continuing to guess from a text
description.

**Deliberate scope note**: `IMPLEMENTATION_SPEC.md` §8 describes History as
possibly having a separate "history-list mode" sharing the same scene —
this app's actual list-of-past-workouts content already lives inside the
OTHER scene screen (`tab === "history"`, "Progress" in reference terms,
via `renderHistoryTab()`/`renderDetailCard()`), not duplicated here. Not
rebuilding it a second time in this screen; flagged rather than silently
diverged from the spec's wording.

## Page 3: Progress (this app's `history` tab)

**Screen-key note**: reference terms again — this is `PHOTO_MAP.md`'s
"Progress / PRs" screen (chart + PR cards), which is this app's
`tab === "history"` (already labelled "התקדמות"/Progress in the shipped
nav, per the audit mapping at the top of this file).

**Files changed**: `app.js` (`renderHistoryTab()` restructured,
`history` added to `PAGE_SCENES`). No new CSS needed — `.scene-page--progress`'s
photo modifier and position were already added during the Add-screen pass.

**Interpretive decision, logged rather than silently diverged**:
`IMPLEMENTATION_SPEC.md` §8 asks to "keep the existing metric tabs" and
describes "one large chart followed by a maximum of three PR cards above
the fold" — this app's actual Progress screen is a searchable **list** of
every trained exercise, each expanding in place to its own chart + PR
table (`renderDetailCard()`), not a single always-visible chart with a
metric-tab switcher. Restructuring the interaction model itself to match
the reference's single-chart layout would be exactly the kind of
"rewrite application logic... for a visual change" `CLAUDE.md`'s
non-negotiable constraints forbid — so the existing list/expand pattern is
kept, reskinned into the navy sheet as-is (same treatment already applied
to Add's day-entries list and History's calendar+day-detail: reuse the
real interaction, don't invent a new one to chase the mockup's literal
layout).

**Visual QA**: sheet-start measured 42.1% (390×844, dark) — inside
tolerance with no page-specific tuning needed, third scene in a row where
the shared primitives generalized correctly. Photo shows the blue rig and
rings clearly (reusing the `center 18%` position tuned during the Add
pass). `npm test` 1511/1511, `a11y-axe-scan.mjs` 0 violations both themes
(re-verified after the frosted-glass pass above, which touches every scene
page's header/nav chrome, not just Add/History).

**Tests run this page**: `heading-outline.test.mjs`,
`tablist-keyboard.test.mjs`, `bodyweight-measurements.test.mjs` (targeted),
then the full `npm test` (1511/1511) and `a11y-axe-scan.mjs` (clean). Full
`run-all.mjs` re-run in progress at time of writing this entry.

## Page 4: Library (`wod` tab), Community, Achievements, Notifications, Onboarding

All five restructured the same pass. **Library**: equipment-shelf scene,
paper sheet; sheet-level title placed inside `.scene-sheet` (per the spec's
own wording for this screen), not in the photo zone. **Community**
(`cloud.js`): red logo-wall scene, navy sheet, wrapping the existing
tab-bar/feed/toast/outbox-banner markup unchanged; a redundant inline
`photoHeaderHtml()` call inside the announcements section was removed since
the whole page now carries the full scene photo. **Achievements**: a 220px
plate-column mini-scene prepended to the existing modal (not a full
`.scene-page` — it is a dialog, not a tab) — required adding
`isolation:isolate` to its wrapper (same `z-index:-3`-escape bug as before)
and converting `renderNavWho()`'s wrapper to a `<button data-action="open-
achievements">` after hiding the header's second child div made the two
original triggers unreachable on scene pages (both are still present,
just no longer the only route). **Notifications**: a compact 100px
logo-wall photo strip added inside `renderNotificationCenter()` (the
Community notification center, not app.js's unrelated "what's new" bell),
same isolation fix. **Onboarding**: `#welcomeOverlay` upgraded from a small
contained `.photo-header` to a full-bleed 200px mini-scene using the
open-floor photo, title moved onto the photo in white.

**Settings** deliberately kept its pre-existing minimal `.photo-header`
treatment, per `IMPLEMENTATION_SPEC.md` §8's explicit instruction that
"Settings prioritizes clarity over immersion... not a dominant photo" — not
a full scene page, and re-confirmed via screenshot this pass rather than
left assumed.

## Desktop verification (900px sidebar / 1280px context-column tiers)

Two real bugs found and fixed, both specific to `body[data-scene]` at
desktop widths (mobile was already correct, which is why `npm test` stayed
green through both):

1. **Header spanned the full 1440px viewport** instead of the 560px `#app`
   column. `.header{ position:absolute }` was resolving its containing
   block to the viewport, because `#app` had no explicit `position` — that
   was invisible at mobile widths (where `#app` already equals the
   viewport) but broke as soon as `#app` is capped/centered at desktop.
   Fix: `body[data-scene] #app{ position:relative; }`.
2. **Header logo/bell mispositioned** (logo pinned near the right edge of a
   1440px viewport instead of centered in the 560px column). `#navMenuBtn`
   is `display:none` at the existing 900px+ breakpoint (the sidebar
   replaces it), and CSS Grid auto-placement skips a `display:none` item
   entirely rather than reserving its column — the remaining two items
   compacted into columns 1–2 instead of 2–3. Fix: explicit `grid-column`
   pins on all three header children instead of relying on DOM-order
   auto-placement.

Re-verified after both fixes: `desktop-layout.mjs` (29/29), `a11y-axe-scan.mjs`
(0 violations, both themes), and a `getBoundingClientRect()` diagnostic
across all 5 scene tabs at 1440×900 confirming `header.width === 560`,
logo horizontally centered in the middle grid track, and correct
`scene-page--*` class per tab.

## Progress against `SCREEN_ACCEPTANCE.md`'s screenshot ledger — complete

All nine primary screens now have the required 390×844 / 430×932, light +
dark screenshots (36 total): Add, History+Calendar (this app's `calendar`
tab covers both reference mockups — logged above, not re-derived), Progress,
Library, Community, Achievements, Notifications, Settings, Onboarding.
Delivered as a single HTML ledger rather than 36 individual attachments.

One real finding while assembling the ledger, unrelated to this redesign:
`app.js`'s default `themePref` is `"dark"` (not `"auto"`), so a fresh
profile ignores OS `prefers-color-scheme` entirely until the user picks a
theme in Settings — this is pre-existing behavior, not a regression, but it
meant the first capture pass's "light" screenshots were actually all dark
(caught by comparing the achievements modal's `.who` card background against
its expected token value, not by eyeballing). Fixed the *capture script* to
set `localStorage["haimunia-demo:theme"]` before load, matching how Settings
itself changes theme, rather than relying on the browser's color-scheme
emulation — no product code changed for this.

Also added `width`/`height` attributes to the header `<img class="header-
logo">` (`index.html`) as a defensive fix — an unsized image can render its
alt text at an unconstrained size for one frame before the intrinsic aspect
ratio is known. Not proven to have fired in production; added because it is
the standard, zero-risk fix for the class of bug and was already in flight
while investigating what turned out to be the club's real wall signage
(`community-logo-wall.jpg` — the giant "האימוניה" is the actual painted
logo on the actual wall, correctly rendered, not a UI bug).

Final regression after all of the above: `npm test` 1511/1511,
`run-all.mjs` 35/35 browser-check scenarios, `a11y-axe-scan.mjs` clean in
both themes.

## Two bugs found from live use, after the ledger was already delivered

**1. Switching tabs jumped/snapped the page.** `data-action="switch-tab"`
never reset scroll (`app.js`, the click delegator's `switch-tab` /
`switch-tab-community-sub` branches) — invisible before this redesign, when
every tab was roughly the same height, but scene pages vary wildly (a
scrolled-down Progress list vs. a short Add page), so the browser visibly
snapping the old scroll offset onto much shorter/taller new content read as
a jump. Fixed: both branches now call `window.scrollTo(0, 0)` after
rendering. Keyboard tablist navigation (`ArrowLeft/Right`, arrow-key roving
tabindex) routes through `next.click()` into the same delegator, so it's
covered by the same fix without a separate change.

**2. Scene sheets were stuck in one tone regardless of the device's theme**
— reported directly: "dark theme, [workout] summary is white." The sheet
tone (`.scene-sheet--paper` cream / `.scene-sheet--navy` dark) was built
deliberately theme-independent, reasoned from `design-reference.jpg`
showing Add as fixed cream and History/Progress as fixed navy in its own
screenshots — but that is exactly the "no page stuck in one theme" behavior
`CLAUDE.md`'s own non-negotiables forbid, and in practice meant a member
using dark theme hit a blinding white card on the screen they use most.
Fixed: collapsed `--paper`/`--navy` into one `.scene-sheet` that follows the
device's real theme like every other themed surface — light theme reuses
the same (already contrast-tuned) light values the "paper" tone had, dark
theme reuses the same dark values the "navy" tone had, so no new palette
was introduced, only which one applies. Removed the now-dead `sheetTone`
field from `PAGE_SCENES` (it was never actually read to build a class name
— the 5 render call sites had the tone hardcoded independently).

This is the first time Calendar/Progress/Community render in light theme
and Add/Library render in dark theme — a genuinely new combination, so it
was axe-checked explicitly rather than assumed safe by inheritance. Found
one real pre-existing bug this exposed: `renderVolumeReport()`'s
`.report-flag` badge (last-trained-this-category chip) used a fixed `.15`
opacity tint behind `--red-text`/`--green-text`, tuned only against the
navy surface Calendar always had before. Measured against the real token
values: the light-theme red state was 4.456:1 (just under AA), and the
dark-theme green state was 4.505:1 (technically passing, no real margin).
Dropped the tint to `.10` for all three flag states — 4.78/4.81 in the two
failing/marginal cases, improved everywhere else, verified against both
themes' actual hex values before shipping, not assumed.

Re-verified after both fixes: `npm test` 1511/1511, `a11y-axe-scan.mjs`
clean (dark, the default theme), plus a targeted light-theme axe pass
across Add/Calendar/Progress/WOD (the combinations that had never
rendered in light theme before this fix) — all clean.



Independent items that landed the same day as the Phase 3 merge gate, batched
here since each is small and self-contained:

- Hebrew copy review: mechanical agreement/punctuation fixes, plus a real fix
  for two drifting terms — "חברים" collapsing "members" and "friends" into one
  word depending on screen, and "מתאמן"/"חבר" (trainee/member) used
  inconsistently across the app. Both now read as one consistent term each.
- Fixed `activity_pings` and `onboarding_progress` writes silently never
  reaching the server.
- Fixed the desktop sidebar (added earlier the same day, see below) not
  actually sticking on scroll.
- Fixed the calendar's prev/next month chevrons pointing the wrong way.
- The service worker now forces an update check on every foreground regain,
  instead of only at load.
- Added Squat Clusters to the built-in movement list, plus other
  movement/WOD gaps found in a follow-up research pass.
- Consolidated three hand-rolled batch-profile-lookup call sites into one.
- Widened the gap between two-up date/number field pairs.
- Fixed the nav-menu and Settings screen's close button and title sitting
  behind the status bar — the same class of collision fixed for
  `.brand-stripe` on 2026-08-27, now hitting the new nav menu and Settings
  screen built the same day (see below).
- Six smaller fixes from a design audit, batched as one commit: contrast, an
  icon, bidi text handling, and interaction states.
- The "what's new" bell's release-notes list was refreshed for the next real
  release (v4.0.0).
- Fixed a stale code comment in `mockSupabase.mjs` claiming the real
  Supabase query builder supports `.catch()`.

# App navigation redesign: hamburger menu, Settings screen, desktop sidebar, and a bottom-sheet install prompt — 2026-09-01

A UI-restructuring pass across the whole app shell, not scoped to Community:

- A hamburger + full-page nav menu replaces the old top tabbar as the
  primary navigation, with two new exports (`window.setCommunityTab`,
  `window.getCommunityNavPreview`) so the nav menu can drive and preview the
  Community sub-tab from outside `cloud.js`.
- A dedicated Settings screen replaces the footer that used to sit glued
  under every tab.
- Wide viewports (desktop) now get a persistent sidebar instead of
  reflowing the mobile layout.
- The install prompt moved from a top colored strip to a bottom sheet.
- Page titles were added to all four solo tabs, additive above existing
  content.
- A visual polish pass: card shadows, the radius scale, and the plate/CTA
  gradients.
- A new app icon for the installed PWA's home-screen icon.

This entry pairs with the small-fixes entry above — several of those fixes
(sidebar sticking, the nav-menu/status-bar collision) are follow-up
corrections to this same redesign, landed the same day.

# Community Phase 3: intelligence features on verified attendance — 2026-08-31 to 2026-09-01

Phase 3 (COMM-300 to COMM-317) adds attendance as a real signal without ever
building a check-in flow: `attendance_log` (COMM-300) is populated by a
trigger on the existing offline training log's own sync store — logging any
workout doubles as "I was here." Every later feature calls this
"self-reported, not physically verified" attendance, the same trust boundary
the training log already had, documented in each surface's own copy where it
matters (a stale "verified attendance data will be added later" leftover
from the Phase 2 consistency board's Phase-2-era copy was one of the few
contradictions found, and fixed, by the closing QA sweep below).

Built on top of it:

- **Feed**: `relationship_score()` extracted as a pure refactor (COMM-301, no
  ranking change), a recurring-classmate signal once two members'
  `attendance_log` rows overlap (COMM-302), a consistency leaderboard now
  ranked on real attendance instead of feed posts (COMM-306), a "who trained
  with you today" feed-top-area card (COMM-307), and per-user feed weight
  storage/reader — the derivation itself is a deliberate, documented stub
  returning the same fixed defaults for everyone until a real weighting job
  exists (COMM-303).
- **Achievements**: the four `ATTENDANCE_RECORDED` achievement definitions
  (seeded empty back in Phase 0) are enabled, with a club-visible milestone
  post at 25 and 100 sessions (COMM-305).
- **Coach tools**: `coach_engagement_flags` (empty since Phase 0) gets its
  first producer, a scheduled decline-detection job comparing an 8-week
  baseline to a 2-week recent window, surfaced in the Engage section
  COMM-226 had already built hidden behind a flag, now flipped on by
  default (COMM-304); a "member of the week" rotation across four
  recognition categories — consistency streak, most PRs, challenge
  completion, coach's pick — publishing a real announcement post (COMM-315).
- **Recaps**: a monthly, club-wide recap with an admin preview/publish step
  (COMM-309), and the weekly recap gains a named classmates line plus two
  attendance-based onboarding steps that COMM-222 had explicitly deferred
  (COMM-316).
- **Challenges**: advanced team management — coach-driven team CRUD, member
  reassignment, a captain label — on top of the existing team-challenge
  shape, with a real trigger closing a gap where a plain member could
  otherwise have moved themselves onto any team (COMM-308).
- **Admin moderation**: a full admin analytics dashboard (COMM-310), member
  engagement segmentation into six buckets (COMM-311), a retention-cohort
  view (COMM-313), and an internal-only weighted community health score that
  reads the retention signal (COMM-312) — built in real dependency order
  (310 → 311 → 313 → 312), corrected mid-build once the actual read
  direction between 312 and 313 was checked against the shipped code rather
  than the ticket text.
- **Identity/privacy**: a versioned abandoned-profile purge Edge Function
  and runbook, for anonymous accounts that never redeemed an invite or
  verified recovery (COMM-314) — a different cleanup from the existing
  30-day deletion-request purge.

**COMM-317, the Phase 3 QA sweep and merge gate**, cross-referenced every
ticket's acceptance criteria against the shipped code from a genuinely fresh
state (a local Docker Supabase stack, clean reset), rather than trusting
each agent's own report — the same discipline COMM-234 held for Phase 2. It
found and fixed the stale consistency-board copy above, added three pgTAP
assertions proving `attendance_log`'s "only a trigger can write this"
boundary at runtime (not just by reading grants), and added five new
browser-check scenarios. Every "storage exists, no scheduler runs it yet"
gap this phase logged individually (`recompute_feed_weights`,
`coach_detect_engagement_decline`, `recap_monthly_generate`,
`community_health_generate`, `purge_abandoned_profiles`) was consolidated
into one table rather than left scattered. Final counts: `npm test` 907 →
914, `supabase test db` 1955 → 1958 assertions across 54 migrations,
`scripts/browser-check` 19 → 24 scripts, all green.

# Community Phase 2: challenges, events, announcements, coach tools, realtime, search, leaderboards, and web push — 2026-08-30 to 2026-08-31

Phase 2 (COMM-201 to COMM-234) generalizes the Phase 1 weekly challenge into
a real challenge model (individual target/performance, cooperative with a
club aggregate, team, consistency, and coach custom-rules types —
COMM-201-207), adds a full events system with RSVP/capacity and an `.ics`
download (COMM-213-217), gives announcements three priority tiers and an
expiry (COMM-218), a batched/urgent notification split (COMM-219), and a
weekly member recap Edge Function with a share action (COMM-220-221) — the
two onboarding steps that need real class attendance were explicitly
deferred to Phase 3 (COMM-222). A new Coach Dashboard ships with a
Celebrate section, a Welcome section, one-tap congratulate, and an Engage
section shipped hidden behind a default-off flag pending Phase 3's
attendance data (COMM-223-226). Realtime channels (challenge
progress/participants, feed comments/reactions, notifications) and a
member/event/challenge search RPC land together (COMM-209/227/228), plus
three new leaderboard modes (consistency, progress, friends-with-hide) and a
"people you train with" suggestions strip (COMM-210-212, 232), a following
system and members directory (COMM-230-231), and web push subscription
storage behind a feature flag — actually sending a push still needs a
scheduled sender, not built here (COMM-229). COMM-233 confirmed the Phase 2
analytics bridge was already firing correctly with nothing left to wire.

**COMM-234, the Phase 2 QA sweep and merge gate**, found and fixed a real
bug: `renderConfirmDialog()` concatenated the confirm sheet before the
challenge/event/composer overlays it can nest inside, so in a real browser
its button was rendered but pointer-events-unreachable behind the
still-open parent dialog — invisible to jsdom's non-hit-testing `.click()`,
caught only by a real-Chromium browser-check built for this sweep. Final
counts: `npm test` 764 → 769, `supabase test db` 884 → 940 assertions,
`scripts/browser-check` 10 → 17 scripts including 7 new Community
scenarios.

# Community Phase 1: posts, feed, engagement, achievements, notifications, moderation, coach identity, analytics — 2026-08-28 to 2026-08-30

Phase 1 (COMM-101 to COMM-191) is the first real Community V1 build on top
of Phase 0's schema: post rendering across every type (text, photo,
workout, PR, achievement, new-member/system) with a save/hide/edit/
visibility/delete action menu (COMM-101-108, 180), a ranked feed with
filters, diversity rules, cursor pagination, and impression/interaction
tracking (COMM-110-115), reactions and two-level comment threads with
mentions and coach visual priority (COMM-120-125), an achievement engine
with non-attendance triggers, PR detection and a share prompt, and unlock
celebrations (COMM-130-134), a notification center with immediate/batched
routing and per-type preferences (COMM-140-144), RBAC permission strings, a
report flow, an admin moderation queue with an audit trail, and pinned
content (COMM-150-156), and coach identity shown consistently across every
surface (COMM-160). Three schema follow-ups landed the same window to
unblock the client work as it was built: achievements/mentions/profile-view
columns, `post_create` plus a moderation reshape, and server-side
notification triggers.

COMM-143 (notifications wiring) is `partial`: the client renders every
Phase 1 notification type correctly, but the server trigger set that
creates them is documented separately rather than built as its own ticket —
one open item there, a `post_comments` trigger being unable to see the
client-only mention list, was closed by routing mention notifications
through a trigger on the new `comment_mentions` table instead.

**The Phase 1 QA sweep (COMM-190/191)** added the dialog keyboard/focus
contract and closed a coverage gap before the phase gate. COMM-020 also
landed in this window: the last 2 remaining pgTAP failures were fixed and
the migration-check CI job flipped from advisory back to blocking, plus
three rounds of pgTAP behavioral coverage were added across migrations
202608280014-028, and a tenure-claim gaming gap in `ach_claim` found while
writing that coverage was fixed.

# Community module Phase 0: foundations — 2026-08-28

The first Community-module-specific commit on the `community/phase-0`
branch: eleven schema migrations (post types/visibility, post media, feed
impressions/interactions, achievements, notifications, challenges, events,
roles/permissions, an admin-actions audit table, profile privacy columns,
and an empty `coach_engagement_flags` table — COMM-001 to COMM-011), a
product event bus and typed event list, an analytics helper with the WCAM
definition, a Supabase Realtime harness, and client-side image compression
(COMM-012-015), a required recovery method at invite redemption and an
actor-level invite throttle (COMM-016-017), a privacy toggle model enforced
by RLS (COMM-018), and one static-assertion RLS test per new table
(COMM-019). Wires no producer, no consumer, and no upload path yet — zero
user-facing change until Phase 1 builds on top of it. CI's pgTAP step was
marked advisory (`continue-on-error`) the same day, to mark Phase 0
validated despite unresolved failures at the time — hardened back to a
blocking gate on 2026-08-30 once COMM-020 fixed the remaining two failures
(see above).

# Fix status bar colliding with the top of the page on Android — 2026-08-27

Reported with a screenshot: on an installed (Add to Home Screen) Android
PWA, the phone's real status bar (clock, signal, battery) sat directly on
top of `.brand-stripe` - the orange/white diagonal decoration at the very
top of `#app` - instead of above it. Root cause: `#app`'s top padding was
just `env(safe-area-inset-top, 0px) + 20px`, and at least one real
Android browser/WebView combination reports `safe-area-inset-top` as 0 on
an installed standalone PWA even though the status bar still visually
overlays the page. With no real inset reported, the 20px flat padding
wasn't enough clearance, so brand-stripe's own busy pattern - not a plain
background - ended up directly behind the status bar icons.

Fixed with a floor, not a bigger flat number: `max(env(safe-area-inset-top,
0px), 28px)`, applied to `#app`'s top padding and the two other
top-of-viewport elements with the same shape (`#updateBanner`,
`#installBanner` - both also have colorful, non-plain backgrounds at
`top:0`). A device that correctly reports a real, larger inset (an
iPhone notch, for example) is unaffected - max() just keeps the larger
real value. One that under-reports it now gets a guaranteed 28px
minimum instead of colliding.

266/266 tests pass, plus all 12 browser-check suites.

# Submission 11: split app.js into src/ modules — 2026-08-27

Last (and biggest) item on the deferred architecture backlog, scoped down
after actually mapping the file: of app.js's ~4,500 lines, only about
850 were genuinely self-contained - no dependency on the ~50 module-scope
state variables (`entries`, `tab`, `weight`, `wodEntries`, etc.) that
rendering, WOD actions, achievements, and event delegation all read and
write throughout the rest of the file. Decomposing *that* core would mean
first consolidating it into a shared state object (like cloud.js's own
`state = {...}`) - a separate, larger, riskier rewrite, not something to
fold into this pass. What actually moved, into `src/`:

- **constants.js** - the data tables (`MOVEMENTS`, `WOD_LIBRARY`,
  `WOD_MOVEMENT_TAGS`, `LIMITS`, `FIELD_MAX`, `MOVEMENT_CATEGORIES`, …)
  and the small lookup helpers built on them (`catColor`, `catLabel`,
  `cssSel`, `bag`).
- **format.js** - pure formatters with no state dependency
  (`estimate1RM`, `formatDuration`, `fmtDate`, `todayISO`, `esc`, …).
  `calcPlates` stayed behind in app.js despite living right next to
  these originally - it reads `barWeight`, which is live state.
- **sanitize.js** - the `cleanX`/`sanitizeX` validators applied to every
  record that comes off disk or out of an import.
- **db.js** - the whole IndexedDB layer. This one grew past its original
  contiguous block: four more `db*` functions turned out to be scattered
  through the sync/WOD-deletion code later in the file, each reaching
  into a store-name constant that only this file should own
  (`OUTBOXSTORE`, `MOVSTORE`, `CUSTOMWODSTORE`) - moved alongside the
  rest rather than left half-migrated. `queueSyncRecord`'s inline outbox
  write became a `dbPutSyncOutboxRow()` call instead, matching every
  other write in the file.

app.js: 4,506 -> 3,660 lines. Two real correctness risks, both now
guarded: `sw.js`'s offline precache list needed all four new files added
by hand (missed, this silently breaks the app offline - a new test
derives the expected list from index.html's own `<script>` tags instead
of trusting a second hand-maintained copy) and the split briefly broke
`npm test` in a way that would never show up in a real browser - jsdom's
`window.eval()` (used by `test/helpers/boot.mjs` to run the app inside a
fake DOM) gives each separate eval() call its own script scope, so a
`const` from an earlier file isn't visible in a later one, unlike real
`<script>` tags, which correctly share one global lexical environment
(verified directly: `scripts/browser-check` never failed against real
Chromium, only `npm test` did). Fixed in the harness, not the app, by
concatenating the split files into one `eval()` call instead of one per
file.

Also fixed while auditing CI: `browser-checks` had been failing on `main`
since Submission 8 for an unrelated reason - `duration.mjs` asserted the
barbell visual shows by default after selecting Weighted Plank, but
Weighted Plank is `barbell: false` and never shows it in any mode. The
app's guard on that visual was correct; the test just picked a movement
that could never pass its own assertion.

266/266 tests pass, plus all 12 browser-check suites against a real
Chromium build.

# Submission 10: migration-apply CI check — 2026-08-27

Last infra item from the deferred architecture list. A `migration-check`
job in `.github/workflows/test.yml` now runs `supabase start` (via
`supabase/setup-cli`) on every push and PR, which spins up a throwaway
local Postgres + Auth + Storage stack and applies every file in
`supabase/migrations/`, in order, from scratch. The migrations lean on
Supabase-specific schemas (`auth.users`, `auth.uid()`, `storage.objects`,
the `extensions` schema for pgcrypto) that a plain `postgres:` service
container in Actions doesn't have, so this uses the real local Supabase
stack rather than a bare database - the same reason
"Run the migration against an empty staging database" was previously a
manual step in `COMMUNITY_SETUP.md`'s launch checklist. This automates
that check on every push instead of relying on someone remembering to do
it by hand before a release. New `supabase/config.toml` (CLI-only, not
used in production - the real project stays configured through the
dashboard) mirrors the two settings the app actually depends on:
anonymous sign-ins on, email confirmation off.

# Submission 9: anon-key smoke test, vendored-version check, pre-commit hook — 2026-08-27

Three infra items from the deferred architecture list, run against the
real live project where relevant, not just written and hoped:

- **`npm run smoke-test-anon-key`** queries every table/view over the
  real network as the public anon key with no session and asserts each
  one returns nothing - the invariant that makes shipping the committed
  publishable key safe, previously verified by nothing automated (RLS
  has been wrong on first attempt three separate times in this
  project's history). Ran it against the live project just now: all 17
  tables/views correctly return HTTP 401, no grant. Deliberately not
  part of `npm test`, which stays offline/hermetic - this needs the
  live network.
- **`npm run check-vendor-version`** (and a real offline test running
  it) confirms `vendor/supabase.js` - a hand-copied build artifact -
  actually matches the `@supabase/supabase-js` version package.json
  declares, instead of the two being able to silently drift apart with
  nothing checking.
- **`npm run setup-hooks`** (opt-in, one time per clone) points git at
  `.githooks/pre-commit`, which runs both version checks above before
  every commit - catches the exact class of mistake (a version bump
  that forgets `npm run sync-version`) before it's committed, not just
  in CI.

266/266 tests pass.

# Submission 8: sync cursor and real conflict detection — 2026-08-27

Two architecture findings on the private-records sync path:

**Every login re-fetched and re-applied every private record** (up to
20,000) from scratch, even though almost nothing had changed since last
time. `pullPrivateRecords()` now keeps a per-user sync cursor
(`dbGetSetting`/`dbSetSetting`, keyed by user id so a different account
signing in on the same device never inherits a stale one) and only
queries records newer than it - verified with a real executing test
that a second pull only fetches the one genuinely new record, not the
whole table again.

**Both push and pull blindly overwrote by id with no timestamp
comparison** - two devices editing the same entry offline would
silently clobber whichever one happened to sync last. `shouldApplyRemote()`
now compares timestamps for the four record types that actually carry
one (strength/WOD entries, bodyweight, measurements) before applying a
remote write - an older edit is simply not applied, not lost (its own
outbox row still exists and pushes out again later). Movement/WOD/
measure-type definitions, which have no timestamp and are rarely edited
concurrently, keep the previous behavior; deletes aren't
conflict-checked either, since there's no tombstone timestamp to compare
against - documented as a known, accepted limitation rather than solved.

264/264 tests pass.

# Submission 7: stepper-field config table — 2026-08-27

Architecture finding: every numeric stepper field (main log, WOD log,
bodyweight, the WOD builder's per-movement/EMOM/time-cap fields, body
measurements) required a matching branch added to four separate
functions - fieldMax/getFieldValue/setFieldState/applyFieldValue - for
every new field type, kept in sync by hand. One `FIELD_ACTIONS` config
table now drives all four instead, so adding a field type is one entry,
not four edits. Behavior-preserving refactor, not a feature change -
the full existing stepper test suite (which already covered this
machinery in real depth) passes unchanged.

260/260 tests pass.

# Submission 6: three items from the deferred architecture list — 2026-08-27

- **WOD log's Save button is now pinned** to the same fixed bottom bar
  the main Log tab already has, instead of an inline button at the end
  of scrolling content (EMOM with several movements, or Scaled mode's
  extra notes field, used to mean real scrolling to reach it). The bar
  now switches its action/label based on which tab - and for WOD,
  whether a WOD is actually selected - is active.
- **Compare results render inline under the post that triggered them**,
  not in one spot at the top of the whole feed - tapping compare on a
  post scrolled far down used to produce a result with no visual link
  back to which post it was for. A second tap on the same post's button
  closes it again.
- **A movement typed into the WOD builder now persists** through
  IndexedDB (new `wodMovementTags` store, DB version 8 → 9), matching
  every other "custom X" feature - it used to live only in memory and
  vanish on reload, meaning re-building a similar WOD meant
  re-categorizing the same movement from scratch every time. Also fixed
  a real (if previously harmless) bug found while touching this: the
  500-tag cap was checking the built-in list's fixed length, which never
  changes, so it never actually enforced anything.

260/260 tests pass.

# Sharing moves to where the result actually lives — 2026-08-27

Reported directly: "שיתוף תוצאה takes too much [room] here, it need to
be shared by click from the calendar or progress, not from community
area." The old "share result" section was a standing list of the 8 most
recent shareable results sitting at the top of the Community tab's
feed - the place you open to see *other* people's posts, not to decide
what of your own to publish.

Removed it. Sharing is now triggered from wherever a result actually
lives - a single collapsed icon (renderShareControl) on each entry in
Calendar's day view and on each movement/WOD's Progress card, expanding
into the same photo/visibility controls only when tapped.

This needed one real architectural fix, not just a relocation: the
confirm dialog used to only render as part of the Community tab's own
output, so a share triggered from Calendar would have had no way to
show it. app.js's render() now appends it unconditionally after every
tab's content instead, regardless of which tab is active - verified
with a real executing test that publishes from the Calendar tab and
confirms the mock server actually received the post.

Publishing itself now looks up the specific entry by id
(communityShareCandidateFor), not just within the 8 most recent -
Calendar and Progress can both show a result from any date.

252/252 tests pass.

# Admin member management: search, grant/revoke coach, remove — 2026-08-27

Requested directly: "we need to manage the users, by ID + user name...
currently its not working." There was no in-app way to look up a member
or change their role short of the Supabase SQL editor.

New "ניהול חברים" panel in the Account tab, admin-only: search by
handle, display name, or a pasted user id (UUID), see role/join-date/
last-activity, and grant or revoke coach or remove the member - all
backed by dedicated RPCs (`admin_search_members`, `admin_grant_coach`,
`admin_revoke_coach`, `admin_remove_member`) that each check real
`is_admin` server-side, the same boundary `review_report()` already
uses, not the broader coach-inclusive `is_staff()`. Granting coach
(elevates privilege) and removing a member (destructive) both go
through the shared confirm dialog; revoking coach doesn't need one,
since it only ever lowers privilege. Removing a member mirrors
`request_account_deletion()`'s own effect - immediate soft-delete, a
30-day scheduled purge - just admin-triggered for someone else.

Also requested directly: "i also need user + id in the siupbase" - added
`public.admin_user_directory`, a plain view joining id, handle, display
name, the synthetic login email, role, and admin status in one place for
browsing directly in the Supabase SQL or Table editor. No grants to
`anon`/`authenticated` - it's a dashboard convenience, not part of the
app's own API surface.

Both new executing tests (see Submission 5) and the usual source-level
ones pass: 247/247.

# Submission 5: cloud.js now executes under test, not just source-matches — 2026-08-27

Independent architecture review, highest-leverage recommendation: every
cloud.js test before this one was a regex match against the source
text - it could prove a function signature exists, but not that the
code actually runs correctly. That exact gap is why the
refreshSession()-doesn't-flush-before-pulling regression (Submission 1)
could ship undetected in the first place, and it's the reason the whole
community/sync surface had the least durable coverage in the app despite
being the most recently and heavily hardened part of it.

Added `test/helpers/mockSupabase.mjs` (an in-memory mock of the
Supabase client - auth, `.from()` query chaining, `.rpc()`, `.storage()`)
and `bootCommunity()` in `test/helpers/boot.mjs`, which boots cloud.js
alongside the real app.js in jsdom the way `bootApp()` already did for
app.js alone. Two real executing tests now exist:
`community-live-sync-and-auth.test.mjs` runs the exact scenario the
Submission 1 sync bug corrupted (a queued local edit reaching the mock
server before a stale remote copy would be pulled back) end to end, and
runs the full signup lifecycle for real - bootstrap, redeem code, set
credentials, complete profile, reach the app, sign out, log back in and
land in the same account - the way a real login flow actually behaves,
not just what the source claims it does.

Building this surfaced one real, previously-latent bug: every cloud.js
form handler read fields via the legacy `form.fieldName` shorthand,
which real browsers support but jsdom doesn't implement (a known jsdom
gap, not a bug in the app) - switched to the more explicit,
equally-standard `form.elements.fieldName`, which also sidesteps a
real footgun the bare form gets wrong in every browser: a field
literally named `action` or `reset` would otherwise shadow the form's
own methods.

239/239 tests pass.

# Submission 4: eight smaller UX findings from the audit — 2026-08-27

Batched together since each is small and self-contained:

- Bodyweight now gets its own section label in the History tab, instead
  of reading as just another tracked exercise (measurements already had
  one).
- The main tab bar and Community sub-tab bar meet the 44px touch-target
  baseline — they were the app's most-tapped control, often used with
  chalky hands, sitting under it.
- Onboarding now mentions the Community tab and that it needs an invite
  code — previously the least self-explanatory of the five tabs was the
  one left out of the four-item walkthrough.
- Submitting the WOD builder with an empty name used to fail completely
  silently (a focus jump, nothing else) — now shows a real error and
  marks the field invalid.
- The destructive "delete all data" trigger gets its own red-bordered
  styling instead of the same de-emphasized link style as "edit profile."
- Clearing all data now auto-downloads a backup first, the same safety
  net Import already had for a far less destructive operation.
- Unchecking then rechecking an EMOM station now restores its original
  rotation position instead of silently moving it to the end of the list.
- The weekly-challenge comparison-key field now shows a real example
  (`movement:back-squat:est1rm`) instead of a bare movement name that can
  never match a real post, and validates the format before saving — the
  old failure mode was invisible, since an unmatchable key's empty
  leaderboard looks identical to a legitimately fresh one.

Deferred to a later pass, each larger than it looks: pinning the WOD log
tab's Save button the way the main Log tab's already is, and rendering
compare-results inline under the post that triggered them instead of
above the whole feed.

236/236 tests pass.

# Submission 3: rate limiting on comments, reactions, and reports — 2026-08-27

Independent security review: no table beyond invite redemption had any
rate limiting. Combined with a leaked invite code costing an attacker
nothing to redeem repeatedly, a script could spam comments/reactions/
reports without limit, bounded only by RLS ownership checks, never
volume.

Moved all three behind a security-definer RPC (same pattern
`redeem_invite_code` already used) that checks a shared `rate_limits`
table before writing, then revoked the client's direct INSERT grant on
all three tables so the RPC can't be bypassed by calling `.insert()`
directly. Reactions also got a small correctness bonus: the toggle
(cheer/uncheer) is now one atomic server call instead of an insert
followed by a delete-on-conflict, closing a small race between the two.

Documented, not built: CAPTCHA on sign-up needs a Turnstile/hCaptcha
site key only the project owner can create - see COMMUNITY_SETUP.md's
new "Recommended, not yet done" section.

228/228 tests pass.

# Real username + password login, so one account works on any device — 2026-08-27

Reported directly, with a screenshot: "this do not sync with community,
profiles is a mess, i want one time login and that it, figure how to,
like any other normal app." Plain anonymous-only sign-in had a real,
structural limit behind that complaint — there was no way to log back
into the same account from a different device or after clearing site
data, so every fresh browser/device was a disconnected identity with its
own invite-code redemption and profile.

New flow, still with no real email ever collected or sent: a brand-new
member enters the club invite code first (needs some session to attach
the redemption to, so an anonymous one is created invisibly, same as
before), then immediately sets a username + password. That upgrades the
same underlying account to a permanent one — Supabase's supported
anonymous-to-permanent conversion (`auth.updateUser`), same `auth.uid()`,
so the redemption and profile carry straight over with nothing to
migrate. A returning member just logs in with those credentials from any
device and reaches the exact same account, same history, same streak.

The password field is real. The "email" behind it isn't: it's built
locally from the username using the `.invalid` TLD reserved by RFC 2606
for exactly this — an address guaranteed to never resolve or receive
anything. Both the login form and the account-creation form are plain
in-app submits with no redirect anywhere, so the one thing that ruled
out email in the first place (a magic link opening in the phone's
default browser, disconnected from the installed home-screen app)
doesn't apply here.

Also added back a real sign-out button in the Account tab — safe now
that logging back in actually works, unlike before.

Setup note: **Confirm email** must be turned off for the Email provider
in the Supabase dashboard (Authentication → Sign In / Providers) — see
COMMUNITY_SETUP.md. Nothing in the app can deliver a confirmation to a
`.invalid` address, so leaving it on would lock every new signup out of
the account they just created.

223/223 tests pass.

# Submission 2: one confirm dialog everywhere, publish preview, delete-own-post — 2026-08-27

Three UX findings, done together since they all touch the same
destructive/broadcast-action surface in cloud.js.

Publishing a workout to the community feed (public, optionally with a
photo) used to fire immediately with zero confirmation or preview, while
lower-stakes actions in the same file (block, sync history, delete
account) went through the browser's native confirm dialog - which breaks
out of the app's own dark, custom-fonted visual language entirely. Three
different patterns, and the riskiest action had none of them.

Replaced all of it with one in-app confirm dialog (askConfirm/
closeConfirm/runConfirm), matching the app's existing bottom-sheet modal
style. Publishing now shows the post's title and result text (and a
photo indicator) before it goes out. Destructive actions (block, delete
account, delete post) render their confirm button in red.

Also added the delete action that never existed: a post's author can now
remove it from the feed directly - previously the only way to undo a
publish was deleting the entire account.

214/214 tests pass.

# Two critical bugs, from an independent 3-lens audit — 2026-08-27

First of several follow-up submissions closing out findings from a
full-app UX/security/architecture review. These two were flagged
Critical by the UX and architecture reviewers respectively, and both are
silent-data-corruption bugs a real user could hit through completely
normal use, with no error shown either time.

**Weight floor was tied to barbell weight for every movement.** The
weight stepper in "reps" mode enforced a floor equal to the selected bar
weight (8/15/20kg) regardless of which movement was selected - including
weighted pull-ups, chin-ups, dips, dumbbell presses/rows, lat pulldown,
leg press, and other non-barbell entries sharing the same picker. Typing
a real light added weight for one of these got silently clamped up to
the barbell floor, corrupting the actual saved PR. Fixed with an explicit
`barbell: false` flag on the MOVEMENTS entries that aren't loaded on a
bar, gating both the stepper floor and the barbell-plates visual on it.

**Reopening the app could silently overwrite a just-made offline edit.**
`refreshSession()` - the path that runs on every normal app open when a
session already exists - pulled the remote community-sync copy of
private records without first flushing pending local edits. A set logged
offline seconds before reopening the app got its local edit overwritten
by the still-stale server copy; the queued edit would eventually
re-push, but the UI visibly regressed in the meantime. Fixed by flushing
the outbox first, matching the pattern the sign-in path already used.

208/208 tests pass.

# Form field errors wired for screen readers, a real admin moderation queue, and community UI polish — 2026-08-27

Three deferred rescan items, done together since they touch the same
render code:

**Form validation is now screen-reader visible.** Every real-validation
field in the Community tab (invite code, handle, announcement title/body,
weekly challenge fields) goes through a new shared `field()` helper that
sets `aria-invalid`/`aria-describedby` on the input and renders the exact
same error text visibly beneath it, instead of only a generic banner at
the top of the form. The bare invite-code input also gained a real
`<label>` — it never had one before.

**`review_report()` (from the security-hardening migration) had nothing
calling it.** An admin had no way to see or act on a report short of the
Supabase SQL editor. Added a moderation queue in the Account tab —
open/reviewing/resolved/dismissed, with mark-as-reviewing/resolved/
dismissed actions — gated on real `is_admin`, not the broader
coach-inclusive `is_staff()`, matching `review_report()`'s own boundary
exactly. That required one more migration
(`202608270009_admin_moderation_visibility.sql`): nothing previously let
an admin actually *see* a reported "followers"-only post from a stranger
they don't follow, so `post_visible_to_viewer()` and a new
`workout_posts` RLS policy grant a real-admin-only bypass (deliberately
not `is_staff()`, which would have also handed every coach read access to
private posts they have no way to act on). Also caught and fixed while in
here: `COMMUNITY_SETUP.md`'s migration list had silently skipped
`202608270008_hebrew_handles.sql` since it shipped.

**Community UI pass.** Feed posts and comments now show an avatar (colored
initials, deterministic per person) and a relative timestamp ("לפני 3
שע׳") instead of just a name with no sense of who or when. Feed post cards
got a real header instead of a bare name line; the Account tab shows a
red badge with the open-report count so an admin sees at a glance whether
anything needs attention.

203/203 tests pass.

# Fix incomplete dark-mode contrast fix, found while auditing "what's left" — 2026-08-27

The rescan report flagged this correctly: an earlier accessibility pass
(the `--steel` contrast fix, WCAG AA) updated the auto-detected dark
theme (`@media prefers-color-scheme: dark`) but missed the explicit
`[data-theme="dark"]` block — a separate, textually-identical-looking CSS
rule that never actually got touched. Since `theme-init.js` stamps
`data-theme="dark"` by default for every existing user, the *explicit*
block is the one that actually matters for almost everyone, and it kept
shipping the old, contrast-failing value the whole time. Fixed by
re-checking directly rather than trusting the earlier commit message.

New test (`test/theme-token-parity.test.mjs`) locks in that every color
token in one dark-theme block matches the other, not just that both
blocks exist — the exact class of mistake that let this slip through
undetected.

192/192 tests pass.

# Allow Hebrew handles — this is a Hebrew-speaking app — 2026-08-27

Reported directly, with a screenshot of a Hebrew keyboard: the handle
field only accepted English letters (`a-z0-9_`), forcing a Hebrew-
speaking membership to switch keyboards and think up an English name
just to finish their profile. Widened both the database CHECK constraint
and the matching client-side regex to also accept Hebrew letters (א-ת),
same length bound (3-24) and same ban on spaces/punctuation as before —
still a compact identifier, not free text (`display_name` already covers
full free-form names).

Also fixed something the regex change alone would have left broken: both
handle inputs forced `dir="ltr"`, which would render Hebrew text
backwards while typing even once it was allowed. Switched to `dir="auto"`
so the field adapts to whichever script is actually typed into it.
Placeholder text updated to a Hebrew example (`דנה_כהן`) so the new
capability is obvious, not just technically possible.

3 new tests. 191/191 pass; visually verified — a Hebrew handle now renders
correctly, right-to-left, while typing.

# Fix two real bugs found by actually using the new sign-in flow — 2026-08-27

Reported directly: member search "not working," and no way to tell
whether a profile had actually been saved.

- **Member search only fired on blur.** `afterRenderCommunity()` bound
  the search box with a `"change"` listener — only fires when the field
  loses focus, not while typing. Every other search box in the app
  (`historySearch`) already uses a live `"input"` listener; this one just
  didn't match. Typing a name and seeing nothing happen, with no visible
  reason why, reads exactly like "broken."
- **A freshly-redeemed invite code landed on the mostly-empty Feed tab**,
  with the actual profile-creation form buried in the Account sub-tab and
  no cue pointing there. Someone who didn't know to navigate there could
  easily believe they were "done" without ever having created a profile
  at all — there was no way to tell "did this save?" from that screen.
  Fixed the same way the two gates before it already work (no session yet
  / no redeemed code yet): a signed-in, code-redeemed user with no
  profile now sees *only* a profile-completion form, full stop, until
  they save one — the whole screen changing to the real tabbed UI
  afterward is the confirmation, not a toast easy to miss.

2 new tests. 188/188 pass; both fixes visually verified against a mocked
client — the gate correctly blocks the tabbed UI until a profile exists,
correctly clears once one's saved, and search now fires from typing
alone with no blur needed.

# Remove email from community sign-in entirely — anonymous auth, invite code only — 2026-08-27

Sign-in no longer collects an email address or sends a magic link.
Opening the Community tab now silently creates a real Supabase Auth
session via `client.auth.signInAnonymously()` — a genuine `auth.users`
row, `auth.uid()` works normally, every existing RLS policy applies
exactly as before (anonymous sessions carry `role: authenticated` with
an `is_anonymous: true` JWT claim, not a lesser access level). The
invite code remains the only real gate — unchanged, still enforced
server-side by `profiles_insert_self`'s RLS policy at profile-creation
time, not by how the session was created.

Why: a magic-link email often opens in whatever the phone's default
browser is, not inside the already-installed home-screen PWA — the auth
session lands somewhere other than where the person meant to be. With no
email step at all, there's nothing to hand off to the wrong app.

Real tradeoff, not free: there's no "sign back in" path anymore — nothing
external ties a person to their identity, so clearing site data or
switching devices means a fresh anonymous session with no memory of the
old one, and the previous profile/history/streak becomes unreachable.
The Account tab's "sign out" button was removed for exactly this reason
— it would have implied a reversibility that doesn't exist; "request
account deletion" is still there for someone deliberately walking away.
The admin-grant instruction in `COMMUNITY_SETUP.md` also had to change
from an email lookup (`where email = ...`, meaningless now — anonymous
users have no email at all) to `where handle = ...`.

4 new tests in `test/community-anonymous-auth.test.mjs`. 185/185 tests
pass; boot-smoke passes with zero console errors against the live
project (Anonymous Sign-ins isn't enabled there yet — the failure path
was verified to degrade to a message, not a crash); visually verified
the connecting state via a mocked client, including that
`signInAnonymously()` fires exactly once per load even across repeated
re-renders and tab switches.

# Catch-up entry: security hardening, DevOps, and accessibility batches not logged here at the time — 2026-08-27

Three rounds of work landed as commits without a matching entry in this
file — recorded here after the fact so the history stays complete.

**Security hardening** (`202608270006_security_hardening.sql`, authored
by a separate Codex-based session working in this same repo, merged in
and then fixed through three live-testing rounds here): invite codes are
now hashed (never stored plaintext), high-entropy (48 hex chars),
expiring, bounded to a max redemption count, and rate-limited (5 attempts
per 15 minutes); coach promotion moved from a redeemable code to a
trusted `grant_coach_role()` service-role-only function; post photo paths
are bound to their author by a database trigger, with a 20-photo upload
quota; reports gained a real admin-only `review_report()` transition
instead of just hiding a post for its reporter; `is_staff()` no longer
accepts an arbitrary user id. Fixed afterward, in order, from live
`SQL editor` failures: a primary-key/foreign-key creation-order bug, a
`CREATE OR REPLACE FUNCTION` default-parameter removal Postgres
disallows, an RLS-policy dependency-ordering bug, and unqualified
pgcrypto calls that broke under the functions' own `search_path = ''`
hardening.

**DevOps**: `run-all.mjs` now auto-discovers browser-check scripts from
disk instead of a hand-maintained list that had silently excluded three
of them; running the full suite for the first time surfaced two scripts
that had gone genuinely stale against the app's current behavior
(unrelated to this work) and both were fixed. CI now runs the real-
Chromium browser suite as a required job, not just unit tests;
`actions/checkout`/`actions/setup-node` pinned to their exact current
commit SHAs; a concurrency group cancels superseded runs. The service
worker's install handler now fails outright if a *required* app-shell
file (index.html/app.js/theme-init.js/cloud.js) can't be cached, instead
of silently activating a broken shell the way every asset used to be
treated.

**Accessibility**: `:focus-visible` widened from `button, input` to
every interactive element type; `.footer-note`/`.link-btn` were using a
border color as text color, measuring under WCAG AA — fixed, and
`--steel` itself retuned per theme to clear 4.5:1 with real margin
everywhere it's already used as secondary text app-wide; two undersized
touch targets (the numeric-field +/- buttons, calendar month navigation)
brought up to 44×44px; the community photo picker gained real visible
label text instead of an emoji-only, title-attribute-only button; and a
real bug — a document-level focus handler was wiping every numeric
field's value the instant it was focused — fixed to select the existing
value instead (typing still replaces it in one keystroke, but the value
is never destructively cleared just from focusing).

# Build the coach access tier — 2026-08-27

Three real tiers now, via new migration `202608270005_coach_tier.sql`:
**admin** (unchanged — full access, manual dashboard-only grant),
**coach** (new — a fixed set of powers, the same for every coach: post/
pin announcements, set the weekly challenge, see the new/inactive member
views), **member** (the default).

Coach is deliberately *not* scoped to "their own" classes or members —
Arbox already owns class scheduling and rosters, so building a parallel
membership model here would duplicate something that already exists
elsewhere. This is the direct outcome of asking, now that Arbox is in the
picture: coach doesn't need a data model for "relevant," it just needs a
fixed set of community-layer powers.

Both tiers are checked server-side through one new function,
`public.is_staff()` (true if either `profiles.is_admin` or the caller's
own `invite_redemptions.role = 'coach'`) — every RLS policy and RPC that
used to check `is_admin` directly now goes through it, so "who counts as
staff" is defined in exactly one place instead of two policies that could
quietly drift apart over time. `cloud.js` got the matching client-side
`isStaff()` helper, and the render function's local `isAdmin` variable
(now genuinely misleading — it gated coach-relevant sections too) was
renamed to `staff` throughout.

6 new tests across `test/community-coach-tier.test.mjs` (migration
static assertions, plus one asserting the four staff-gated render
sections all route through `isStaff()` and none of them check
`state.profile.is_admin` directly anymore) and an update to an existing
engagement test whose assertion had gone stale. 164/164 tests pass;
boot-smoke passes with zero console errors.

# Fix the admin-grant trigger bug, and build the community-strategy quick/medium wins — 2026-08-27

## Bug: the manual admin grant never actually worked

`protect_is_admin` (from the previous migration) fired on every update to
`profiles`, unconditionally resetting `is_admin` back to its old value —
including for a legitimate `update ... set is_admin = true` run directly
in the SQL editor. The trigger doesn't know or care who's running the
UPDATE, only that a row changed, so it silently undid the grant every
time — `is_admin` stayed `false` no matter how many times the manual step
was followed correctly. Fixed by scoping the trigger to `auth.role() =
'authenticated'`: real client requests always carry a JWT and read
`'authenticated'` from it, while a direct SQL editor session has no JWT
context at all and reads `null` — so the trigger now only clobbers the
column for actual client requests, exactly the property it was meant to
have, while a genuine dashboard-run grant now works.

## New migration: `202608270004_community_engagement.sql`

Built from a strategy review of what makes fitness-app communities work
(Strava, Peloton, Duolingo, SugarWOD/Wodify) against what this app
actually has — the quick wins and medium bets from that review, not the
bigger one (class scheduling), which still needs its own planning pass.

- **Comments** — `post_comments`, gated by the same `post_visible_to_viewer()`
  rule reactions already use, so a comment can never be more exposed than
  its post. `community_feed` gained a `comment_count` alongside
  `cheer_count`.
- **"Who's new"** — `coach_new_members()`, the mirror of
  `coach_inactive_members()`: same admin self-gate, but looks at each
  member's *earliest* `activity_pings` row instead of their latest.
- **Photo attachment** — one optional photo per shared result. A private
  `post-photos` Storage bucket (5MB limit, image MIME types only),
  RLS-scoped so uploads only ever land under the uploader's own
  `uid/...` folder, and read access mirrors the post's own visibility
  rule rather than defaulting to public or owner-only.
- **Pinned daily note** — `announcements.pinned_date`; when set to today,
  it surfaces as a distinct "today's workout note" instead of sitting in
  the regular chronological list.

## Community tab: sub-tabs, top-3-plus-your-rank, comments UI

`cloud.js`'s render function was rewritten around three sub-tabs (Feed /
Boards / Account, reusing the same `.subtabbar` pattern the WOD tab
already has) instead of one long scroll through profile, announcements,
weekly challenge, streaks, member search, sharing, the feed, and the
admin views, all stacked vertically.

Streaks and the weekly challenge now render as top-3-in-full, then — if
the viewer isn't already in the top 3 — a divider and their own
highlighted row, instead of one long ranked list past the leaders
(showing someone they're "#18 of 40" discourages more than it motivates;
a small, friendly comparison does the opposite).

Each feed post gets a comment count/expand button alongside the existing
cheer count; expanding loads and shows the thread plus a small
add-a-comment form, and a comment's own author gets a delete link on it.
Sharing a result now offers an optional photo attachment via a
lightweight `<label for=...>` file-picker trigger next to the existing
followers/public buttons.

13 new tests across `test/community-engagement.test.mjs` (migration
static assertions) and `test/community-engagement-ui.test.mjs` (source
shape of the new render/wiring). Visual behavior verified with real
screenshots against a mocked Supabase client (a real signed-in session
isn't reachable without a live magic-link email) — all three sub-tabs,
the expanded-comments state, and the ranked-list framing. 157/157 tests
pass; boot-smoke browser check passes with zero console errors against
the live (partially-migrated) backend.

# Redesign the Community tab — it was misusing the app's own design system — 2026-08-27

Every section of the Community tab (profile, announcements, weekly
challenge, streaks, member search, feed) rendered as an identical stack of
`.chart-card` boxes separated only by a tiny 12px gray `.section-label`,
with almost every action — save profile, follow, block, cheer, report,
post an announcement, set the weekly challenge — using `.link-btn`. That
class is an 11px underlined micro-link, styled in `var(--border)` (the
lowest-contrast color in the palette), meant for a deliberately
de-emphasized action like "delete account." Using it for every primary
action in the tab is what made the whole screen read as a flat, low-
contrast wall of near-identical boxes with no hierarchy.

Fixed by reusing the app's own existing vocabulary instead of inventing a
new one: every section now gets a real header — the same colored-dot +
bold-title pattern (`.ach-section-head`/`.ach-section-dot`/
`.ach-section-title`) the achievements screen already uses, one accent
color per section (brass for announcements, teal for the weekly
challenge, purple for streaks, energy for sharing, blue for the feed and
comparisons, red for the admin-only inactive-members view) so sections
are visually distinguishable at a glance, not just by reading the label.

New `.chip-btn`/`.chip-btn.primary`/`.chip-row` give every real action an
actual button (bordered chip for secondary actions, filled energy-orange
for the primary one per group) instead of underlined micro-text — `.link-btn`
now only used where it already made sense, the account-deletion link.

Admin-only forms (the announcement composer, the weekly-challenge setter)
now get a visibly distinct treatment — an energy-orange left border
(`.admin-card`) plus a small "ניהול" pill (`.admin-tag`) right on their
heading — so it's unmistakable which controls are admin-only versus
regular community actions, which the flat card stack made impossible to
tell apart before. The profile form also gained real field labels above
each input instead of relying on placeholder text that disappears the
moment a value is set.

Verified visually, not just by reading the diff: screenshotted the tab
against realistic mocked data (a fake Supabase client stubbed in before
page load, since a real signed-in session isn't reachable without a live
magic-link email) before and after — the "before" shot is what surfaced
this in the first place. 145/145 tests and the boot-smoke browser check
still pass.

# Gate community sign-up behind an invite code, and fix an admin self-lockout bug found along the way — 2026-08-27

Anyone who found the demo URL could sign in with any email and create a
community profile. New migration `supabase/migrations/202608270003_invite_gate.sql`
closes that: `invite_codes` (one shared code per role, member/coach) plus
`invite_redemptions` (one row per user, written only by the new
`redeem_invite_code()` RPC — no direct client insert path). `profiles_insert_self`
now requires a redemption on file before a profile can be created at all.
Community tab shows a new "enter invite code" step ahead of the profile
form whenever a signed-in user hasn't redeemed one yet.

The end state discussed for this is three access tiers — admin (full
access), coach (scoped to their own relevant classes/members), member —
but "coach" doesn't have a data model for what "their relevant" means
yet. So a coach-code redemption is deliberately just a label right now
(`invite_redemptions.role`), not wired to `is_admin` or any elevated
access — avoids locking in "coach == full admin" as the real design
before the actual scoping work happens. Full admin stays a manual,
dashboard-only grant, same as before this migration.

Bug found while writing the above: `profiles_update_self`'s RLS check
required `is_admin = false` on *every* update — meaning the moment any
profile actually had `is_admin = true`, that account could never save its
own profile again (any edit would get rejected, since the resulting row
still has `is_admin = true`). This would have locked out the very first
real admin account. Fixed with a trigger (`protect_is_admin`) that pins
`is_admin` to its previously stored value on every update, so no
client-side path — invite code, profile-edit upsert, or otherwise — can
ever change it after creation; the update policy's `is_admin = false`
requirement was then unnecessary and removed.

5 new tests in `test/community-invite-gate.test.mjs`. 145/145 pass.

# Lock down an anon read leak found by live-testing the previous migration — 2026-08-27

Found immediately after applying `202608270001_community_growth.sql`
against the live project and testing it with no login at all (just the
publishable key, no session): `activity_pings`, `announcements`,
`weekly_challenges`, and the `community_streaks` view were all readable
by anyone, no auth required. `activity_pings` in particular was designed
to be self-only — its own RLS policies say so — but RLS never got a
chance to run, because the `anon` role had a standing table-level SELECT
grant that bypassed the question entirely. Writes were still safe: a test
insert into `announcements` correctly failed on the RLS policy.

Cause: this Supabase project has a default privilege that auto-grants
`anon` (and `authenticated`) SELECT/INSERT/UPDATE/DELETE on any newly
created table. `202608260001`'s blanket `revoke all ... from anon,
authenticated` only covered tables that existed at the moment it ran —
every table `202608270001` created afterward silently picked the default
back up, since nothing in that migration re-revoked it.

New migration `202608270002_lock_anon_defaults.sql`: revokes the leaked
access on the four objects above, and — so this can't repeat itself the
next time a migration adds a table — runs `alter default privileges in
schema public revoke select, insert, update, delete on tables from anon,
authenticated`, which stops the auto-grant from applying to anything
created from this point forward. Every table this app needs already gets
an explicit `grant ... to authenticated` alongside its own RLS policy, so
nothing legitimate depended on the default.

1 new static-assertion test locks in that this migration exists and does
what it says.

# Close the reactions RLS gap, and add achievement sharing, streaks, announcements, and a weekly challenge — 2026-08-27

Two threads from the earlier audit of this repo's community layer, done
together: closing out the remaining credibility gaps it found, and
building the growth features discussed for pitching this to the box
manager.

## Credibility fixes

- **CSP `frame-ancestors`**: the audit flagged this directive as dropped
  compared to a "proper" CSP. On inspection this isn't fixable as stated —
  `frame-ancestors`/`X-Frame-Options` are spec-ignored when delivered via
  `<meta>`, only a real HTTP response header enforces them, and GitHub
  Pages has no way to set custom response headers on static files. Adding
  the directive back to the `<meta>` tag would be inert, not a fix. Left
  the file's own comment expanded to say this plainly instead of silently
  re-adding dead config — real clickjacking mitigation here would need
  moving off GitHub Pages. For what it's worth, the production app ships
  no CSP at all, so this demo is still strictly ahead on every directive
  that *does* work via `<meta>`.
- **Reactions RLS gap**: `reactions_visible`/`reactions_insert_self` only
  checked that the referenced post *existed*, not that it was still
  visible to the viewer — a deleted post, a blocked author, or a
  followers-only post from someone you don't follow all leaked reaction
  rows even though `posts_feed_select` correctly hid the post itself. New
  migration factors the exact visibility rule `posts_feed_select` already
  uses into `post_visible_to_viewer()` and both reaction policies now call
  it, so the two rules can't drift apart again.
- **README.md**: rewrote it — it still described the old mock-data-only
  preview ("runs entirely on mock data today... not live for real
  members"), which stopped being true once this became a real
  Supabase-backed PWA.

## New features

New migration `supabase/migrations/202608270001_community_growth.sql`
(on top of the existing `202608260001_community_foundation.sql` — **must
be run against the live Supabase project before these features work; this
session had no CLI/service-role access to apply it directly**):

- **Achievement-unlock sharing**: `workout_posts.source_type` now accepts
  `'achievement'` alongside the existing strength/WOD entry types. A new
  share button appears per newly-earned badge directly in the existing
  celebration popup (`celebrationShare` in `index.html`, wired in
  `showCelebration()` in `app.js`) — only when the community layer
  reports the athlete signed in (`window.isCommunitySignedIn()`).
  Achievement unlocks aren't durable local records the way strength/WOD
  entries are, so this is a transient share offer at the moment of
  unlock rather than an addition to `communityShareCandidates()`.
- **Activity streaks**: new `activity_pings` table (one row per user per
  day, self-insert/self-select only — raw per-day presence stays
  private) plus a `community_streaks` view that aggregates a
  gaps-and-islands current-streak calculation across every user and
  exposes only the resulting number to the whole community. The view is
  deliberately *not* `security_invoker`, so it can read across
  `activity_pings` rows RLS would otherwise restrict to their own owner —
  the raw dates never leave the table, only the streak length does.
- **Coach announcements**: new `announcements` table, admin-only insert
  (checked against `profiles.is_admin`), readable by every signed-in
  member. Composer form appears in the Community tab only for admins.
- **Weekly box-wide challenge**: new `weekly_challenges` table (admin
  sets a title, a `comparison_key`, and a date range) plus a
  `weekly_challenge_leaderboard` view that reads straight from the
  existing `workout_posts` — reusing `posts_feed_select`'s visibility
  rules via `security_invoker`, so a challenge leaderboard never shows a
  post its own visibility settings would otherwise hide from that viewer.
- **Coach "who hasn't logged recently"**: new `coach_inactive_members()`
  function, security-definer with an internal admin check (raises if the
  caller isn't an admin profile) rather than widening `activity_pings`'
  own RLS — keeps raw per-day activity data admin-only without a second
  parallel table.

7 new static-assertion tests in `test/community-growth.test.mjs` (matching
the existing pattern in `test/community-foundation.test.mjs` — no live
Postgres to run migrations against in this test suite) plus 2 new
jsdom tests in `test/achievements.test.mjs` covering the celebration
share button's visibility and click wiring.

# Isolate this demo's browser storage from the production app — 2026-08-27

Found by an independent audit: this demo and the real production app
(`haimuniya.github.io/haimunia-app/`) are served from the same GitHub
Pages origin — just different paths — and browser storage (IndexedDB,
localStorage, sessionStorage, Cache Storage) is scoped per-origin, not
per-path. This demo was using the production app's exact identifiers:

- IndexedDB: `DB_NAME` was `"box-log-db"`, identical to production.
  A real member whose browser had opened both URLs would have this
  demo's community/social code reading and able to publish their real
  local training data.
- localStorage/sessionStorage: every key used the bare `"haimunia:"`
  prefix (or the legacy `"boxlog:"` one), same as production.
- Cache Storage: the service worker's cache name shared production's
  `"haimunia-v..."` prefix — and its activate handler deleted *any*
  cache that wasn't its own current version, which would have deleted
  the production app's cached assets outright the first time both
  service workers had ever run in the same browser.

Every identifier above is now demo-specific (`"haimunia-demo-db"`,
`"haimunia-demo:*"` keys, `"haimunia-demo-v..."` cache names), and the
service worker's cleanup now only ever deletes caches matching its own
prefix instead of "anything that isn't me." `manifest.json`'s `id`/
`start_url`/`scope` were checked too — those are relative URLs that
already resolve differently per path, so no change was needed there.

4 new tests in `test/storage-isolation.test.mjs` lock this in: the
IndexedDB name, every storage key actually written during real app
flows, a source-level sweep of all four JS files for any lingering
production identifier, and the cache-cleanup scoping logic itself (not
just its name). Full suite: 130/130 (126 existing + 4 new), green.

# Fix: WOD tab's רישום/היסטוריה pill highlight not following the subtab — 2026-08-25

Reported by the user with a screenshot: after switching WOD subtabs,
היסטוריה stayed highlighted while the רישום (log) form was actually
showing underneath. Root cause: the pill buttons are rendered once in
renderWodTab(), which only runs on a full top-level tab switch —
switch-wod-subtab's handler only ever called renderWodContent() (swaps
#wodContent's innerHTML), so the content switched correctly but the
highlight never followed it. Fixed by having the handler also update the
two buttons' active/aria-selected state directly, same pattern already
used for the WOD builder's format chips.

# Workout format support, sub-tasks A (WOD builder half) + B + D + extras — 2026-08-25

Finishes the workout-format-support spec: the WOD builder's own duration
toggle (the other half of sub-task A), blocks/supersets (B), EMOM (D), and
the two lower-priority extras (time cap, partner tag). Sub-task C was
already covered by the existing ladder feature (confirmed in the previous
round). Plain single-exercise logging, and every previously-shipped
feature, is unaffected — re-verified via the full test suite and browser
checks after each addition below.

- **WOD builder duration toggle.** A movement checked in the builder can be
  marked "reps" or "duration" (a reps/duration chip pair per movement,
  reusing the toggle from the Log tab). Only changes the free-text
  description the builder generates (`builderMovementsToDesc`) — WOD
  entries themselves have never stored structured per-movement data for any
  format except EMOM (see below).
- **Supersets and A/B/C/D block labels.** Extends the existing ladder
  mechanism rather than replacing it: a ladder can now optionally take a
  second exercise (`setLadderPartner`), turning it into a superset —
  alternating rounds between exactly two exercises under one `groupId`,
  switched between via two pills (`switchLadderExercise`) instead of the
  normal exercise picker (which still ends it, same as before). An
  optional `blockLabel` chip (A/B/C/D) tags the whole group, carried by
  every round. The calendar day view and Log tab's running list both
  derive "is this a superset" from the group's own data (more than one
  distinct exerciseId), not from in-progress session state, so a finished
  superset displays correctly regardless of how it was built.
- **EMOM.** A fourth WOD scoreType, built through the same
  reusable/named WOD builder as Fran or Grace — not a one-off freeform
  entry. Unlike every other format, an EMOM's movement rotation
  (`emomMovements`/`emomTargetReps`/`emomMinutes`) is structured data on the
  WOD record itself, because the log form needs it to render one reps
  field per movement, prefilled from that WOD's own targets and resized
  automatically when switching between differently-shaped EMOM WODs.
  Explicitly out of scope per the confirmed spec: no cross-attempt scoring
  — `bestWodScore`/the History tab's PR chart both skip EMOM entirely
  rather than fabricate a comparison that doesn't mean anything for it.
- **Time cap and partner tag.** Two small, independent additions: an
  optional reference-only time cap on a WOD (shown in the log header,
  never enforced or scored), and a free-text partner tag per WOD entry
  ("with Dana") shown next to Rx/Scaled in history and the calendar.

Also fixed along the way: the strength Log tab's est-1RM/barbell-visual
live-update on raw keystroke input wasn't duration-mode-aware (a latent gap
from the previous round, caught while wiring the same live-update path for
the new duration stepper), and picking an exact-name search match in the
exercise picker via Enter didn't end an active ladder the way clicking the
same movement's button already did — both now consistent.

# Workout format support, sub-task A: duration/hold entries — 2026-08-25

A structured spec came in covering four workout-logging gaps that BTWB/
SugarWOD-style apps handle poorly: timed holds, multi-part A/B/C blocks
with supersets, pyramid rep schemes, and EMOMs with rotating movements.
Pyramid schemes turned out to already be covered by the existing ladder
feature (confirmed, not assumed — skipped as its own sub-task). This round
covers sub-task A only; blocks/supersets and EMOM are separate, larger
changes staged for their own rounds.

- **Duration/hold entries in the strength Log tab.** A new reps/duration
  toggle next to the exercise picker switches the whole entry form: reps
  mode is exactly what existed before (unchanged), duration mode swaps the
  reps stepper for a duration-in-seconds one and skips the barbell-plate
  visual and bar-weight row (neither applies to a timed hold). Weight stays
  available in duration mode for weighted carries/holds, defaulting to 0
  for a bodyweight hold. `sanitizeEntry` gained a `type` ("reps" |
  "duration") discriminator and a `durationSeconds` field — every entry
  from before this change has no `type`, which sanitizes to "reps"
  automatically, so existing data and the plain reps flow are unaffected.
- Selecting an exercise now defaults the toggle to whatever it was last
  logged as (a hold-only movement like a plank stays in duration mode),
  and editing an existing entry restores its own type regardless of
  whatever the toggle currently shows.
- PR tracking, the History tab's per-exercise chart, and the achievement
  system's per-category PR counter all now correctly separate duration
  entries from reps entries — a hold-only movement reports "no 1RM" (not a
  phantom 0kg one), and its History chart plots hold time instead of
  est1RM. Recent-history, the calendar day view, and ladder-round display
  all format each entry by its own type, so a mixed history (an exercise
  logged both ways over time) renders correctly everywhere.
- Ladders and duration entries compose: a ladder can be a sequence of
  progressively longer holds, same as it can be a sequence of different
  weight/rep rungs. Switching the reps/duration toggle mid-ladder ends it,
  same as switching exercise or date already did.

# Roadmap round: notifications, onboarding, streaks, recent history, session notes — 2026-08-25

A 10-phase roadmap came in for "look at every tab." Two phases turned out
to already be substantially satisfied by existing code (found during
research, not assumed): the WOD tab's custom + Girls/Heroes-benchmark entry
paths, and the Log tab's last-session reference (which the immediately
preceding round had already turned into a tap-to-prefill button). Phase 9
depended on a "Goals" feature that doesn't exist anywhere in the codebase —
asked directly, skipped for this round. Phase 8 (build-then-commit a whole
session before saving anything) is a real redesign of the save flow the
user themselves flagged as needing its own planning pass — deferred to a
dedicated follow-up rather than bundled in with seven other features.

This round: expanded `WOD_LIBRARY` with 7 more evergreen benchmarks (Kelly,
Eva, Barbara, Filthy Fifty, Michael, Danny, Badger). Everything below is new.

- **Update notifications.** A small `RELEASE_NOTES` list (separate from
  this file — short, Hebrew, user-facing) backs both a one-time "מה חדש"
  popup shown to returning users after a real update, and a persistent bell
  icon in the header with an unread badge. A genuinely fresh install sees
  neither — nothing to catch up on; existing devices from before this
  shipped get silently backfilled so they're never shown a changelog
  retroactively.
- **First-time onboarding.** A short one-screen walkthrough (what each tab
  is for) shown once, immediately after the very first welcome/name modal —
  never for a device that already has data or a name.
- **Recent history at the point of entry.** Picking an exercise or WOD now
  shows up to 5 real logged attempts from the last 14 days, not just the
  single most-recent one. No warm-up logic anywhere in it — every row is an
  actual saved set.
- **Streak indicator.** Consecutive days (strength set or WOD, either
  counts) with at least one entry, shown next to the header's date. Reuses
  the exact same day-has-an-entry check the calendar's dots already used
  (extracted into one shared `hasAnyEntryOn`), so the two can never disagree
  about what counts as a trained day. Today not being logged yet doesn't
  break it — just isn't counted until it is.
- **Per-day session note.** One free-text field per calendar date ("how did
  the session feel"), distinct from the existing per-WOD-entry scaling
  notes. Surfaced from the Calendar day view.

Files changed: `app.js`, `index.html`. New `test/roadmap-features.test.mjs`
(7 tests: version comparison, fresh-install vs. existing-device bootstrap
paths, streak counting across gaps, the 14-day/5-item recent-history cap,
session-note round-trip). New `scripts/browser-check/roadmap.mjs` — real
Chromium session driving all five features end to end, including the
session note surviving a navigate-away-and-back round trip. `boot-smoke.mjs`
and `ladder.mjs` re-verified for regressions; their shared `dismissWelcomeModal`
helper updated to also close the new onboarding modal, since every
fresh-context check now hits it.

---

# Prefill from last session — 2026-08-25

Reframed what this app actually is: filled in after a workout (from memory
or a whiteboard scribble), not used live during one — which rules out
things like a rest timer, but means entry *speed* for reconstructing a
session is what matters. Progressive overload means today's numbers are
usually close to last time's, not random, yet the "אימון אחרון" (last
session) card was informational only — you still dragged the steppers from
scratch every time.

It's now a button: tapping it copies that exercise's last weight, reps,
and sets straight into the steppers (and the barbell visual updates with
them). A small repeat icon signals it's interactive, distinct from the
adjacent 1RM card which stays informational.

Files changed: `app.js`. Two new tests in `test/app-flow.test.mjs` (prefill
pulls the right exercise's history, not whatever was left over from a
different one; no-op when there's no history yet). Verified visually in a
real Chromium session — steppers and barbell both update from one tap.

---

# Committed browser-check scripts — 2026-08-25

Three real bugs this session (self-reload on first install, PR celebration
firing on every ladder rung, editing mid-ladder not ending it) only
surfaced through real-Chromium testing — jsdom doesn't implement Service
Worker lifecycle or real DOM event timing, so the committed `npm test`
suite structurally can't catch this class of bug. Those checks previously
lived as scratch scripts, rebuilt from scratch each time.

`scripts/browser-check/` — a separate package (own `package.json`, own
`playwright` dependency, own lockfile) so the main app's dependency tree
stays untouched:

- `npm run setup` once (installs Playwright + downloads Chromium)
- `npm run check:boot` — fresh load, fonts actually loaded, no self-reload,
  all 4 tabs switch, no console errors
- `npm run check:ladder` — a real 5-round working-up ladder end to end:
  toggle, save, celebration suppression, calendar grouping, edit, delete,
  finish
- `npm run check:update` — the Service Worker update lifecycle (first
  install doesn't self-reload; an update hidden from view auto-applies
  silently; one landing mid-session shows the banner and applies on the
  next visibility regain). Local-only — it edits `sw.js` on disk to
  simulate a new deploy landing, reverted when it's done.
- `npm run check:all` runs all three, stopping at the first failure

Each defaults to a throwaway local static server over the working tree
(uncommitted changes included); `TARGET_URL=<url>` points any of them at a
deployed site instead, e.g. to verify a push actually landed.

Not part of the main test suite or any CI — on-demand only, the same way
this session ran them by hand throughout.

---

# Gap-hunting pass — 2026-08-25

Went back through the app looking for rough edges, focused on the ladder
feature since it's newest. Found and fixed one real interaction bug, plus
an accessibility gap.

- **Bug: editing an unrelated entry mid-ladder didn't end it.**
  `startEditEntry()` (the pencil icon on any set in history/calendar)
  switches the selected exercise and log date, exactly like picking a new
  movement or changing the date already did — but unlike those two, it
  never called `endLadder()`. Editing an old set from a different exercise
  while a ladder was running left the toggle still advertising an active
  ladder for the wrong context. Fixed — with one deliberate exception:
  editing one of the *active ladder's own* rounds (fixing a typo in set 3)
  does **not** end it, so correcting a mistake mid-session doesn't strand
  you from adding set 6 afterward.
- **Accessibility:** the ladder progress text ("5 סטים נרשמו · הבא: 6")
  now carries `aria-live="polite"`, matching the pattern already used for
  the storage-error and import-result messages.

Files changed: `app.js`. Two new regression tests in `test/app-flow.test.mjs`
cover both the "unrelated edit ends it" and "own-round edit doesn't" cases;
the fix was verified in a real Chromium session too — my own test script
had exercised this exact path without realizing the tested behavior was
wrong until this pass looked closer.

---

# Ladder UX pass — 2026-08-25

The ladder toggle worked but was easy to miss (a small text link) and gave
no feedback on what it actually did — no indication of which set you were
on, the save button never changed to reflect it, and finishing without
switching tabs first left stale state on screen (a real bug: `endLadder()`
via the explicit toggle never called `render()`, so the UI kept showing
"finish ladder" and the old round list until something else happened to
re-render).

- Toggle is now a full-width bordered button (matching the app's existing
  "+ add new" prompt pattern) with a ladder icon and a plain-language
  subtitle when off. While active, it shows live progress inline — "5 סטים
  נרשמו · הבא: 6" — instead of requiring a scroll down to the chip list to
  know where you are.
- The Save button's own label now changes too: "הוספת סט 6 לסולם — Strict
  Press" instead of the generic "רישום סט", so it's explicit that tapping
  it adds another rung rather than finishing anything.
- Fixed: tapping "סיום" now re-renders immediately (previously required
  switching tabs to see the toggle/list actually clear) and shows a brief
  confirmation ("הסולם נשמר — 5 סטים") reusing the existing footer message
  mechanism.
- Fixed a copy bug: the empty-ladder hint referenced "the blue button" —
  the save button is actually the brand's orange/energy color, never blue.

Files changed: `app.js`. Verified with the full test suite plus a real
Chromium session driving the exact flow (toggle on, 5 different-weight
rounds, finish without switching tabs, confirm the render and message).

---

# Service worker: stop self-reloading on first install, apply updates without reopening — 2026-08-25

Two bugs in the update-delivery path, found while chasing a report that the
new ladder feature "wasn't showing up."

**Critical: every fresh visit was reloading itself ~1-2s after opening.**
`self.clients.claim()` in the service worker's `activate` handler fires
`controllerchange` even on a page's very first-ever install — not just on a
real update swap. The app's `controllerchange` listener reloaded
unconditionally, so any in-progress input (the welcome-modal name field, a
weight being adjusted, a ladder mid-session) could get silently wiped a
second or two into every single visit. `applyUpdate()` now sets a
`swapRequested` flag right before asking a waiting worker to take over, and
the listener only reloads when that flag is set — ignoring the incidental
first-claim event. Confirmed via a real Chromium session: before the fix, a
fresh load always fired a second navigation within ~2s; after, zero.

**Updates now apply without a manual reopen, in the common case.** Previously
every update needed an explicit tap on the "עדכון חדש זמין" banner. Since the
phone screen locking between sets already fires `visibilitychange`, updates
now apply automatically the moment the page regains visibility after being
backgrounded — no banner, no reopening needed. The banner still appears as a
fallback only when an update lands while the page has stayed continuously
visible (reloading then could drop unsaved input), and applies automatically
on the next visibility regain even if the banner is never tapped.

Files changed: `app.js`. No test suite coverage for either fix — both are
real Service Worker lifecycle behavior that jsdom doesn't implement, so they
were verified with a real Chromium session (Playwright) against a local
static server instead; see the session's own scratch scripts for the pattern
if this code changes again.

---

# Ladder logging — 2026-08-25

Working-up ladders (e.g. Press: 6 reps @ 60, 5 @ 70, 4 @ 80, 3 @ 85, 3 @ 90 —
each rung a different weight *and* rep count) didn't fit the "Sets" field,
which only means "N identical sets at one weight/reps." Saving each rung
separately already worked, but showed up as unrelated rows.

- Entries gained an optional `groupId` (`sanitizeEntry`) tying together the
  rows saved in one ladder session. Existing records get `groupId: null` —
  no behavior change for anyone who never uses this.
- New toggle in the log tab: "רישום סולם" turns it on (generates a session
  id), every Save while it's on joins that session, a running list of the
  rounds so far shows underneath with a per-round remove. "סיום סולם" turns
  it off. Switching exercise or changing the log date auto-ends it, so a set
  can't silently misjoin the wrong session.
- The calendar day view groups a ladder's rows into one card (exercise name
  + PR flame shown once) — but every rung keeps its own edit/delete, so a
  specific set stays individually correctable.
- The full-screen "PR!" celebration popup is suppressed while a ladder is
  active — an ascending ladder routinely beats the previous best est1RM on
  every rung, which meant one popup per rung. The inline barbell flash still
  shows a PR immediately; the popup resumes normally once the ladder ends.
- Nothing else changed: PR detection, `bestEst1RM`/`repRecordFor`, the
  progress chart, and export/import all still treat every round as its own
  entry, same as before — a ladder's rungs just happen to share a tag.

Files changed: `app.js`. Tests: `test/sanitizers.test.mjs` (groupId
round-trip), `test/app-flow.test.mjs` (a real 5-round ladder end to end,
including surviving a simulated reload, and exercise-switch auto-ending it).

---

# "Next level" pass — 2026-08-25

Follow-up to the review below: closed out the "left for you" items from the
2.8.0 pass, plus an accessibility sweep, an install prompt, and the first
committed automated test suite.

Files changed: `app.js`, `index.html`, `sw.js`. New: `assets/fonts/*` (13
files), `package.json`, `package-lock.json`, `scripts/sync-version.mjs`,
`test/*`, `.gitignore`. `manifest.json` unchanged.

Verified with `npm test` (Node's built-in test runner, jsdom + fake-indexeddb,
dev-only — nothing here ships to the deployed site): **19 assertions**, all
passing, covering sanitizers/XSS-escaping, the add-movement → log-a-set →
simulated-reload round trip, and the import path (valid backup, `__proto__`
category neutralization, wrong-app-id rejection, oversized-file rejection).

## Self-hosted fonts, tightened CSP

- Downloaded the exact Rubik (400/600/700/800/900, latin+hebrew subsets),
  JetBrains Mono (500/700), and Anton (400) `.woff2` files Google's own CSS2
  API serves for this app, into `./assets/fonts/`. Verified woff2 magic bytes
  on all 13 files.
- Replaced the Google Fonts `<link>` in `index.html` with local `@font-face`
  rules using the same `unicode-range` values, so subsetting behavior is
  unchanged.
- CSP's `style-src`/`font-src` no longer allow any external origin — the app
  now makes zero third-party network requests, full stop.
- `sw.js` precaches all 13 font files, so typography no longer degrades
  offline.

## Accessibility pass

Previously: 2 `aria-*`/`role` attributes in the whole app. Now: 120 across
`index.html` + `app.js`. Added:
- `role="tablist"`/`"tab"`/`aria-selected` on the main tab bar and the WOD
  sub-tab bar, kept in sync on every tab switch.
- `role="dialog"` `aria-modal` `aria-labelledby` on all 6 modals (picker, WOD
  picker, WOD builder, achievements, celebration, welcome), `aria-label` on
  every icon-only close button.
- `aria-label` on every search input, date input, and icon-only edit/delete
  button; `aria-label` on the stepper +/− buttons and value fields.
- `role="radiogroup"`/`"radio"` + `aria-checked` on the WOD format picker, bar
  weight picker, Rx/Scaled toggle, and theme picker; `role="checkbox"`
  `aria-checked` on the WOD-builder movement checklist rows.
- `role="status"`/`aria-live` on the update banner, install banner, loading
  screen, storage-error footer note, and import-result message.

## Version sync automated

`APP_VERSION` (app.js) and `SW_VERSION` (sw.js) were kept in sync by hand.
`scripts/sync-version.mjs` now does it — `npm run sync-version` after bumping
`APP_VERSION`, `npm run check-version` (or `npm test`) fails loudly if they
ever drift.

## Install prompt

Custom "Add to Home Screen" banner (`app.js`: `beforeinstallprompt` handling;
`index.html`: `#installBanner`), styled like the update banner but with the
brand stripe instead of solid energy color so the two are visually distinct.
Shows once per session, steps aside if an update banner is showing, never
shows if already installed. iOS Safari doesn't fire `beforeinstallprompt`, so
the banner simply never appears there — no regression, just no improvement
for that platform.

## Export privacy notice

One line under the export/import buttons: the backup file is plaintext JSON
and includes name, bodyweight history, and full training log.

## Left undone (by design, not oversight)

- **Server response headers** (HSTS, `X-Content-Type-Options`,
  `Permissions-Policy`, real `frame-ancestors`) — GitHub Pages can't set
  custom headers; would need Cloudflare or another host in front. Decided
  against for now: no backend, no data leaves the device, so this was already
  low real-world risk.

---

# Security & hardening pass — v2.7.0 → v2.8.0

Files changed: `app.js`, `index.html`, `sw.js`. `manifest.json` unchanged.

Verified with two suites run against the real app booted in a DOM
(jsdom + fake-indexeddb): **58 security assertions** and **59 functional
regression assertions**, all passing.

---

## Critical

### 1. XSS via unescaped HTML attributes
`esc()` was applied to text nodes but skipped on several attribute values.

- `renderStepper()` — `data-field`, `data-action`, `data-step`, `data-min`,
  `value`, and the label are now all escaped. `field` is a user-authored
  movement name from the WOD builder.
- `data-id` on `pick-movement`, `pick-wod`, `select-history`,
  `select-wod-history`, `delete-entry`, `delete-wod-entry`; `data-date` on
  `cal-select-day`.
- `CATEGORY_LABELS[cat] || cat` and `style="background:${CATEGORY_COLORS[cat]}"`
  — replaced with `catLabel()` / `catColor()`, which use `hasOwnProperty` and
  fall back to safe defaults, then escaped.
- The `render()` catch-block printed `err.message` raw into `innerHTML`.

The `id` and `category` sinks were reachable from an imported backup file,
which is the vector that mattered.

### 2. Import accepted arbitrary data
`importDataFromFile()` checked only that `record.id` was truthy.

- Added `sanitizeMovement` / `sanitizeCustomWod` / `sanitizeEntry` /
  `sanitizeWodEntry` / `sanitizeBodyweight`. Each rebuilds the record field by
  field from a whitelist: `cleanId` (charset `A-Za-z0-9._:-`), `cleanStr`
  (control chars stripped, length capped), `cleanNum` (clamped both ends),
  `cleanISODate`, `cleanTs`. Nothing from the file is ever stored as-is.
- `data.app` and `data.version` are now verified (they were written on export
  and ignored on import).
- 25 MB file cap, 20,000-record-per-list cap.
- Confirmation prompt before merging, and a `box-log-rollback-<date>.json`
  auto-backup is downloaded first, since the merge can't be undone in-app.
- Result message reports imported / rejected / failed-to-save counts.
- New `reloadFromDb()` re-sanitizes on every load, so records written by an
  older build of the app can't poison the render path either.

### 3. Prototype pollution → persistent DoS
`byCategory[m.category]` with `category: "__proto__"` resolved to
`Object.prototype`, and `.push` threw a `TypeError`. Because the record was
persisted, the picker crashed on every load until "clear all data".

- `byCategory` and `builderMovements` now use `Object.create(null)` via `bag()`.
- `catColor` / `catLabel` guard lookups with `hasOwnProperty`.
- The category whitelist in the sanitizer closes the entry point.

---

## Hardening

- **CSP added** to `index.html` — `script-src 'self'`, `object-src 'none'`,
  `base-uri 'none'`, `form-action 'none'`, `connect-src 'self'`.
  `'unsafe-inline'` is in `style-src` only (inline `style=` attributes; there is
  no inline `<script>` anywhere). `frame-ancestors` is in the meta tag but is
  ignored there — **set it as a real response header on the host.**
- `<meta name="referrer" content="no-referrer">`.
- Google Fonts left in place but documented inline with the exact steps to
  self-host; `preconnect` to `fonts.gstatic.com` was missing and is now added.
  Self-hosting is the one item I couldn't do for you — it needs the woff2 files.

---

## Service worker (rewritten)

- **Origin-gated.** It previously cached every successful GET from any origin,
  forever. Now same-origin only, and only app-shell paths are written back.
- **`Promise.allSettled` over individual `cache.add()`** instead of `addAll()`,
  which failed the entire install on one missing file.
- **Added the maskable icons** to `ASSETS` (referenced in the manifest, absent
  from the precache list).
- **Navigation handling with `ignoreSearch: true`** — this is what makes the
  manifest shortcuts (`./index.html?tab=add`) work offline; exact-URL matching
  missed on the query string.
- **`skipWaiting()` removed from install.** A new worker parks in `waiting`; the
  update banner posts `SKIP_WAITING` and the page reloads on `controllerchange`.
  Previously the new worker took over while the old `app.js` was still running.
- Navigation preload enabled; `SW_VERSION` bumped to 2.8.0 alongside
  `APP_VERSION`.

---

## Smaller fixes

- **Pinch-zoom restored.** `user-scalable=no` / `maximum-scale=1` removed from
  the viewport meta, and the `touchmove` / `gesture*` blockers removed from
  `app.js` (WCAG 1.4.4). The double-tap-zoom suppression is kept, since that one
  fires by accident on the steppers.
- **Numeric inputs bounded at both ends** via `clampField()` — previously only a
  floor. `1e12` in a weight box no longer propagates into app state.
- **`maxlength` on every text input**, plus `cleanStr()` caps in JS (names 80,
  notes 300).
- **IDs now use `crypto.randomUUID()`.** The old slug scheme stripped every
  non-`[a-z0-9]` character, so all Hebrew movement names collapsed to
  `custom--<timestamp>`.
- **`userName` moved from localStorage to IndexedDB** (with one-time migration).
  It's the only PII in the app and "clear all data" never touched it — it does
  now, and the welcome modal reappears. Same for the last-export marker.
- **Storage failures surfaced.** `noteStorageError()` distinguishes
  `QuotaExceededError` and shows it in red in the footer instead of silently
  swallowing it.
- `CSS.escape` via `cssSel()` on the two `querySelector` calls that interpolate
  a field name — these threw on any name containing a quote.
- `openDB()` now memoises its promise instead of reopening the DB per call.
- `URL.revokeObjectURL` deferred 30s so the download reliably starts.
- `mobile-web-app-capable` added next to the deprecated Apple variant.

---

## Left for you

1. **Self-host the fonts** and tighten the CSP to `font-src 'self'` /
   `style-src 'self' 'unsafe-inline'`.
2. **Server response headers**: HSTS, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, `Permissions-Policy` denying
   camera/microphone/geolocation/usb, and `frame-ancestors 'none'` as a real
   header.
3. **Automate the version bump** — `APP_VERSION` in `app.js` and `SW_VERSION` in
   `sw.js` are still synced by hand. A missed bump means users stay on stale
   code, which is now a security concern and not just a UX one.
4. Exports are still plaintext JSON containing the name, bodyweight history, and
   full training log. Normal for a backup, but worth a line of UI text next to
   the export button.
# Community foundation and cloud sync — v3.0.0 — 2026-08-26

- Added a Supabase/PostgreSQL community backend migration with deny-by-default
  Row Level Security for private records, profiles, follows, blocks, workout
  posts, cheers, reports, and account-deletion requests.
- Added magic-link authentication, profiles, athlete discovery, following,
  a follower/public feed, explicit workout sharing, comparable-result views,
  reactions, reporting, blocking, and a 30-day deletion workflow.
- Existing and new workout records remain in IndexedDB for offline use. Cloud
  migration requires explicit consent, and an IndexedDB outbox retries writes
  after connectivity returns. Remote private records hydrate a new device.
- Social posts are sanitized snapshots: bodyweight, measurements, session and
  WOD notes, partner tags, email, and backups never enter the public post.
- Reconciled the unfinished working-tree regression pass: fixed edit identity
  corruption, stale ladder state, EMOM switching/input behavior, custom-WOD
  deletion, backup tests, text scaling, and tiered achievement artwork.
- Added setup, privacy, terms, and CI documentation. The Community tab remains
  in safe setup mode until `cloud-config.js` contains a project URL and public
  publishable key.

## 2026-09-09 — immersive reference reimplementation, audit and pass 1

Authority: external haimunia-claude-handoff/CLAUDE.md, IMPLEMENTATION_SPEC.md,
SCREEN_ACCEPTANCE.md, PHOTO_MAP.md, ALL_PHOTOS_MANIFEST.md, VISUAL_QA_PROTOCOL.md,
and design-reference.jpg. No applicable AGENTS.md exists in workspace/handoff/parents.
Existing dirty app.js, cloud.js, index.html and CHANGES.md are retained.
Route inventory: renderLogTab/add; renderCalendarTab/calendar (History);
renderHistoryTab/history (Progress); renderWodTab/wod; cloud.js/community.
Achievements, notifications, settings and welcome are existing modal render paths.
Preserve all delegated actions and IDs, cloud/storage logic, theme initialization and CSP.
Photo aliases already exist locally; source originals remain in external handoff.

Baseline actual Chromium screenshots: /tmp/immersive-qa/before/{add,calendar,history}-{light,dark}-{390,430}.png.
Baseline measurements: Add/History/Progress sheet 42.10% at 390 and 42.28% at 430;
36px titles; 68px nav; no document overflow. Media ends at 371/410px while pages
extend 954–1841px, violating full-page media. Five nav destinations instead of four.
Negative sheet margin reduces effective inner padding to 2/4px; target 17.94/19.78px.
Add subtitle is occluded by sheet. Calendar nests a blue bordered panel inside sheet.
Progress sheet must move to 38%; target 36–40%. These are failing baseline results.


## Final QA ledger — 2026-09-09

Three correction passes were completed for Add, History/Calendar and Progress at 390x844 and 430x932. Screenshots and measured geometry are in `docs/visual-qa/immersive/final/`; isolated HEAD baseline capture is in `before-head/` (the existing dirty-tree baseline is in `before/`). Final scene measurements: Add sheet 42.0% (390), 42.3% (430); History/Calendar 40.0% / 40.2%; Progress 38.0% / 38.2%; title 34px; 17.94–24px sheet padding; mobile bottom nav 68px; photo media touches all scene edges and continues under the sheet; no horizontal overflow.

Final verification: `scripts/visual-qa/verify.mjs` — 72 cases, 0 axe issue groups, 0 overflow cases; `scripts/visual-qa/community.mjs` — 8 populated Community/Notifications cases, 0 axe issues; isolated `community-render-cost.mjs` — 5.5ms at 4x; `npm test` — 1512/1512; `npm run check-version` and `npm run check-vendor-version` pass; `test/calendar-view-mode.test.mjs` and `scripts/browser-check/duration.mjs` pass. Full sequential run logs are in `docs/visual-qa/immersive/logs/`.

Deliberate differences: the production app keeps its existing fixed IDs and delegated save bar, so Add’s `שמירת אימון` label is written into the existing `#saveBtnLabel`; desktop retains the existing sidebar/context semantics; Settings and dense dialogs remain solid reading surfaces while their scene edge treatment uses local club photography.
