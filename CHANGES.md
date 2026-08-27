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
