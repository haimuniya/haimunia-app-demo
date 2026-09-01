begin;

-- Club Modules. An admin can turn a Community feature off for the whole
-- club: no tab/card/button/notification, and genuinely unqueryable via
-- RLS, not just client-hidden. Single implicit club (default_club_id()) -
-- multi-club/platform super-admin is explicitly out of scope here.
--
-- Six toggles, matching what the app's current structure actually exposes
-- as independently gateable surfaces (not the larger original wishlist -
-- comments/reactions/workout-sharing have no RLS entry point of their own,
-- they key off workout_posts' own visibility; directory reads straight off
-- profiles, the single most foundational read policy in the schema, so it
-- stays a client-only hide; notifications already has its own per-type
-- toggle system in notification_preferences, a club-wide switch on top of
-- that would be a second, overlapping control plane):
--   announcements, events, challenges, achievements, feed, leaderboards.
--
-- clubs.settings jsonb already holds unrelated data (v_club.settings ->>
-- 'image_url', 202608280019) - not reused here. A dedicated table matches
-- this schema's existing bias toward typed tables over jsonb blobs for
-- anything with a fixed shape (see leaderboard_row's own reasoning).
create table public.club_features (
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  module_key text not null check (module_key ~ '^[a-z][a-z0-9_]{2,31}$'),
  -- config exists only for a module that needs sub-structure beyond a
  -- single on/off - none does today. Kept as an empty jsonb rather than
  -- omitted so a future sub-toggle doesn't need a column migration.
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (club_id, module_key)
);

alter table public.club_features enable row level security;
grant select on public.club_features to authenticated;
-- Same shape as roles/permissions/role_permissions (202608280001): world
-- readable to any authenticated member, no direct write policy. Writes go
-- exclusively through admin_set_club_feature() below, which runs as the
-- table owner (security definer) and does its own authorization check -
-- the same no-direct-write-policy shape invite_redemptions has for `role`,
-- written only through admin_grant_coach() (202608280025).
create policy club_features_read on public.club_features for select to authenticated using (true);

-- The single predicate every gated RLS policy and the client resolver both
-- call. `true` when no row exists for a key - a module this migration
-- doesn't seed (e.g. anything gated only client-side) is never
-- accidentally hidden by a missing row.
create or replace function public.club_feature_enabled(p_module_key text, p_sub_key text default null)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select case when p_sub_key is null then cf.enabled
                 else cf.enabled and coalesce((cf.config ->> p_sub_key)::boolean, true)
            end
     from public.club_features cf
     where cf.club_id = public.default_club_id() and cf.module_key = p_module_key),
    true
  );
$$;
revoke all on function public.club_feature_enabled(text, text) from public, anon;
grant execute on function public.club_feature_enabled(text, text) to authenticated;

-- Seed all six, enabled - a migration must never silently turn something
-- off for a live club.
insert into public.club_features (module_key, enabled) values
  ('announcements', true),
  ('events', true),
  ('challenges', true),
  ('achievements', true),
  ('feed', true),
  ('leaderboards', true)
on conflict (club_id, module_key) do nothing;

-- Write path. admin-tier by design (matches community.analytics.view's
-- seeding, not staff/coach) since toggling a whole feature off for
-- everyone is a heavier action than the moderation/coach-grant permissions
-- already scoped to lower tiers.
insert into public.permissions (code, description) values
  ('community.club.manage_modules', 'Turn per-club feature modules on or off');
insert into public.role_permissions (role_code, permission_code) values
  ('admin', 'community.club.manage_modules'),
  ('owner', 'community.club.manage_modules');

