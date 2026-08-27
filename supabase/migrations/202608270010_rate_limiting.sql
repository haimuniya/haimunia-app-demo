begin;

-- Every table a redeemed member can reach (reactions, post_comments,
-- reports) accepted inserts at whatever rate the client sent, bounded
-- only by RLS ownership checks, never volume - the only rate limit
-- anywhere in the app was redeem_invite_code's. Combined with anonymous
-- sign-in costing an attacker nothing, a single leaked invite code was
-- enough for unlimited comment/reaction/report spam. Same
-- upsert-with-sliding-window pattern invite_attempts already uses,
-- generalized to one shared table + helper so each new limited action is
-- one call, not a new tracking table.
create table public.rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  primary key (user_id, action)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from public, anon, authenticated;

-- Not directly callable by a client (see revoke below) - only ever
-- invoked from inside another security definer function, immediately
-- before the write it's guarding.
create or replace function public.check_rate_limit(p_action text, p_max_per_window integer, p_window_minutes integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.rate_limits(user_id, action, window_started_at, attempt_count)
  values (auth.uid(), p_action, now(), 1)
  on conflict (user_id, action) do update set
    window_started_at = case when public.rate_limits.window_started_at < now() - make_interval(mins => p_window_minutes) then now() else public.rate_limits.window_started_at end,
    attempt_count = case when public.rate_limits.window_started_at < now() - make_interval(mins => p_window_minutes) then 1 else public.rate_limits.attempt_count + 1 end
  returning attempt_count into v_count;
  return v_count <= p_max_per_window;
end $$;
revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;

-- Comments, reactions, and reports move behind a security definer
-- function each, matching redeem_invite_code's own pattern - the
-- rate-limit check and the write happen atomically in one call, and the
-- table's own INSERT grant is revoked below so a client can't bypass the
-- check by calling .insert() directly.
create or replace function public.add_post_comment(p_post_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.check_rate_limit('post_comment', 20, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;
  insert into public.post_comments(post_id, author_id, body) values (p_post_id, auth.uid(), left(coalesce(p_body, ''), 280))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.add_post_comment(uuid, text) from public, anon;
grant execute on function public.add_post_comment(uuid, text) to authenticated;

-- Replaces the client's own insert-then-delete-on-conflict toggle with
-- one atomic call - also closes a small race the client-side version
-- had between the failed insert and the follow-up delete.
create or replace function public.toggle_reaction(p_post_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_existing boolean;
begin
  if not public.check_rate_limit('reaction', 60, 10) then raise exception 'rate_limited'; end if;
  select exists(select 1 from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer') into v_existing;
  if v_existing then
    delete from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer';
    return false;
  end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;
  insert into public.reactions(post_id, user_id, kind) values (p_post_id, auth.uid(), 'cheer');
  return true;
end $$;
revoke all on function public.toggle_reaction(uuid) from public, anon;
grant execute on function public.toggle_reaction(uuid) to authenticated;

create or replace function public.submit_report(p_post_id uuid, p_reason text default 'inappropriate') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.check_rate_limit('report', 10, 10) then raise exception 'rate_limited'; end if;
  insert into public.reports(reporter_id, post_id, reason) values (auth.uid(), p_post_id, p_reason);
end $$;
revoke all on function public.submit_report(uuid, text) from public, anon;
grant execute on function public.submit_report(uuid, text) to authenticated;

revoke insert on public.post_comments from authenticated;
revoke insert on public.reactions from authenticated;
revoke insert on public.reports from authenticated;

commit;
