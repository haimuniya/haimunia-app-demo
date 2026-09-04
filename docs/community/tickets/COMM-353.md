# COMM-353 Align .page-title typography treatment

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: partial
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`.page-title` (every screen's heading) switched to a different
font/weight/letter-spacing treatment in Community (Anton/400+tracking) with no
corresponding Noam change (Rubik/800) — the two apps' page headers currently
don't match at all.

## Acceptance criteria

- [ ] One typography treatment chosen and applied in both repos for `.page-title`.

## Location / evidence

- `index.html:155` (Noam)
- `index.html:306` (Community)

## Investigated 2026-09-04 (real read of `crossfit-pwa-Noam`, not assumed)

Actually read `crossfit-pwa-Noam/index.html:155`:

```css
.page-title{ font-weight:800; font-size:21px; color:var(--chalk); margin-bottom:16px; }
```

Community's current rule (`index.html:402` — line number has since shifted
from the `:306` on file, content unchanged):

```css
.page-title{ font-family:'Anton',sans-serif; font-weight:400; letter-spacing:.3px; font-size:22px; color:var(--chalk); margin-bottom:14px; }
```

Confirmed: Noam still renders `.page-title` in Rubik/800 with no
letter-spacing, exactly as the backlog assumed. Community's Anton/400+
tracking treatment is the deliberate shipped redesign (commit `28819f7`),
not drift, and needs no change here. Noam already has the `Anton`
`@font-face` declared (`index.html:74`, used elsewhere for e.g.
`.history-stat-value`/`.save-btn`), so this is a pure CSS-rule change, no
new font asset to add.

### Exact diff for `crossfit-pwa-Noam/index.html`

```diff
- .page-title{ font-weight:800; font-size:21px; color:var(--chalk); margin-bottom:16px; }
+ .page-title{ font-family:'Anton',sans-serif; font-weight:400; letter-spacing:.3px; font-size:22px; color:var(--chalk); margin-bottom:14px; }
```

(line 155 in the checkout read for this ticket; confirm the line number is
still current before applying, since Noam has unrelated local changes in
progress.)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
