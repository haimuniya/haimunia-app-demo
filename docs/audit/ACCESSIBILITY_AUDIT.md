# Accessibility audit

Commit `d2e6408`, branch `main`. Greps and line numbers below are against that commit.
The headline dialog finding was **verified empirically in real Chromium**, not inferred
from reading — the driver script and its raw output are reproduced below.

**No automated scanner was run.** There is no `axe-core` or `@axe-*` dependency
anywhere in this repo — not in `package.json`, not in `scripts/browser-check/package.json`,
not in `.github/workflows/`. `test/heading-outline.test.mjs`'s own header comment says
so explicitly. No WCAG conformance score is claimed here; this is a targeted structural
review plus one executed browser probe.

---

## 1. Structure: headings and landmarks

### Landmark roles

| File | `<main>` | `<nav>` | `role="dialog"` | `aria-modal` | `role="tablist"` | `role="tabpanel"` | `role="alert"` | `aria-live` |
|---|---|---|---|---|---|---|---|---|
| `index.html` | 1 | 2 | 10 | 10 | 1 | **1** | 2 | 2 |
| `app.js` | – | – | – | – | 4 | **0** | 4 | 2 |
| `cloud.js` | – | – | 13 | 13 | 5 | **0** | 27 | – |

Landmarks are present and correct at the shell level: one `<main>`, two `<nav>`, and
**every** `role="dialog"` is paired with `aria-modal="true"` — 23 of 23, no exceptions.
`role="alert"` is used liberally (33 occurrences) for error and validation text, and
`field()` in `cloud.js` splices `aria-invalid` + `aria-describedby` onto the input and
renders the matching visible error with `role="alert"` — the same message reaching
sighted and screen-reader users at the same place. That is genuinely well done.

### Finding A1 — 10 tablists, 1 tabpanel, and it belongs to none of them

```html
<!-- index.html:791 -->
<main><div id="content" role="tabpanel"></div></main>
```

There is exactly **one** `role="tabpanel"` in the entire codebase, and it is a single
shared container reused by every tab. It carries no `aria-labelledby` pointing at the
active tab, so a screen reader announces "tab panel" with no indication of *which*
panel.

Meanwhile `cloud.js` has **5 `role="tablist"` groups** (community sub-tabs 11328,
Manage sub-tabs 11414, feed-scope filter 11139, plus others) and **zero `aria-controls`
attributes** — `grep -c "aria-controls" cloud.js` → `0`. `app.js` has 4. So every
Community tablist declares the tab/tablist pattern without ever naming the region it
controls, and no Community tab has a panel at all.

Consequence: assistive tech is told "this is a tab in a tablist" — which sets an
expectation of an associated, labelled panel — and then finds none.

### Finding A2 — the Community module is nearly heading-free

Total heading elements in the shipped source:

| File | `<h1>` | `<h2>` | `<h3>` | `<h4>`–`<h6>` | `role="heading"` |
|---|---|---|---|---|---|
| `index.html` | 0 | 0 | 0 | 0 | 0 |
| `app.js` | 1 | 4 | 0 | 0 | 0 |
| `cloud.js` | **3** | 1 | 1 | 0 | 0 |

`index.html` has **zero** headings — expected, since all content is rendered by JS.

But `cloud.js` — 841 KB, 13 dialogs, 5 tablists, the feed, profiles, challenges,
events, recaps, moderation, and the whole admin surface — ships **five heading elements
total**. Three `<h1>` (11331, 11391, 11420, mutually exclusive page titles), one `<h2>`
(4405), one `<h3>` (5386).

Section titles are styled `<div>`s instead. Every dialog's `aria-labelledby` points at a
`<div>`, e.g.:

```js
// cloud.js:4394
<div id="communityConfirmTitle" style="...font-weight:800;font-size:17px;...">
```

