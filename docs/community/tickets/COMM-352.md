# COMM-352 Restore the --text-scale token and unify the Large Text magnitude

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

The "Large text" accessibility toggle scales content by 20% in Noam (`--text-
scale:1.2` as a real custom property) but only 12% in Community (hardcoded
`zoom:1.12`, the variable removed entirely) — the same user-facing setting
behaves differently between the two apps with no comment justifying the
smaller value.

## Acceptance criteria

- [ ] `--text-scale` custom property reintroduced in Community (or 1.12 confirmed as
  deliberate and backported to Noam instead).
- [ ] Both apps' "Large text" setting scales by the same amount.

## Location / evidence

- `index.html:83-95,105-106` (Noam)
- `index.html:153` (Community, hardcoded `zoom:1.12`)

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
