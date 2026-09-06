# Monitoring and alerting

Launch-readiness audit, MON-1. Before this document there was no monitoring
configuration anywhere in the repository and no way to answer "is the
backend actually doing its job" other than opening the app and looking.

## Why this exists, concretely

`purge_due_accounts()` — the function that implements `PRIVACY.md`'s promise
to erase an account 30 days after deletion is requested — was written,
correct, granted, and **never scheduled**. Nobody noticed for the life of
the project, because a job that does not run emits nothing: no error, no
row, no failure. It was found by reading migrations, not by any signal.

Everything below exists so that class of failure is loud instead of silent.

## 1. Scheduled jobs (highest value — start here)

`public.scheduled_job_health()` (migration `202609060016`, service_role
only) returns one row per pg_cron job with its schedule, last run, that
run's status, and a conservative `healthy` boolean.

**The alert query:**

```sql
select jobname, last_status, last_run, seconds_since_last_run
  from public.scheduled_job_health()
 where not healthy;
```

**Alert if this returns any row.** `healthy` is false when a job is
inactive, when its last run failed, when it has never run at all, or when
it last ran more than 8 days ago (wider than the weekly jobs' cadence so a
weekly job is not flagged the day before it is due).

A job that has never run reports `last_status = 'never run'` — the exact
state `purge_due_accounts()` sat in.

**Expected jobs** (10, as of `202609060016`):

| Job | Cadence | If it stops |
|---|---|---|
| `purge-due-accounts` | daily 03:59 | **The 30-day deletion promise stops being kept.** Highest-severity of the set — it is a privacy commitment, not a feature. |
| `purge-abandoned-profiles` | daily 03:31 | Abandoned anonymous accounts accumulate |
| `telemetry-retention-purge` | daily 03:47 | The 90-day analytics retention promise stops being kept |
| `idempotency-purge` | daily 03:19 | `request_idempotency` grows without bound |
| `notif-batch-flush` | every 15 min | Batched notifications are never delivered |
| `chal-notify-ending-soon` | hourly | "Challenge ending soon" never fires |
| `coach-engagement-decline` | daily 06:17 | Coaches stop seeing at-risk members |
| `recap-weekly` | Mon 05:11 | No weekly recaps (needs Vault secrets set) |
| `recap_monthly` | 1st 04:41 | No monthly club recap |
| `community-health` | Mon 04:43 | `community_health_scores` stops updating |

`feed-weights-recompute` was deliberately **unscheduled** (`202609060015`,
FEAT-010) because the function it called is an empty stub. Its absence is
correct; if it reappears without the derivation being built, that is a
regression.

Two of these (`recap-weekly`, `purge-abandoned-profiles`) reach Edge
Functions through `cron_invoke_edge_function()` and are **inert until the
Vault secrets are set**. They will report `succeeded` regardless, because
the cron job's SQL succeeded — see §4.

## 2. Authentication and abuse

Supabase dashboard → Authentication → Logs. Watch for:

- A spike in anonymous sign-ups. With CAPTCHA enabled (SEC-004) this should
  be low and human-shaped; a spike means either the CAPTCHA is
  misconfigured or it is being bypassed.
- Repeated failed `signInWithPassword` against many usernames — credential
  stuffing. Usernames are club-public via the member directory, so this is
  a realistic attack.

```sql
-- Invite-code guessing. The throttle allows 5 per 15 min per actor;
-- sustained pressure means somebody is working through the space.
select count(*), date_trunc('hour', created_at) as hour
  from public.invite_attempts
 where created_at > now() - interval '24 hours'
 group by 2 order by 2 desc;
```

## 3. Rate limits actually firing

```sql
select action, count(*), max(attempt_count)
  from public.rate_limits
 where window_started_at > now() - interval '1 hour'
 group by action order by 3 desc;
```

A limit being hit occasionally is the system working. `post_create` or
`private_record_write` pinned at its ceiling for a single user, repeatedly,
is either abuse or a client retry loop — both worth looking at.

## 4. Edge Functions

Supabase dashboard → Edge Functions → Logs, for `recap_weekly`,
`purge_abandoned_profiles`, `admin_reset_password`.

`cron_invoke_edge_function()` dispatches asynchronously through `pg_net`, so
**a cron job reporting `succeeded` only means the request was queued**. The
function's own outcome is in:

```sql
select * from net._http_response order by created desc limit 20;
```

This is the one place where "the job is green" and "the work happened" can
genuinely disagree. Check it after any change to the recap or purge
functions.

## 5. Moderation backlog

```sql
select count(*) from public.reports where status = 'open';
```

Not a system-health metric — a duty-of-care one. A backlog that keeps
growing means reports are being filed and not reviewed.

## What is deliberately NOT monitored

No third-party APM, error-tracking SDK, or analytics vendor is wired in, and
none should be added casually: the app ships a strict CSP with no CDN in
`script-src` and a `connect-src` pinned to the Supabase project (SEC-015
leans on both). Adding a monitoring SDK means widening that policy, which
trades a real XSS mitigation for observability. If it is ever done, it
should be a deliberate, documented decision with the same scrutiny the
CAPTCHA hosts got — not a dependency someone adds in passing.
