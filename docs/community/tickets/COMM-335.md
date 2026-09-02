# COMM-335 Finish legal essentials in PRIVACY.md / TERMS.md and remove draft language

Phase: Design sync & audit remediation (2026-09-02)
Agent: identity-privacy
Status: todo
Priority: P0
Attendance-blocked: no

## Problem / user outcome

PRIVACY.md and TERMS.md still open with "this is a draft, must be reviewed"
language and PRIVACY.md closes with a literal unfinished checklist (operator
identity, contact, hosting region, retention periods, subprocessors, lawful
basis, age requirement, data-subject rights). Nothing on this list has been
added since the 2026-08-27 audit scored this 2/10 — only one unrelated
paragraph (auto-backup) was added. Both documents are linked live from the in-
app UI, so a real user can click through to a privacy policy that tells them,
in its own text, that it isn't finished.

## Acceptance criteria

- [ ] Operator legal identity, contact details, hosting region, data retention
  periods, subprocessors, lawful basis, minimum age, and applicable data-subject
  rights are all present in PRIVACY.md/TERMS.md.
- [ ] All "this is a draft"/"requires legal review" language is removed.
- [ ] A founder or legal sign-off is recorded (outside this repo if needed) before
  the in-app links (`app.js:2844`) are considered launch-ready.

## Location / evidence

- `PRIVACY.md:1-3,22`
- `TERMS.md:1-3`
- In-app links: `app.js:2844`

## Dependencies

- COMM-336

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