-- Shaped like admin_grant_coach (202608280025): security definer, an
-- inline authorization check that raises rather than silently no-opping,
-- the write, then log_admin_action. Uses has_perm() rather than the
-- literal is_admin check admin_grant_coach itself uses - cloud.js already
-- flags that inline check as a legacy shape (the handful of server
-- functions still checking is_admin directly), so new code follows the
-- current permission-string convention instead of extending that list.
create or replace function public.admin_set_club_feature(p_module_key text, p_enabled boolean, p_config jsonb default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_before record;
begin
  if not public.has_perm('community.club.manage_modules') then
    raise exception 'not authorized';
  end if;
  if p_module_key !~ '^[a-z][a-z0-9_]{2,31}$' then
    raise exception 'invalid module_key';
  end if;

  select enabled, config into v_before from public.club_features
    where club_id = public.default_club_id() and module_key = p_module_key;

  insert into public.club_features (club_id, module_key, enabled, config, updated_by, updated_at)
  values (public.default_club_id(), p_module_key, p_enabled, coalesce(p_config, '{}'::jsonb), auth.uid(), now())
  on conflict (club_id, module_key) do update
    set enabled = excluded.enabled, config = excluded.config,
        updated_by = excluded.updated_by, updated_at = now();

  perform public.log_admin_action(
    'club_feature_toggle', 'club', null,
    jsonb_build_object('module_key', p_module_key, 'enabled', v_before.enabled, 'config', v_before.config),
    jsonb_build_object('module_key', p_module_key, 'enabled', p_enabled, 'config', coalesce(p_config, v_before.config))
  );
end $$;
revoke all on function public.admin_set_club_feature(text, boolean, jsonb) from public, anon;
grant execute on function public.admin_set_club_feature(text, boolean, jsonb) to authenticated;

alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review',
  'member_of_week_publish',
  'monthly_recap_publish',
  -- Club Modules.
  'club_feature_toggle'
));

-- =====================================================================
-- RLS extension. Every predicate below is the live policy's original
-- condition, unchanged, with one additive `and club_feature_enabled(...)`
-- - so every existing pgTAP assertion about who can read a row when the
-- module is on keeps passing unmodified.
-- =====================================================================

drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements for select to authenticated
  using (
    deleted_at is null
    and (expires_at is null or expires_at > now() or public.is_staff())
    and public.club_feature_enabled('announcements')
  );

drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (
  (
    status <> 'draft'
    or created_by = auth.uid()
    or public.has_perm('community.event.manage')
  )
  and public.club_feature_enabled('events')
);

drop policy if exists challenges_read on public.challenges;
create policy challenges_read on public.challenges for select to authenticated using (
  (
    status <> 'draft'
    or created_by = auth.uid()
    or public.has_perm('community.challenge.create')
  )
  and public.club_feature_enabled('challenges')
);

-- Whole predicate gated, including the own-row branch: "off" means
-- genuinely unqueryable, including a member's own past unlocks, not just
-- unqueryable to ordinary members.
drop policy if exists member_achievements_read on public.member_achievements;
create policy member_achievements_read on public.member_achievements for select to authenticated using (
  (
    user_id = auth.uid()
    or (
      visibility = 'club'
      and public.can_view_profile_field(user_id, 'show_achievements')
    )
    or (
      visibility = 'friends'
      and public.are_friends(user_id)
      and public.can_view_profile_field(user_id, 'show_achievements')
    )
  )
  and public.club_feature_enabled('achievements')
);

-- Feed. Comments (post_comments_visible) and reactions (reactions_visible)
-- both key off a workout_posts existence/visibility check rather than
-- their own independent policy, so gating this one table gates them too -
-- there is no separate table to extend for them.
drop policy if exists posts_feed_select on public.workout_posts;
create policy posts_feed_select on public.workout_posts for select to authenticated using (
  deleted_at is null
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = author_id)
       or (b.blocker_id = author_id and b.blocked_id = auth.uid())
  )
  and (
    author_id = auth.uid()
    or (
      status = 'active'
      and (
        visibility in ('public', 'club')
        or (visibility = 'followers' and exists (
              select 1 from public.follows f
              where f.follower_id = auth.uid() and f.followed_id = author_id))
        or (visibility = 'friends' and public.are_friends(author_id))
      )
    )
  )
  and public.club_feature_enabled('feed')
);

