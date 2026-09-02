# COMM-344 Fix onboarding modal subtitle to match the 5 screens now listed

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: todo
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Community's onboarding modal kept the subtitle "ארבעה מסכים, כל אחד למטרה שלו"
("four screens") verbatim from Noam, but appended a 5th row for Community —
the header text now contradicts the list content for every new user.

## Acceptance criteria

- [ ] Subtitle updated to reflect 5 items (e.g. "חמישה מסכים") or otherwise reworded
  so it no longer says "four" while listing five.

## Location / evidence

- `index.html:829-859`

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
