# Abandoned-profile purge runbook

COMM-314. Operational notes for `purge_abandoned_profiles`
(`supabase/functions/purge_abandoned_profiles/index.ts`, calling
`public.purge_abandoned_profiles(p_retention_days)` in
`supabase/migrations/202609010004_purge_abandoned_profiles.sql`). Not the
same job as `purge_due_accounts()` — see that ticket's own note in
`docs/community/tickets/COMM-314.md` if you land here looking for the
member-requested-deletion purge instead.

**A note on this file's own name.** The ticket that specified this doc
suggested `docs/community/attendance-purge-runbook.md`. That name does not
describe this job — it purges abandoned anonymous sessions, not attendance
data, and attendance has nothing to do with either the eligibility
criteria or the retention window here. The ticket itself called the name
"the planner's call at build time," so this file is named for what it
actually documents instead of the placeholder path, on the theory that a
runbook nobody can find by its own subject during an incident is worse
than one with a slightly different name than a ticket guessed at.

## What this job does, in one paragraph

Once a day (once a scheduler exists — see "Nothing schedules this yet"
below), the job finds every `auth.users` row that is a real anonymous
session (`is_anonymous = true`), was never redeemed with an invite code,
never had its owner verify a real recovery method, and is older than the
retention window (30 days, as of this writing). It deletes those rows for
real — not a soft delete — which cascades through `profiles` and
everything else foreign-keyed to that account. It is idempotent: running
it again immediately, or a hundred times in a row, only ever finds and
touches the same set of already-abandoned accounts once each.

## How to run it manually

There is no scheduler wired yet (see below), so until one exists, this is
also the *only* way it runs.

1. **Local / staging**, with `supabase start` (or `supabase functions
   serve purge_abandoned_profiles`) already running:

   ```
   curl -X POST http://127.0.0.1:54321/functions/v1/purge_abandoned_profiles \
     -H "Authorization: Bearer <local service_role key from `supabase status`>"
   ```

