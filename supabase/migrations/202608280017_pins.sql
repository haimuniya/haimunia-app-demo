begin;

-- COMM-155. Up to three items held at the top of the club surface.
--
-- The hard cap of 3 is structural, not a counting trigger. `slot` is
-- constrained to 0..2 and (club_id, slot) is unique, so a fourth pin has no
-- free slot to take. Same reasoning post_media used for its 0..3 position
-- cap in 202608280005: a count-rows trigger reads a snapshot and two
-- concurrent pins can both see 2 and both insert, while a unique slot
-- cannot be beaten by concurrency. The ticket says "enforced by a trigger",
-- which is the intent - this is the version of that intent that actually
-- holds. `slot` doubles as the display order of the pinned strip, so it is
-- not dead scaffolding either.
--
-- No foreign key on target_id: it points at one of four different tables.
-- Existence and pinnability are checked by a trigger on write, and the four
-- auto-unpin triggers at the bottom do the job ON DELETE CASCADE would have
-- done, plus the soft-delete and status cases a foreign key could not see.

create table public.pins (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  target_type text not null check (target_type in ('announcement', 'challenge', 'event', 'post')),
  target_id uuid not null,
  slot smallint not null check (slot between 0 and 2),
  -- Not a foreign key, same reasoning as admin_actions.admin_id: the pin
  -- outlives the account that made it, and the audit row points here.
  pinned_by uuid not null,
  note text not null default '' check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  -- The cap.
  unique (club_id, slot),
  -- The same item cannot occupy two slots.
  unique (club_id, target_type, target_id)
);
create index pins_target_idx on public.pins(target_type, target_id);

create or replace function public.enforce_pin_target() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ok boolean := false;
begin
  -- IF/ELSIF rather than a CASE expression on purpose: the four branches
  -- reference columns that only exist on their own table, and a single CASE
  -- would be prepared as one expression against all of them.
  if new.target_type = 'post' then
    select exists (
      select 1 from public.workout_posts p
      where p.id = new.target_id and p.deleted_at is null and p.status = 'active'
    ) into v_ok;
  elsif new.target_type = 'announcement' then
    select exists (
      select 1 from public.announcements a where a.id = new.target_id and a.deleted_at is null
    ) into v_ok;
  elsif new.target_type = 'event' then
    select exists (
      select 1 from public.events e where e.id = new.target_id and e.status <> 'cancelled'
    ) into v_ok;
  elsif new.target_type = 'challenge' then
    select exists (
      select 1 from public.challenges c where c.id = new.target_id and c.status <> 'archived'
    ) into v_ok;
  end if;
  if not v_ok then raise exception 'pin target not found or not pinnable'; end if;
  return new;
end $$;
create trigger pins_target_exists before insert or update of target_type, target_id
  on public.pins for each row execute function public.enforce_pin_target();

alter table public.pins enable row level security;

-- SELECT only, and the select is open to every signed-in member: a pinned
-- item is the most public thing in the club by definition. There is no
-- insert, update, or delete policy and no write grant, exactly like
-- admin_actions: the only write path is pin_set() and pin_clear() below,
-- which check community.content.pin and write an audit row in the same
-- transaction. Handing staff a direct RLS write would make the
-- admin_actions requirement in COMM-155 depend on the client behaving.
revoke all on public.pins from public, anon;
grant select on public.pins to authenticated;
create policy pins_read on public.pins for select to authenticated using (true);

create or replace function public.pin_set(p_target_type text, p_target_id uuid, p_note text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_club uuid;
  v_slot smallint;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.content.pin') then raise exception 'not authorized'; end if;
  if p_target_type not in ('announcement', 'challenge', 'event', 'post') then
    raise exception 'unknown pin target type %', p_target_type;
  end if;
  if p_target_id is null then raise exception 'pin target required'; end if;

  v_club := public.default_club_id();

  -- Serialises slot selection so two staff pinning at the same moment get a
  -- clean "already three pinned" instead of a raw unique violation. The
  -- unique constraint is still the real guarantee; this only makes the
  -- error message honest.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('community.pins'));

  if exists (
    select 1 from public.pins
    where club_id = v_club and target_type = p_target_type and target_id = p_target_id
  ) then
    return;
  end if;

  select pg_catalog.min(s)::smallint into v_slot
  from pg_catalog.generate_series(0, 2) s
  where not exists (select 1 from public.pins p where p.club_id = v_club and p.slot = s);
  if v_slot is null then raise exception 'pin_limit_reached'; end if;

  insert into public.pins (club_id, target_type, target_id, slot, pinned_by, note)
  values (v_club, p_target_type, p_target_id, v_slot, v_uid, left(coalesce(p_note, ''), 200));

  perform public.log_admin_action(
    'content_pin', p_target_type, p_target_id,
    null,
    jsonb_build_object('slot', v_slot, 'note', left(coalesce(p_note, ''), 200))
  );
end $$;
revoke all on function public.pin_set(text, uuid, text) from public, anon;
grant execute on function public.pin_set(text, uuid, text) to authenticated;

create or replace function public.pin_clear(p_target_type text, p_target_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.pins;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.content.pin') then raise exception 'not authorized'; end if;

  select * into v_row from public.pins
  where club_id = public.default_club_id()
    and target_type = p_target_type and target_id = p_target_id;
  -- Unpinning something already unpinned is a no-op, not an error, so a
  -- double tap does not surface a failure to a member of staff.
  if not found then return; end if;

  delete from public.pins where id = v_row.id;

  perform public.log_admin_action(
    'content_unpin', p_target_type, p_target_id,
    jsonb_build_object('slot', v_row.slot, 'note', v_row.note),
    null
  );
end $$;
revoke all on function public.pin_clear(text, uuid) from public, anon;
grant execute on function public.pin_clear(text, uuid) to authenticated;

-- "A deleted or removed target is auto-unpinned." Each table gets an UPDATE
-- trigger with the deadness test in the WHEN clause, so the shared function
-- never has to reach for a column that does not exist on the table it was
-- fired from, plus a DELETE trigger doing the job a foreign key cascade
-- would have done if target_id could have had one.
--
-- These deletes are not audited. Auto-unpinning is a consequence of an
-- action that is already in admin_actions (the delete, the removal, the
-- cancellation), not a separate staff decision.
create or replace function public.unpin_target() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if tg_op = 'DELETE' then v_id := old.id; else v_id := new.id; end if;
  delete from public.pins where target_type = tg_argv[0] and target_id = v_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger pins_unpin_dead_post after update on public.workout_posts
  for each row when (new.deleted_at is not null or new.status <> 'active')
  execute function public.unpin_target('post');
create trigger pins_unpin_deleted_post after delete on public.workout_posts
  for each row execute function public.unpin_target('post');

create trigger pins_unpin_dead_announcement after update on public.announcements
  for each row when (new.deleted_at is not null)
  execute function public.unpin_target('announcement');
create trigger pins_unpin_deleted_announcement after delete on public.announcements
  for each row execute function public.unpin_target('announcement');

create trigger pins_unpin_dead_event after update on public.events
  for each row when (new.status = 'cancelled')
  execute function public.unpin_target('event');
create trigger pins_unpin_deleted_event after delete on public.events
  for each row execute function public.unpin_target('event');

create trigger pins_unpin_dead_challenge after update on public.challenges
  for each row when (new.status = 'archived')
  execute function public.unpin_target('challenge');
create trigger pins_unpin_deleted_challenge after delete on public.challenges
  for each row execute function public.unpin_target('challenge');

commit;
