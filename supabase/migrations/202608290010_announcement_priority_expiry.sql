begin;

-- Community Phase 2, announcements cluster: COMM-218 (priority levels and
-- expiry) and the server half of COMM-219 (notification toggle and urgent
-- path). Exactly the two contracts.md lists: "Needs from schema,
-- admin-moderation (Phase 2)" for the columns, and the COMM-218/219 bullet
-- of "Needs from schema, notifications (Phase 2)" for the predicate and the
-- trigger.
--
-- This is a widen, not a rewrite. Everything Phase 1 shipped against
-- `announcements.important` keeps working with no edit:
--
--   * `important` stays a real, writable boolean column. contracts.md
--     offers "generated column OR an equivalent trigger-maintained mirror";
--     this file takes the trigger-maintained option, because a GENERATED
--     ALWAYS column would make `insert into announcements (..., important)`
--     and `update announcements set important = true` hard errors, and both
--     of those are live in the shipped pgTAP suite (0026, 0027) and in any
--     client build that predates the priority field. A mirror keeps both
--     spellings legal and always consistent.
--   * The write gate is untouched. `announcements_insert_admin` /
--     `announcements_update_admin` are whole-row `public.is_staff()`
--     policies, so a new column on the table is staff-only to write the
--     moment it exists. No policy is widened here; the only policy change
--     below is the READ policy getting narrower for expired rows.
--   * Pins are untouched. Expiry is not deadness: `pins_unpin_dead_announcement`
--     still fires only on `deleted_at`, so an expired-but-pinned
--     announcement stays pinned until a staff member explicitly unpins it
--     (COMM-218 acceptance criterion), it simply stops being readable by
--     members, which is what empties it out of the strip.
--
-- COMM-219 needs no `notification_preferences` change: the ticket is
-- explicit that the existing coarse `announcements` key from COMM-144 is
-- the only preference row involved, and the urgent path is the SAME
-- `notif_create` immediate path with `notif_is_operational` answering true,
-- not a second channel or a second key.

------------------------------------------------------------------------
-- 1. The three-tier priority column, and the expiry column.
------------------------------------------------------------------------
alter table public.announcements
  add column if not exists priority text not null default 'normal';
alter table public.announcements
  drop constraint if exists announcements_priority_check;
alter table public.announcements
  add constraint announcements_priority_check
  check (priority in ('normal', 'important', 'urgent'));

alter table public.announcements
  add column if not exists expires_at timestamptz;

-- Backfill from the Phase 1 boolean, so an announcement already flagged
-- important before this migration ran lands on the matching tier rather
-- than on the column default. Idempotent: re-running matches nothing.
update public.announcements
   set priority = 'important'
 where important and priority = 'normal';

comment on column public.announcements.priority is
  'COMM-218 three-tier urgency: normal < important < urgent. important and urgent are both operational (they bypass a members off announcements preference); urgent additionally gets the strongest client treatment. Staff-only write, via the existing is_staff() insert/update policies.';
comment on column public.announcements.expires_at is
  'COMM-218 optional expiry. Past this instant the row stops being readable by non-staff members (announcements_read), which is what drops it out of the feed top area and the pinned strip at query time - no cron, no backfill, same shape as a timed-out posting restriction. Staff keep reading it, because expiry hides an announcement from members, not from the record.';
comment on column public.announcements.important is
  'COMM-144 operational override, kept as a mirror of priority <> normal (COMM-218) so every Phase 1 trigger, policy, and client that reads or writes it keeps working. Maintained by announcements_priority_sync in both directions; never write it and priority to disagreeing values in one statement, priority wins.';

-- No index on expires_at as a partial predicate: now() is not immutable, so
-- "not yet expired" cannot be a partial index condition. A plain index on
-- the sparse set of rows that carry an expiry is all the read policy needs.
create index if not exists announcements_expires_idx
  on public.announcements(expires_at) where expires_at is not null;

