begin;

-- COMM-010 privacy columns, COMM-016 recovery_verified_at, and the
-- helpers COMM-018 enforces against.
--
-- Two decisions from 2026-08-28 are baked in here:
--   - No birth date column, anywhere. The `show_birthday` toggle COMM-010
--     listed is deliberately NOT created: a toggle guarding a field that
--     does not exist is dead schema. Coach Celebrate keeps anniversary,
--     which comes from invite_redemptions.redeemed_at.
--   - Friends means a mutual follow edge. are_friends() below is the only
--     definition of it; there is no friend table and there never will be.

-- 1. Privacy toggles. Anything that exposes a member's numbers
-- (workout results, PRs, attendance, upcoming bookings) defaults OFF.
-- Anything that only makes a member reachable inside a closed, invited
-- club (visible_to_club, follows, mentions, leaderboards, achievements,
-- attendee lists) defaults ON, because a club where everyone is invisible
-- by default is not a community.
alter table public.profiles
  add column club_id uuid not null default public.default_club_id() references public.clubs(id),
  add column visible_to_club boolean not null default true,
  add column show_workout_results boolean not null default false,
  add column show_attendance boolean not null default false,
  add column show_upcoming_booking boolean not null default false,
  add column show_prs boolean not null default false,
  add column show_achievements boolean not null default true,
  add column in_leaderboards boolean not null default true,
  add column allow_follows boolean not null default true,
  add column allow_mentions boolean not null default true,
  add column allow_messages boolean not null default false,
  add column show_in_attendee_lists boolean not null default true,
  add column recovery_verified_at timestamptz;

create index profiles_visible_idx on public.profiles(visible_to_club) where deleted_at is null;

-- 2. Backfill recovery_verified_at for accounts that already satisfy
-- COMM-016 ("existing username and password accounts satisfy the
-- requirement without re-verification"). An anonymous sign-in has no
-- encrypted_password, so it is left null and correctly falls outside
-- is_community_member() until the member sets a real method. Checking the
-- password column rather than is_anonymous keeps this working across
-- GoTrue versions, where is_anonymous is comparatively recent.
update public.profiles p
set recovery_verified_at = now()
from auth.users u
where u.id = p.id
  and p.recovery_verified_at is null
  and u.email is not null
  and u.encrypted_password is not null
  and u.encrypted_password <> '';

-- 3. recovery_verified_at and club_id join is_admin as fields no client
-- request may set. Without this a member could stamp their own
-- recovery_verified_at through the existing own-row profiles update and
-- walk straight past every community gate below. Same trigger as before
-- (202608270004), same "only pin on a real authenticated API request"
-- scoping so a manual dashboard fix still works.
-- The `app.allow_recovery_stamp` escape hatch is what lets
-- mark_recovery_verified() below actually write the column. Being SECURITY
-- DEFINER is not enough on its own: auth.role() reads the caller's JWT
-- claim, which still says 'authenticated' inside a definer function, so
-- without this the trigger would silently revert the stamp the function
-- just made. The GUC is transaction-local and lives under `app.`, which
-- PostgREST never populates from a request (it only ever fills `request.*`),
-- and set_config itself is in pg_catalog and so is not an exposed RPC.
create or replace function public.protect_is_admin() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated' then
    new.is_admin = old.is_admin;
    new.club_id = old.club_id;
    if coalesce(current_setting('app.allow_recovery_stamp', true), '') <> 'on' then
      new.recovery_verified_at = old.recovery_verified_at;
    end if;
  end if;
  return new;
end $$;

-- The only client-reachable way to stamp the column. It refuses unless
-- Auth itself says the caller really has a verified email plus password,
-- so the gate cannot be self-certified.
create or replace function public.mark_recovery_verified() returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_ok boolean;
  v_ts timestamptz;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  select (u.email is not null
          and u.encrypted_password is not null and u.encrypted_password <> ''
          and u.email_confirmed_at is not null)
    into v_ok
  from auth.users u where u.id = v_uid;
  if not coalesce(v_ok, false) then raise exception 'recovery method not verified'; end if;

  -- Transaction-local, cleared immediately after the one UPDATE it exists
  -- for. See the note on protect_is_admin() above.
  perform set_config('app.allow_recovery_stamp', 'on', true);
  update public.profiles
    set recovery_verified_at = coalesce(recovery_verified_at, now())
  where id = v_uid and deleted_at is null
  returning recovery_verified_at into v_ts;
  perform set_config('app.allow_recovery_stamp', 'off', true);

  if v_ts is null then raise exception 'profile not found'; end if;
  return v_ts;
end $$;
revoke all on function public.mark_recovery_verified() from public, anon;
grant execute on function public.mark_recovery_verified() to authenticated;

-- 4. The community access predicate. Every policy that gates posting,
-- commenting, reacting, or joining is keyed to this, per the locked
-- decision that community RLS requires a verified recovery method. Read
-- paths are deliberately NOT gated: an account still setting up its
-- recovery method can look around, it just cannot contribute.
create or replace function public.is_community_member() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.deleted_at is null and p.recovery_verified_at is not null
  ) and exists (
    select 1 from public.invite_redemptions ir where ir.user_id = auth.uid()
  );
