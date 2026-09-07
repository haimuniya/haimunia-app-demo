begin;

-- =====================================================================
-- DATA LOSS. purge_abandoned_profiles() deletes members' training logs.
-- =====================================================================
--
-- WHAT WAS WRONG. `private_records.user_id references auth.users(id) on
-- delete cascade` (202608260001:21). `purge_abandoned_profiles()`
-- (202609010004) deletes straight from `auth.users` and its predicate does
-- not mention `private_records` anywhere - its header says in as many words
-- that it "trusts the same cascade" `purge_due_accounts()` relies on.
--
-- That reasoning is sound for the account the ticket had in mind: an
-- anonymous session that was never anything, holding nothing. It is
-- catastrophic for the account this app actually mints by the hundred.
-- Cloud backup starts on the member's FIRST SAVED SET (cloud.js
-- `flushOutbox()`, wired to the `haimunia-sync-needed` event `app.js`
-- `queueSyncRecord()` raises) - no prompt, no account creation the member
-- is aware of, no credentials. Their entire training history lives in
-- `private_records` under an anonymous uid with no invite redemption and no
-- recovery method. Every one of the old predicate's four conditions is
-- therefore TRUE for them on day 31, and the run that "collects an empty
-- shell" instead cascades away every workout they ever logged. It is their
-- only server-side copy, and for a member who changed device it is their
-- only copy at all.
--
-- Reproduced on a clean stack before this migration was written: one
-- anonymous account, 30 strength_entry rows, created_at 40 days back, no
-- redemption, no recovery. `select public.purge_abandoned_profiles()`
-- returned {"checked":1,"success":1,"failure":0} and left 0 auth.users rows
-- and 0 private_records rows.
--
-- LIVE, AND INERT ONLY BY ACCIDENT. The job is scheduled
-- (202609050005, 'purge-abandoned-profiles', 03:31 UTC daily) and the
-- function is on production. Nothing has been deleted yet for one reason
-- only: `cron_invoke_edge_function()` returns NULL without ever issuing the
-- request while the `edge_functions_*` Vault secrets are still their
-- committed placeholders (202609050005:206-210). Setting those two secrets -
-- a one-line ops step with no code change - would have armed this on the
-- next 03:31.
--
-- THE WARNING THAT WAS ALREADY WRITTEN. 202609060023's header spends a
-- section on why `purge_abandoned_profiles()` and `admin_reclaim_invite()`
-- are "complementary, not overlapping", and warns that broadening either to
-- cover the other's population "could delete real logs". That sentence was
-- about exactly this hazard, from the other direction, and nobody connected
-- it to the cascade. This migration is the connection.
--
-- ---------------------------------------------------------------------
-- THE NEW PREDICATE
-- ---------------------------------------------------------------------
-- Two changes, and deliberately nothing else. The four original conditions
-- are all kept verbatim; this narrows the population, it never widens it.
--
-- (A) AN ACCOUNT THAT HOLDS TRAINING DATA IS NEVER PURGED BY THIS JOB.
--     Not "purged later", not "purged under a longer window" - removed from
--     this function's population outright. `public.account_holds_training_data()`
--     below is the one place that question is answered.
--
--     Why presence and not liveness. The check is "is there a
--     `private_records` row at all", NOT "is there a row with `deleted_at is
--     null`. Three reasons:
--       * `deleted_at` is client-set. `flushOutbox()` writes it from an
--         outbox row's own `deleted` flag, so a buggy build, a bad merge, or
--         a hand-crafted request can mark a live log deleted, and the
--         consequence of believing it would be permanent.
--       * A tombstone is proof that a real person used this account as a
--         training log. That is the fact the predicate actually cares about.
--       * It matches the discipline 202609010004 already applied to
--         `recovery_verified_at`: "genuinely absent", never "merely old" or
--         "merely flagged". Same rule, same reason, one more column.
--     The cost is that an account whose member deleted every entry is never
--     auto-collected. That is a handful of rows with empty `payload`
--     objects, weighed against permanently destroying a log that was only
--     flagged as deleted by mistake. Not a close call.
--
--     `attendance_log` is checked too, and it is DEFENSIVE rather than
--     load-bearing today - said plainly here so a later reader does not
--     mistake it for a case that is currently reachable.
--     `attendance_log.user_id references public.profiles(id)`
--     (202608310001), `profiles_insert_self` requires an
--     `invite_redemptions` row to exist first (202608270003 / 202608280003),
--     and an `invite_redemptions` row already disqualifies an account here.
--     So no account this function can currently see has attendance rows. It
--     is checked anyway because attendance_log is APPEND-ONLY and is never
--     retracted when the source `private_records` entry is soft-deleted
--     (202608310001's own "correct forward, not backward" rule): it can
--     therefore outlive the data it was derived from, which makes it the one
--     place a member's training history can exist with no `private_records`
--     row behind it. If any later change ever lets a profiled account reach
--     this predicate - `admin_reclaim_invite()` removing a redemption is
--     already one step down that road, and it refuses on a profiles row
--     today precisely because of it - the attendance history alone blocks
--     the delete instead of vanishing with it.
--
-- (B) THE DORMANCY CLOCK IS LAST ACTIVITY, NOT `created_at`.
--     The old comparison was `u.created_at <= now() - window`, which asks
--     "how long ago was this account opened", not "how long has nobody been
--     here". An empty anonymous shell that the member opens every morning is
--     31 days old on day 31 and was eligible for deletion mid-use. Now the
--     comparison is against
--     `greatest(created_at, coalesce(last_sign_in_at, created_at))`, so the
--     value can only ever be LATER than the one used before and this change
--     can only ever spare an account, never newly condemn one.
--
--     `auth.users.updated_at` is DELIBERATELY NOT in that greatest(). It
--     was, in a first draft, on the theory that it is the most conservative
--     signal available - and 0086's own fixtures caught the problem
--     immediately: they carry `updated_at = now()` on accounts abandoned
--     twenty days ago, because that column tracks any write to the row and
--     not the member. Anything that touches auth.users server-side - a
--     GoTrue upgrade, an admin action, a backfill - would push every
--     account's clock forward at once and silently render this job inert.
--     That is the same failure mode as the placeholder Vault secrets that
--     kept this bug harmless: a job that looks scheduled and does nothing.
--     `last_sign_in_at` is caused by the member and by nothing else, which
--     is the only property that makes it a dormancy signal. The absolute
--     protection here is (A), which does not depend on any clock; (B) is
--     precision, and precision is better served by the honest column.
--
-- THE RETENTION WINDOW IS UNCHANGED at 30 days and is still a plain
-- parameter read from `RETENTION_DAYS` in the Edge Function. Per
-- 202609010004's own rule, a change to the WINDOW needs no version bump but
-- a change to the PREDICATE does - this is a predicate change, so
-- `PURGE_VERSION` in supabase/functions/purge_abandoned_profiles/index.ts
-- goes 1 -> 2 in the same commit as this file.
--
-- WHAT IS DELIBERATELY NOT HERE: a longer window that eventually deletes a
-- backup-only account's real log. It was considered and rejected at this
-- layer. An anonymous account has no email, no phone and no push channel -
-- the synthetic '<username>@members.haimuniya.invalid' address is not
-- deliverable and an account at this stage does not even have one - so
-- there is no way for the database to warn anyone before deleting their
-- only copy. The only place a warning or an export prompt can be delivered
-- is in the app, on next open, which is the exact moment the account stops
-- being dormant. Shipping a silent long-window delete would repeat this
-- defect with a bigger number on it. If that path is ever wanted it needs
-- client work (a warning surface and an export prompt) and its own policy
-- language first; the counter this function now returns
-- (`retained_with_data`) is there to size that decision honestly.
--
-- SCOPE. `purge_due_accounts()` (202608260001) was checked for the same
-- hole and does NOT have it, so it is not touched by this migration. Its
-- population is `account_deletion_requests.purge_after <= now()`, and every
-- writer of that table is an explicit request: `request_account_deletion()`
-- (auth.uid()'s own account) and `admin_remove_member()` (202609060022,
-- admin-only, refuses self). Cascading `private_records` away there is the
-- promise being kept, not a bug. See 0090's own assertions.

-- =====================================================================
-- 1. The one definition of "this account holds training data"
-- =====================================================================
-- Separate function rather than two inline NOT EXISTS clauses so the rule
-- has ONE definition that a pgTAP test can hit directly, and so any future
-- job that deletes accounts asks the same question instead of re-deriving
-- it. Same reasoning `attendance_session_record_types()` (202608310001)
-- records for the session-type list.
--
-- NOT `security definer`, on purpose. Called from inside
-- `purge_abandoned_profiles()` it already runs as that function's owner and
-- sees every row; called by anything else it is subject to RLS like any
-- other invoker function, so it cannot become an oracle. Granted to
-- service_role only for the same reason: `exists(...)` over another
-- member's `private_records` is a yes/no answer about a stranger's training
-- history, and that is not a question any client role gets to ask.
create or replace function public.account_holds_training_data(p_user_id uuid)
returns boolean
language sql stable set search_path = '' as $$
  select p_user_id is not null and (
    exists (select 1 from public.private_records pr where pr.user_id = p_user_id)
    or exists (select 1 from public.attendance_log al where al.user_id = p_user_id)
  );
$$;

comment on function public.account_holds_training_data(uuid) is
  'Data-loss fix, 202609070001. TRUE when the account has any private_records row (SOFT-DELETED ROWS INCLUDED - deleted_at is client-set, and a tombstone still proves a real person used this account as a training log) or any attendance_log row. The single definition of "there is training history here" used by purge_abandoned_profiles() to refuse to delete an account. attendance_log is checked defensively: it references profiles, which requires a redemption, which already disqualifies an account from that job - but it is append-only and is never retracted when its source record is soft-deleted, so it is the one place a training history can outlive the private_records row behind it. AUTH: security INVOKER, so it is subject to RLS for any caller other than the definer function that calls it; revoked from public, anon and authenticated and granted to service_role only, because a yes/no answer about a stranger''s training history is not a question a client role may ask. Read-only. Returns false for null.';

revoke all on function public.account_holds_training_data(uuid) from public, anon, authenticated;
grant execute on function public.account_holds_training_data(uuid) to service_role;

-- =====================================================================
-- 2. The purge, with the guard
-- =====================================================================
-- SHAPE PRESERVED FROM 202609010004, deliberately and in full: one
-- candidate at a time, each delete in its own exception block, the
-- exception's detail discarded rather than logged. That structure is not
-- incidental - it is what makes a future FK to auth.users WITHOUT `on
-- delete cascade` one counted failure instead of a run that aborts for
-- every candidate queued behind it, and it is what keeps a message that
-- could carry a raw id or address out of the logs. Neither is changed here.
--
-- ONE NEW RETURN KEY: `retained_with_data`. The guard has to be OBSERVABLE
-- or nobody can tell whether it ever fired, which is the same class of
-- blindness that let this ship - `{checked, success, failure}` looks
-- identical whether the guard is working or the population is empty. It
-- counts accounts that passed all four of the original conditions and were
-- spared ONLY by the training-data check: i.e. exactly the accounts the old
-- function would have deleted. It is a blast-radius gauge, and it is also
-- the number needed to size any future decision about long-dormant
-- backup-only accounts. Still no personal content - a count, like every
-- other key.
--
-- The candidate query answers both questions in ONE pass, rather than
-- filtering data-holding accounts out in the WHERE clause and counting them
-- in a second query. Two copies of one predicate is how the two drift.
create or replace function public.purge_abandoned_profiles(p_retention_days integer default 30)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_checked integer := 0;
  v_success integer := 0;
  v_failure integer := 0;
  v_retained integer := 0;
  v_id uuid;
  v_has_data boolean;
  v_cutoff timestamptz;
begin
  v_cutoff := now() - (greatest(coalesce(p_retention_days, 30), 0) || ' days')::interval;

  for v_id, v_has_data in
    select u.id, public.account_holds_training_data(u.id)
    from auth.users u
    where u.is_anonymous = true
      -- (B) last activity, not birthday. The second term coalesces back to
      -- created_at, so this value is >= the old comparison's in every case
      -- and no account becomes newly eligible because of this line.
      and greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at)) <= v_cutoff
      and not exists (select 1 from public.invite_redemptions ir where ir.user_id = u.id)
      and not exists (
        select 1 from public.profiles p
        where p.id = u.id and p.recovery_verified_at is not null
      )
  loop
    -- (A) The guard. Counted and skipped BEFORE v_checked is incremented,
    -- so `checked` keeps its original meaning - accounts this run actually
    -- attempted to delete - and stays comparable across the version bump.
    if v_has_data then
      v_retained := v_retained + 1;
      continue;
    end if;

    v_checked := v_checked + 1;
    begin
      delete from auth.users where id = v_id;
      v_success := v_success + 1;
    exception when others then
      -- No personal content: the exception's own detail (which could
      -- carry an email or a raw id in its message) is deliberately
      -- discarded here, matching recap_weekly's "no user id, no computed
      -- figures" logging discipline. The caller only ever learns a count.
      v_failure := v_failure + 1;
    end;
  end loop;

  return jsonb_build_object(
    'checked', v_checked,
    'success', v_success,
    'failure', v_failure,
    'retained_with_data', v_retained);
