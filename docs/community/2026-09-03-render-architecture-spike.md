# COMM-366 — scoped/keyed rendering vs. cloud.js's full-tree rerender

Spike, 2026-09-03. Agent: platform.

**Decision: keep the full-tree rerender. Do not migrate to a keyed diff or a
framework.** Adopt three narrow guardrails instead, and record the trip-wires
that would reverse this decision. The migration path, costed, is in §6 so a
future ticket does not have to redo this analysis.

---

## 1. What the ticket asked

> Every state mutation triggers a full `innerHTML` rebuild of the visible tab
> (341 `rerender()` call sites), which is expensive enough that a ~60-line
> manual DOM-focus-restoration subsystem (`syncCloudDialogFocus`) exists purely
> to compensate. This is a scaling risk as Phase 2/3 add more UI on top of the
> same pattern.
>
> — [`docs/community/tickets/COMM-366.md`](tickets/COMM-366.md)

Acceptance was explicitly *"either a migration plan is proposed, or an explicit
documented decision is made to keep full-rerender with known limits."* This
note does both: the decision, plus the plan that would be executed if the
trip-wires in §5 ever fire.

## 2. How it actually works today

`cloud.js`'s `rerender()` is one line:

```js
function rerender() { if (typeof window.render === "function") window.render(); }
```

`window.render()` (`app.js`) builds the whole visible tab as one string, then
does a single `document.getElementById("content").innerHTML = content + cloudOverlay;`
plus four smaller unconditional whole-element writes (`#navMenuList`,
`#settingsBody`, `#desktopSidebar`, `#bottomTabBar`). There is no diff, no
keying and no node reuse: **every element in the tab is destroyed and
recreated on every state change**, which the spike instrument confirms
directly (`#content.firstElementChild` is never the same node twice).

Current scale, measured on this branch:

| | |
| --- | --- |
| `rerender()` call sites in cloud.js | 342 |
| cloud.js | 10,680 lines |
| Focus/keyboard restoration subsystem it forces | 148 lines (`syncCloudDialogFocus` itself is 46) |
| Surgical DOM patches that exist to *avoid* a rerender | 8 `getElementById` sites, 3 of them documented as "no rerender on input, so typing never loses focus" |

## 3. What it costs — measured, not assumed

Run it yourself: `node scripts/browser-check/community-render-cost.mjs`
(real Chromium, local static server, in-page mock backend).

Signed-in member, Community tab, one loaded feed page (20 post cards):

```
  post cards in #content   20
  HTML returned            27548 bytes
  elements in #content     274
  focusable controls       92
  window.render()          0.96 ms   (mean of 50)
  innerHTML write alone    0.43 ms
  => string building       0.53 ms of it
```

Under CDP CPU throttling, which is the case that actually decides this — the
members using this app are on phones, not on the machine it was written on:

```
  1x slowdown (desktop)              0.89 ms/render
  4x slowdown (~mid-range phone)     3.79 ms/render
  6x slowdown (~low-end phone)       5.92 ms/render
```

Scaling with feed depth (the `innerHTML` write alone, one real post card
repeated — feed pages are 20 cards, so 120 is six pages deep):

```
  cards    bytes   elements   ms/write
      1     1221         12      0.037
     10    12210        120      0.243
     30    36630        360      0.740
     60    73260        720      1.457
    120   146520       1440      2.057
```

Linear, with no cliff. And one ordinary interaction:

```
  One tap on the feed's "toggle-comments" control triggered 2 full-tab rebuilds.
```

**Read of the numbers.** At today's depth a full rebuild costs ~4 ms on a
mid-range phone and ~6 ms on a low-end one — comfortably inside a 16 ms frame,
even at 2 rebuilds per tap. Six feed pages deep the write alone roughly
quadruples; call it ~15–20 ms per rebuild at 6× throttle, which is where it
starts to be felt on a scroll-and-react session. That is a real ceiling, but it
is a ceiling this product is not near, and it is reached gradually rather than
suddenly.

## 4. So the performance framing in the ticket is the wrong framing

The ticket calls this "expensive enough that a ~60-line focus-restoration
subsystem exists to compensate." The measurements say the expense is not the
milliseconds. **The cost is correctness, and it is already being paid.**

Destroying every node on every state change means everything the DOM normally
holds for you has to be re-established by hand:

- **Focus.** `syncCloudDialogFocus` (148 lines) exists solely for this. It has
  to capture the clicked control in the *capture* phase, because the
  bubble-phase handler that opens a dialog re-renders `#content` and destroys
  the very button that was clicked. It then serialises that button into a CSS
  selector built from `data-community-action` plus every other `data-*`
  attribute, and re-resolves it against the fresh DOM later — because a direct
  element reference would already be detached. That is not defensive
  over-engineering; it is the minimum this rendering model requires.
- **Typing.** Three separate surfaces (the composer body counter, the Member of
  the Week reason counter, the coach Welcome assign/contact drafts) deliberately
  do *not* rerender on input and patch the DOM directly instead, precisely to
  avoid the caret jumping. Each one is a hand-written exception to the model.
- **Scroll position, `<details>` open state, IME composition, CSS transitions.**
  None of these survive a rebuild, and none of them have a restoration
  subsystem — they are simply accepted losses today.

Every new feature has to independently rediscover these rules. That is the
scaling risk, and it scales with **surface count**, not with feed depth.

## 5. Decision, and the trip-wires that reverse it

**Keep the full-tree rerender.**

Reasons, in order of weight:

1. **The measured cost is not a user problem, and a rewrite is not free.** 342
   call sites in a 10,680-line file that is the load-bearing client for a live
   box. The failure mode of a botched rendering migration is not "slower" — it
   is "a member's comment silently posts to the wrong thread." The expected
   value is negative while frame budget is being met by 4×.
