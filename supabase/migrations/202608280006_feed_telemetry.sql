begin;

-- COMM-003. What the feed showed, where, and what the member did with it.
--
-- Both tables are strictly own-row: a member reads and writes only rows
-- carrying their own user_id. Nobody, admin included, reads another
-- member's impression stream through RLS - the aggregate view that
-- COMM-310 needs is a definer function's job, not a widened policy.

create table public.feed_impressions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.workout_posts(id) on delete cascade,
  "position" smallint not null check ("position" >= 0),
  feed_session_id uuid not null,
  shown_at timestamptz not null default now(),
  opened boolean not null default false,
  engaged boolean not null default false,
  -- Makes feed_record_impressions() idempotent: the client retrying a
  -- batch after a dropped response cannot double-count a post.
  unique (user_id, feed_session_id, post_id)
);
create index feed_impressions_user_idx on public.feed_impressions(user_id, shown_at desc);
create index feed_impressions_post_idx on public.feed_impressions(post_id);

create table public.feed_interactions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.workout_posts(id) on delete cascade,
  kind text not null check (kind in ('open', 'react', 'comment', 'share', 'hide', 'save', 'profile_open')),
  created_at timestamptz not null default now()
);
create index feed_interactions_user_idx on public.feed_interactions(user_id, created_at desc);
create index feed_interactions_post_idx on public.feed_interactions(post_id);

alter table public.feed_impressions enable row level security;
alter table public.feed_interactions enable row level security;

revoke all on public.feed_impressions, public.feed_interactions from public, anon;
grant select, insert on public.feed_impressions to authenticated;
grant select, insert on public.feed_interactions to authenticated;

create policy feed_impressions_self_select on public.feed_impressions for select to authenticated
  using (user_id = auth.uid());
create policy feed_impressions_self_insert on public.feed_impressions for insert to authenticated
  with check (user_id = auth.uid());

create policy feed_interactions_self_select on public.feed_interactions for select to authenticated
  using (user_id = auth.uid());
create policy feed_interactions_self_insert on public.feed_interactions for insert to authenticated
  with check (user_id = auth.uid());

-- No UPDATE grant or policy on feed_impressions on purpose. The only
-- thing that ever flips `opened` and `engaged` is
-- feed_record_interaction() below, which runs with definer rights, so a
-- client cannot rewrite its own measured history after the fact.

create or replace function public.feed_record_impressions(p_rows jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a json array';
  end if;
  if jsonb_array_length(p_rows) > 50 then
    raise exception 'at most 50 impressions per call';
  end if;

  insert into public.feed_impressions (user_id, post_id, "position", feed_session_id, shown_at)
  select
    v_uid,
    (r ->> 'post_id')::uuid,
    least(greatest(coalesce((r ->> 'position')::integer, 0), 0), 32767)::smallint,
    (r ->> 'feed_session_id')::uuid,
    coalesce((r ->> 'shown_at')::timestamptz, now())
  from jsonb_array_elements(p_rows) r
  where r ->> 'post_id' is not null
    and r ->> 'feed_session_id' is not null
  on conflict (user_id, feed_session_id, post_id) do nothing;
end $$;
revoke all on function public.feed_record_impressions(jsonb) from public, anon;
grant execute on function public.feed_record_impressions(jsonb) to authenticated;

create or replace function public.feed_record_interaction(p_post_id uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_kind not in ('open', 'react', 'comment', 'share', 'hide', 'save', 'profile_open') then
    raise exception 'unknown interaction kind %', p_kind;
  end if;
  if not public.check_rate_limit('feed_interaction', 300, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;

  insert into public.feed_interactions (user_id, post_id, kind) values (v_uid, p_post_id, p_kind);

  update public.feed_impressions
  set opened = opened or p_kind = 'open',
      engaged = engaged or p_kind in ('react', 'comment', 'share', 'save')
  where user_id = v_uid and post_id = p_post_id;
end $$;
revoke all on function public.feed_record_interaction(uuid, text) from public, anon;
grant execute on function public.feed_record_interaction(uuid, text) to authenticated;

commit;