------------------------------------------------------------------------
-- 2. Keeping `important` and `priority` in lockstep.
------------------------------------------------------------------------
-- A BEFORE trigger rather than a generated column, for the reason at the
-- top of this file. Resolution rules, stated once so the two spellings can
-- never drift:
--
--   INSERT: a non-normal `priority` wins outright. Otherwise a true
--     `important` (the legacy spelling, priority left at its default) is
--     read as `important` tier. Otherwise normal/false.
--   UPDATE: if `priority` actually changed, it wins and `important` is
--     recomputed from it. Otherwise, if `important` actually changed, it is
--     the legacy spelling of an escalation/de-escalation and `priority`
--     follows it (true -> important, false -> normal). Otherwise the pair
--     is simply re-normalised, which is a no-op on a consistent row.
--
-- Both branches leave the row consistent, so `important = (priority <>
-- 'normal')` is an invariant of the table after this migration.
create or replace function public.announcements_priority_sync() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.priority is not null and new.priority <> 'normal' then
      new.important := true;
    elsif coalesce(new.important, false) then
      new.priority := 'important';
    else
      new.priority := coalesce(new.priority, 'normal');
      new.important := false;
    end if;
  else
    if new.priority is distinct from old.priority then
      new.important := (new.priority <> 'normal');
    elsif coalesce(new.important, false) is distinct from coalesce(old.important, false) then
      new.priority := case when new.important then 'important' else 'normal' end;
    else
      new.important := (new.priority <> 'normal');
    end if;
  end if;
  return new;
end $$;
revoke all on function public.announcements_priority_sync() from public, anon, authenticated;

drop trigger if exists announcements_priority_sync on public.announcements;
create trigger announcements_priority_sync before insert or update on public.announcements
  for each row execute function public.announcements_priority_sync();

-- The one place that says what "upward" means on the three tiers. Used by
-- the escalation trigger; also useful to a client ordering a badge list, so
-- it is granted to authenticated. Pure, no row access, nothing to leak.
create or replace function public.announcement_priority_rank(p_priority text) returns integer
language sql immutable set search_path = '' as $$
  select case p_priority when 'urgent' then 2 when 'important' then 1 else 0 end;
$$;
revoke all on function public.announcement_priority_rank(text) from public, anon;
grant execute on function public.announcement_priority_rank(text) to authenticated;

------------------------------------------------------------------------
-- 3. Expiry is a read-time filter, enforced in RLS.
------------------------------------------------------------------------
-- Members read `announcements` directly under RLS - there is no
-- server-side announcements page function - so the read policy is the only
-- honest place to hide an expired row. A client-side `expires_at > now()`
-- filter would be a UI check, not a boundary, and the module's rule is that
-- the boundary is never the UI.
--
-- Narrower than before, never wider: `deleted_at is null` is unchanged, and
-- staff keep seeing everything so an admin audit read still shows the
-- record. Nothing else in the module reads this table through RLS: the
-- notification fan-out and the pin triggers are definer/owner paths.
drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements for select to authenticated
  using (
    deleted_at is null
    and (expires_at is null or expires_at > now() or public.is_staff())
  );

