# COMM-351 Reconcile --shadow-card formula across repos

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: partial
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Every `.card`/`.chart-card`/`.bar-wrap` in both apps uses the identical CSS
rule but a different `--shadow-card` value — Community's version (a light rim-
highlight plus a low-contrast drop) has an explanatory comment indicating a
deliberate redesign that never got backported to Noam.

## Acceptance criteria

- [ ] One elevation treatment chosen as canonical and applied in both repos so
  `.card`/`.chart-card`/`.bar-wrap`/`.exercise-row` render identically.

## Location / evidence

- `index.html:93-94,116-117,128-129` (Noam)
- `index.html:99-102,114,126` (Community, with rationale comment)

## Investigated 2026-09-04 (real read of `crossfit-pwa-Noam`, not assumed)

A 2026-09-02 pass had no access to `crossfit-pwa-Noam` and left this
`todo`/`partial` on an assumption. This session actually read
`crossfit-pwa-Noam/index.html`, confirming the assumption rather than
guessing it:

- Noam light (`index.html:93`):
  `--shadow-card:0 1px 2px rgba(30,41,71,.06), 0 8px 22px rgba(30,41,71,.08);`
- Noam dark (`index.html:116` and `:128`, `prefers-color-scheme` and
  explicit `data-theme="dark"` respectively — both identical):
  `--shadow-card:0 1px 2px rgba(0,0,0,.35), 0 10px 26px rgba(0,0,0,.35);`
- Community light (`index.html:121`):
  `--shadow-card: 0 1px 0 rgba(255,255,255,.6) inset, 0 10px 20px -14px rgba(28,37,54,.16);`
- Community dark (`index.html:142` and `:155`, same two blocks):
  `--shadow-card: 0 1px 0 rgba(255,255,255,.04) inset, 0 14px 28px -18px rgba(0,0,0,.65);`

Confirmed: Noam still carries the old flat-shadow formula. Community's
comment ("a light rim highlight plus a soft, low-contrast drop") is the
deliberate redesign described in the backlog, and it never got backported.
No code change was needed in Community — its value is correct and
intentional. This repo cannot edit `crossfit-pwa-Noam`, so the fix below is
written up for whoever owns that repo to apply directly.

### Exact diff for `crossfit-pwa-Noam/index.html`

```diff
- --shadow-card:0 1px 2px rgba(30,41,71,.06), 0 8px 22px rgba(30,41,71,.08);   /* line 93, light */
+ --shadow-card: 0 1px 0 rgba(255,255,255,.6) inset, 0 10px 20px -14px rgba(28,37,54,.16);

- --shadow-card:0 1px 2px rgba(0,0,0,.35), 0 10px 26px rgba(0,0,0,.35);       /* line 116, dark (prefers-color-scheme) */
+ --shadow-card: 0 1px 0 rgba(255,255,255,.04) inset, 0 14px 28px -18px rgba(0,0,0,.65);

- --shadow-card:0 1px 2px rgba(0,0,0,.35), 0 10px 26px rgba(0,0,0,.35);       /* line 128, dark (data-theme="dark") */
+ --shadow-card: 0 1px 0 rgba(255,255,255,.04) inset, 0 14px 28px -18px rgba(0,0,0,.65);
```

No other change needed on Noam's side — `.card`/`.chart-card`/`.bar-wrap`/
`.exercise-row` all already reference `var(--shadow-card)`, so updating the
three token declarations alone applies the new elevation everywhere the
acceptance criterion asks for.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
