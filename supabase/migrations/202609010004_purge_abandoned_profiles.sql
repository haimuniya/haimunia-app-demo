begin;

-- COMM-314. `purge_abandoned_profiles`, versioned and idempotent, for a
-- category `purge_due_accounts()` (202608260001) does not cover: an
-- anonymous session that was NEVER a real member's account, so there is
-- nothing to preserve and nothing they explicitly asked for.
--
-- "Abandoned" (all four must hold, not merely most):
--   1. `auth.users.is_anonymous = true` - a real anonymous session, not a
--      member who happens to have gone quiet.
--   2. No `public.invite_redemptions` row for that user - never redeemed.
--   3. No `public.profiles.recovery_verified_at` - never verified a real
--      recovery method (mark_recovery_verified(), 202608280003). A member
--      who redeemed or verified even the day before the retention window
--      would have closed is never eligible - both of these are checked as
--      "genuinely absent", not "older than the window", so a timestamp
--      that itself happens to be old still protects the account forever.
--   4. `auth.users.created_at` older than the retention window.
--
-- ONE DEVIATION FROM THE TICKET'S OWN MIGRATION OUTLINE, recorded here
-- because the ticket said "no new table" and this migration does add a
-- new function (not a table, so the letter of that line still holds, but
-- worth being explicit about why it wasn't avoidable):
--
-- The ticket's migration outline described the Edge Function as "reading
-- auth.users, invite_redemptions, and profiles directly with the
-- service-role key". That is not actually reachable the way it reads:
-- supabase/config.toml's `[api] schemas = ["public", "graphql_public"]`
-- is what PostgREST exposes to ANY caller, service-role key included - the
-- service-role key bypasses RLS on exposed tables, it does not add
-- `auth.users` to the exposed schema list. `supabase.from("...")` from the
-- Edge Function's JS client can reach `public.invite_redemptions` and
-- `public.profiles` directly (as planned), but never `auth.users` - there
-- is no `supabase.from("auth.users")` that will ever resolve.
--
-- So the actual `auth.users` read AND the deletion both have to happen
-- inside the database, in a function the Edge Function calls over RPC -
-- the same shape `recap_weekly` already uses for
-- `recap_weekly_classmates()` (202609010003) for its own privacy-gated
-- server-side-only logic, and the same reasoning COMM-309's schema notes
-- record for choosing a Postgres function over a second Edge Function for
-- `recap_monthly_generate()`: a grant that is revoked from `public`, `anon`
-- and `authenticated` and held only by `service_role` is a hole with no
-- open side, the same "the grant IS the gate" reasoning `purge_due_accounts`
-- already relies on. This migration keeps the Edge Function itself (the
-- ticket asked for it by path and the auth-header pattern is worth having
-- there too, matching recap_weekly's posture belt-and-braces), but the
-- Edge Function's own body does the real work through this RPC rather than
-- through direct table reads.
--
-- DELETION MECHANISM: matches `purge_due_accounts()` exactly - a raw SQL
-- `delete from auth.users` inside a SECURITY DEFINER function, not the
-- Admin API. `purge_due_accounts()` already ships this and already relies
-- on the same FK cascade shape (`profiles.id`, `invite_redemptions.user_id`
-- and everything else foreign-keyed to `auth.users(id)` is `on delete
-- cascade`), so this function trusts the same cascade rather than doing
-- the Admin API's HTTP round trip per account. The one difference from
-- `purge_due_accounts()`: this function deletes one candidate at a time
-- inside its own exception block, because "success and failure counts" is
-- an explicit acceptance criterion here (purge_due_accounts' single bulk
-- delete has no way to fail for one row and succeed for another) - a
-- future FK added on some other table straight to `auth.users` without
-- `on delete cascade` becomes one counted failure, not a run that aborts
-- for every candidate behind it.
--
-- VERSIONING lives one layer up, in
-- supabase/functions/purge_abandoned_profiles/index.ts (`PURGE_VERSION`),
-- not in this function - the same spirit as `SCHEMA_VERSION` in
-- src/analytics.js, one more place a definition can change without
-- silently reinterpreting an old run. If a later change touches the WHERE
-- clause below (the abandonment predicate itself, not just the retention
-- window), bump `PURGE_VERSION` in that file so the log record it writes
-- is distinguishable from a run under the old rule. The retention window
-- is the one exception: it is a plain parameter here
-- (`p_retention_days`), read from ITS OWN named constant
-- (`RETENTION_DAYS`) in that same Edge Function file, so changing the
-- window is the one-line edit the ticket asks for and does not need a
-- version bump or a migration.
create or replace function public.purge_abandoned_profiles(p_retention_days integer default 30)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_checked integer := 0;
  v_success integer := 0;
  v_failure integer := 0;
  v_id uuid;
begin
  for v_id in
    select u.id
    from auth.users u
    where u.is_anonymous = true
      and u.created_at <= now() - (greatest(coalesce(p_retention_days, 30), 0) || ' days')::interval
      and not exists (select 1 from public.invite_redemptions ir where ir.user_id = u.id)
      and not exists (
        select 1 from public.profiles p
        where p.id = u.id and p.recovery_verified_at is not null
      )
  loop
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

  return jsonb_build_object('checked', v_checked, 'success', v_success, 'failure', v_failure);
end $$;

-- Idempotent by construction, same shape purge_due_accounts() already
-- has: the candidate query re-runs every call, and a row this function
-- already deleted (cascaded out of auth.users, profiles and
-- invite_redemptions together) simply cannot be found by it again. A
-- re-run against an already-purged account returns
-- {"checked": 0, "success": 0, "failure": 0} and touches nothing.
comment on function public.purge_abandoned_profiles(integer) is
  'COMM-314. service_role only. Deletes auth.users rows for anonymous sessions that never redeemed an invite and never verified recovery, older than p_retention_days (default 30, the confirmed window). Idempotent: a rerun finds nothing left to purge for an account already removed. Called by supabase/functions/purge_abandoned_profiles/index.ts over RPC, never reachable from a client role.';

revoke all on function public.purge_abandoned_profiles(integer) from public, anon, authenticated;
grant execute on function public.purge_abandoned_profiles(integer) to service_role;

commit;
