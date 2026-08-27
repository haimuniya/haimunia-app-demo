begin;

-- Security hardening for invite redemption, post-photo ownership,
-- upload abuse, staff checks, and report moderation.

-- Replace plaintext invite codes with opaque IDs and hashes. Existing
-- codes are revoked. Operators must issue new high-entropy member codes.
alter table public.invite_codes add column id uuid default gen_random_uuid();
alter table public.invite_codes add column code_hash text;
alter table public.invite_codes add column expires_at timestamptz;
alter table public.invite_codes add column max_uses integer not null default 1 check (max_uses between 1 and 1000);
alter table public.invite_codes add column use_count integer not null default 0 check (use_count >= 0);
alter table public.invite_codes add column revoked_at timestamptz;

update public.invite_codes
set code_hash = encode(extensions.digest(code, 'sha256'), 'hex'),
    revoked_at = coalesce(revoked_at, now());
alter table public.invite_codes alter column id set not null;
alter table public.invite_codes alter column code_hash set not null;
alter table public.invite_codes add constraint invite_codes_code_hash_key unique (code_hash);

alter table public.invite_redemptions add column invite_id uuid;
update public.invite_redemptions ir set invite_id = ic.id
from public.invite_codes ic where ir.code = ic.code;
alter table public.invite_redemptions alter column invite_id set not null;

-- Swap invite_codes' primary key from code to id BEFORE adding the new
-- FK below that references id — a foreign key's target column needs a
-- unique/primary-key constraint to already exist at the moment the FK is
-- created. Dropping the old code-based FK first is what makes it safe to
-- then drop the old code-based primary key and add the new one on id.
alter table public.invite_redemptions drop constraint invite_redemptions_code_fkey;
alter table public.invite_codes drop constraint invite_codes_pkey;
alter table public.invite_codes add constraint invite_codes_pkey primary key (id);

alter table public.invite_redemptions add constraint invite_redemptions_invite_id_fkey
  foreign key (invite_id) references public.invite_codes(id);
alter table public.invite_redemptions drop column code;
alter table public.invite_codes drop column code;

create table public.invite_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz not null default now()
);
alter table public.invite_attempts enable row level security;
revoke all on public.invite_attempts from public, anon, authenticated;