end $$;

-- Still idempotent by construction, and now idempotent in a second sense:
-- a run over a population of data-holding accounts returns the same
-- {"checked":0,"success":0,"failure":0,"retained_with_data":N} every night
-- and touches nothing, forever.
comment on function public.purge_abandoned_profiles(integer) is
  'COMM-314, predicate corrected by 202609070001 (PURGE_VERSION 2). service_role only. Deletes auth.users rows for anonymous sessions that (1) never redeemed an invite, (2) never verified recovery, (3) HOLD NO TRAINING DATA - no private_records row of any kind, soft-deleted included, and no attendance_log row, per account_holds_training_data() - and (4) whose LAST ACTIVITY (greatest of created_at and last_sign_in_at, not created_at alone; auth.users.updated_at is deliberately excluded because it tracks any write to the row rather than the member) is older than p_retention_days (default 30). Condition 3 is new and is a data-loss fix: private_records cascades from auth.users, cloud backup opens an anonymous account on the member''s first saved set, and the old predicate therefore deleted the entire training history of every backup-only member on day 31. An account holding training data is never deleted by this job at all, under any window - deletion of a real log stays with purge_due_accounts(), which the member asks for. RETURNS jsonb {checked, success, failure, retained_with_data}; retained_with_data counts accounts that met all four of the ORIGINAL conditions and were spared only by the training-data guard, so the guard is visible in run history. Idempotent: a rerun finds nothing left to purge for an account already removed. Called by supabase/functions/purge_abandoned_profiles/index.ts over RPC, never reachable from a client role.';

revoke all on function public.purge_abandoned_profiles(integer) from public, anon, authenticated;
grant execute on function public.purge_abandoned_profiles(integer) to service_role;

commit;
