# COMM-354 Reconcile the --steel token value between repos

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
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

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
