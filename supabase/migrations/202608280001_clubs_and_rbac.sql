begin;

-- COMM-008 (roles, permissions, role_permissions) plus the single-club
-- carrier decided on 2026-08-28.
--
-- Two things land together because everything else in Phase 0 depends on
-- them: `has_perm()` is the authorization primitive every later policy is
-- keyed to, and `clubs` is the one row every new table's `club_id` column
-- defaults to. There is deliberately no multi-tenant logic anywhere - the
-- column exists so a second club is a data migration later instead of a
-- schema rewrite, and nothing reads it as a filter today.

-- 1. The single club. `attendee_lists_enabled` is the club-wide admin
-- override COMM-010 asks for: when an admin turns it off, no member shows
-- up in an attendee list regardless of their own show_in_attendee_lists
-- toggle. can_view_profile_field() (202608280003) reads it.
create table public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  attendee_lists_enabled boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into public.clubs (id, name)
values ('11111111-1111-1111-1111-111111111111', 'Haimunia')
on conflict (id) do nothing;

-- Every new table defaults club_id through this rather than repeating the
-- literal, so the seeded id lives in exactly one place.
create or replace function public.default_club_id() returns uuid
language sql stable set search_path = '' as $$
  select '11111111-1111-1111-1111-111111111111'::uuid;
$$;
revoke all on function public.default_club_id() from public, anon;
grant execute on function public.default_club_id() to authenticated;

-- 2. Roles. `rank` is what is_staff()/is_admin() compare against, so a new
-- tier slots in without touching either helper. HEAD_COACH is exposed to
-- the UI in Phase 1, STAFF and OWNER in Phase 2 - all three exist now so
-- the mapping below is the only thing that changes then.
create table public.roles (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{2,31}$'),
  label text not null check (char_length(label) between 1 and 60),
  rank smallint not null check (rank between 0 and 100)
);

insert into public.roles (code, label, rank) values
  ('member', 'Member', 10),
  ('coach', 'Coach', 20),
  ('head_coach', 'Head coach', 30),
  ('staff', 'Staff', 40),
  ('admin', 'Admin', 50),
  ('owner', 'Owner', 60);

create table public.permissions (
  code text primary key check (code ~ '^[a-z][a-z0-9_.]{4,63}$'),
  description text not null default '' check (char_length(description) <= 200)
);

insert into public.permissions (code, description) values
  ('community.post.create', 'Create community posts'),
  ('community.post.delete_any', 'Delete any member post'),
  ('community.comment.moderate', 'Act on reported comments and posts'),
  ('community.challenge.create', 'Create and edit challenges'),
  ('community.event.manage', 'Create and edit events'),
  ('community.analytics.view', 'Read community analytics and the admin audit log'),
  ('community.member.restrict', 'Restrict or unrestrict a member'),
  ('community.announcement.publish', 'Publish club announcements'),
  ('community.content.pin', 'Pin content to the club home');

create table public.role_permissions (
  role_code text not null references public.roles(code) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_code, permission_code)
);

-- Mapping. `owner` is seeded with everything and is ALSO short-circuited
-- inside has_perm(), so a permission string added by a later migration is
-- held by owner immediately without a matching seed row.
insert into public.role_permissions (role_code, permission_code) values
  ('member', 'community.post.create'),

  ('coach', 'community.post.create'),
  ('coach', 'community.comment.moderate'),
  ('coach', 'community.challenge.create'),
  ('coach', 'community.event.manage'),
  ('coach', 'community.announcement.publish'),

  ('head_coach', 'community.post.create'),
  ('head_coach', 'community.comment.moderate'),
  ('head_coach', 'community.challenge.create'),
  ('head_coach', 'community.event.manage'),
  ('head_coach', 'community.announcement.publish'),
  ('head_coach', 'community.post.delete_any'),
  ('head_coach', 'community.member.restrict'),
  ('head_coach', 'community.content.pin'),

  ('staff', 'community.post.create'),
  ('staff', 'community.event.manage'),
  ('staff', 'community.announcement.publish'),
  ('staff', 'community.content.pin'),

  ('admin', 'community.post.create'),
  ('admin', 'community.post.delete_any'),
  ('admin', 'community.comment.moderate'),
  ('admin', 'community.challenge.create'),
  ('admin', 'community.event.manage'),
  ('admin', 'community.analytics.view'),
  ('admin', 'community.member.restrict'),
  ('admin', 'community.announcement.publish'),
  ('admin', 'community.content.pin'),

  ('owner', 'community.post.create'),
  ('owner', 'community.post.delete_any'),
  ('owner', 'community.comment.moderate'),
  ('owner', 'community.challenge.create'),
  ('owner', 'community.event.manage'),
  ('owner', 'community.analytics.view'),
  ('owner', 'community.member.restrict'),
  ('owner', 'community.announcement.publish'),
  ('owner', 'community.content.pin');

-- 3. invite_redemptions.role becomes the role store. Its old inline check
-- only allowed member/coach; a foreign key to roles replaces it so
-- head_coach/staff/owner are grantable without another constraint edit.
-- Dropped by lookup rather than by name: the constraint was declared
-- inline in 202608270003, so its name is whatever Postgres generated.
do $$
declare v_name text;
begin
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.invite_redemptions'::regclass and contype = 'c'
  loop
    execute format('alter table public.invite_redemptions drop constraint %I', v_name);
  end loop;
end $$;
alter table public.invite_redemptions add constraint invite_redemptions_role_fkey
  foreign key (role) references public.roles(code);

alter table public.clubs enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;

