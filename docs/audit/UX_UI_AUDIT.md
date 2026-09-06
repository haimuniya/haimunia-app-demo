# UX / UI audit

This stream did not re-run a full screen-by-screen visual review (the
2026-09-02 cross-repo audit already did that in depth, 99 findings across 10
domains, and its P0/P1 design-drift items were the subject of the later
"Implement the redesign mockup" and "Close every finding" commits). This
document covers what changed or was newly found in this pass, and points at
the existing record for everything else rather than re-deriving it.

## UX defects found and fixed this pass

### UX-001 (fixed) — The confirm sheet was keyboard-unreachable when stacked on another dialog

The single highest-impact UX finding of this pass was accessibility-flagged
(`ACCESSIBILITY_AUDIT.md` finding A3) but is really a core interaction defect:
**a keyboard-only user could not click Confirm or Cancel on ~19 destructive
actions** — delete account, admin remove-member, leave a challenge, cancel an
event, block a user, delete a post/comment — whenever the confirm sheet
opened on top of another dialog. Verified live in Chromium: five Tab presses
never reached the sheet, and Escape closed the wrong dialog. Fixed this pass
by registering the confirm sheet in the shared dialog layer
(`cloud.js` `CLOUD_DIALOGS`, first position so it always wins focus/Tab/Escape
priority over whatever it is stacked on); test coverage added
(`test/community-dialog-focus.test.mjs`, 12th dialog).

### UX-002 (fixed) — A profile report in the moderation queue showed a "remove content" button that always failed

`CODE_QUALITY_AUDIT.md` CQ-002: a moderator reviewing a reported **profile**
(as opposed to a post or comment) saw the identical five-decision button row
as any other report, including "הסרת התוכן" (remove content) — a decision
`mod_review()` unconditionally rejects for a profile target
(`'a profile report has no content to remove'`). The error surfaced as "try
again," which could never succeed. Fixed this pass: the button is no longer
offered for a profile report, with a named error message kept as a defensive
second layer.

### UX-003 (fixed) — A reported profile was mislabeled "post" in two admin screens

`CODE_QUALITY_AUDIT.md` CQ-001: same root cause as UX-002 — a two-way
post/comment ternary predates `target_type: 'profile'` and fell through to
"פוסט" (post) for a profile report, in both the moderation queue row and the
context sheet. A moderator was shown the member's own bio captioned as a
"post excerpt." Fixed this pass with a proper three-way label map.

### UX-004 (fixed) — A flaky connection could re-run new-member onboarding on an existing member

`CODE_QUALITY_AUDIT.md` CQ-006: `loadProfile()`/`loadRedemption()` collapsed
"the fetch failed" into "the row doesn't exist," so a returning member on a
bad connection saw the first-run intro carousel and then an unskippable
"complete your profile" form — for an account that already has one.
Submitting it would attempt to create a duplicate profile. Fixed this pass:
a distinct retry screen ("בעיה בטעינת הקהילה" / "problem loading the
community") now renders instead of silently reinterpreting a load failure as
"never joined," with a manual retry action.

### UX-005 (fixed) — One transient error could permanently hide the coach badge for a whole batch of members

`CODE_QUALITY_AUDIT.md` CQ-003: `loadMemberRoles()` dropped its RPC error and
pre-seeded every requested id as "no role" with no retry path for the rest of
the session — invisible in the UI as anything other than "that coach's badge
is just... gone" on every surface that shows one (feed, comments, profile
headers, search, directory). Fixed this pass.

## UX gaps identified but not fixed this pass (documented, prioritized)

These are real, but lower priority (P2/P3) or require product-owner input
before a safe fix — listed here so they are tracked, not silently dropped:

- **CQ-004 / CQ-004b** (`CODE_QUALITY_AUDIT.md`) — signed avatar/photo URLs
  are cached for the session but the signature expires after 1 hour; a
  long-lived installed-PWA session sees broken images with no retry.
  `saveAvatarUrl()` also lacks the read-back pattern its two sibling editors
  use. P2/P3, open.
- **CQ-005** — `map_link` (event location link) is validated only
  server-side; a coach who enters a bad scheme gets a generic save-failure
  message with no indication which field is wrong. Not a security finding
  (the DB CHECK is the real boundary and rendering is already safe) — a pure
  UX gap. P3, open.
- **CQ-007+** (see `CODE_QUALITY_AUDIT.md` for the full CQ-007 through CQ-014
  list) — assorted partial-failure/race-condition UI gaps in coach
  celebrate/welcome posts and elsewhere, not reviewed in depth by this
  document; treat `CODE_QUALITY_AUDIT.md` as the source of record.
- **A2/A4/A5** (`ACCESSIBILITY_AUDIT.md`) — near-zero heading structure
  across the entire Community module (5 heading elements total), contrast
  testing that covers only one of two theme-critical colors in light mode
  only, and no automated accessibility scanner (axe or equivalent) anywhere
  in CI. These are accessibility findings with direct UX consequences
  (screen-reader users cannot navigate Community by heading at all) and are
  tracked there, not duplicated here.
- **Design-token/visual-consistency drift** named by the 2026-09-02 audit —
  reconciliation of which of those 99 findings are still open vs. fixed by
  the subsequent redesign commits is `RISK_REGISTER.md`'s job, not
  re-derived here.

## Positive findings

- Icon-only control labelling is complete — every checked control across
  `index.html`/`app.js`/`cloud.js` carries an `aria-label` (`ACCESSIBILITY_AUDIT.md`
  §3); this is also a UX win (screen-reader and voice-control users can
  identify every control).
- Error-state conventions are mostly consistent: the loading/error/populated
  three-way switch (`*Loading`/`*Error`/`*Loaded` state triples) is used
  correctly across the large majority of loaders reviewed in
  `CODE_QUALITY_AUDIT.md` — the P1 findings fixed this pass were the
  documented **outliers** from an otherwise-followed convention, not evidence
  the convention itself is weak.
- Destructive-action confirmation exists everywhere it should (~19 actions
  gated through `askConfirm()`) — the defect fixed this pass was in *reaching*
  that confirmation by keyboard, not in its absence.
