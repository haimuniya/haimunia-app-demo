# Removed features this pass

**None.** No feature, code path, table, or UI surface was removed during this
audit pass.

## Why

Every defect found during this pass (see `RISK_REGISTER.md`,
`SECURITY_AUDIT.md`, `CODE_QUALITY_AUDIT.md`) was judged fixable in place at
acceptable cost and risk, and was fixed rather than removed — the standing
guidance for this pass was "preserve correct existing behavior... avoid
unnecessary rewrites," and nothing surfaced that was unsafe-beyond-repair,
purely duplicated, confirmed unused, or actively harmful enough to warrant
deletion instead of correction:

- The **`posts_delete_self` RLS policy** (a raw DELETE grant superseded by
  the moderator-aware `post_delete()` RPC) came closest to a removal
  candidate and was in fact dropped — but it was dead/harmful *access*, not
  a feature; the feature it gated (removing your own post) is fully intact
  through `post_delete()`, which already existed and already did the same
  thing correctly. Recorded as a correction in `CORRECTIONS_COMPLETED.md`,
  not a feature removal.
- `docs/community/backlog.md`'s own record shows all 7 previously-`parked`
  backlog items already closed by prior work (`FEATURE_INVENTORY.md`), and
  this pass did not identify any additional feature as parked, duplicated,
  or unused during its own review of the 24 most-recent features
  (`CODE_QUALITY_AUDIT.md` §"Recent additions").

## Candidates considered and kept

- **`private_records`'s no-membership-gate design** — flagged in
  `SECURITY_AUDIT.md` SEC-007 as a resource-abuse surface, but confirmed
  intentional and load-bearing (the offline-sync channel must work for a
  pre-redemption/no-profile session by design, per
  `COMMUNITY_SETUP.md` §"Offline synchronization"). Mitigated with a rate
  limit instead of removed or gated.
- **`posts_select_admin_review`'s blanket admin read-bypass** (SEC-016) —
  reviewed and kept as-is; it is a deliberate, narrowly-scoped moderation
  capability (real `is_admin`, not staff-wide), not an oversight.

If a future audit pass identifies a genuine removal candidate, this
document's format should record: reason, dependencies, affected data,
migration requirements, and the replacement flow, per the standing
instructions for this kind of audit.
