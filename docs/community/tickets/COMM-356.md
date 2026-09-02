# COMM-356 Give the challenge-joined status its own tag style instead of overriding .admin-tag

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

`.admin-tag` (defined as an energy-orange pill for admin/management context)
is reused for the weekly-challenge "joined" status with only its background
overridden to brass, leaving the text and border at their original energy-
orange — an unintentional two-tone badge for a semantically unrelated status.

## Acceptance criteria

- [ ] The challenge "joined" status gets its own small chip style (or a `.tag` base
  class with color modifiers).
- [ ] `.admin-tag` is only ever used unmodified for admin-context labels going
  forward.

## Location / evidence

- `cloud.js:5887`
- `index.html:463` (`.admin-tag` definition)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
