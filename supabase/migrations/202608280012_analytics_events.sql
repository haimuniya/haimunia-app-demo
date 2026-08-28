begin;

-- COMM-013, table only. The platform agent owns analytics_track() and the
-- event-name constants on the client; schema owns the table it writes to.

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  -- Nullable so a pre-profile event (an invite screen view, a failed
  -- redemption) is still recordable.
  user_id uuid references public.profiles(id) on delete set null,
  event_name text not null check (event_name ~ '^[a-z][a-z0-9_.]{2,63}$'),
  props jsonb not null default '{}'::jsonb,
  schema_version smallint not null default 1 check (schema_version >= 1),
  created_at timestamptz not null default now()
);
create index analytics_events_name_idx on public.analytics_events(event_name, created_at desc);
create index analytics_events_user_idx on public.analytics_events(user_id, created_at desc);

-- The 4 KB props cap is a trigger rather than a CHECK because
-- pg_column_size() is STABLE and Postgres refuses a non-IMMUTABLE
-- function inside a check constraint. Unlike admin_actions, this table
-- takes a direct client insert, so the cap cannot live in a function
-- either - a trigger is the only place that covers every write path.
create or replace function public.enforce_analytics_props_size() returns trigger
language plpgsql set search_path = '' as $$
begin
  if pg_column_size(new.props) > 4096 then
    raise exception 'props exceeds 4 KB';
  end if;
  return new;
end $$;
create trigger analytics_events_props_size before insert or update of props
  on public.analytics_events for each row execute function public.enforce_analytics_props_size();

alter table public.analytics_events enable row level security;
revoke all on public.analytics_events from public, anon;
grant select, insert on public.analytics_events to authenticated;

-- Insert own-row, read only with the analytics permission. A member
-- cannot read the analytics stream at all, not even their own rows: the
-- table is a measurement surface, and letting it be read back per-member
-- turns it into a second, unpoliced profile of what someone did.
create policy analytics_events_insert_self on public.analytics_events for insert to authenticated
  with check (user_id = auth.uid() or user_id is null);
create policy analytics_events_read_analytics on public.analytics_events for select to authenticated
  using (public.has_perm('community.analytics.view'));

-- The event_name allow-list lives in the client constants (COMM-013), not
-- in a CHECK: a new tracked event would otherwise need a migration to
-- ship. The format check above is the schema-side floor.

commit;