-- The default-privilege revoke from 202608270002 should already keep anon
-- off anything created here. Stated explicitly anyway: that revoke is a
-- setting on a role in another migration, and a table with no policy for
-- anon plus a standing grant is exactly the hole 202608270002 was written
-- to close.
revoke all on public.clubs, public.roles, public.permissions, public.role_permissions from public, anon;
grant select on public.clubs, public.roles, public.permissions, public.role_permissions to authenticated;
grant insert, update, delete on public.clubs, public.roles, public.permissions, public.role_permissions to authenticated;

-- 4. my_role_code() is SECURITY DEFINER on purpose, and it is the one
-- place in this file that needs to be. The write policies below call it,
-- and it reads public.roles - an invoker-rights version would re-enter
-- roles' own RLS from inside roles' own policy and recurse. Definer
-- rights also let it read the caller's profiles/invite_redemptions rows
-- without depending on those tables' self-select policies staying as they
-- are. It never takes a user id argument: the only row it can ever resolve
-- is auth.uid()'s, checked first.
create or replace function public.my_role_code() returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_code text;
begin
  v_uid := auth.uid();
  if v_uid is null then return null; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.deleted_at is null) then
    return null;
  end if;
  -- Highest-ranked of the redeemed role and the legacy is_admin flag.
  -- Both scalar subqueries can be null; `code in (null, null)` matches no
  -- row, which is the correct "no role at all" answer.
  select r.code into v_code
  from public.roles r
  where r.code in (
    (select ir.role from public.invite_redemptions ir where ir.user_id = v_uid),
    (select 'admin' from public.profiles p where p.id = v_uid and p.is_admin and p.deleted_at is null)
  )
  order by r.rank desc
  limit 1;
  return v_code;
end $$;
revoke all on function public.my_role_code() from public, anon;
grant execute on function public.my_role_code() to authenticated;

create or replace function public.role_rank(p_code text) returns smallint
language sql stable security definer set search_path = '' as $$
  select r.rank from public.roles r where r.code = p_code;
$$;
revoke all on function public.role_rank(text) from public, anon;
grant execute on function public.role_rank(text) to authenticated;

create or replace function public.has_perm(p_permission text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_code text;
begin
  if auth.uid() is null then return false; end if;
  v_code := public.my_role_code();
  if v_code is null then return false; end if;
  if v_code = 'owner' then return true; end if;
  return exists (
    select 1 from public.role_permissions rp
    where rp.role_code = v_code and rp.permission_code = p_permission
  );
end $$;
revoke all on function public.has_perm(text) from public, anon;
grant execute on function public.has_perm(text) to authenticated;

create or replace function public.my_permissions() returns setof text
language plpgsql stable security definer set search_path = '' as $$
declare v_code text;
begin
  if auth.uid() is null then return; end if;
  v_code := public.my_role_code();
  if v_code is null then return; end if;
  if v_code = 'owner' then
    return query select p.code from public.permissions p order by p.code;
    return;
  end if;
  return query
    select rp.permission_code from public.role_permissions rp
    where rp.role_code = v_code order by rp.permission_code;
end $$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- 5. is_staff() keeps its exact signature so the announcements and
-- weekly_challenges policies that already bound to it stay valid, and
-- keeps its exact meaning: coach rank or above. is_admin() is new and is
-- the table-driven replacement for the `profiles.is_admin` literal that
-- review_report(), the moderation policy, and the admin RPCs still check
-- inline - those stay as they are until COMM-150 migrates them.
create or replace function public.is_staff() returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce(public.role_rank(public.my_role_code()) >= 20, false);
$$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce(public.role_rank(public.my_role_code()) >= 50, false);
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 6. RLS. The three RBAC tables are world-readable to a logged-in member
-- (the client caches its own permission set from them) and writable only
-- by owner - a role or permission change is a deploy-level act, not
-- something an admin does from the app.
create policy clubs_read on public.clubs for select to authenticated using (true);
create policy clubs_write_owner on public.clubs for update to authenticated
  using (public.my_role_code() = 'owner') with check (public.my_role_code() = 'owner');
create policy clubs_insert_owner on public.clubs for insert to authenticated
  with check (public.my_role_code() = 'owner');
create policy clubs_delete_owner on public.clubs for delete to authenticated
  using (public.my_role_code() = 'owner');

create policy roles_read on public.roles for select to authenticated using (true);
create policy roles_insert_owner on public.roles for insert to authenticated
  with check (public.my_role_code() = 'owner');
create policy roles_update_owner on public.roles for update to authenticated
  using (public.my_role_code() = 'owner') with check (public.my_role_code() = 'owner');
create policy roles_delete_owner on public.roles for delete to authenticated
  using (public.my_role_code() = 'owner');

create policy permissions_read on public.permissions for select to authenticated using (true);
create policy permissions_insert_owner on public.permissions for insert to authenticated
  with check (public.my_role_code() = 'owner');
create policy permissions_update_owner on public.permissions for update to authenticated
  using (public.my_role_code() = 'owner') with check (public.my_role_code() = 'owner');
create policy permissions_delete_owner on public.permissions for delete to authenticated
  using (public.my_role_code() = 'owner');

create policy role_permissions_read on public.role_permissions for select to authenticated using (true);
create policy role_permissions_insert_owner on public.role_permissions for insert to authenticated
  with check (public.my_role_code() = 'owner');
create policy role_permissions_update_owner on public.role_permissions for update to authenticated
  using (public.my_role_code() = 'owner') with check (public.my_role_code() = 'owner');
create policy role_permissions_delete_owner on public.role_permissions for delete to authenticated
  using (public.my_role_code() = 'owner');

commit;