create or replace function public.redeem_invite_code(p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_attempts integer;
  v_invite_id uuid;
  v_existing_role text;
begin
  if auth.uid() is null then return 'invalid'; end if;

  select role into v_existing_role from public.invite_redemptions where user_id = auth.uid();
  if v_existing_role is not null then return v_existing_role; end if;

  insert into public.invite_attempts(user_id, window_started_at, attempt_count, last_attempt_at)
  values (auth.uid(), now(), 1, now())
  on conflict (user_id) do update set
    window_started_at = case when public.invite_attempts.window_started_at < now() - interval '15 minutes' then now() else public.invite_attempts.window_started_at end,
    attempt_count = case when public.invite_attempts.window_started_at < now() - interval '15 minutes' then 1 else public.invite_attempts.attempt_count + 1 end,
    last_attempt_at = now()
  returning attempt_count into v_attempts;

  if v_attempts > 5 then return 'rate_limited'; end if;
  if p_code is null or p_code !~ '^[a-f0-9]{40,128}$' then return 'invalid'; end if;

  -- Ordinary redemption never grants or upgrades to coach.
  update public.invite_codes set use_count = use_count + 1
  where code_hash = encode(extensions.digest(p_code, 'sha256'), 'hex')
    and role = 'member' and active and revoked_at is null
    and (expires_at is null or expires_at > now()) and use_count < max_uses
  returning id into v_invite_id;
  if v_invite_id is null then return 'invalid'; end if;

  insert into public.invite_redemptions(user_id, invite_id, role)
  values (auth.uid(), v_invite_id, 'member');
  return 'member';
end $$;
revoke all on function public.redeem_invite_code(text) from public, anon;
grant execute on function public.redeem_invite_code(text) to authenticated;

create or replace function public.create_member_invite(
  p_expires_at timestamptz default (now() + interval '14 days'),
  p_max_uses integer default 1
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if p_max_uses < 1 or p_max_uses > 1000 then raise exception 'max uses must be between 1 and 1000'; end if;
  if p_expires_at is null or p_expires_at <= now() then raise exception 'expiry must be in the future'; end if;
  v_code := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.invite_codes(id, code_hash, role, active, expires_at, max_uses)
  values (gen_random_uuid(), encode(extensions.digest(v_code, 'sha256'), 'hex'), 'member', true, p_expires_at, p_max_uses);
  return v_code;
end $$;
revoke all on function public.create_member_invite(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.create_member_invite(timestamptz, integer) to service_role;

create or replace function public.grant_coach_role(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.invite_redemptions set role = 'coach', redeemed_at = now() where user_id = p_user_id;
  if not found then raise exception 'user must redeem a member invite before coach access is granted'; end if;
end $$;
revoke all on function public.grant_coach_role(uuid) from public, anon, authenticated;
grant execute on function public.grant_coach_role(uuid) to service_role;

-- Replace the arbitrary-user staff lookup with a caller-only function.
-- CREATE OR REPLACE cannot remove an existing default parameter value
-- (Postgres error 42P13, "cannot remove parameter defaults from existing
-- function") — 202608270005's is_staff(p_uid uuid default auth.uid())
-- has to be dropped outright before a caller-only is_staff() can take
-- its place. Unlike PL/pgSQL function bodies (opaque text, not
-- catalog-tracked — coach_inactive_members/coach_new_members below can
-- safely stay in their not-yet-replaced form across the drop), an RLS
-- policy's USING/WITH CHECK clause is a real parsed expression, and
-- Postgres DOES track a dependency on whatever function it resolves to
-- at CREATE POLICY time. These three policies were created while
-- is_staff(uuid) was the only overload, so calling public.is_staff()
-- with no arguments in their WITH CHECK bound to that specific default-
-- parameter overload — they have to be dropped before it, not after.
drop policy announcements_insert_admin on public.announcements;
drop policy announcements_update_admin on public.announcements;
drop policy weekly_challenges_insert_admin on public.weekly_challenges;

drop function public.is_staff(uuid);

create or replace function public.is_staff() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null)
    or exists (select 1 from public.invite_redemptions where user_id = auth.uid() and role = 'coach');
$$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

create policy announcements_insert_admin on public.announcements for insert to authenticated
  with check (author_id = auth.uid() and public.is_staff());
create policy announcements_update_admin on public.announcements for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy weekly_challenges_insert_admin on public.weekly_challenges for insert to authenticated
  with check (created_by = auth.uid() and public.is_staff());

create or replace function public.coach_inactive_members(p_since date default (current_date - 7))
returns table(user_id uuid, handle text, display_name text, last_activity_on date)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'not authorized'; end if;
  return query select pr.id, pr.handle, pr.display_name, max(ap.activity_date)
    from public.profiles pr left join public.activity_pings ap on ap.user_id = pr.id
    where pr.deleted_at is null group by pr.id
    having max(ap.activity_date) is null or max(ap.activity_date) < p_since
    order by max(ap.activity_date) asc nulls first;
end $$;

create or replace function public.coach_new_members(p_within_days integer default 14)
returns table(user_id uuid, handle text, display_name text, first_activity_on date)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'not authorized'; end if;
  return query select pr.id, pr.handle, pr.display_name, min(ap.activity_date)
    from public.profiles pr join public.activity_pings ap on ap.user_id = pr.id
    where pr.deleted_at is null group by pr.id
    having min(ap.activity_date) >= (current_date - p_within_days)
    order by min(ap.activity_date) desc;
end $$;

-- Bind every photo path to its author and limit uploads to active members.
update public.workout_posts set photo_path = null
where photo_path is not null and split_part(photo_path, '/', 1) <> author_id::text;

create or replace function public.enforce_post_photo_ownership() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.photo_path is not null and split_part(new.photo_path, '/', 1) <> new.author_id::text then
    raise exception 'photo path must belong to the post author';
  end if;
  return new;
end $$;
drop trigger if exists workout_posts_photo_owner on public.workout_posts;
create trigger workout_posts_photo_owner before insert or update of photo_path, author_id
on public.workout_posts for each row execute function public.enforce_post_photo_ownership();

create or replace function public.can_upload_post_photo(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and split_part(p_name, '/', 1) = auth.uid()::text
    and exists (
      select 1 from public.profiles p join public.invite_redemptions ir on ir.user_id = p.id
      where p.id = auth.uid() and p.deleted_at is null
    )
    and (select count(*) from storage.objects o
      where o.bucket_id = 'post-photos' and split_part(o.name, '/', 1) = auth.uid()::text) < 20;
$$;
revoke all on function public.can_upload_post_photo(text) from public, anon;
grant execute on function public.can_upload_post_photo(text) to authenticated;

drop policy post_photos_insert_own on storage.objects;
create policy post_photos_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'post-photos' and public.can_upload_post_photo(name));
drop policy post_photos_select_if_post_visible on storage.objects;
create policy post_photos_select_if_post_visible on storage.objects for select to authenticated
  using (bucket_id = 'post-photos' and exists (
    select 1 from public.workout_posts p where p.photo_path = storage.objects.name
      and split_part(storage.objects.name, '/', 1) = p.author_id::text
      and public.post_visible_to_viewer(p.id)
  ));

create or replace function public.list_orphaned_post_photos(p_older_than interval default interval '1 day')
returns table(object_name text)
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o where o.bucket_id = 'post-photos'
    and o.created_at < now() - p_older_than
    and not exists (select 1 from public.workout_posts p where p.photo_path = o.name);
$$;
revoke all on function public.list_orphaned_post_photos(interval) from public, anon, authenticated;
grant execute on function public.list_orphaned_post_photos(interval) to service_role;

-- Add a trusted report-review transition and audit fields.
alter table public.reports add column reviewed_by uuid references public.profiles(id);
alter table public.reports add column resolution_notes text not null default '' check (char_length(resolution_notes) <= 1000);

create or replace function public.review_report(
  p_report_id uuid, p_status public.report_status, p_resolution_notes text default ''
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  if p_status = 'open' then raise exception 'review transition must move the report out of open'; end if;
  update public.reports set status = p_status,
    resolution_notes = left(coalesce(p_resolution_notes, ''), 1000),
    reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_report_id;
  if not found then raise exception 'report not found'; end if;
end $$;
revoke all on function public.review_report(uuid, public.report_status, text) from public, anon;
grant execute on function public.review_report(uuid, public.report_status, text) to authenticated;

commit;
