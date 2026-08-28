begin;

-- COMM-009. Append-only audit log for every sensitive staff action.
--
-- Lands this early in Phase 0 so the migrations after it can call
-- log_admin_action() from inside their own trusted functions.

create table public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  -- Deliberately NOT a foreign key to profiles. An audit row has to
  -- outlive the account that produced it: a cascade would erase the trail
  -- exactly when someone is removed, and a restrict would make
  -- purge_due_accounts() fail on any admin who ever acted.
  admin_id uuid not null,
  action_type text not null check (action_type in (
    'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
    'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
    'content_pin', 'content_unpin', 'report_review'
  )),
  target_type text not null check (target_type in (
    'post', 'comment', 'member', 'role', 'challenge', 'achievement',
    'event', 'announcement', 'report', 'club'
  )),
  target_id uuid,
  -- The 8 KB cap on each blob is enforced in log_admin_action() below,
  -- not as a CHECK: pg_column_size() is STABLE, and Postgres rejects a
  -- non-IMMUTABLE function inside a check constraint. The function is the
  -- only write path here anyway, so the cap has nowhere to leak past.
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index admin_actions_recent_idx on public.admin_actions(created_at desc);
create index admin_actions_admin_idx on public.admin_actions(admin_id, created_at desc);
create index admin_actions_target_idx on public.admin_actions(target_type, target_id);

alter table public.admin_actions enable row level security;

-- SELECT only. There is no insert, update, or delete policy and no write
-- grant, by design: the single write path is log_admin_action() below,
-- which runs with definer rights. That is what makes the log append-only
-- for every client, admin included.
revoke all on public.admin_actions from public, anon;
grant select on public.admin_actions to authenticated;
create policy admin_actions_read_analytics on public.admin_actions for select to authenticated
  using (public.has_perm('community.analytics.view'));

-- Called from inside another security definer function, immediately
-- before that function returns, so a failed log fails the whole action.
-- Not client-callable: no grant to authenticated, which also means a
-- client can never forge an audit row for someone else.
create or replace function public.log_admin_action(
  p_action_type text,
  p_target_type text,
  p_target_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_before is not null and pg_column_size(p_before) > 8192 then
    raise exception 'before_data exceeds 8 KB';
  end if;
  if p_after is not null and pg_column_size(p_after) > 8192 then
    raise exception 'after_data exceeds 8 KB';
  end if;
  insert into public.admin_actions (admin_id, action_type, target_type, target_id, before_data, after_data)
  values (v_uid, p_action_type, p_target_type, p_target_id, p_before, p_after);
end $$;
revoke all on function public.log_admin_action(text, text, uuid, jsonb, jsonb) from public, anon, authenticated;

create or replace function public.admin_actions_page(
  p_cursor timestamptz default null,
  p_limit integer default 25,
  p_filters jsonb default '{}'::jsonb
) returns setof public.admin_actions
language plpgsql stable security invoker set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.analytics.view') then raise exception 'not authorized'; end if;
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  return query
    select a.* from public.admin_actions a
    where (p_cursor is null or a.created_at < p_cursor)
      and (coalesce(p_filters ->> 'action_type', '') = '' or a.action_type = p_filters ->> 'action_type')
      and (coalesce(p_filters ->> 'admin_id', '') = '' or a.admin_id = (p_filters ->> 'admin_id')::uuid)
    order by a.created_at desc
    limit v_limit;
end $$;
revoke all on function public.admin_actions_page(timestamptz, integer, jsonb) from public, anon;
grant execute on function public.admin_actions_page(timestamptz, integer, jsonb) to authenticated;

commit;
