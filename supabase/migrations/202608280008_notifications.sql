begin;

-- COMM-005. The per-member notification stream, per-type delivery
-- preferences, and push endpoints stored now for the Phase 2 web push
-- ticket (COMM-229).

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type ~ '^[a-z][a-z0-9_.]{2,63}$'),
  category text not null check (category in ('community', 'training', 'challenges', 'events', 'club')),
  title text not null default '' check (char_length(title) <= 160),
  body text not null default '' check (char_length(body) <= 500),
  source_type text check (source_type is null or char_length(source_type) <= 40),
  source_id uuid,
  -- An in-app route, never an external URL. The leading slash check is
  -- what stops a notification row from becoming an open redirect.
  deep_link text check (deep_link is null or deep_link ~ '^/[A-Za-z0-9_/?=&.%-]{0,300}$'),
  read_at timestamptz,
  push_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, created_at desc);
create index notifications_unread_idx on public.notifications(user_id, created_at desc) where read_at is null;

create table public.notification_preferences (
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type ~ '^[a-z][a-z0-9_.]{2,63}$'),
  channel text not null check (channel in ('push', 'in_app', 'off')),
  updated_at timestamptz not null default now(),
  primary key (user_id, type)
);

-- A missing row means in_app, so an empty table is a valid, fully
-- functional default state and no backfill is needed here or later.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) between 1 and 1000),
  keys jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id) where revoked_at is null;

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on public.notifications, public.notification_preferences, public.push_subscriptions from public, anon;
grant select, update on public.notifications to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Notifications are readable and markable-read by their owner and nobody
-- else. There is no insert policy and no insert grant: a notification is
-- created only by a trigger or an event-bus consumer running as the
-- service role, so a member can never plant one in someone else's stream.
create policy notifications_self_select on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_self_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The own-row UPDATE above is meant for read_at only. Without this the
-- owner could rewrite the title, body, or deep_link of a notification the
-- server wrote - harmless to others, but it would make the stream
-- untrustworthy as an audit surface. Same "only pin on a real
-- authenticated API request" scoping protect_is_admin() uses, so a
-- service-role or dashboard write still passes.
create or replace function public.protect_notification_content() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated' then
    new.user_id = old.user_id;
    new.club_id = old.club_id;
    new.type = old.type;
    new.category = old.category;
    new.title = old.title;
    new.body = old.body;
    new.source_type = old.source_type;
    new.source_id = old.source_id;
    new.deep_link = old.deep_link;
    new.push_sent_at = old.push_sent_at;
    new.created_at = old.created_at;
  end if;
  return new;
end $$;
create trigger notifications_protect_content before update on public.notifications
  for each row execute function public.protect_notification_content();

create policy notification_preferences_self_select on public.notification_preferences for select to authenticated
  using (user_id = auth.uid());
create policy notification_preferences_self_insert on public.notification_preferences for insert to authenticated
  with check (user_id = auth.uid());
create policy notification_preferences_self_update on public.notification_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notification_preferences_self_delete on public.notification_preferences for delete to authenticated
  using (user_id = auth.uid());

create policy push_subscriptions_self_select on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy push_subscriptions_self_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid());
create policy push_subscriptions_self_update on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_subscriptions_self_delete on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

create or replace function public.notif_list(p_cursor timestamptz default null, p_limit integer default 20)
returns setof public.notifications
language plpgsql stable security invoker set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 40);
  return query
    select n.* from public.notifications n
    where n.user_id = auth.uid()
      and (p_cursor is null or n.created_at < p_cursor)
    order by n.created_at desc
    limit v_limit;
end $$;
revoke all on function public.notif_list(timestamptz, integer) from public, anon;
grant execute on function public.notif_list(timestamptz, integer) to authenticated;

create or replace function public.notif_mark_read(p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_ids is null or array_length(p_ids, 1) is null then return; end if;
  if array_length(p_ids, 1) > 100 then raise exception 'at most 100 ids per call'; end if;
  update public.notifications set read_at = coalesce(read_at, now())
  where user_id = v_uid and id = any(p_ids);
end $$;
revoke all on function public.notif_mark_read(uuid[]) from public, anon;
grant execute on function public.notif_mark_read(uuid[]) to authenticated;

create or replace function public.notif_unread_count() returns integer
language sql stable security invoker set search_path = '' as $$
  select count(*)::integer from public.notifications
  where user_id = auth.uid() and read_at is null;
$$;
revoke all on function public.notif_unread_count() from public, anon;
grant execute on function public.notif_unread_count() to authenticated;

commit;