------------------------------------------------------------------------
-- 4. notif_is_operational widens to the two operational tiers.
------------------------------------------------------------------------
-- Byte-for-byte the 202608280026 function with one predicate swapped:
-- `a.important` becomes `a.priority in ('important', 'urgent')`. Because
-- `important` is now the mirror of `priority <> 'normal'`, the two spellings
-- agree on every existing row - this is a rename of the source of truth,
-- not a behaviour change, until a row is actually set to urgent.
create or replace function public.notif_is_operational(p_type text, p_source_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_type = 'announcement' then coalesce(
      (select a.priority in ('important', 'urgent')
         from public.announcements a where a.id = p_source_id), false)
    else false
  end;
$$;
revoke all on function public.notif_is_operational(text, uuid) from public, anon, authenticated;

------------------------------------------------------------------------
-- 5. The fan-out: never a second row for the same announcement.
------------------------------------------------------------------------
-- Two changes to the 202608280027 body, same signature, same grants:
--
--   a. An already-expired announcement fans out to nobody. Notifying a
--      member about a row the read policy will not let them open is a dead
--      end, and there is no ticket state where it is wanted.
--   b. A member who already holds a notification row for this announcement
--      is skipped, whatever their preference. The Phase 1 `p_off_only`
--      filter alone was exact for a single boolean flip; across three tiers
--      an announcement can be escalated repeatedly (and even de-escalated
--      and re-escalated), and COMM-219 promises "nobody gets two rows for
--      the same announcement no matter how many times its priority
--      changes". This makes that promise structural instead of leaning on
--      `notif_create`'s one-hour dedupe window.
--
-- On the INSERT pass this exclusion matches nothing, so first fan-out
-- behaviour is unchanged.
create or replace function public.notif_announcement_fanout(p_id uuid, p_off_only boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.announcements;
  v_member uuid;
begin
  select * into v_row from public.announcements where id = p_id;
  if not found or v_row.deleted_at is not null then return; end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then return; end if;

  for v_member in
    select p.id
    from public.profiles p
    where p.deleted_at is null
      and p.id <> v_row.author_id
      and exists (select 1 from public.invite_redemptions ir where ir.user_id = p.id)
      and not exists (
        select 1 from public.notifications n
        where n.user_id = p.id and n.type = 'announcement' and n.source_id = v_row.id
      )
      and (
        not p_off_only
        or exists (
          select 1 from public.notification_preferences np
          where np.user_id = p.id and np.type = 'announcements' and np.channel = 'off'
        )
      )
  loop
    perform public.notif_create(
      v_member, 'announcement', 'club',
      v_row.title, v_row.body,
      'announcement', v_row.id,
      '/community/feed?announcement=' || v_row.id::text
    );
  end loop;
end $$;
revoke all on function public.notif_announcement_fanout(uuid, boolean) from public, anon, authenticated;

-- Backs the "does this member already have a row for this announcement"
-- test above, and notif_create's own (user, type, source_id) dedupe probe.
create index if not exists notifications_source_idx
  on public.notifications(source_id, user_id) where source_id is not null;

------------------------------------------------------------------------
-- 6. The escalation trigger, generalised to the three tiers.
------------------------------------------------------------------------
-- Phase 1 fired on one boolean flip. Now it fires on any upward move on
-- `normal < important < urgent`:
--
--   normal -> important   fan out to the members the INSERT skipped (the
--                         explicit `off` rows). Identical to Phase 1.
--   normal -> urgent      same: the jump must still reach the `off`
--                         members, even though the `important` tier was
--                         never occupied.
--   important -> urgent   fires, but reaches nobody: at `important` the
--                         announcement was already operational, so every
--                         member holds a row and the fan-out's
--                         already-notified filter drops all of them. The
--                         trigger is deliberately not short-circuited on
--                         this transition - "who was already reached" is
--                         one rule, in the fan-out, rather than two rules
--                         that could disagree.
--   any downgrade         no fan-out at all.
create or replace function public.notif_on_announcement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is null then
      perform public.notif_announcement_fanout(new.id, false);
    end if;
  elsif tg_op = 'UPDATE' then
    if new.deleted_at is null
       and public.announcement_priority_rank(new.priority)
           > public.announcement_priority_rank(old.priority) then
      perform public.notif_announcement_fanout(new.id, true);
    end if;
  end if;
  return null;
end $$;
revoke all on function public.notif_on_announcement() from public, anon, authenticated;

-- The column list widens to BOTH columns, not just `priority`. `UPDATE OF
-- <col>` matches the columns named in the statement's SET clause, not the
-- values a BEFORE trigger ends up writing, so a legacy `update ... set
-- important = true` would never fire an `of priority` trigger even though
-- announcements_priority_sync has just moved the row to the `important`
-- tier. Listing both keeps the Phase 1 spelling working; the body decides
-- on `priority` either way.
drop trigger if exists announcements_notify_escalate on public.announcements;
create trigger announcements_notify_escalate after update of priority, important on public.announcements
  for each row execute function public.notif_on_announcement();

commit;
