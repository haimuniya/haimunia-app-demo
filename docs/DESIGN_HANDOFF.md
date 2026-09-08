# Design handoff — האימוניה

For a designer working on the app's look without reading 1,277 lines of CSS.

---

## Read this first: what you can and cannot change from CSS

Styling lives in two places, and the split decides what a CSS-only redesign
can actually do.

| Where | What is there | Can a designer change it alone? |
|---|---|---|
| `index.html` `<style>` | 22 design tokens, ~225 component classes, 1,277 lines | **Yes** |
| `app.js` + `cloud.js` | **~1,300 inline `style="…"` attributes** | **No** — needs a developer |

Colours, type, radii, shadows, and the appearance of cards, chips and buttons
are all reachable from `index.html`, and a token + class override will work.

**Per-element spacing, sizing and layout are inline in the JavaScript, and
inline styles beat class rules.** A designer who changes layout in
`index.html` will find their changes silently overridden on exactly the
screens they cared about. If the redesign changes layout, budget developer
time to move those inline styles into classes — do not expect CSS alone to
land it.

---

## Tokens (light theme)

Every colour in the app comes from these. Change them here and the whole app
follows. The dark theme redefines the same names in two blocks — see
"Both themes" below.

```
--bg          #F2F5FA   page background
--surface     #FFFFFF   cards, rows, inputs
--surface2    #E9EFF8   chips, secondary fills, inset panels
--border      #D6DFEC   every 1px border and divider

--chalk       #1C2536   primary text
--steel       #57627A   secondary text, labels, captions

--energy      #C94B29   THE primary action colour. Save buttons, primary chips.
--brass       #956529   numbers that matter: PRs, results, 1RM, highlights
--blue        #2E5AA8   feed section marker
--green       #2E7A48   success / positive
--red         #C2392C   destructive / moderation
--teal        #1E7D76   accent, avatars
--purple      #7A4FC2   accent, avatars
--yellow      #B07E12   accent

--shadow-card  card elevation (a light inset rim + a soft drop)
--shadow-sm    small active-state elevation
--stripe       the diagonal barrier stripe under the header
--avatar-ink   text colour on a coloured avatar swatch (one per theme)
--text-scale   1.2 — the "large text" multiplier
```

**`--brass` has an accessibility floor.** It was darkened from `#A6702E` to
`#956529` because it is used at 13–14px bold for real numeric data (PRs, 1RM,
results), and the lighter value measured 4.22:1 on `--surface` — under the
4.5:1 AA minimum. If you re-pick it, keep it at or above 4.5:1 on both
`--surface` and `--bg`.

---

## Typography

Self-hosted, subset per script. `font-src` is `'self'` — **no Google Fonts, no
CDN.** Any new face must be added as a `woff2` in `assets/fonts/` and
precached in `sw.js`, or the app breaks offline.

- **Rubik** 400/600/700/800/900 — body. Full Latin **and** Hebrew cuts.
- **Anton** 400 — display, **Latin only**.
- **Secular One** 400 — display, **Hebrew only**.
- **JetBrains Mono** 500/700 — numbers, results, workout notation. Latin only.

The display stack is `'Anton','Secular One','Rubik',sans-serif` and the order
is load-bearing: `unicode-range` sends Latin to Anton, Hebrew to Secular One,
and anything neither covers to Rubik. **Rubik must stay in every stack** — it
is what catches whatever the Latin-only and Hebrew-only faces do not, and
without it Hebrew headings fall through to whatever the device happens to
have.

**Display faces are weight 400 and must stay there.** Anton and Secular One
each ship a single cut; asking for 700 or 800 makes the browser synthesise a
fake bold and smear both faces. Size carries the emphasis instead.

---

## The components that matter

Restyle these five and you have restyled most of the app.

```css
.chart-card   background:var(--surface); border:1px solid var(--border);
              border-radius:20px; padding:16px; box-shadow:var(--shadow-card);

.chip-btn     padding:9px 16px; border-radius:12px; font-weight:700;
              font-size:13px; background:var(--surface2);
.chip-btn.primary   background:var(--energy); colour #1a0d08; tinted shadow

.save-btn     the full-width primary action; Anton/Secular One, 19px

.log-row      border-radius:12px; padding:10px 12px  (list rows)

.ach-section-title   section headings; display face, weight 400, 15.5px
```

One surface deliberately has its **own material** and does not follow the card
ramp: `.wod-board`, the club's workout board. It is slate with a chalk-dust
texture because it represents the physical whiteboard in the gym. It is meant
to look different. Restyle it on purpose or leave it alone — do not "unify" it
by accident.

---

## Both themes are required

The app ships light and dark, and the viewer's OS decides. Tokens are declared
three times:

1. `:root{ … }` — the complete light palette
2. `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){ … } }`
3. `:root[data-theme="dark"]{ … }` — so an explicit choice wins

**Redefine tokens, never components, inside those blocks.** A colour whose only
definition sits inside a dark block will not exist in light mode, and the page
renders one theme's text on the other theme's background.

---

## Hard constraints — these are not preferences

- **RTL throughout.** Hebrew is the primary language. Use `margin-inline`,
  `padding-inline`, `inset-inline` — never `left`/`right`.
- **Strict CSP.** No external stylesheets, no external fonts, no CDN, no
  inline `<script>`. Everything ships from this origin.
- **No build step.** The CSS in `index.html` is what runs. No Sass, no
  Tailwind, no PostCSS.
- **Offline-first.** Every asset must be listed in `sw.js`, or the app breaks
  with no network.
- **44px minimum hit target.** This is used with chalky hands. Several
  existing sizes exist because a smaller control caused a real mis-tap bug.
- **Do not use colour alone** to carry meaning — badges pair colour with an
  icon and a word, deliberately.

---

## What the app is, so the design serves it

**Post-workout management.** A member opens it *after* training to record what
they did, see how it is going, and work out what to aim for next time. It is
not a during-workout companion — there is no rest timer and no bar-side
calculator, on purpose.

The community layer sits on top of that: a feed, the club's board for the
day's workout, and challenges. Its whole premise is that it produces value
from data the member has already logged, rather than asking them to type
posts — it competes with a WhatsApp group, and it loses any competition that
costs more effort.

Two product rules the design must not quietly break:

- **Results are private by default.** A member's numbers are shown to the club
  only if they turned that on. Designs must not imply otherwise, and must not
  nudge anyone to change it.
- **There is no ranking.** The club board is ordered by who joined it, never by
  score. A "cleaner" design must not become a leaderboard by accident.