-- Leaderboards. No base-table policy to extend - feed_leaderboard() reads
-- under its own security definer rights (202608310004 is the live
-- version). Recreated in full with one added gate near the top, everything
-- else byte-identical to the live function.
create or replace function public.feed_leaderboard(
  p_mode text,
  p_challenge_id uuid default null,
  p_scope text default 'club',
  p_limit int default 50
) returns setof public.leaderboard_row
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_scope text;
  v_limit int;
  v_challenge public.challenges;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if public.my_role_code() is null then raise exception 'not authorized'; end if;
  if not public.club_feature_enabled('leaderboards') then
    raise exception 'leaderboards disabled';
  end if;

  v_mode := lower(btrim(coalesce(p_mode, '')));
  v_scope := lower(btrim(coalesce(p_scope, 'club')));
  if v_scope = '' then v_scope := 'club'; end if;

  if v_mode not in ('consistency', 'progress') then
    raise exception 'unknown leaderboard mode %', p_mode;
  end if;
  if v_scope not in ('club', 'friends') then
    raise exception 'unknown leaderboard scope %', p_scope;
  end if;

  if v_mode = 'progress' then
    if p_challenge_id is null then
      raise exception 'challenge required';
    end if;
    select * into v_challenge from public.challenges c where c.id = p_challenge_id;
    if not found then raise exception 'challenge not found'; end if;
    if v_challenge.status = 'draft'
       and v_challenge.created_by is distinct from v_uid
       and not public.has_perm('community.challenge.create') then
      raise exception 'challenge not found';
    end if;
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));

  return query
  with cand as (
    select p.id as uid,
           p.display_name,
           p.handle,
           p.avatar_url,
           coalesce(ir.redeemed_at, p.created_at) as joined_at
    from public.profiles p
    left join public.invite_redemptions ir on ir.user_id = p.id
    where p.deleted_at is null
      and (v_scope = 'club' or p.id = v_uid or public.are_friends(p.id))
      and public.can_view_profile_field(p.id, 'visible_to_club')
      and public.can_view_profile_field(p.id, 'in_leaderboards')
  ),
  valued as (
    select c.uid, c.display_name, c.handle, c.avatar_url, c.joined_at,
           coalesce(s.streak, 0)::numeric as value
    from cand c
    left join public.consistency_week_streaks() s on s.user_id = c.uid
    where v_mode = 'consistency'
      and public.can_view_profile_field(c.uid, 'show_attendance')
    union all
    select c.uid, c.display_name, c.handle, c.avatar_url, c.joined_at,
           cp.progress_value
    from cand c
    join public.challenge_participants cp
      on cp.user_id = c.uid
     and cp.challenge_id = p_challenge_id
     and cp.status <> 'withdrawn'
    where v_mode = 'progress'
  ),
  ranked as (
    select v.uid, v.display_name, v.handle, v.avatar_url,
           (row_number() over (
              order by v.value desc,
                       v.joined_at asc,
                       coalesce(nullif(btrim(v.display_name), ''), v.handle) asc,
                       v.uid asc
            ))::integer as rank_pos,
           v.value,
           (v.uid = v_uid) as is_self
    from valued v
  )
  select r.uid, r.display_name, r.handle, r.avatar_url, r.rank_pos, r.value, r.is_self
  from ranked r
  where r.rank_pos <= v_limit or r.is_self
  order by (case when r.rank_pos <= v_limit then 0 else 1 end), r.rank_pos;
end $$;

revoke all on function public.feed_leaderboard(text, uuid, text, int) from public, anon;
grant execute on function public.feed_leaderboard(text, uuid, text, int) to authenticated;

comment on function public.feed_leaderboard(text, uuid, text, int) is
  'COMM-210/211/212 leaderboard, consistency moved onto verified attendance by COMM-306, gated by club_feature_enabled(''leaderboards'') by the Club Modules migration (202609010012). p_mode consistency (club-wide ISO-week streak of attendance_log training days, p_challenge_id ignored) or progress (challenge_participants.progress_value, p_challenge_id required or it raises). p_scope club or friends (are_friends mutual follows, caller always included). Every ranked member passes can_view_profile_field for in_leaderboards and visible_to_club, and in consistency mode for show_attendance as well. rank is a position with ties broken by tenure then display name. The caller''s own row is always returned, appended last with its real rank when outside p_limit (clamped 1..100).';

commit;
