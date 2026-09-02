# COMM-351 Reconcile --shadow-card formula across repos

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
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

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
