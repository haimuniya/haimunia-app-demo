# Incident response

Launch-readiness audit, INC-1. There was no incident process in the
repository at all.

Written for what this actually is: a single club's app, run by its coaching
team, with no on-call rota and no separate company behind it (see
`PRIVACY.md`, "Who runs this"). A twelve-page enterprise runbook would be
theatre. This is the short version that can genuinely be followed by one
person on a phone.

## Roles

There is one role: **whoever is handling it**. Say so out loud in the
coaching team's own channel so two people do not act at once — the most
likely way to make an incident worse here is two admins independently
resetting things.

Only a real `profiles.is_admin` account can perform most of the actions
below, and admin is a manual, dashboard-only grant. Make sure at least two
people hold it before you need it at 22:00.

## Severity

| | Meaning | Examples |
|---|---|---|
| **SEV-1** | Member data exposed, or destroyed | A read policy leaking another member's data; account deletion running against the wrong rows |
| **SEV-2** | The club cannot use the app | Sign-in broken; feed not loading for everyone |
| **SEV-3** | One feature degraded | Recaps not sending; a scheduled job failing |

## First 15 minutes

1. **Write down the time and what you saw.** In the channel, not in your
   head. Everything after this is easier with a timestamp.
2. **Decide: is data exposed or being destroyed right now?** If yes, it is
   SEV-1 and containment comes before diagnosis. Skip to §Containment.
3. **Check the obvious shared causes** before assuming a bug:
   - `select * from public.scheduled_job_health() where not healthy;`
   - Supabase dashboard → is the project itself up, and is it out of disk
     or connection budget?
   - Did something deploy? `git log --oneline -5` on the Pages branch.

## Containment (SEV-1)

Pick the smallest hammer that stops the bleeding.

**A leaking read policy.** Tighten the policy, do not disable the table.
The pattern this repo uses everywhere:

```sql
drop policy if exists <name> on public.<table>;
create policy <name> on public.<table> for select to authenticated
  using (public.is_community_member() and <the corrected predicate>);
```

Ship it as a NEW migration (`supabase/migrations/`) — never by editing an
applied one; `scripts/check-migration-immutability.mjs` will reject that,
and it would silently diverge production from local anyway.

**A compromised admin account.** From the dashboard:

```sql
update public.profiles set is_admin = false where id = '<uuid>';
```

Then rotate that member's password via the `admin_reset_password` Edge
Function from a *different* admin account, and read
`public.admin_actions` for what they did while compromised:

```sql
select * from public.admin_actions
 where admin_id = '<uuid>' order by created_at desc;
```

**A leaked service-role key.** This is the worst case: it bypasses every RLS
policy in the schema. Rotate it in the dashboard immediately (Settings →
API), then redeploy the Edge Functions so they pick up the new value. The
key is not in this repository and must never be added to it.

**Runaway writes / abuse.** The rate limits are already in the schema
(`check_rate_limit`). If a specific account is the problem:

```sql
select public.admin_remove_member('<uuid>');   -- soft-delete + 30-day purge
```

## Data loss

**Stop writing first.** A restore that races live traffic makes it worse.

Supabase dashboard → Database → Backups. Restore to a **new project or
branch**, never in place over the live one — you want to compare before you
switch. Confirm the restored data actually contains what is missing before
cutting over.

Note the two soft-delete windows in this schema, which often mean data is
recoverable without a restore at all:

- A deleted account is soft-deleted immediately and hard-purged only after
  30 days (`account_deletion_requests.purge_after`). Inside that window,
  clearing `profiles.deleted_at` and deleting the `account_deletion_requests`
  row brings the member back.
- A removed post is `status = 'removed'`, not deleted. The row is still
  there.

## Communicating

For anything that exposed member data, tell the affected members directly —
the coaching team is the whole of support (`PRIVACY.md`). Say what happened,
what was exposed, what you did, and what they should do. Do not wait until
you have a complete root cause; an early honest note beats a late polished
one.

## After it is over

Within a few days, write a short note in `docs/ops/incidents/` covering:
what happened, when, how it was found, what fixed it, and **what would have
caught it sooner**. That last question is the only one that compounds.

Then close the loop in code:

- A missing test → add it (`test/` for client, `supabase/tests/` for RLS).
- A missing signal → add it to `docs/ops/MONITORING.md`.
- A missing guard → new migration.

The `purge_due_accounts()` scheduling gap is the worked example: correct
code, never invoked, invisible for the life of the project. The fix was one
`cron.schedule` line; the *durable* fix was `scheduled_job_health()`, so the
next never-run job is a query away instead of an archaeology exercise.