$$;
revoke all on function public.is_community_member() from public, anon;
grant execute on function public.is_community_member() to authenticated;

-- 5. Friends. A mutual follow edge, computed against the caller. Both
-- follows rows are readable to the caller under the existing
-- follows_visible policy (one has follower_id = auth.uid(), the other has
-- followed_id = auth.uid()), so this stays security invoker.
create or replace function public.are_friends(p_other uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select auth.uid() is not null
    and p_other is not null
    and p_other <> auth.uid()
    and exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followed_id = p_other)
    and exists (select 1 from public.follows f where f.follower_id = p_other and f.followed_id = auth.uid());
$$;
revoke all on function public.are_friends(uuid) from public, anon;
grant execute on function public.are_friends(uuid) to authenticated;

-- 6. can_view_profile_field. One resolution point for every surface, so
-- feed, profile, leaderboard, and search cannot each invent their own
-- answer. Definer rights because it has to read the TARGET's toggle row,
-- which the caller may not be able to select once visible_to_club is off
-- - auth.uid() is checked first and the function only ever answers about
-- the caller's view of one other member.
create or replace function public.can_view_profile_field(p_target uuid, p_field text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.profiles;
  v_club_allows boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then return false; end if;
  if p_field is null or p_field not in (
    'visible_to_club', 'show_workout_results', 'show_attendance', 'show_upcoming_booking',
    'show_prs', 'show_achievements', 'in_leaderboards', 'allow_follows',
    'allow_mentions', 'allow_messages', 'show_in_attendee_lists'
  ) then
    raise exception 'unknown profile field %', p_field;
  end if;
  if p_target is null then return false; end if;
  if p_target = v_uid then return true; end if;

  -- A block edge in either direction ends the question before any toggle
  -- is consulted.
  if exists (
    select 1 from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = p_target)
       or (b.blocker_id = p_target and b.blocked_id = v_uid)
  ) then
    return false;
  end if;

  select * into v_row from public.profiles where id = p_target and deleted_at is null;
  if not found then return false; end if;

  if public.is_admin() then return true; end if;
  if not v_row.visible_to_club then return false; end if;

  select c.attendee_lists_enabled into v_club_allows from public.clubs c where c.id = v_row.club_id;

  return case p_field
    when 'visible_to_club' then v_row.visible_to_club
    when 'show_workout_results' then v_row.show_workout_results
    when 'show_attendance' then v_row.show_attendance
    when 'show_upcoming_booking' then v_row.show_upcoming_booking
    when 'show_prs' then v_row.show_prs
    when 'show_achievements' then v_row.show_achievements
    when 'in_leaderboards' then v_row.in_leaderboards
    when 'allow_follows' then v_row.allow_follows
    when 'allow_mentions' then v_row.allow_mentions
    when 'allow_messages' then v_row.allow_messages
    -- The club-wide override can only ever subtract from the member's own
    -- choice, never add to it.
    when 'show_in_attendee_lists' then v_row.show_in_attendee_lists and coalesce(v_club_allows, true)
    else false
  end;
end $$;
revoke all on function public.can_view_profile_field(uuid, text) from public, anon;
grant execute on function public.can_view_profile_field(uuid, text) to authenticated;

-- 6b. The update trigger above pins recovery_verified_at, but INSERT runs
-- no trigger - a first profile insert could otherwise arrive with the
-- column already stamped and skip the gate entirely. Close it in the
-- insert policy, keeping the rest of profiles_insert_self identical.
drop policy profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert to authenticated with check (
  id = auth.uid()
  and is_admin = false
  and recovery_verified_at is null
  and exists (select 1 from public.invite_redemptions ir where ir.user_id = auth.uid())
);

-- 7. The profiles read policy now respects visible_to_club. Self and a
-- real admin always pass, so a member who hides can still edit their own
-- row and moderation still works.
drop policy profiles_read_authenticated on public.profiles;
create policy profiles_read_authenticated on public.profiles for select to authenticated using (
  deleted_at is null
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = id)
       or (b.blocker_id = id and b.blocked_id = auth.uid())
  )
  and (id = auth.uid() or visible_to_club or public.is_admin())
);

-- 8. allow_follows becomes a real boundary rather than a hidden button.
-- A follow row is also refused across a block edge in either direction,
-- which the old policy left to the client.
drop policy follows_insert_self on public.follows;
create policy follows_insert_self on public.follows for insert to authenticated with check (
  follower_id = auth.uid()
  and exists (
    select 1 from public.profiles p
    where p.id = followed_id and p.deleted_at is null and p.allow_follows
  )
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = followed_id)
       or (b.blocker_id = followed_id and b.blocked_id = auth.uid())
  )
);

commit;
