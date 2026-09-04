# COMM-354 Reconcile the --steel token value between repos

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: partial
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`--steel` (secondary/muted text — the same semantic role in both apps) is the
one color token that differs between the two repos in both light and dark
theme; every other palette token is byte-identical, suggesting unintentional
drift rather than a deliberate palette change.

## Acceptance criteria

- [ ] One `--steel` light/dark pair chosen and applied in both repos.

## Location / evidence

- `index.html:85,110,122` (Noam)
- `index.html:85,107,119` (Community)

## Investigated 2026-09-04 (real read of `crossfit-pwa-Noam`, not assumed)

Actually read `crossfit-pwa-Noam/index.html`:

- Noam light (`:85`): `--steel:#68748C;`
- Noam dark (`:110` and `:122`, `prefers-color-scheme` and explicit
  `data-theme="dark"` — both identical): `--steel:#8891A6;`

Community's current values (`index.html:99` light, `:135`/`:148` dark —
line numbers have shifted since the ticket's `:85,107,119`, content
unchanged):

- Light: `--steel:#57627A;`
- Dark: `--steel:#A8B3C9;`

Confirmed exactly as the backlog's commit-history read predicted: Noam's
`#68748C`/`#8891A6` are the pre-fix values commit `e3a5a5f`
("Accessibility fixes...") deliberately moved away from in this repo, to
clear the 4.5:1 AA contrast floor. This is not a false-positive drift read
— it is real, confirmed drift, just in the direction of "Noam hasn't caught
up yet" rather than "Community regressed." No change needed in Community.

### Exact diff for `crossfit-pwa-Noam/index.html`

```diff
- --chalk:#1C2536; --steel:#68748C; --red:#C2392C; --blue:#2E5AA8;   /* line 85, light */
+ --chalk:#1C2536; --steel:#57627A; --red:#C2392C; --blue:#2E5AA8;

- --chalk:#F2ECE1; --steel:#8891A6; --red:#D8453C; --blue:#3E6FD9;   /* line 110, dark (prefers-color-scheme) */
+ --chalk:#F2ECE1; --steel:#A8B3C9; --red:#D8453C; --blue:#3E6FD9;

- --chalk:#F2ECE1; --steel:#8891A6; --red:#D8453C; --blue:#3E6FD9;   /* line 122, dark (data-theme="dark") */
+ --chalk:#F2ECE1; --steel:#A8B3C9; --red:#D8453C; --blue:#3E6FD9;
```

Only the `--steel` value changes on each line — `--chalk`/`--red`/`--blue`
shown for context/uniqueness of the match, not part of the fix. This
directly clears the same AA contrast floor in Noam that commit `e3a5a5f`
already fixed in Community.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