2. **Full rerender is what makes cloud.js's state model safe.** There is exactly
   one way for the UI to be wrong (state is wrong) rather than two (state is
   wrong, *or* the diff missed something). For a small team shipping fast, on a
   codebase with no component boundaries, that is worth real milliseconds. It is
   the same trade COMM-365's `state` namespacing leans on.
3. **No build step is a standing product constraint.** Every keyed-diff library
   worth adopting (lit-html, µhtml, morphdom) means either a bundler or another
   vendored dependency in a repo that has deliberately avoided both. morphdom is
   the one that could be vendored as-is, and §6 explains why it is still not the
   first move.
4. **The half that hurts is fixable without touching the render model** — see
   the guardrails below.

**Guardrails adopted now** (small, and each is independently useful):

- **G1 — the rerender is the contract; direct DOM patching is the exception and
  must say why.** The three existing patch sites all carry a comment explaining
  the caret. New ones must too. `test/community-state-namespaces.test.mjs` and
  `test/community-dialog-focus.test.mjs` are the existing guards on the model;
  keep any new dialog registered in `CLOUD_DIALOGS` rather than hand-rolling
  focus handling per surface.
- **G2 — `scripts/browser-check/community-render-cost.mjs` is the trip-wire
  instrument, and it is armed.** It runs as part of `run-all.mjs` and *fails*
  if a full rerender exceeds 16 ms at 4× throttle, if one tap costs more than
  four full rebuilds, or if the feed stops rendering under it. Not in CI (it
  needs Chromium), so re-run `run-all.mjs` at the end of each phase and paste
  the numbers into that phase's notes — this spike is only as good as the
  numbers being refreshed.
- **G3 — no new full-tab rerender on `input`/`keyup`.** Every one of those needs
  a direct DOM patch or a debounce, because there is no keyed diff to save the
  caret. This is already the de-facto rule; write it down.

**Trip-wires. Reverse this decision if any one of these fires:**

- The measured full render exceeds **16 ms at 4× CPU throttle** at a depth
  members actually reach (today: 3.8 ms — a ~4× headroom). This one is
  automated: it is an assertion in the instrument, not a note to self.
- A **third** hand-rolled DOM-state restoration subsystem appears alongside
  focus (e.g. scroll-position restoration and `<details>` restoration both
  becoming necessary). Two is a pattern; three is a framework you are writing
  by accident, badly.
- A surface needs to animate or transition an element **across** a state change.
  That is structurally impossible under this model, not merely awkward, and no
  guardrail fixes it.
- Feed virtualisation is needed. Virtualisation and full-tree `innerHTML` are
  fundamentally incompatible; whichever ticket brings virtualisation brings
  scoped rendering with it.

## 6. The migration plan, if a trip-wire fires

Do **not** adopt a framework, and do not attempt a big-bang keyed diff. The
incremental path already has a working precedent in this repo: `app.js`'s other
tabs are *already* scope-rendered. `render()` writes the tab shell once and then
calls `renderHistoryListArea()`, `renderBodyweightArea()`, `renderMeasureArea()`,
`renderCalendarGrid()` and `renderWodContent()`, each of which writes into its
own `getElementById(...)` container. The Community tab is the one tab that never
adopted this. So the migration is "make Community look like the rest of app.js",
not "introduce a new architecture".

**Phase A — introduce the seam (1 ticket, low risk).**
Add one helper to cloud.js:

```js
// Writes `html` into the element with this id if it is on screen, and returns
// true. Returns false when it is not, so the caller can fall back to rerender().
function renderSection(id, html) { ... }
```

and a `rerenderSection(name)` wrapper that maps a domain name to its container
id + its render function. Change **nothing** else. Every existing `rerender()`
keeps working.

**Phase B — convert the hottest surfaces one at a time (n small tickets).**
COMM-365's state namespacing is what makes this tractable: each namespace maps
to a section, so "this mutation only touches `state.engagement`" becomes a
mechanical claim rather than a judgement call. Highest value first:

1. `state.engagement.*` → the comment thread of one post (the surface with the
   worst caret/focus behaviour today).
2. `state.feed.items` append on "load more" → append cards instead of rebuilding
   the list (this is also the prerequisite for virtualisation).
3. `state.notif.unread` → the bell badge, currently a full-tab rebuild to change
   one number.

Each conversion is independently revertible: if `rerenderSection` is wrong, the
caller goes back to `rerender()` in one line.

**Phase C — only if B is not enough.** Vendor morphdom (~3 KB, single classic
script, no build step, fits `vendor/`) and change the *one* line in `app.js`'s
`render()` from `content.innerHTML = html` to `morphdom(content, html)`. Because
morphdom preserves matching nodes, focus and scroll survive by themselves, and
`syncCloudDialogFocus` shrinks to the "move focus in when a dialog first
appears" case. Note this is a genuinely different risk profile from A/B: it
changes the behaviour of all 342 call sites at once, and `data-*`-driven
matching would have to be audited. Do it last, or not at all.

**Cost.** A: ~half a day. B: ~1 day per surface. C: ~2 days plus a full manual
sweep. Compare against a from-scratch keyed-diff migration of 342 call sites,
which is weeks and has no safe intermediate state.

## 7. What this spike deliberately did not do

- It did not rewrite any rendering code. Per the ticket, this is a spike.
- It did not benchmark a keyed-diff alternative head to head. That would only be
  worth doing once a trip-wire fires; the decision above does not depend on the
  margin, only on the fact that the current model has ~4× headroom.
- It did not measure a real device, only CDP throttling. A 4×/6× throttle is a
  good proxy but not the same thing; if a member reports jank, measure their
  actual phone before acting on these numbers.
