# COMM-381 Phase 4 QA sweep and merge gate

Phase: 4
Agent: qa
Status: todo
Attendance-blocked: no

Last, the phase's merge gate, the same role COMM-191/234/317/338 played for
every earlier phase. Depends on every other Phase 4 ticket (COMM-370
through COMM-380).

## User outcome

Phase 4 ships with the same standing guarantee every prior phase shipped
with: every acceptance criterion in this phase's tickets is backed by a
real, executing test, and all three CI jobs (`npm test`, `supabase test
db`, `scripts/browser-check`) are green from a genuinely fresh state.

## Acceptance criteria

- [ ] Cross-reference every Phase 4 ticket's acceptance criteria against
  the existing suite; close any real gap found rather than assuming an
  earlier agent's own report.
- [ ] pgTAP coverage for every new table and RLS boundary in this phase,
  following the "0037-onward, committed alongside the migration" standard
  this module has held since Phase 3: `invites` (no client write grant at
  all, the three admin RPCs are the only path in, revoke is refused after
  redemption), `invite_codes`' newly-exposed RPCs (role gates, the
  narrower `community.invite.manage_codes` permission versus the wider
  `community.member.invite`), `redeem_invite_code`'s widened body (a
  per-person invite grants its role, an already-redeemed/revoked/expired
  per-person invite returns the same generic `'invalid'` a wrong guess
  does — the anti-enumeration property COMM-372 names explicitly),
  `onboarding_step_content` (read-all/staff-write-only, `updated_by`
  pinned server-side, no insert/delete grant, the audit trigger firing),
  `admin_member_roster` (`is_staff()` read gate, role-change actions still
  admin-only), `registration_funnel` (the permission gate, period
  validation, and that the response contains no per-member identity —
  the same no-uuid-anywhere style of assertion `analytics_dashboard`'s own
  pgTAP file already established).
- [ ] A real end-to-end check (mocked backend, real Chromium via
  `scripts/browser-check`, following COMM-234/317's precedent of never
  running against the live production Supabase project) of the full
  per-person invite lifecycle: an admin generates one, a new signup
  redeems it, the admin sees it flip to redeemed with the right identity
  attached, and a second redemption attempt on the same code is refused.
- [ ] Confirm the "Open questions" resolutions logged in the backlog for
  this phase (generic `'invalid'` on a spent per-person invite; no
  reordering of onboarding steps; permission tiers for
  `community.member.invite` versus `community.invite.manage_codes` versus
  `community.content.manage_onboarding`) match what actually shipped,
  the same audit COMM-317 ran for Phase 3's own open questions.
- [ ] Full WCAM re-review is not expected to be needed here (this phase
  adds no new member-facing participation event — invite management,
  roster browsing, and onboarding-copy editing are all staff actions or
  passive reads), but confirm that explicitly rather than assuming it, the
  same "checked, not defaulted" discipline COMM-317 held for Phase 3.
- [ ] Re-verify all three CI jobs independently from a genuinely fresh
  state (`supabase db reset` then `supabase test db`, and a clean `npm
  test`), not trusted from any earlier agent's own report in this phase.

## Frontend states

Not applicable.

## Client calls and contracts

None new. Verifies every contract COMM-370 through COMM-380 introduced.

## Validation rules and limits

None new.

## Migration outline

None expected, unless this sweep finds a real boundary gap, matching every
earlier QA-sweep ticket's own stated posture.

## Dependencies

- COMM-370, COMM-371, COMM-372, COMM-373, COMM-374, COMM-375, COMM-376,
  COMM-377, COMM-378, COMM-379, COMM-380.