This gives the dialog a correct *accessible name* — so `aria-labelledby` is not broken
— but it means heading-based navigation (the primary way screen-reader users skim a
screen: `H`, or the rotor's heading list) returns essentially nothing across the entire
Community module.

`test/heading-outline.test.mjs` is honest about this in its own header:

> *"The community screens (feed/profile/challenges/admin) named in the same criterion
> are NOT covered here: reaching them needs a signed-in community fixture … which is
> real, separate work - see the COMM-329 ticket file's 'Not done' section."*

So the gap is **known and documented**, not hidden. It is still the largest structural
accessibility gap in the product.

---

## 2. Dialog focus management

### The shared layer — well built, for the 11 dialogs it owns

`cloud.js` has a real, shared focus layer (COMM-190), and it is good work:

- `CLOUD_DIALOGS` registry (`cloud.js:11480`) — 11 entries, each `{ key, isOpen, close }`
- `cloudDialogFocusables()` (`cloud.js:11535`) — filters `disabled`, `aria-hidden="true"`, `display:none`
- `syncCloudDialogFocus()` — moves focus in on open, restores to the opener on close
- Opener tracking by **re-resolvable CSS selector** (`cloudOpenerSelector`, `cloud.js:11514`) rather
  than an element reference, because the render that opens a dialog destroys the button
  that triggered it — a genuinely thoughtful solution to a real problem this
  architecture creates
- Tab trap at `cloud.js:12432`, Escape chain at `12446–12458`, backdrop-click close at `12462`

`app.js` has its own equivalent layer for the 10 `index.html` overlays (`APP_DIALOGS` `app.js:3710`,
`registerAppDialog` `:3711`, `appDialogFocusables` `:3716`, Escape+Tab trap at `app.js:3730–3740`), with
`onboarding` and `welcome` deliberately opting out of Escape-to-close while keeping the
Tab trap. Also well reasoned.

### Coverage of `community-dialog-focus.test.mjs` — exactly 11 of 11 registered dialogs

| `data-cloud-dialog` key | In `CLOUD_DIALOGS` | Covered by the test |
|---|---|---|
| `reportSheet` | ✅ | ✅ |
| `modAction` | ✅ | ✅ |
| `modContext` | ✅ | ✅ |
| `notifCenter` | ✅ | ✅ |
| `achUnlock` | ✅ | ✅ |
| `prPrompt` | ✅ | ✅ |
| `composer` | ✅ | ✅ |
| `profileView` | ✅ | ✅ |
| `challengeView` | ✅ | ✅ |
| `eventView` | ✅ | ✅ |
| `recapView` | ✅ | ✅ |

**Coverage of the registry is complete — 11/11, no gaps.** Each is asserted against the
same five-point contract (role/aria-modal, focus-in, Tab wrap both directions, Escape +
focus restore, backdrop close). This is a well-maintained test.

### Finding A3 (HIGH) — the confirm sheet is the 12th dialog, and it is in no registry at all

`renderConfirmSheet()` (`cloud.js:4388`) renders a `role="dialog" aria-modal="true"`
overlay that:

- **carries no `data-cloud-dialog` attribute** — verified in the browser, `false`
- is **absent from `CLOUD_DIALOGS`** (11 keys, none is a confirm key)
- is **absent from the Escape chain** (`cloud.js:12446–12458` lists 8 states; `state.ui.confirmDialog` is not among them)
- is **absent from `community-dialog-focus.test.mjs`**

It is therefore invisible to `currentCloudDialog()`, which drives the focus-in, the Tab
trap, the Escape close and the focus restore.

This is not a minor dialog. `askConfirm()` gates **~19 destructive or irreversible
actions**, including:

| Action | `cloud.js` |
|---|---|
| Delete account | 11874 |
| Admin: remove member | 11974 |
| Admin: reset password | 11975 |
| Admin: grant coach / set role | 11970, 11972 |
| Admin: revoke invite | 11958 |
| Block a user | 11871 |
| Delete post / delete share | 11872, 11992 |
| Delete comment | 11877 |
| Cancel an event | 8231 |
| Leave a challenge | 6791 |
| Delete a challenge draft / team | 12062, 6757 |
| Discard a composed post | 8976 |
| Migrate private history to the cloud | 11839 |

#### Verified in real Chromium

Driver: Playwright + the repo's own `lib/mockCloud.mjs`, seeded with one active
challenge the member has joined. (Written to a temp file, executed, then deleted — no
repo file was modified.)

**Case 1 — confirm sheet stacked on `challengeView`** (via "leave challenge"):

```json
{
  "openOverlayCount": 2,
  "confirmIsLastOverlay": true,
  "confirmHasCloudDialogAttr": false,
  "activeElementTag": "BUTTON",
  "activeElementText": "✕",
  "focusIsInsideConfirmSheet": false,
  "challengeViewStillInDom": true
}
after 5x Tab: {"focusInConfirmSheet":false,"focusInChallengeView":true,"activeText":"✕"}
after Escape: {"confirmSheetStillOpen":true,"challengeViewStillOpen":false}
```

Three real defects, all measured:

1. **Focus never enters the confirm sheet.** It stays on `challengeView`'s ✕ button.
2. **Five Tab presses never reach it.** `currentCloudDialog()` returns `"challengeView"`
   (the first registry entry whose `isOpen()` is true), so the Tab trap actively locks
   focus inside the dialog *underneath* — which is visually covered and non-interactive.
   **A keyboard-only user cannot reach the Confirm or Cancel button at all.**
3. **Escape closes the wrong dialog.** It destroys `challengeView` and leaves the
   orphaned confirm sheet on screen — a broken state reachable with one keypress.

**Case 2 — confirm sheet with nothing underneath** (via Account → "delete account"):

```json
{
  "openOverlayCount": 1,
  "confirmHasCloudDialogAttr": false,
  "activeElementTag": "BODY",
  "focusIsInsideConfirmSheet": false
}
after 5x Tab: {"focusInConfirmSheet":false,"activeText":"שמירת פרופיל"}
after Escape: {"confirmSheetStillOpen":true}
```

1. Focus **drops to `<body>`** when the sheet opens (the rerender destroyed the opener).
2. Tab then **walks the page behind the overlay** — landing on "Save profile", a control
   the modal is covering. No trap whatsoever.
3. Escape does nothing.

#### Why this exists

`cloud.js:10895` documents the mouse-side half of exactly this bug being found and fixed:

> *"askConfirm() is meant to be a modal-on-modal confirmation nested inside whatever
> triggered it … so it has to render LAST, not first - a real Chromium browser check
> caught this (jsdom's programmatic .click() has no hit-testing, so every existing node
> test clicked straight through the invisible overlap and never noticed a real user
> cannot reach the confirm button at all in this state)."*

The z-order fix landed. **The keyboard equivalent of the same bug did not.** And the
root cause the comment names — jsdom can't hit-test — is precisely why
`community-dialog-focus.test.mjs`, which runs in jsdom, could never have caught it.

Note also that `currentCloudDialog()` returns the **first match in array order**, not
the topmost dialog. Any future modal-on-modal pairing inherits the same bug.

---

## 3. Labelling of icon-only controls

**No gaps found here.** Every icon-only control checked carries an `aria-label`:

| Control | Location |
|---|---|
| `≡` nav menu | `index.html:771` `aria-label="תפריט"` + `aria-haspopup="dialog"` + `aria-controls` |
| 🔔 notifications | `index.html:775` `aria-label="עדכונים"` |
| `✕` delete custom WOD | `app.js:3960` `aria-label="מחיקת ${name}"` — interpolates the item name |
| `✕` cancel share | `cloud.js:4240` |
| `✕` unpin | `cloud.js:6075` |
| `⋯` post menu | `cloud.js:6179` + `aria-haspopup` + `aria-expanded` |
| `✕` close challenge/event/recap | `cloud.js:7970, 8549, 8949` |

Counts: `aria-label` — 29 (`index.html`), 39 (`app.js`), 50 (`cloud.js`);
`aria-labelledby` — 14 / 1 / 13. Tab badges get `aria-label="${n} דיווחים ממתינים"`,
and the bottom tab bar interpolates the badge count into the tab's own label
(`app.js:128`) rather than leaving a bare number.

A regex sweep for symbol-only buttons (`✕ ✓ ← → › ‹ ⋯ … ⚙ 🔔 ＋`) missing `aria-label`
returned **no hits** in any of the three files.

---

## 4. Design tokens — fresh grep

A prior audit flagged a shadow token as deleted. Reporting only what is in the file
today; reconciling that earlier finding belongs to another stream.

**`--shadow-sm` exists, in all three theme blocks:**

| `index.html` | Block | Value |
|---|---|---|
| 124 | `:root` (light) | `0 1px 3px rgba(30,41,71,.10)` |
| 143 | `@media (prefers-color-scheme: dark)` | `0 1px 3px rgba(0,0,0,.4)` |
| 156 | `[data-theme="dark"]` | `0 1px 3px rgba(0,0,0,.4)` |

`--shadow-card` is likewise defined at 121 / 142 / 155. Both are consumed throughout
(`.tabbtn.active`, `.card`, `.chart-card`, `.stat-card`, `.log-row`, `.exercise-row`,
`.settings-block`, `.desktop-sidebar`, `.movement-btn`, `.cal-panel`, …).

**No missing token. Nothing to fix.** The light/dark/explicit-toggle triple is correctly
defined in all three places.

---

## 5. What the existing a11y tests actually assert

| File | Asserts | Leaves unguarded |
|---|---|---|
| `chart-accessible-name.test.mjs` (36 ln) | `renderChart()` SVG gets `role="img"` + an `aria-label` naming point count, first value, last value, PR count; single-point charts too | Only `renderChart()`. No other SVG/canvas/`<progress>` visual in either file is checked for a text alternative. |
| `heading-outline.test.mjs` (87 ln) | Inside `<main>`: non-empty heading list, no skipped levels, exactly one `<h1>` — for `add`/`history`/`calendar`/`wod` + `manage` | **feed, profile, challenges, events, recaps, admin, moderation** — the entire Community surface, and all 23 dialogs. Documented as "Not done" in-file. |
| `tablist-keyboard.test.mjs` (68 ln) | Roving tabindex; RTL-aware Arrow Left/Right; Home/End; Arrow Up/Down on the WOD subtabbar; focus follows selection | Community's 5 tablists — the header says the feed-scope filter "reuses the exact same handler and is not re-tested here". No test that a tab has a labelled `tabpanel` (see A1). |
| `community-dialog-focus.test.mjs` (538 ln) | Full 5-point contract × 11 dialogs | **The confirm sheet (A3).** Also: jsdom cannot hit-test, so *visual* reachability of stacked overlays is structurally out of reach for this file. |
| `brass-contrast.test.mjs` (45 ln) | Real relative-luminance ratio: light `--brass` ≥ 4.5:1 vs `--surface` and `--bg`, parsed from shipped `index.html` | **Only `--brass`, only light theme.** `--steel` (used at 11–13.5 px for secondary text throughout `cloud.js`) is never checked, in either theme. No dark-theme contrast test exists at all. No non-text/UI-component contrast (3:1) check. |

Collectively these are focused, honest tests that guard real regressions — and each one
documents its own boundary. The gap is breadth, not quality.

---

## Summary — ranked

| # | Finding | Severity | Evidence |
|---|---|---|---|
| **A3** | Confirm sheet (`cloud.js:4388`) is in no dialog registry: no focus-in, no Tab trap, no Escape. Stacked, the trap **locks focus in the covered dialog** and Escape closes the wrong one; unstacked, focus drops to `<body>` and Tab walks the page behind the modal. Gates ~19 destructive actions incl. delete-account and admin remove-member. | **High** | Verified in Chromium, raw output above |
| **A2** | Entire Community module ships 5 heading elements; dialog titles are `<div>`s. Heading navigation is effectively dead across feed/profile/challenges/admin. | **Medium-High** | `grep -oE "<h[1-6]" cloud.js` → 5; documented "Not done" in `heading-outline.test.mjs` |
| **A1** | 10 tablists but 1 shared unlabelled `role="tabpanel"`; `aria-controls` count in `cloud.js` is **0**. Tab pattern declared without the panel it implies. | **Medium** | `index.html:791`; `grep -c aria-controls cloud.js` → 0 |
| A4 | Contrast testing covers `--brass` only, light theme only. `--steel` at 11–13.5 px is untested in either theme; no dark-theme contrast test exists. | Medium | `brass-contrast.test.mjs` |
| A5 | No automated scanner (axe or equivalent) anywhere in the repo or CI. | Medium | No `axe-core` in `package.json` or workflows |

**Not measured here:** WCAG conformance level, screen-reader behaviour with a real
AT (NVDA/JAWS/VoiceOver/TalkBack), colour-contrast sweep across all token pairs,
reflow/zoom to 400 %, touch-target sizing. None of the tooling for any of these exists
in this repo, and no real assistive technology was available in this environment.
