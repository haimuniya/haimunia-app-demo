# COMM-350 Reconcile active-tab visual language once Community's nav IA is final

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Three different active-state treatments now coexist (`.tabbtn.active`
pill+cap, `.navrow.tabbtn.active` inset-shadow+border, `.subtabbtn.active`), a
direct consequence of Community's nav IA expansion. Blocked on the navigation-
pattern decision in COMM-327.

## Acceptance criteria

- [ ] Once COMM-327 is decided, one active-state treatment is chosen and applied
  consistently across `.tabbtn`, `.navrow.tabbtn`, and `.subtabbtn`.

## Location / evidence

- `index.html:165-175` (Noam `.tabbar`/`.tabbtn`), `:191-193, 293-294`
  (Community `.tabbar`/`.navrow.tabbtn`)

## Dependencies

- COMM-327

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