2. **The real project**, from wherever the real `SUPABASE_SERVICE_ROLE_KEY`
   is available (never from a browser, never committed anywhere — check
   with whoever manages the live Supabase project for where the real key
   lives and how it is rotated; that is operator/ops knowledge, not
   something this repo documents):

   ```
   curl -X POST https://<project-ref>.functions.supabase.co/purge_abandoned_profiles \
     -H "Authorization: Bearer <real service_role key>"
   ```

   A request with any other bearer token — including the public anon key
   already shipped in `cloud-config.js` — gets a plain `401`. That check is
   inside the function body on purpose (see the file's own header comment):
   the platform's default JWT verification would otherwise accept the anon
   key too, which would let anyone trigger a real deletion run against the
   real database on demand.

3. **Directly against the database**, bypassing the Edge Function
   entirely, if you only need the deletion and not the HTTP wrapper (for
   example, from the SQL editor in the Supabase dashboard, connected as a
   role that can reach `service_role`-granted functions):

   ```sql
   select public.purge_abandoned_profiles();
   ```

   This is the same function the Edge Function calls over RPC; calling it
   directly skips the `Authorization` header check but still requires
   `service_role` (or the dashboard's elevated connection) — `authenticated`
   and `anon` get a permission error (`42501`), never a partial run.

Either path returns the same shape:

```json
{ "checked": 3, "success": 3, "failure": 0 }
```

(the Edge Function response additionally wraps this with `version`,
`retention_days` and `ran_at` — see "How to verify a run's counts" below.)

## How to change the retention window safely

The window is one named constant, `RETENTION_DAYS`, at the top of
`supabase/functions/purge_abandoned_profiles/index.ts`. Change the number,
redeploy the Edge Function. That is the whole change — no migration, no
edit to the SQL function, no edit to the abandonment criteria itself.

Do **not**:

- Change the SQL function's own default (`p_retention_days integer default
  30`) instead. That default only exists so `select
  public.purge_abandoned_profiles();` run by hand (path 3 above) has a
  sane fallback — the Edge Function always passes `RETENTION_DAYS`
  explicitly, so editing the SQL default alone would silently do nothing
  for the scheduled/HTTP path while changing the behavior of manual runs,
  which is the one outcome most likely to confuse whoever is debugging a
  count that "looks wrong" later.
- Confuse this constant with the four-part abandonment predicate itself
  (is_anonymous, no invite_redemptions row, no recovery_verified_at). That
  predicate lives in the WHERE clause inside
  `202609010004_purge_abandoned_profiles.sql`, not here, and changing IT
  (not just the window) is the one case that should bump `PURGE_VERSION`
  in the same `index.ts` file — see "Versioning" below.

## How to verify a run's counts

Every run's response (both the Edge Function's HTTP response and its own
log line) carries:

- `version` — `PURGE_VERSION`, bumped only when the abandonment predicate
  itself changes (not the retention window). Two runs with different
  `version` values are not directly comparable; a spike or a drop across a
  version boundary may be the criteria changing, not real account
  behavior.
- `retention_days` — the window that run actually used.
- `checked` — how many accounts matched the four-part predicate this run.
- `success` — how many of those were actually deleted.
- `failure` — how many matched but could not be deleted (see below).
- `ran_at` — when.

No email, handle, display name or user id is ever written to the log or
the response — matching `recap_weekly` and `purge_due_accounts()`'s
existing discipline (no personal content in this job's own output). If you
need to know *which* accounts a given run touched, there is deliberately
no record of that beyond the count — see "Open questions and gaps" below.

To sanity-check a `checked` count against the database directly (read-only,
safe to run any time, against either environment):

```sql
select count(*) from auth.users u
where u.is_anonymous = true
  and u.created_at <= now() - interval '30 days'
  and not exists (select 1 from public.invite_redemptions ir where ir.user_id = u.id)
  and not exists (
    select 1 from public.profiles p where p.id = u.id and p.recovery_verified_at is not null
  );
```

(swap the `interval '30 days'` literal for whatever `RETENTION_DAYS`
actually is at the time.) Run this *before* invoking the purge — after a
successful run it will report the count still remaining, which should be
`0` unless a new anonymous session has aged past the window since.

## What to do if the count looks wrong before the next scheduled run

There is no scheduler yet (see below), so today "the next scheduled run"
means "the next time someone runs this manually or wires one up" — but the
same checklist applies once one exists.

1. **`checked` is higher than expected.** Run the read-only query above by
   hand and inspect the actual rows it returns (add `u.id, u.created_at` to
   the select list for this one-off check — it is fine to look at ids
   directly from an ops session, just do not log or store them). Confirm
   each one really is `is_anonymous = true` with no `invite_redemptions`
   row and no `profiles.recovery_verified_at`. If a row you expected to be
   protected shows up as a candidate, check `mark_recovery_verified()`
   (`202608280003`) actually ran for that account — it is the only client
   write path to `recovery_verified_at`, and a client-side bug that stops
   calling it silently reopens accounts to this purge that a real member
   believed they had already protected.
2. **`failure` is nonzero.** This means the deletion itself raised inside
   `purge_abandoned_profiles()`'s per-row exception block (see the SQL
   function's own comment for why it is per-row rather than one bulk
   statement) — most likely a foreign key added on some newer table that
   points at `auth.users(id)` without `on delete cascade`. Find it with:

   ```sql
   select conrelid::regclass, conname
   from pg_constraint
   where confrelid = 'auth.users'::regclass and confdeltype <> 'c';
   ```

   Any row that comes back other than the ones already known about
   (`account_deletion_requests`, and anything intentionally `restrict`) is
   the fix: add `on delete cascade` (or the correct handling for that
   table) in a new migration, the same shape every existing FK to
   `auth.users` in this schema already has.
3. **`checked` is `0` when you expected candidates.** Re-run the read-only
   query above. If it also returns `0`, the accounts you expected are
   protected by one of the four criteria — check `invite_redemptions` and
   `recovery_verified_at` for them directly before assuming the job is
   broken. If the read-only query returns rows the job did not `check`,
   the Edge Function may be passing a stale `RETENTION_DAYS` (check the
   deployed function's source, not just this repo's working tree) or the
   RPC call itself is failing before it reaches the predicate — check the
   function's own logs for `purge_abandoned_profiles vN: run failed`.
4. **Before re-running after any of the above**, remember the job is
   idempotent — re-running it after a fix is always safe and never
   double-deletes or double-counts an account it already removed.

## Nothing schedules this yet

Same open infra item `recap_weekly`, `notif_batch_flush_due()`,
`chal_notify_ending_soon()`, `coach_detect_engagement_decline()` and
`recap_monthly_generate()` all already carry in this repo: `pg_cron` is not
guaranteed present in the CI Supabase stack, and wiring a scheduler (either
a `pg_cron` entry calling the SQL function directly, or an external
scheduler calling the Edge Function over HTTP with the real service role
key) is infra, not something this ticket built. Until one exists, "runs
daily" only happens if someone (or some other piece of infra) actually
calls it daily — see "How to run it manually" above.

## Open questions and gaps

- **No per-account audit trail.** The job's own log and response carry
  counts only, by design (no personal content). If an incident needs to
  know exactly which accounts a specific past run deleted, there is
  currently no record beyond "N accounts matching the predicate, at this
  retention window, at this version, at this time" — the same tradeoff
  `recap_weekly` and `purge_due_accounts()` already make. If that ever
  becomes a real requirement, it is a new, separate append-only log table
  (ids and timestamps only, still no email/handle/display name), not a
  change to this job's existing logging discipline.
- **No test coverage for the Edge Function file itself.** The SQL function
  it calls (`public.purge_abandoned_profiles`) has full pgTAP coverage in
  `supabase/tests/0048_purge_abandoned_profiles_test.sql`. The `index.ts`
  wrapper — the `Authorization` header check and the RPC call — has no
  automated test, matching `recap_weekly`'s own `index.ts`, which also has
  none: this repo's `npm test` suite (`node --test`) runs against
  `test/helpers/mockSupabase.mjs` for client-side (`cloud.js`) behavior
  only, and nothing in it invokes a Deno Edge Function. Verifying the
  Edge Function's own auth check and RPC wiring is a manual step (path 1
  or 2 above, against a local `supabase start`) until this repo has a
  Deno-side test harness.
