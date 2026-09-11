begin;

-- Security hunt, round 7 (2026-09-12), race-condition agent.
--
-- push_subscriptions_guard_count() (202609060012) is another
-- count-then-insert cap with no lock: it counts active subscriptions for
-- new.user_id and rejects at 10, but two concurrent inserts for the same
-- user (two tabs, two devices, or a scripted burst) each read the same
-- pre-insert count under READ COMMITTED. Confirmed live against real
-- local Postgres: with 9 active subscriptions already seeded for one
-- account, two concurrent inserts both read count=9 and both committed,
-- landing 11 active rows against a stated cap of 10.
--
-- Own-account resource cap only (bounds push-notification fanout abuse
-- from a single compromised or scripted session, not a cross-user issue),
-- so this is the lowest severity of this round's three race findings, but
-- the fix is the same one-line shape as the other two: a transaction-
-- scoped advisory lock keyed by user_id serializes the count-check-insert
-- section for that user before the count runs.

create or replace function public.push_subscriptions_guard_count() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('push_subscriptions_guard_count:' || new.user_id::text));
  -- Counts ACTIVE subscriptions only (revoked_at is null), matching the
  -- table's own partial index (push_subscriptions_user_idx) - counting
  -- revoked history too would eventually lock a real long-time member out
  -- of ever registering a new device.
  if (select count(*) from public.push_subscriptions where user_id = new.user_id and revoked_at is null) >= 10 then
    raise exception 'too many push subscriptions for this account';
  end if;
  return new;
end $$;
revoke all on function public.push_subscriptions_guard_count() from public, anon, authenticated;

commit;
