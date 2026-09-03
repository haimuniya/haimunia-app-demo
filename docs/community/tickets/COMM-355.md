# COMM-355 Preserve the cloud-aware backup staleness threshold when porting the Settings redesign

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P1
Attendance-blocked: no

## Problem / user outcome

Community's settings staleness banner uses a legitimate cloud-aware threshold
(30 days if cloud sync is active, 5 days otherwise) but lost Noam's icon+box
`.settings-warn` visual treatment in favor of plain colored text. This should
be preserved, not reverted, when COMM-323 ports the Settings redesign.

## Acceptance criteria

- [x] The 5/30-day cloud-aware threshold logic is carried into the new `.settings-
  warn` component as part of COMM-323, not reverted to Noam's flat 21-day rule.

## Shipped 2026-09-03

Done together with COMM-323. `renderSettingsBody()`'s `cloudCovered ? 30 : 5`
logic is untouched (byte-identical); only the wrapping markup changed, from
a plain `.footer-note` colored line to `.settings-warn` (icon + box,
`index.html`) - same threshold, same message, new chrome.

## Location / evidence

- `app.js:2799-2809` (Community threshold logic)
- `app.js:4024-4025` (Noam's flat 21-day rule and `.settings-warn` styling)

## Dependencies

- COMM-323

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
