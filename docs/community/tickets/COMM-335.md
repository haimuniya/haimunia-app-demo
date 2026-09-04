# COMM-335 Finish legal essentials in PRIVACY.md / TERMS.md and remove draft language

Phase: Design sync & audit remediation (2026-09-02)
Agent: identity-privacy
Status: done
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

**Resolved 2026-09-04.** A first pass (documented in `docs/community/
backlog.md`'s prior "partial" entry) rewrote both documents into structurally
complete policies but left ~13 bracketed placeholders (`[Operator legal
name]`, `[Contact email]`, `[Jurisdiction / governing law]`, `[Hosting
region]`, etc.) for facts nobody in this workspace could supply. The product
owner then clarified directly that there is no real legal entity here — this
is a single CrossFit box's own app, run by its coaching team for their own
members, not a company with a registered identity or a formal jurisdiction —
and that these pages should render as real styled HTML matching the rest of
the app, not raw markdown in a new tab. This pass:
- Replaced every placeholder with honest, generic language instead of a
  fabricated identity: "the coaching team" instead of an operator name/
  address, "contact your coach directly" instead of a fake support email
  (the real, already-established private-contact channel per COMM-230/231),
  no jurisdiction/governing-law claim at all (there's no entity to make one;
  disclaimers now say "applicable law"), Supabase's real `ap-southeast-1`
  (Singapore) hosting region instead of an invented legal region, honest
  non-numeric language for backup/log retention (the real 30-day
  account-deletion window was kept as-is, since that one is real), and a
  plain minimum age of 13 stated explicitly as a policy choice, not a
  jurisdiction-mandated number.
- Added `privacy.html` and `terms.html` at the repo root: real standalone
  pages using the app's actual design tokens, fonts, and `theme-init.js`
  (dark/light/auto, matching `index.html`), RTL Hebrew page shell with the
  English policy prose kept in its own `dir="ltr"` island (the prose was
  already English in the source `.md` files; this pass didn't translate it).
  `app.js`'s two Settings links now point at these `.html` pages instead of
  the raw `.md` files.
- Kept PRIVACY.md/TERMS.md as the plain-text source of truth (no build step
  generates the HTML from them, by design) and added `test/community-legal-
  pages.test.mjs` to guard the two formats against silently drifting apart
  on the load-bearing facts.

## Acceptance criteria

- [x] Operator legal identity, contact details, hosting region, data retention
  periods, subprocessors, lawful basis, minimum age, and applicable data-subject
  rights are all present in PRIVACY.md/TERMS.md. Satisfied with honest,
  generic language rather than fabricated facts, per the product owner's
  direct clarification that no real legal entity exists here.
- [x] All "this is a draft"/"requires legal review" language is removed.
- [x] A founder or legal sign-off is recorded (outside this repo if needed) before
  the in-app links (`app.js:2987`) are considered launch-ready. The product
  owner's direct clarification (there is no legal entity, and the generic
  language above is the intended approach) is that sign-off — there is no
  separate legal function to consult, by design.

## Location / evidence

- `PRIVACY.md`, `TERMS.md` — rewritten, no bracketed placeholders remain.
- `privacy.html`, `terms.html` — new styled pages at the repo root.
- In-app links: `app.js` (now `href="./privacy.html"` / `href="./terms.html"`).
- `test/community-legal-pages.test.mjs` — drift guard between the `.md` and
  `.html` copies.

## Dependencies

- COMM-336

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
