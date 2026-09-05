begin;

-- events.map_link gets a SCHEME check on top of the length check it has
-- carried since 202608280010.
--
-- THE HOLE. `map_link text check (map_link is null or char_length(map_link) <=
-- 500)` accepts any 500 characters, and the column exists to be rendered as an
-- href by whatever surface shows an event. `javascript:...` is 500 characters.
-- So is `data:text/html,...`. Events are writable by any holder of
-- community.event.manage - coach and above - so this is not a "trusted admin
-- only" field, and a client-side scheme check is exactly the kind of boundary
-- this module refuses to leave to the UI. The same reasoning
-- notifications.deep_link already carries: its CHECK is what stops a stored
-- string from becoming a navigation the writer did not earn.
--
-- THE RULE: null, or a string that starts with http:// or https://,
-- case-insensitively, and still at most 500 characters. Case-insensitive
-- because `HTTPS://maps.example` is a legitimate link and `JaVaScRiPt:` is the
-- oldest bypass in the list. Anchored with ^ so the scheme has to be at the
-- START - `javascript:void(0)//https://x` must not pass.
--
-- Nothing narrower is attempted here. This is not a URL validator and does not
-- try to be one: it forbids the schemes that execute, and leaves whether a
-- given https URL is a real map to the person typing it.
--
-- WIDENING, NOT REPLACING. Postgres has no way to alter a CHECK expression in
-- place, so drop-and-re-add is the only mechanism - the same shape 202609030004
-- uses on admin_actions and 202609050002 uses on reports. The constraint was
-- declared inline on a single column in 202608280010, so its name is the
-- deterministic `events_map_link_check`; it is looked up by definition anyway,
-- the way 202608280024 handled reports' inline reason CHECK, so a differently
-- named constraint on the live project is still found and replaced rather than
-- left behind to contradict the new one. The re-added constraint KEEPS the
-- length rule: this is one constraint doing both jobs, not a second one added
-- next to a survivor.
--
-- ROWS THAT WOULD FAIL. The constraint is added VALIDATED, so a pre-existing
-- row with a non-http map_link fails this migration loudly rather than being
-- grandfathered in. That is the intended behaviour for a constraint whose
-- whole purpose is that nothing gets past it, and it is safe here: the events
-- surface is Phase 2 and the column has no writer in the shipped client. If a
-- live project ever does trip it, the fix is to null out the offending
-- map_link, not to weaken the check.

do $$
declare v_name text;
begin
  select conname into v_name from pg_constraint
  where conrelid = 'public.events'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%map_link%';
  if v_name is not null then
    execute format('alter table public.events drop constraint %I', v_name);
  end if;
end $$;

alter table public.events
  add constraint events_map_link_check
  check (
    map_link is null
    or (char_length(map_link) <= 500 and map_link ~* '^https?://')
  );

commit;
