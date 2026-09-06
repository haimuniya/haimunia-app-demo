# Implemented features this pass

This audit pass was corrective, not additive — its job was to close security,
reliability, and correctness gaps in what already exists, not to build new
product surface. No new user-facing product feature was added. Three items
are worth listing here rather than in `CORRECTIONS_COMPLETED.md` because they
are new *capabilities* that did not exist in any form before, as distinct
from a bug fix to an existing one:

## Activated: the 30-day account-erasure job

`public.purge_due_accounts()` has existed as a complete, correct function
since the foundation migration (`202608260001`) but was never scheduled —
functionally, the feature `PRIVACY.md` has always promised ("permanently
deleted after 30 days") did not exist from a user's perspective, because
nothing ever called the function that implements it. This pass gives it a
`cron.schedule` entry. See `PRIVACY_AUDIT.md` PRIV-002 and
`CORRECTIONS_COMPLETED.md` item 4.

## New: a server-side rate limit on admin password resets

`admin_check_password_reset_rate_limit()` (SEC-011) is a genuinely new
capability — before this pass, `admin_reset_password` had no rate limit of
any kind, unlike every other write path in the module. This is a new,
narrow RPC plus new Edge Function wiring, not a fix to an existing limit.

## New: a load-failure retry state for the community join funnel

Before this pass, a failed `loadProfile()`/`loadRedemption()` fetch had no
distinct UI state at all — it silently degraded into whichever join-funnel
screen "no such row" would have produced (CQ-006). The retry screen
("בעיה בטעינת הקהילה") added this pass is a new UI state, not a fix to an
existing one, since no error-handling behavior existed there before to fix.

## Deliberately not implemented

- **CAPTCHA on sign-up (SEC-004).** `COMMUNITY_SETUP.md` already names this
  as the recommended next step, and `SECURITY_AUDIT.md` upgrades it from
  "nice to have" to load-bearing now that SEC-001 exposed how much a free
  anonymous session could reach. Not implemented this pass because it
  requires a site key only the project owner can create in a live Supabase
  dashboard (Authentication → Bot and Abuse Protection) — no code change in
  this repo can complete it end-to-end without that external step. The
  client-side half (threading `captchaToken` through `signInAnonymously()`
  at `cloud.js:3789` and `updateUser()` at `cloud.js:3884`) is a small,
  well-scoped follow-up once the site key exists.
- **Multi-tenant `club_id` filtering (SEC-008, the "real" fix).** This pass
  implemented the cheap, correct invariant for launch (refuse a second
  `clubs` row) rather than the actual filtering work, which the audit itself
  frames as a separate, larger effort to begin only once a second club is a
  real, near-term product need — see `FEATURE_RECOMMENDATIONS.md`.

See `FEATURE_RECOMMENDATIONS.md` for what a product owner should consider
adding next, and `docs/community/backlog.md` for the club's own live ticket
backlog, which this audit did not attempt to supersede.
