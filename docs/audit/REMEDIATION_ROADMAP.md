# Remediation roadmap

Everything below is **still open** after this pass. Items this pass closed
are in `CORRECTIONS_COMPLETED.md`, not repeated here. Ordered by priority;
priority does not grant permission to defer — see `PRODUCTION_ACCEPTANCE_CHECKLIST.md`
for why none of this blocks a release-readiness verdict from being honest
about what remains.

## P0 — none open

The single P0 this audit found (SEC-001) is fixed this pass, pending live
verification (see `PRODUCTION_ACCEPTANCE_CHECKLIST.md`).

## P1 — open

1. **Verify the two new migrations against a real Postgres.** Neither
   `202609060011` nor `202609060012` has run against a live database — this
   sandbox has no Supabase CLI and no running Docker container. Required:
   `supabase db reset` (clean apply of all ~78 migrations) then
   `supabase test db` (pgTAP, including the two new test files). This is the
   single most important unresolved item — every fix in this pass is
   currently **unverified**, not **disproven**.
2. **SEC-004 — CAPTCHA on sign-up.** Requires a live Supabase dashboard site
   key; see `FEATURE_RECOMMENDATIONS.md`.
3. **Reliability — no idempotency on `post_create`/`add_post_comment`/`challenge_progress`.**
   `RELIABILITY_AUDIT.md`: a retried write after a client-perceived timeout
   can duplicate a post/comment or double-count challenge progress. Not
   fixed this pass — requires either client-generated idempotency keys
   threaded through each RPC or server-side dedup, a real design decision
   with client+server coordination, not a mechanical fix.
4. **Reliability — the offline outbox covers only `private_records`.**
   `RELIABILITY_AUDIT.md`: zero community writes (posts, comments, reactions)
   are queued or auto-retried on a dropped connection; `README.md`'s "IndexedDB
   outbox retries writes" claim is true only for the private training log,
   not the Community module. A real gap between documented and actual
   behavior.
5. **Reliability — `toggle_reaction` inverts rather than converges on
   retry.** A retried toggle after a timeout can flip a reaction to the wrong
   state instead of being a safe no-op. Needs the RPC changed from "flip" to
   "set" semantics, or a client-side dedup guard.
6. **Accessibility A2 — near-zero heading structure across Community.**
   Also filed as COMM-329 in `FEATURE_RECOMMENDATIONS.md`.
7. **DB-HIGH — 4 migrations edited in place after being applied.**
   `DATABASE_AUDIT.md` DB-M1: CI cannot detect this drift today (a
   `supabase db reset` from empty is unaffected, but it means the migration
   history does not describe what actually happened over time). Process fix,
   not a schema fix: add a CI check that no already-applied migration's git
   history shows a post-application edit.
8. **Feature — COMM-337/329/338**, tracked in `FEATURE_RECOMMENDATIONS.md`.

## P2 — open

1. **SEC-009 / PRIV-001 — attendance-log disclosure vs. schema mismatch.**
   Product decision required (narrow the policy, or rewrite the disclosure)
   — see `PRIVACY_AUDIT.md`.
2. **SEC-010 — any coach can edit/soft-delete any other staff member's
   announcement with no audit row.** Documented as likely-intentional in a
   small trusted-coach club; needs product confirmation, or route through a
   definer function that writes `admin_actions` (matching `pin_set`'s shape).
3. **DB-M2/DB-M3 — 28 of 31 `club_id` FKs and ~21 cascade-path FK columns
   have no supporting index.** Low current impact (single-tenant; `club_id`
   is a uniform value today) but a real multi-club or purge-volume
   precondition. Purely additive (`CREATE INDEX IF NOT EXISTS`), low-risk —
   a good candidate for a follow-up migration once the two pending
   migrations from this pass are verified.
4. **Performance — `cloud.js` (~841 KB) loads eagerly for every user**, even
   one who never opens the Community tab. `PERFORMANCE_AUDIT.md`: 77% of all
   shipped JS. No code-splitting or lazy-load exists for it.
5. **Performance — unbounded `select("*")` on `challenges`/`events`
   queries**, no pagination. Will degrade as either table grows.
6. **Performance — three search inputs fire an RPC + full DOM rebuild per
   keystroke**, no debounce.
7. **CQ-004/CQ-004b — signed avatar/photo URL cache never expires** (real
   signature does, after 1 hour), producing broken images on long sessions.
8. **Dependency/process — no Dependabot, no scheduled `npm audit` outside
   the CI run added this pass, no integrity/byte pin on the vendored
   Supabase bundle, no `deno.lock` for the 3 Edge Functions.**
   `DEPENDENCY_AUDIT.md`. Zero live vulnerabilities today; these are process
   gaps that let a future one go unnoticed.
9. **Infra — `supabase/setup-cli` installs `version: latest`.** Not pinned
   this pass (see `CORRECTIONS_COMPLETED.md` for why); needs a human with a
   working CLI to confirm and pin a specific version.
10. **CQ-005 — `map_link` client-side validation gap** (UX only; the DB
    CHECK is the real boundary).

## P3 — open

- SEC-013's sibling housekeeping is done; remaining P3s from
  `SECURITY_AUDIT.md` (SEC-014 host limitation — needs COMM-337 first;
  SEC-015 accepted risk, no action available; SEC-016 by-design, no action
  needed; SEC-018 `app.js` innerHTML sinks — sampled and found clean,
  exhaustive verification not completed; SEC-019 display-name impersonation
  — low priority, a schema change here needs live-data duplicate-checking
  this sandbox cannot do safely) are recorded in `SECURITY_AUDIT.md` and not
  repeated here.
- PRIV-003 — no in-UI sensitivity note on the plaintext export.
- The 4 remaining pre-Phase-0-era migrations with no pgTAP file
  (`DATABASE_AUDIT.md` DB-M4).
- `check-version`/`check-vendor-version` git hooks exist
  (`scripts/setup-hooks.mjs`) but are opt-in and inactive in a fresh clone —
  low-cost to make `npm ci` prompt for `npm run setup-hooks` or run it via a
  `prepare` script.

## Process recommendation, independent of any single finding

Two "15-agent"/"5-stream" audit passes landed on this exact branch within
the same session window (this one, and the `d2e6408` commit that landed
mid-audit — see `RISK_REGISTER.md`'s note on the moving target). That is a
sign of a healthy, fast-iterating audit culture on this repo, but it also
means **the next reviewer should re-run `git log` and re-check HEAD before
trusting any finding's file:line citations**, including the ones in this
document — line numbers drift with every edit, and this document was
written against a specific HEAD (see `STATUS.md`).
